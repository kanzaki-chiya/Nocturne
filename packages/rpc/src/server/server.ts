/**
 * RPC 服务端（ADR-0044）：给定一个 Runtime，把公开 API 映射成 JSON-RPC 方法，
 * 把会话事件推成 `event` 通知。与传输无关：只接收按行收发的 LineTransport。
 *
 * 一个服务端同一时刻只接一个客户端，可同时打开多个会话。权限判定仍只在
 * Runtime 的权限层——这里只转发 `permission.requested` 事件与回复（AGENTS.md 硬性约束）。
 */
import { randomUUID } from "node:crypto";

import {
  commitProvider,
  describeAccountStorage,
  describeProviderSetup,
  discardDraftLogin,
  discardProvider,
  isReasoningEffort,
  listProviderPresets,
  logoutProvider,
  MODEL_ROLES,
  prepareProvider,
  ProviderLoginError,
  startDraftProviderLogin,
  startProviderLogin,
  type AddProviderInput,
  type ContentBlock,
  type CreateSessionOptions,
  type JevEndpoint,
  type JevReviewerConfig,
  type LoginResult,
  type LoginSession,
  type ModelRole,
  type PermissionReply,
  type ProviderCredentialInput,
  type ProviderLoginOptions,
  type QuestionReply,
  type RewindMode,
  type Runtime,
  type RuntimeConfig,
  type RuntimeEvent,
  type RuntimeSession,
  type SubmitInput,
} from "@nocturne/core";

import {
  encodeMessage,
  invalidRequestFailure,
  isRpcId,
  parseLine,
  RPC_PROTOCOL_VERSION,
  type RpcErrorObject,
  type RpcFailure,
  type RpcId,
  type RpcMessage,
} from "../shared/jsonrpc.js";
import {
  RPC_METHOD_NAMES,
  type LoginCompleted,
  type LoginStarted,
  type RpcMethodName,
  type RpcMethods,
  type SessionOpened,
  type WireAttachment,
} from "../shared/methods.js";
import type { LineTransport } from "../shared/transport.js";
import { MethodNotFoundError, RpcProtocolError, toRpcError } from "./errors.js";
import {
  asParams,
  decodeBase64,
  InvalidParamsError,
  optBool,
  optInt,
  optString,
  reqInt,
  reqModel,
  reqObject,
  reqString,
  type Params,
} from "./params.js";

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
 * 参数里可能含秘密值的方法（ADR-0044 第 6 节：密钥明文只在两个进程的管道里）：
 * 请求失败时把错误 message 与 data 各字符串中出现的每个非空秘密值替换为
 * `[redacted]`，避免密钥随报错文本回流客户端或进入日志。诊断记录本来就不含参数。
 */
export const SENSITIVE_METHODS: Partial<Record<RpcMethodName, (p: Params) => string[]>> = {
  "runtime.updateSettings": (p) => (typeof p.reviewerKey === "string" ? [p.reviewerKey] : []),
  "provider.prepareProvider": (p) => {
    const credential = p.credential;
    if (typeof credential !== "object" || credential === null) return [];
    const { kind, key } = credential as { kind?: unknown; key?: unknown };
    return kind === "apiKey" && typeof key === "string" ? [key] : [];
  },
  "provider.setCredential": (p) => (typeof p.key === "string" ? [p.key] : []),
  "login.submitManual": (p) => (typeof p.text === "string" ? [p.text] : []),
};

export interface RpcServerOptions {
  nocturneVersion: string;
  /**
   * 握手后创建 Runtime：客户端声明的 `interactive` 能力决定 Runtime 的 `interactive`
   * （权限请求能否交给客户端；false 时按非交互规则处理）。
   */
  createRuntime(init: { clientName: string; interactive: boolean }): Promise<RpcRuntimeHandle>;
  /** 订阅回放每批推送的事件数，批间让出事件循环（默认 256） */
  replayChunkSize?: number | undefined;
  /** 回放批间的让出点，默认 setImmediate；测试可注入以在回放中途暂停，制造"回放期间有新事件" */
  replayYield?: (() => Promise<void>) | undefined;
  /** 诊断记录：只含方法名与结果，永远不含参数（参数里可能有密钥明文） */
  diagnostics?: ((record: RpcDiagnostic) => void) | undefined;
}

export type RpcDiagnostic =
  | { kind: "connection"; state: "open" | "closed" }
  | { kind: "request"; id: RpcId; method: string }
  | { kind: "notification"; method: string }
  | { kind: "response"; id: RpcId | null; ok: boolean; errorCode?: string };

export interface RpcServer {
  /** 本服务端实现的请求方法（不含通知）；覆盖测试用它与公开 API 对照 */
  readonly methods: readonly RpcMethodName[];
  /**
   * 在一条传输上服务一个客户端。输入结束时中断 Turn、等待在途请求并刷出回复，
   * 再关闭全部会话（刷盘、释放锁）和释放 Runtime 资源。shutdown 先清理再回复。
   */
  serve(transport: LineTransport): Promise<void>;
}

const DEFAULT_REPLAY_CHUNK = 256;

interface OpenSession {
  session: RuntimeSession;
  unsubscribe: (() => void) | undefined;
  /** 每次 subscribe/unsubscribe/close 递增；回放循环发现自己过期就停手 */
  generation: number;
}

