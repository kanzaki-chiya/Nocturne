/**
 * 后台级共享状态（ADR-0052 第 2 节）：Runtime 句柄、已打开的会话、服务商配置与
 * 配置变更队列属于整个后台，不属于某一条连接。连接（server.ts 的 Connection）
 * 只保留自己的状态：在途请求、订阅、草稿、登录、握手进度。
 */
import {
  createPlatform,
  type Platform,
  type Runtime,
  type RuntimeConfig,
  type RuntimeSession,
} from "@nocturne/core";

import type { RpcMessage } from "../shared/jsonrpc.js";
import { RpcProtocolError } from "./errors.js";
import { optString, type Params } from "./params.js";

/** createRuntime 的产物：Runtime 加上服务端要对外报告与收尾的信息 */
export interface RpcRuntimeHandle {
  runtime: Runtime;
  /** 会话日志目录，握手时作为只读信息返回 */
  sessionsDir?: string | undefined;
  /** 全部会话关闭之后调用，释放 Runtime 之外的资源 */
  dispose?: (() => Promise<void> | void) | undefined;
  /**
   * 服务商配置（docs/protocols/rpc.md 3.3）：缺省时 provider.* / login.*
   * 一律以 `provider_config_unavailable` 拒绝。
   */
  providerConfig?:
    | {
        /**
         * 创建 Runtime 用的同一个配置对象。服务端在每次变更后重载并整体替换
         * （启动时对象的 `base` 是加载时快照，不能发现本进程新加的服务商），
         * 与 CLI/TUI 的 `updateProviders(await reloadConfig())` 等价。
         */
        config: RuntimeConfig;
        /** 重新分层加载（apps 注入，等价 CLI 的 makeConfigLoader） */
        reload: () => Promise<RuntimeConfig>;
        /** describeProviders / listModelSettings / saveModelSettings 的工作区 */
        workspaceRoot?: string | undefined;
      }
    | undefined;
}

/**
 * 服务商配置（握手时取自 handle.providerConfig）：`current` 是最近一次
 * 重载的结果——Core 的草稿与草稿登录按 RuntimeConfig 对象登记，而启动时
 * 对象的 `base` 是快照，所以变更方法后整体换成重载出的新对象。
 */
export interface ProviderState {
  current: RuntimeConfig;
  reload: () => Promise<RuntimeConfig>;
  workspaceRoot: string | undefined;
}

/** Hub 向连接广播通知所需要的最小接口 */
export interface HubPeer {
  readonly origin: "local" | "remote";
  /** 已完成握手；通知只发给已握手的连接 */
  readonly initialized: boolean;
  send(message: RpcMessage): void;
  disconnect(): Promise<void>;
}

export class Hub {
  stopping = false;
  private handle: RpcRuntimeHandle | undefined;
  private providerState: ProviderState | undefined;
  /** 配置变更串行队列：变更 → 重载 → updateProviders → providersChanged 通知，响应最后 */
  private configQueue: Promise<unknown> = Promise.resolve();
  private readonly platform: Platform = createPlatform();
  /** 后台里已打开的会话（sessionId → 会话） */
  private readonly sessions = new Map<string, RuntimeSession>();
  private readonly peers = new Set<HubPeer>();
  private readonly references = new Map<string, number>();
  private readonly active = new Map<string, number>();
  private readonly opening = new Map<string, Promise<RuntimeSession>>();
  private readonly closing = new Map<string, Promise<void>>();

  get available(): boolean {
    return this.handle !== undefined && !this.stopping;
  }

  async closeRemotes(): Promise<void> {
    await Promise.allSettled(
      [...this.peers].filter((peer) => peer.origin === "remote").map((peer) => peer.disconnect()),
    );
  }

  // ── 连接登记 ─────────────────────────────────────────────

  attach(peer: HubPeer): void {
    this.peers.add(peer);
  }

  detach(peer: HubPeer): void {
    this.peers.delete(peer);
  }

  notifyLocal(message: RpcMessage): void {
    for (const peer of this.peers) {
      if (peer.origin === "local" && peer.initialized) peer.send(message);
    }
  }

  /** `runtime.providersChanged` 广播给所有已握手的连接 */
  notifyProvidersChanged(): void {
    for (const peer of this.peers) {
      if (peer.initialized) {
        peer.send({ jsonrpc: "2.0", method: "runtime.providersChanged", params: {} });
      }
    }
  }

  // ── Runtime ──────────────────────────────────────────────

  /** 握手创建 Runtime 成功后登记句柄与服务商配置 */
  setHandle(handle: RpcRuntimeHandle): void {
    this.handle = handle;
    const providerConfig = handle.providerConfig;
    this.providerState =
      providerConfig !== undefined
        ? {
            current: providerConfig.config,
            reload: providerConfig.reload,
            workspaceRoot: providerConfig.workspaceRoot,
          }
        : undefined;
  }

  get sessionsDir(): string | undefined {
    return this.handle?.sessionsDir;
  }

  runtime(): Runtime {
    if (this.handle === undefined) {
      throw new RpcProtocolError("not_initialized", "第一条请求必须是 initialize");
    }
    return this.handle.runtime;
  }

  // ── 服务商配置 ───────────────────────────────────────────

  providerConfig(): ProviderState {
    if (this.providerState === undefined) {
      throw new RpcProtocolError("provider_config_unavailable", "服务端未提供服务商配置");
    }
    return this.providerState;
  }

  /**
   * 运行时级方法的 workspaceRoot 参数（ADR-0051）：同步读方法依赖配置的
   * 工作区层缓存，派发前先解析真实路径再加载目标工作区；解析失败保留原串。
   * 缺省返回 undefined（= 后台启动目录）。无 providerConfig 的后台跳过预加载，
   * 已打开会话的工作区在会话打开时已加载。
   */
  async workspaceOf(p: Params): Promise<string | undefined> {
    const input = optString(p, "workspaceRoot");
    if (input === undefined) return undefined;
    const root = await this.platform.resolveReal(input).catch(() => input);
    if (this.providerState !== undefined) {
      await this.providerConfig().current.forWorkspace(root);
    }
    return root;
  }