/** 进行中的登录会话：saved 是已保存服务商的重新登录，draft 是表单里未保存的草稿登录 */
interface LoginEntry {
  session: LoginSession;
  kind: "saved" | "draft";
  /** 创建登录时用的配置对象（草稿登录的暂存凭据按它登记） */
  config: RuntimeConfig;
  /** 对应 start/startDraft 响应写出后 resolve——login.completed 绝不先于它到达 */
  started: Promise<void>;
  resolveStarted: () => void;
  /** 无系统后端时经 onUnstoredKey 记录的密钥（只记第一次；随 login.completed 发出后丢弃） */
  unstored: { value: { key: string; envName: string } | undefined };
}

type Handler<K extends RpcMethodName> = (
  params: Params,
) => Promise<RpcMethods[K]["result"]> | RpcMethods[K]["result"];
type HandlerTable = { [K in RpcMethodName]: Handler<K> };

export function createRpcServer(options: RpcServerOptions): RpcServer {
  let serving = false;
  return {
    methods: RPC_METHOD_NAMES,
    async serve(transport) {
      if (serving) throw new Error("RPC 服务端同一时刻只接一个客户端");
      serving = true;
      try {
        await new Connection(options, transport).run();
      } finally {
        serving = false;
      }
    },
  };
}

class Connection {
  private handle: RpcRuntimeHandle | undefined;
  private initPromise: Promise<void> | undefined;
  private initialized = false;
  private shuttingDown = false;
  private closed = false;
  private inputEnded = false;
  private readonly requests = new Set<Promise<void>>();
  private cleanupPromise: Promise<void> | undefined;
  private readonly sessions = new Map<string, OpenSession>();
  private readonly opening = new Set<Promise<unknown>>();
  private readonly abort = new AbortController();
  private readonly handlers: HandlerTable;
  /**
   * 服务商配置（握手时取自 handle.providerConfig）：`current` 是最近一次
   * 重载的结果——Core 的草稿与草稿登录按 RuntimeConfig 对象登记，而启动时
   * 对象的 `base` 是快照，所以变更方法后整体换成重载出的新对象。
   */
  private providerState:
    | {
        current: RuntimeConfig;
        reload: () => Promise<RuntimeConfig>;
        workspaceRoot: string | undefined;
      }
    | undefined;
  /** 配置变更串行队列：变更 → 重载 → updateProviders → providersChanged 通知，响应最后 */
  private configQueue: Promise<unknown> = Promise.resolve();
  /** draftId → 创建草稿时的配置对象（与该登录的创建配置一致；见 buildHandlers 的 prepareProvider） */
  private readonly providerDrafts = new Map<
    string,
    { config: RuntimeConfig; loginId?: string | undefined }
  >();
  /** loginId → 本连接 login.startDraft 创建时的配置对象（进行中或已完成未提交） */
  private readonly draftLogins = new Map<string, RuntimeConfig>();
  /** 进行中的登录会话（loginId → 条目）；完成或取消时移出并推 login.completed */
  private readonly logins = new Map<string, LoginEntry>();

  constructor(
    private readonly options: RpcServerOptions,
    private readonly transport: LineTransport,
  ) {
    this.handlers = this.buildHandlers();
  }

  run(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.diagnose({ kind: "connection", state: "open" });
      this.transport.onLine((line) => {
        this.onLine(line);
      });
      this.transport.onClose(() => {
        this.inputEnded = true;
        for (const entry of this.sessions.values()) entry.session.interrupt();
        void (async () => {
          await Promise.allSettled([...this.requests]);
          await this.transport.flush?.();
          await this.cleanup();
          this.closed = true;
          this.diagnose({ kind: "connection", state: "closed" });
          resolve();
        })();
      });
    });
  }

  // ── 报文收发 ─────────────────────────────────────────────

  private diagnose(record: RpcDiagnostic): void {
    try {
      this.options.diagnostics?.(record);
    } catch {
      // 诊断回调出错不影响服务
    }
  }

  private send(message: RpcMessage): void {
    if (this.closed) return;
    try {
      this.transport.send(encodeMessage(message));
    } catch {
      // 传输已断开：由 onClose 收尾
    }
  }

  private fail(failure: RpcFailure): void {
    this.diagnose({
      kind: "response",
      id: failure.id,
      ok: false,
      ...(failure.error.data?.code !== undefined ? { errorCode: failure.error.data.code } : {}),
    });
    this.send(failure);
  }

  private onLine(line: string): void {
    if (line.trim() === "") return;
    const parsed = parseLine(line);
    if (parsed.kind === "error") {
      this.fail(parsed.failure);
      return;
    }
    const message = parsed.message;
    const id = message.id;
    const method = message.method;
    if (message.jsonrpc !== "2.0") {
      this.fail(invalidRequestFailure(isRpcId(id) ? id : null, 'jsonrpc 必须是 "2.0"'));
      return;
    }
    if (typeof method !== "string") {
      // 客户端发来的应答：服务端不发请求，直接忽略
      if ("result" in message || "error" in message) return;
      this.fail(invalidRequestFailure(isRpcId(id) ? id : null, "缺少 method"));
      return;
    }
    if (id === undefined) {
      this.onNotification(method, message.params);
      return;
    }
    if (!isRpcId(id)) {
      this.fail(invalidRequestFailure(null, "id 必须是字符串或数字"));
      return;
    }
    const request = this.onRequest(id, method, message.params);
    this.requests.add(request);
    void request.finally(() => this.requests.delete(request));
  }

  private onNotification(method: string, params: unknown): void {
    this.diagnose({ kind: "notification", method });
    if (method === "session.interrupt") this.interrupt(params);
    // 其他通知没有定义，忽略
  }

  private interrupt(params: unknown): void {
    try {
      const sessionId = reqString(asParams(params), "sessionId");
      this.sessions.get(sessionId)?.session.interrupt();
    } catch {
      // 通知没有应答：参数不对就当没发
    }
  }

  private async onRequest(id: RpcId, method: string, params: unknown): Promise<void> {
    this.diagnose({ kind: "request", id, method });
    try {
      let result: unknown;
      if (method === "session.interrupt") {
        // 允许以请求形式发中断（便于需要确认送达的客户端）
        this.interrupt(params);
        result = null;
      } else {
        result = await this.dispatch(method, params);
      }
      this.diagnose({ kind: "response", id, ok: true });
      this.send({ jsonrpc: "2.0", id, result: result ?? null });
      // login.completed 绝不先于对应 start 响应到达（rpc.md 3.4）
      if (method === "login.start" || method === "login.startDraft") {
        const loginId = (result as { loginId?: unknown } | null)?.loginId;
        if (typeof loginId === "string") this.logins.get(loginId)?.resolveStarted();
      }
      if (method === "shutdown") this.transport.close();
    } catch (error) {
      const err = this.redactSecrets(method, params, toRpcError(error));
      this.fail({ jsonrpc: "2.0", id, error: err });
    }
  }

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    if (!Object.hasOwn(this.handlers, method)) {
      throw new MethodNotFoundError(method);
    }
    const name = method as RpcMethodName;
    if (name !== "initialize" && name !== "shutdown") {
      // 管线化的客户端可能在 initialize 未返回时就发后续请求：等握手结束
      if (this.initPromise !== undefined) await this.initPromise.catch(() => undefined);
      if (!this.initialized) {
        throw new RpcProtocolError("not_initialized", "第一条请求必须是 initialize");
      }
      if (this.shuttingDown) throw new RpcProtocolError("shutting_down", "服务端正在关闭");
    }
    const handler = this.handlers[name] as (p: Params) => unknown;
    const result = handler(asParams(params));
    // EOF 可能发生在等待 initialize 时；刚开始的 Turn/压缩同样必须中断。
    if (this.inputEnded) {
      for (const entry of this.sessions.values()) entry.session.interrupt();
    }
    return await result;
  }

  // ── 生命周期 ─────────────────────────────────────────────

  /** 中断运行中的 Turn、关闭全部会话、释放 Runtime 资源；幂等 */
  private cleanup(): Promise<void> {
    this.cleanupPromise ??= (async () => {
      this.shuttingDown = true;
      this.abort.abort();
      // 握手与会话打开可能还在途中：等它们落定，新打开的会话在 register 里被直接关闭
      await this.initPromise?.catch(() => undefined);
      await Promise.allSettled([...this.opening]);
      // 进行中的登录先取消（关闭回环端口）；其 login.completed 仍照常推送
      for (const entry of this.logins.values()) {
        entry.resolveStarted();
        entry.session.cancel();
      }
      // 本连接的未提交草稿绑定其创建配置；丢弃只释放内存，不写盘也不消费登录
      for (const [draftId, record] of this.providerDrafts) {
        discardProvider(record.config, draftId);
      }
      this.providerDrafts.clear();
      // 完成未提交的草稿登录：丢弃暂存凭据
      for (const [loginId, config] of this.draftLogins) {
        discardDraftLogin(config, loginId);
      }
      this.draftLogins.clear();
      await this.configQueue.catch(() => undefined);
      const entries = [...this.sessions.values()];
      this.sessions.clear();
      for (const entry of entries) {
        entry.generation++;
        entry.unsubscribe?.();
        entry.session.interrupt();
      }
      await Promise.allSettled(entries.map((entry) => entry.session.close()));
      await this.handle?.dispose?.();
    })();
    return this.cleanupPromise;
  }

  private runtime(): Runtime {
    if (this.handle === undefined) {
      throw new RpcProtocolError("not_initialized", "第一条请求必须是 initialize");
    }
    return this.handle.runtime;
  }

  private providerConfig(): NonNullable<Connection["providerState"]> {
    if (this.providerState === undefined) {
      throw new RpcProtocolError("provider_config_unavailable", "服务端未提供服务商配置");
    }
    return this.providerState;
  }

  /**
   * 变更入队执行，随后 reload → updateProviders → 推 `runtime.providersChanged`
   * （docs/protocols/rpc.md 3.3）。变更抛错不重载、原样抛；重载抛错则请求
   * 以重载错误失败——此时写入已生效、Runtime 仍用旧配置。
   */
  private enqueueConfig<T>(task: (config: RuntimeConfig) => Promise<T>): Promise<T> {
    const run = this.configQueue.then(() => task(this.providerConfig().current));
    // 前一个任务失败不阻塞后续任务
    this.configQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async reloadProviders(): Promise<void> {
    const next = await this.providerConfig().reload();
    this.runtime().updateProviders(next);
    this.providerConfig().current = next;
    this.send({ jsonrpc: "2.0", method: "runtime.providersChanged", params: {} });
  }

  private mutateAndReload<T>(mutate: (config: RuntimeConfig) => Promise<T>): Promise<T> {
    return this.enqueueConfig(async (config) => {
      const result = await mutate(config);
      await this.reloadProviders();
      return result;
    });
  }

  // ── 登录会话 ─────────────────────────────────────────────

  private loginOptions(p: Params, unstored: LoginEntry["unstored"]): ProviderLoginOptions {
    const options: ProviderLoginOptions = {
      onUnstoredKey: (key, envName) => {
        unstored.value ??= { key, envName };
      },
    };
    const remote = optBool(p, "remote");
    if (remote !== undefined) options.remote = remote;
    const accountStorage = optString(p, "accountStorage");
    if (accountStorage !== undefined) {
      if (accountStorage !== "plaintext" && accountStorage !== "memory") {
        throw new InvalidParamsError(`accountStorage 必须是 "plaintext" 或 "memory"`);
      }
      options.accountStorage = accountStorage;
    }
    return options;
  }

  private loginStarted(loginId: string, session: LoginSession): LoginStarted {
    return {
      loginId,
      authorizeUrl: session.authorizeUrl,
      manualInput: session.manualInput,
      ...(session.userCode !== undefined ? { userCode: session.userCode } : {}),
    };
  }

  private registerLogin(
    loginId: string,
    kind: LoginEntry["kind"],
    config: RuntimeConfig,
    session: LoginSession,
    unstored: LoginEntry["unstored"],
  ): void {
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    this.logins.set(loginId, { session, kind, config, started, resolveStarted, unstored });
    void session.completion.then(
      (result) => this.finishLogin(loginId, result),
      (error: unknown) => this.finishLogin(loginId, undefined, error),
    );
  }

  /**
   * 登录完成：移出进行中表，先等对应 start 响应写出（顺序保证），
   * saved 成功时先串行重载（providersChanged），最后推 login.completed。
   */
  private async finishLogin(loginId: string, result?: LoginResult, error?: unknown): Promise<void> {
    const entry = this.logins.get(loginId);
    if (entry === undefined) return;
    this.logins.delete(loginId);
    if (result === undefined) this.draftLogins.delete(loginId);
    await entry.started;
    let warning: string | undefined;
    if (result !== undefined && entry.kind === "saved") {
      try {
        await this.enqueueConfig(() => this.reloadProviders());
      } catch (e) {
        // 凭据已写入但 Runtime 仍用旧配置：结果照常推，附重载失败提示
        warning = e instanceof Error ? e.message : String(e);
      }
    }
    const params: LoginCompleted = { loginId };
    if (result !== undefined) {
      params.result = {
        providerId: result.providerId,
        ...(result.account !== undefined ? { account: result.account } : {}),
      };
    } else {
      // ProviderLoginError 只有固定文案；其他异常不能把授权内容带给客户端（同 safeLoginError）
      params.error =
        error instanceof ProviderLoginError
          ? { code: error.code, message: error.message }
          : { code: "failed", message: "登录未完成，请重新登录" };
    }
    if (entry.unstored.value !== undefined) {
      params.unstoredKey = entry.unstored.value;
      entry.unstored.value = undefined;
    }
    if (warning !== undefined) params.warning = warning;
    this.send({ jsonrpc: "2.0", method: "login.completed", params });
  }

  /** 请求失败时把敏感参数值从错误文本中抹掉（SENSITIVE_METHODS） */
  private redactSecrets(method: string, params: unknown, error: RpcErrorObject): RpcErrorObject {
    const extract = SENSITIVE_METHODS[method as RpcMethodName];
    if (extract === undefined) return error;
    const p =
      typeof params === "object" && params !== null && !Array.isArray(params)
        ? (params as Params)
        : {};
    const secrets = extract(p).filter((secret) => secret !== "");
    if (secrets.length === 0) return error;
    const redact = (text: string): string =>
      secrets.reduce((out, secret) => out.split(secret).join("[redacted]"), text);
    const data =
      error.data === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(error.data).map(([key, value]) => [
              key,
              typeof value === "string" ? redact(value) : value,
            ]),
          );
    return {
      code: error.code,
      message: redact(error.message),
      ...(data !== undefined ? { data } : {}),
    };
  }

  private session(p: Params): OpenSession {
    const sessionId = reqString(p, "sessionId");
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) {
      throw new RpcProtocolError("unknown_session", `没有打开的会话：${sessionId}`);
    }
    return entry;
  }

  /** 登记一个新打开的会话；服务端已在关闭时直接关掉它 */
  private async register(session: RuntimeSession): Promise<SessionOpened> {
    if (this.shuttingDown) {
      await session.close().catch(() => undefined);
      throw new RpcProtocolError("shutting_down", "服务端正在关闭");
    }
    this.sessions.set(session.id, { session, unsubscribe: undefined, generation: 0 });
    const state = session.state();
    return {
      sessionId: session.id,
      meta: state.meta,
      config: state.config,
      warnings: [...session.warnings],
      ...(session.recovery !== undefined ? { recovery: session.recovery } : {}),
      lastSeq: state.lastSeq,
    };
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.opening.add(promise);
    const done = () => {
      this.opening.delete(promise);
    };
    promise.then(done, done);
    return promise;
  }

  // ── 订阅与回放 ───────────────────────────────────────────

  /**
   * 先挂监听并缓冲，再推 seq > afterSeq 的持久事件（分批，批间让出事件循环），
   * 之后按 seq 去重冲刷缓冲，再转实时（events.md 第 1 节、ADR-0044 第 5 节）。
   * 临时事件不回放，只有订阅之后发生的才会推。
   */
  private async subscribe(entry: OpenSession, afterSeq: number): Promise<number> {
    entry.unsubscribe?.();
    const generation = ++entry.generation;
    const sessionId = entry.session.id;
    const chunk = Math.max(1, this.options.replayChunkSize ?? DEFAULT_REPLAY_CHUNK);
    let lastSeq = afterSeq;
    let replaying = true;
    const buffer: RuntimeEvent[] = [];

    const push = (event: RuntimeEvent): void => {
      if (entry.generation !== generation) return;
      if ("seq" in event) {
        // 持久事件按 seq 去重：已在回放里推过的（含"已写日志、尚未分发给监听器"的）跳过
        if (event.seq <= lastSeq) return;
        lastSeq = event.seq;
      }
      this.send({ jsonrpc: "2.0", method: "event", params: { sessionId, event } });
    };

    entry.unsubscribe = entry.session.subscribe((event) => {
      if (replaying) buffer.push(event);
      else push(event);
    });

    const snapshot = entry.session.durableEvents().filter((event) => event.seq > afterSeq);
    for (let i = 0; i < snapshot.length; i += chunk) {
      if (entry.generation !== generation) return lastSeq;
      for (const event of snapshot.slice(i, i + chunk)) push(event);
      if (i + chunk < snapshot.length) {
        await (this.options.replayYield?.() ?? new Promise<void>((r) => setImmediate(r)));
      }
    }
    replaying = false;
    for (const event of buffer.splice(0)) push(event);
    return lastSeq;
  }

  // ── 方法表 ───────────────────────────────────────────────

  private buildHandlers(): HandlerTable {
    return {
      initialize: async (p) => {
        if (this.initPromise !== undefined) {
          throw new RpcProtocolError("already_initialized", "initialize 只能调用一次");
        }
        const version = reqInt(p, "protocolVersion");
        if (version !== RPC_PROTOCOL_VERSION) {
          throw new RpcProtocolError(
            "protocol_version_mismatch",
            `协议版本不一致：客户端 ${version}，服务端 ${RPC_PROTOCOL_VERSION}`,
          );
        }
        const clientName = reqString(p, "clientName");
        const interactive = optBool(reqObject(p, "capabilities"), "interactive") ?? false;
        const init = this.options
          .createRuntime({ clientName, interactive })
          .then((handle) => {
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
            this.initialized = true;
          })
          .catch((error: unknown) => {
            // 创建失败：允许客户端修正后重试
            this.initPromise = undefined;
            throw error;
          });
        this.initPromise = init;
        await init;
        return {
          protocolVersion: RPC_PROTOCOL_VERSION,
          nocturneVersion: this.options.nocturneVersion,
          ...(this.handle?.sessionsDir !== undefined
            ? { sessionsDir: this.handle.sessionsDir }
            : {}),
        };
      },
      shutdown: async () => {
        await this.cleanup();
        return null;
      },

      "runtime.listSessions": (p) => {
        const cwd = optString(p, "cwd");
        const includeSubagents = optBool(p, "includeSubagents");
        return this.runtime().listSessions({
          ...(cwd !== undefined ? { cwd } : {}),
          ...(includeSubagents !== undefined ? { includeSubagents } : {}),
        });
      },
      "runtime.createSession": (p) =>
        this.track(
          (async () => {
            const options: CreateSessionOptions = { model: reqModel(p, "model") };
            const preset = optString(p, "permissionPreset");
            if (preset !== undefined) options.permissionPreset = preset;
            const effort = optString(p, "reasoningEffort");
            if (effort !== undefined) {
              if (!isReasoningEffort(effort)) {
                throw new InvalidParamsError(`reasoningEffort 不是已知档位：${effort}`);
              }
              options.reasoningEffort = effort;
            }
            return await this.register(await this.runtime().createSession(options));
          })(),
        ),
      "runtime.resumeSession": (p) =>
        this.track(
          (async () => {
            const sessionId = reqString(p, "sessionId");
            if (this.sessions.has(sessionId)) {
              throw new RpcProtocolError(
                "session_already_open",
                `会话已在本连接中打开：${sessionId}`,
              );
            }
            const force = optBool(p, "force");
            const model =
              p.model === undefined || p.model === null ? undefined : reqModel(p, "model");
            const session = await this.runtime().resumeSession(sessionId, {
              ...(force !== undefined ? { force } : {}),
              ...(model !== undefined ? { model } : {}),
            });
            return await this.register(session);
          })(),
        ),
      "runtime.forkSession": async (p) => {
        const targetSeq = optInt(p, "targetSeq");
        const sessionId = await this.runtime().forkSession(reqString(p, "sessionId"), {
          ...(targetSeq !== undefined ? { targetSeq } : {}),
        });
        return { sessionId };
      },
      "runtime.listModels": () => this.runtime().listModels(),
      "runtime.defaultModel": () => this.runtime().defaultModel() ?? null,
      "runtime.listRecentModels": () => this.runtime().listRecentModels(),
      "runtime.describeSettings": () => this.runtime().describeSettings(),
      "runtime.updateSettings": (p) => {
        const reviewerKey = optString(p, "reviewerKey");
        return this.runtime().updateSettings(
          reqObject(p, "patch"),
          reviewerKey !== undefined ? { reviewerKey } : undefined,
        );
      },
      "runtime.setDefaultModel": (p) => {
        const effort = optString(p, "reasoningEffort");
        if (effort !== undefined && !isReasoningEffort(effort)) {
          throw new InvalidParamsError(`reasoningEffort 不是已知档位：${effort}`);
        }
        return this.runtime().setDefaultModel(reqString(p, "model"), effort ?? null);
      },
      "runtime.describeModelRoles": () => this.runtime().describeModelRoles(),
      "runtime.setModelRole": (p) => {
        const role = reqString(p, "role");
        if (!(MODEL_ROLES as readonly string[]).includes(role)) {
          throw new InvalidParamsError(`role 必须是 ${MODEL_ROLES.join("/")} 之一`);
        }
        return this.runtime().setModelRole(role as ModelRole, optString(p, "ref") ?? null);
      },
      "runtime.getPreference": (p) => this.runtime().getPreference(reqString(p, "key")) ?? null,
      "runtime.setPreference": async (p) => {
        await this.runtime().setPreference(reqString(p, "key"), optString(p, "value"));
        return null;
      },
      "runtime.listReviewerProviders": () => this.runtime().listReviewerProviders(),
      "runtime.defaultReviewer": (p) => {
        const baseURL = optString(p, "baseURL");
        return this.runtime().defaultReviewer(reqString(p, "endpoint") as JevEndpoint, baseURL);
      },
      "runtime.listReviewerModels": (p) =>
        this.runtime().listReviewerModels(
          reqObject(p, "reviewer") as unknown as JevReviewerConfig,
          this.abort.signal,
        ),

      // 服务商配置（rpc.md 3.3）：只读方法用最近一次重载出的配置对象；
      // Core 的预设/凭据判断不在此复制，RPC 层只做形状校验与转发。
      "provider.listProviderPresets": () => {
        this.providerConfig();
        return listProviderPresets();
      },
      "provider.describeProviders": async () => {
        const { current, workspaceRoot } = this.providerConfig();
        const providers = await current.describeProviders(workspaceRoot);
        const setupWarning = current.providerSetupWarning;
        return {
          providers,
          ...(setupWarning !== undefined ? { setupWarning } : {}),
        };
      },
      "provider.describeProviderSetup": (p) =>
        describeProviderSetup(this.providerConfig().current, reqString(p, "presetId")),
      "provider.describeAccountStorage": (p) => {
        const { current } = this.providerConfig();
        const providerId = reqString(p, "providerId");
        const entry = current.base.providers.find((item) => item.id === providerId);
        return describeAccountStorage(current, entry ?? {}) ?? null;
      },
      "provider.prepareProvider": async (p) => {
        const input = parsePrepareInput(p);
        // 引用本连接草稿登录时用该登录创建时的配置对象：Core 的暂存凭据
        // 按 RuntimeConfig 对象登记，重载出的新对象上找不到它
        let config = this.providerConfig().current;
        if (input.credential.kind === "login") {
          config = this.draftLogins.get(input.credential.loginId) ?? config;
        }
        const result = await prepareProvider(config, input, { signal: this.abort.signal });
        this.providerDrafts.set(result.draftId, {
          config,
          ...(input.credential.kind === "login" ? { loginId: input.credential.loginId } : {}),
        });
        return result;
      },
      "provider.commitProvider": async (p) => {
        const draftId = reqString(p, "draftId");
        const manualModelId = optString(p, "manualModelId");
        return await this.mutateAndReload(async () => {
          const record = this.providerDrafts.get(draftId);
          const config = record?.config ?? this.providerConfig().current;
          const result = await commitProvider(
            config,
            draftId,
            manualModelId !== undefined ? { manualModelId } : {},
          );
          // 只在保存成功后移除草稿记录（Core 侧草稿随之失效）；失败可重试
          this.providerDrafts.delete(draftId);
          if (record?.loginId !== undefined) this.draftLogins.delete(record.loginId);
          return result;
        });
      },
      "provider.discardProvider": (p) => {
        const draftId = reqString(p, "draftId");
        const record = this.providerDrafts.get(draftId);
        discardProvider(record?.config ?? this.providerConfig().current, draftId);
        this.providerDrafts.delete(draftId);
        return null;
      },
      "provider.setCredential": async (p) => {
        const providerId = reqString(p, "providerId");
        const key = reqString(p, "key");
        return await this.mutateAndReload(async (config) => {
          await config.setCredential(providerId, key);
          return null;
        });
      },
      "provider.listModelSettings": (p) => {
        const { current, workspaceRoot } = this.providerConfig();
        return current.listModelSettings(reqString(p, "providerId"), workspaceRoot);
      },
      "provider.saveModelSettings": async (p) => {
        const providerId = reqString(p, "providerId");
        const modelId = reqString(p, "modelId");
        const patch = reqObject(p, "patch");
        return await this.mutateAndReload(async (config) => {
          await config.saveModelSettings(
            providerId,
            modelId,
            patch,
            this.providerConfig().workspaceRoot,
          );
          return null;
        });
      },
      "provider.refreshUpstreamLimits": async (p) => {
        const providerId = reqString(p, "providerId");
        return await this.mutateAndReload(async (config) => ({
          warning: (await config.refreshUpstreamLimits(providerId)) ?? null,
        }));
      },
      "provider.refreshModelsDev": async () =>
        await this.mutateAndReload(async (config) => ({
          warning: (await config.refreshModelsDev()) ?? null,
        })),
      "provider.removeSetupProvider": async (p) => {
        const providerId = reqString(p, "providerId");
        return await this.mutateAndReload(async (config) => {
          // "正在使用拒绝删除"是客户端规则（同 CLI/TUI）；服务端持有会话，
          // 所以在服务端对本连接全部已打开会话判断——Core 不判断这条
          for (const entry of this.sessions.values()) {
            if (entry.session.state().config.model.provider === providerId) {
              throw new RpcProtocolError(
                "provider_in_use",
                `当前会话正在使用 ${providerId}，不能删除；先切换到其他服务商的模型`,
              );
            }
          }
          await config.removeSetupProvider(providerId);
          return null;
        });
      },
      "provider.logoutProvider": async (p) => {
        const providerId = reqString(p, "providerId");
        return await this.mutateAndReload(async (config) => {
          await logoutProvider(config, providerId);
          return null;
        });
      },

      // 登录会话（rpc.md 3.4）：start 返回句柄，完成经 login.completed 通知
      "login.start": async (p) => {
        const { current } = this.providerConfig();
        const unstored: LoginEntry["unstored"] = { value: undefined };
        const session = await startProviderLogin(
          current,
          reqString(p, "providerId"),
          this.loginOptions(p, unstored),
        );
        // 已保存服务商的 loginId 由服务端生成（rpc.md 3.4）
        const loginId = randomUUID();
        this.registerLogin(loginId, "saved", current, session, unstored);
        return this.loginStarted(loginId, session);
      },
      "login.startDraft": async (p) => {
        const { current } = this.providerConfig();
        const name = reqString(p, "name");
        const baseURL = optString(p, "baseURL");
        const unstored: LoginEntry["unstored"] = { value: undefined };
        const session = await startDraftProviderLogin(
          current,
          {
            presetId: reqString(p, "presetId"),
            name,
            ...(baseURL !== undefined ? { baseURL } : {}),
          },
          this.loginOptions(p, unstored),
        );
        // 草稿登录沿用 Core 分配的 loginId——暂存凭据按它登记
        const loginId = session.loginId;
        this.draftLogins.set(loginId, current);
        this.registerLogin(loginId, "draft", current, session, unstored);
        return this.loginStarted(loginId, session);
      },
      "login.submitManual": async (p) => {
        this.providerConfig();
        const entry = this.logins.get(reqString(p, "loginId"));
        if (entry === undefined) {
          throw new RpcProtocolError("unknown_login", "登录会话不存在或已结束");
        }
        await entry.session.submitManual(reqString(p, "text"));
        return null;
      },
      "login.cancel": (p) => {
        this.providerConfig();
        const loginId = reqString(p, "loginId");
        const entry = this.logins.get(loginId);
        if (entry !== undefined) {
          // 进行中：取消后照常推带 cancelled 错误的 login.completed
          entry.session.cancel();
          return null;
        }
        const draftConfig = this.draftLogins.get(loginId);
        if (draftConfig !== undefined) {
          // 已完成但未提交的草稿登录：丢弃暂存凭据，不推通知
          discardDraftLogin(draftConfig, loginId);
          this.draftLogins.delete(loginId);
          return null;
        }
        throw new RpcProtocolError("unknown_login", "登录会话不存在或已结束");
      },

      "session.subscribe": async (p) => {
        const entry = this.session(p);
        const lastSeq = await this.subscribe(entry, optInt(p, "afterSeq") ?? 0);
        return { lastSeq };
      },
      "session.unsubscribe": (p) => {
        const entry = this.session(p);
        entry.generation++;
        entry.unsubscribe?.();
        entry.unsubscribe = undefined;
        return null;
      },
      "session.submit": async (p) => {
        const { session } = this.session(p);
        const input: SubmitInput = {};
        const text = optString(p, "text");
        if (text !== undefined) input.text = text;
        if (p.content !== undefined && p.content !== null) {
          input.content = parseContent(p.content);
        }
        if (p.attachments !== undefined && p.attachments !== null) {
          input.attachments = parseAttachments(p.attachments);
        }
        return await session.submit(input);
      },
      "session.respondPermission": async (p) => {
        await this.session(p).session.respondPermission(
          reqString(p, "requestId"),
          reqObject(p, "reply") as unknown as PermissionReply,
        );
        return null;
      },
      "session.respondQuestion": async (p) => {
        await this.session(p).session.respondQuestion(
          reqString(p, "requestId"),
          reqObject(p, "reply") as unknown as QuestionReply,
        );
        return null;
      },
      "session.setModel": async (p) => {
        await this.session(p).session.setModel(reqModel(p, "model"));
        return null;
      },
      "session.setPermissionPreset": async (p) => {
        await this.session(p).session.setPermissionPreset(reqString(p, "name"));
        return null;
      },
      "session.setReasoningEffort": async (p) => {
        await this.session(p).session.setReasoningEffort(reqString(p, "level"));
        return null;
      },
      "session.setShell": async (p) => {
        await this.session(p).session.setShell(reqString(p, "kind"));
        return null;
      },
      "session.compact": async (p) => {
        await this.session(p).session.compact();
        return null;
      },
      "session.rewindTargets": (p) => this.session(p).session.rewindTargets(),
      "session.rewind": (p) => {
        const mode = reqString(p, "mode");
        return this.session(p).session.rewind(reqInt(p, "targetSeq"), mode as RewindMode);
      },
      "session.state": (p) => {
        const state = this.session(p).session.state();
        return {
          meta: state.meta,
          config: state.config,
          todos: state.todos,
          usage: state.usage,
          lastSeq: state.lastSeq,
          openTurn: state.openTurn,
        };
      },
      "session.describeContext": (p) => {
        const built = this.session(p).session.describeContext();
        return {
          report: built.report,
          overBudget: built.overBudget,
          mustCompact: built.mustCompact,
          ...(built.compaction !== undefined ? { compaction: built.compaction } : {}),
          ...(built.missingAttachments !== undefined
            ? { missingAttachments: built.missingAttachments }
            : {}),
        };
      },
      "session.reasoningEffortInfo": (p) => this.session(p).session.reasoningEffortInfo(),
      "session.shellInfo": (p) => this.session(p).session.shellInfo(),
      "session.listShells": (p) => this.session(p).session.listShells(),
      "session.visionInfo": (p) => this.session(p).session.visionInfo(),
      "session.mcpServers": (p) => this.session(p).session.mcpServers(),
      "session.fileIndex": (p) => this.session(p).session.fileIndex(),
      "session.readInputHistory": (p) => this.session(p).session.readInputHistory(),
      "session.recordInputHistory": async (p) => {
        await this.session(p).session.recordInputHistory(reqString(p, "text"));
        return null;
      },
      "session.close": async (p) => {
        const entry = this.session(p);
        this.sessions.delete(entry.session.id);
        entry.generation++;
        entry.unsubscribe?.();
        await entry.session.close();
        return null;
      },
    };
  }
}