  /**
   * 变更入队执行，随后 reload → updateProviders → 推 `runtime.providersChanged`
   * （docs/protocols/rpc.md 3.3）。变更抛错不重载、原样抛；重载抛错则请求
   * 以重载错误失败——此时写入已生效、Runtime 仍用旧配置。
   */
  enqueueConfig<T>(task: (config: RuntimeConfig) => Promise<T>): Promise<T> {
    const run = this.configQueue.then(() => task(this.providerConfig().current));
    // 前一个任务失败不阻塞后续任务
    this.configQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async reloadProviders(notify = true): Promise<void> {
    const next = await this.providerConfig().reload();
    await this.runtime().updateProviders(next);
    this.providerConfig().current = next;
    if (notify) this.notifyProvidersChanged();
  }

  mutateAndReload<T>(mutate: (config: RuntimeConfig) => Promise<T>, notify = true): Promise<T> {
    return this.enqueueConfig(async (config) => {
      const result = await mutate(config);
      await this.reloadProviders(notify);
      return result;
    });
  }

  // ── 会话 ─────────────────────────────────────────────────

  addSession(session: RuntimeSession): void {
    this.sessions.set(session.id, session);
    this.references.set(session.id, (this.references.get(session.id) ?? 0) + 1);
  }

  async resume(
    sessionId: string,
    options: Parameters<Runtime["resumeSession"]>[1],
  ): Promise<RuntimeSession> {
    await this.closing.get(sessionId);
    const existing = this.sessions.get(sessionId);
    if (existing !== undefined) {
      this.addSession(existing);
      return existing;
    }
    let pending = this.opening.get(sessionId);
    if (pending === undefined) {
      pending = this.runtime()
        .resumeSession(sessionId, options)
        .then((session) => {
          this.sessions.set(sessionId, session);
          return session;
        });
      this.opening.set(sessionId, pending);
    }
    try {
      const session = await pending;
      this.addSession(session);
      return session;
    } finally {
      if (this.opening.get(sessionId) === pending) this.opening.delete(sessionId);
    }
  }

  async release(sessionId: string): Promise<void> {
    this.references.set(sessionId, Math.max(0, (this.references.get(sessionId) ?? 0) - 1));
    await this.closeUnused(sessionId);
  }

  private async closeUnused(sessionId: string): Promise<void> {
    if ((this.references.get(sessionId) ?? 0) > 0 || (this.active.get(sessionId) ?? 0) > 0) return;
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    this.sessions.delete(sessionId);
    this.references.delete(sessionId);
    const closing = session.close();
    this.closing.set(sessionId, closing);
    try {
      await closing;
    } finally {
      this.closing.delete(sessionId);
    }
  }

  async operate<T>(session: RuntimeSession, task: () => Promise<T>): Promise<T> {
    this.active.set(session.id, (this.active.get(session.id) ?? 0) + 1);
    try {
      return await task();
    } finally {
      this.active.set(session.id, (this.active.get(session.id) ?? 1) - 1);
      await this.closeUnused(session.id);
    }
  }

  async allowWorkspace(input: string): Promise<boolean> {
    const root = await this.platform.resolveReal(input).catch(() => undefined);
    if (root === undefined) return false;
    const summaries = await this.runtime().listSessions({ includeSubagents: false });
    for (const summary of summaries) {
      for (const directory of [summary.cwd, summary.workspaceRoot]) {
        if (root === (await this.platform.resolveReal(directory).catch(() => undefined)))
          return true;
      }
    }
    return false;
  }

  /**
   * 远程新建会话的目录检查（ADR-0052 修订 2026-10-15）：目录必须是已存在的绝对路径；
   * 工作区根有项目配置却未信任、且不是已有会话用过的工作区时，信任要在电脑上决定，
   * 手机不能代为在新目录里以未信任方式开始。
   */
  async checkRemoteWorkspace(cwd: string | undefined, root: string | undefined): Promise<void> {
    const real: string[] = [];
    for (const directory of [cwd, root]) {
      if (directory === undefined) continue;
      const resolved = this.platform.paths.isAbsolute(directory)
        ? await this.platform.resolveReal(directory).catch(() => undefined)
        : undefined;
      const stat =
        resolved === undefined
          ? undefined
          : await this.platform.fs.stat(resolved).catch(() => undefined);
      if (resolved === undefined || stat?.type !== "directory") {
        throw new RpcProtocolError(
          "workspace_not_found",
          `目录不存在或不是文件夹：${directory}（请填写电脑上的完整路径）`,
        );
      }
      real.push(resolved);
    }
    const workspace = root !== undefined ? real.at(-1) : real[0];
    if (workspace === undefined || this.providerState === undefined) return;
    const { projectConfig } = await this.providerConfig().current.forWorkspace(workspace);
    if (
      projectConfig.present &&
      !projectConfig.trusted &&
      !(await this.allowWorkspace(workspace))
    ) {
      throw new RpcProtocolError(
        "workspace_untrusted",
        "这个目录的项目配置还没有信任。手机不能代为决定，请在电脑上信任该项目（在项目目录运行 nctrn trust）或先在电脑上新建会话",
      );
    }
  }

  openSessions(): IterableIterator<RuntimeSession> {
    return this.sessions.values();
  }

  interruptAll(): void {
    for (const session of this.sessions.values()) session.interrupt();
  }

  // ── 收尾 ─────────────────────────────────────────────────

  /**
   * 整个后台收尾：等配置队列落定，中断并关闭全部会话（刷盘、释放会话锁），
   * 释放 Runtime 之外的资源，然后复位，之后新的握手可以重新创建 Runtime。
   */
  async shutdown(): Promise<void> {
    await this.configQueue.catch(() => undefined);
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const session of sessions) session.interrupt();
    await Promise.allSettled(sessions.map((session) => session.close()));
    await Promise.allSettled([...this.closing.values()]);
    this.references.clear();
    this.active.clear();
    await this.handle?.dispose?.();
    this.handle = undefined;
    this.providerState = undefined;
    this.stopping = false;
  }
}