/** provider.prepareProvider 的入参形状：presetId 必填，其余字段按 credential.kind 判别 */
function parsePrepareInput(p: Params): AddProviderInput {
  const input: AddProviderInput = {
    presetId: reqString(p, "presetId"),
    credential: parseCredential(p.credential),
  };
  const name = optString(p, "name");
  if (name !== undefined) input.name = name;
  const baseURL = optString(p, "baseURL");
  if (baseURL !== undefined) input.baseURL = baseURL;
  const sessionHeader = optString(p, "sessionHeader");
  if (sessionHeader !== undefined) input.sessionHeader = sessionHeader;
  return input;
}

function parseCredential(value: unknown): ProviderCredentialInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidParamsError("参数 credential 必须是对象");
  }
  const o = value as Params;
  switch (o.kind) {
    case "apiKey":
      return { kind: "apiKey", key: reqString(o, "key") };
    case "env":
      return { kind: "env", name: reqString(o, "name") };
    case "login":
      return { kind: "login", loginId: reqString(o, "loginId") };
    case "external-file":
      return { kind: "external-file" };
    default:
      throw new InvalidParamsError("credential.kind 必须是 apiKey/env/login/external-file 之一");
  }
}

function parseContent(value: unknown): ContentBlock[] {
  if (!Array.isArray(value)) throw new InvalidParamsError("content 必须是数组");
  for (const block of value) {
    if (
      typeof block !== "object" ||
      block === null ||
      typeof (block as { type?: unknown }).type !== "string"
    ) {
      throw new InvalidParamsError("content 的每一项必须是带 type 的对象");
    }
  }
  return value as ContentBlock[];
}

function parseAttachments(value: unknown): NonNullable<SubmitInput["attachments"]> {
  if (!Array.isArray(value)) throw new InvalidParamsError("attachments 必须是数组");
  return value.map((raw: unknown, i) => {
    const o = asParams(raw) as Partial<Record<keyof WireAttachment, unknown>>;
    if (typeof o.data !== "string") {
      throw new InvalidParamsError(`attachments[${i}].data 必须是 base64 字符串`);
    }
    if (typeof o.mimeType !== "string") {
      throw new InvalidParamsError(`attachments[${i}].mimeType 必须是字符串`);
    }
    if (o.label !== undefined && typeof o.label !== "string") {
      throw new InvalidParamsError(`attachments[${i}].label 必须是字符串`);
    }
    return {
      data: decodeBase64(o.data, `attachments[${i}].data`),
      mimeType: o.mimeType as WireAttachment["mimeType"],
      ...(o.label !== undefined ? { label: o.label } : {}),
    };
  });
}
