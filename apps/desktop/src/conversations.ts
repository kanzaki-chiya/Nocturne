import {
  createSessionView,
  type ModelRef,
  type ReasoningEffort,
  type RewindMode,
  type SessionView,
} from "@nocturne/core/protocol";
import {
  trackSessionView,
  type RpcClient,
  type RpcSession,
  type SessionOpened,
  type SessionViewTracker,
} from "@nocturne/rpc/client";

import type { ComposerSubmit } from "./Composer";
import { projectKey, type SessionStatus } from "./session-tree";

export interface ConversationBackendPool {
  ensure(workspace: string): Promise<RpcClient>;
  release(workspace: string): Promise<void>;
}

export interface OpenConversation {
  session: RpcSession;
  client: RpcClient;
  workspace: string;
  view: SessionView;
  warnings: string[];
  busy: boolean;
  tracker?: SessionViewTracker;
  /**
   * 所在后台已退出（崩溃或被强杀）：会话保留在 opened 里等「重启后台」恢复，
   * view 冻结在退出前的状态；session/client 句柄属于死进程，不能再用。
   * 恢复路径：resumeBackend 逐个 resumeSession 并以 view.lastSeq 续接订阅。
   */
  dead?: boolean;
  /** 每次视图折叠后回调（send 用来等待 Turn 被接受） */
  readonly listeners: Set<() => void>;
}

export function conversationStatus(entry: OpenConversation): SessionStatus {
  if (entry.view.pendingPermission !== undefined || entry.view.pendingQuestion !== undefined) {
    return "pending";
  }
  return entry.busy || entry.view.currentTurn !== undefined || entry.view.status !== "idle"
    ? "running"
    : "idle";
}

/** 非空闲（运行中或等待确认）的会话数；装更新前据此决定是否先确认 */
export function activeConversationCount(entries: Iterable<OpenConversation>): number {
  let count = 0;
  for (const entry of entries) if (conversationStatus(entry) !== "idle") count += 1;
  return count;
}

/** 会话切换串行；Turn 不占切换队列，后台中的其他会话仍可继续运行。 */
export interface CreateSessionChoice {
  /** 草稿选中的模型；undefined 时回落后台默认模型 */
  model?: ModelRef | string | undefined;
  reasoningEffort?: string;
  permissionPreset?: string;
}

export class Conversations {
  readonly opened = new Map<string, OpenConversation>();
  selectedId: string | null = null;
  draftWorkspace: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly pool: ConversationBackendPool,
    private readonly plainWorkspace: () => string | null,
    private readonly changed: () => void,
    private readonly failed: (error: unknown) => void,
  ) {}

  get selected(): OpenConversation | undefined {
    return this.selectedId === null ? undefined : this.opened.get(this.selectedId);
  }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(action);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /**
   * 把会话句柄接入 opened 并订阅视图。
   * continuity：后台重启后的续接——沿用崩溃前的 view（保持当前浏览位置），
   * 订阅从 view.lastSeq 之后回放，崩溃前写入但未送达的事件也会补上。
   */
  private async attach(
    client: RpcClient,
    workspace: string,
    result: { session: RpcSession; opened: SessionOpened },
    continuity?: { view: SessionView; afterSeq: number },
  ): Promise<OpenConversation> {
    const entry: OpenConversation = {
      client,
      workspace,
      session: result.session,
      view: continuity?.view ?? createSessionView(),
      warnings: result.opened.warnings,
      busy: false,
      listeners: new Set(),
    };
    this.opened.set(entry.session.id, entry);
    try {
      entry.tracker = await trackSessionView(
        entry.session,
        () => {
          for (const listener of entry.listeners) listener();
          this.changed();
          // 非当前会话完成后释放锁；submit/compact 的 promise 收束前仍保持 busy。
          void this.serial(() => this.closeIfIdle(entry)).catch(this.failed);
        },
        {
          view: entry.view,
          ...(continuity !== undefined ? { afterSeq: continuity.afterSeq } : {}),
        },
      );
      return entry;
    } catch (error) {
      this.opened.delete(entry.session.id);
      await entry.session.close();
      throw error;
    }
  }

  open(id: string, workspace: string, force = false): Promise<void> {
    return this.serial(async () => {
      let entry = this.opened.get(id);
      // 后台已退出的会话：点开即用原视图续接重开（ensure 会启动新后台）。
      // 失败时把死条目放回去，横幅里的「重启后台」仍可重试。
      const dead = entry?.dead === true ? entry : undefined;
      if (entry === undefined || dead !== undefined) {
        const target = dead?.workspace ?? workspace;
        const continuity =
          dead !== undefined ? { view: dead.view, afterSeq: dead.view.lastSeq } : undefined;
        const client = await this.pool.ensure(target);
        try {
          entry = await this.attach(
            client,
            target,
            await client.runtime.resumeSession(id, { force }),
            continuity,
          );
        } catch (error) {
          if (dead !== undefined) this.opened.set(id, dead);
          await this.releaseIfUnused(target);
          throw error;
        }
      }
      const previous = this.selected;
      this.selectedId = id;
      this.draftWorkspace = null;
      this.changed();
      if (previous !== undefined && previous !== entry) await this.closeIfIdle(previous);
    });
  }

  newConversation(workspace: string): Promise<void> {
    return this.serial(async () => {
      const previous = this.selected;
      this.selectedId = null;
      this.draftWorkspace = workspace;
      this.changed();
      if (previous !== undefined) await this.closeIfIdle(previous);
    });
  }

  /**
   * 发一条消息（可带图片附件）。仅第一条消息才创建会话日志；先标 busy，
   * 避免 submit 准备阶段被切换关掉。返回时 Turn 已被后台接受：持久视图
   * 出现新 Turn 或新用户条目、或 submit 响应到达，三者先到为准；
   * submit 在接受前拒绝则抛出（输入框保留草稿与附件）。草稿选项里只有
   * 显式选过的字段写进 createSession，其余交给 Core 解析项目默认。
   */
  async send(input: ComposerSubmit, create?: CreateSessionChoice): Promise<void> {
    const entry = await this.serial(async () => {
      let selected = this.selected;
      if (selected === undefined) {
        const workspace = this.draftWorkspace ?? this.plainWorkspace();
        if (workspace === null) throw new Error("普通对话工作区尚未就绪");
        const client = await this.pool.ensure(workspace);
        try {
          const model = create?.model ?? (await client.runtime.defaultModel());
          if (model === undefined)
            throw new Error("尚未配置默认模型，请先用 nctrn setup 配置服务商");
          selected = await this.attach(
            client,
            workspace,
            await client.runtime.createSession({
              model,
              ...(create?.reasoningEffort !== undefined
                ? { reasoningEffort: create.reasoningEffort as ReasoningEffort }
                : {}),
              ...(create?.permissionPreset !== undefined
                ? { permissionPreset: create.permissionPreset }
                : {}),
            }),
          );
        } catch (error) {
          await this.releaseIfUnused(workspace);
          throw error;
        }
      }
      if (selected.dead === true) throw new Error("会话所在的后台已退出，请先重启后台");
      if (conversationStatus(selected) !== "idle") throw new Error("会话正在运行");
      if (input.text !== "") await selected.session.recordInputHistory(input.text);
      selected.busy = true;
      this.changed();
      return selected;
    });

    const baseline = entry.view.entries.length;
    const isAccepted = () =>
      entry.view.currentTurn !== undefined || entry.view.entries.length > baseline;
    const accepted = new Promise<"accepted">((resolve) => {
      if (isAccepted()) {
        resolve("accepted");
        return;
      }
      const listener = () => {
        if (isAccepted()) {
          entry.listeners.delete(listener);
          resolve("accepted");
        }
      };
      entry.listeners.add(listener);
    });
    const submission = entry.session.submit({
      text: input.text,
      ...(input.skill ? { skill: input.skill } : {}),
      ...(input.delegate ? { delegate: input.delegate } : {}),
      attachments: input.attachments,
    });
    try {
      await Promise.race([accepted, submission.then(() => "finished" as const)]);
    } catch (error) {
      // submit 在接受前拒绝（如附件校验失败）：会话保持空闲，普通关闭路径清理
      entry.busy = false;
      this.changed();
      void this.serial(() => this.closeIfIdle(entry)).catch(this.failed);
      throw error;
    }
    // 接受后才选中并清空草稿工作区
    this.selectedId = entry.session.id;
    this.draftWorkspace = null;
    this.changed();
    // 接受后归还输入框控制；Turn 完成由订阅更新，切换不会等整轮输出。
    void submission.catch(this.failed).finally(() => {
      entry.busy = false;
      this.changed();
      void this.serial(() => this.closeIfIdle(entry)).catch(this.failed);
    });
  }

  /**
   * 重发/编辑重发（U-01）：先 rewind 回退到目标用户消息之前，再走普通 send
   * （接受/busy/历史记录逻辑一致）。rewind 拒绝时抛出——编辑框据此保留草稿；
   * rewind 成功后 submit 被拒同样抛出，但会话视图已被回退截断。
   * 附件、@文件 快照与技能/委派快照不复用：重发只带消息文本。
   */
  async resubmit(targetSeq: number, text: string, mode: RewindMode): Promise<void> {
    const entry = this.selected;
    if (entry === undefined) throw new Error("请先打开会话");
    if (entry.dead === true) throw new Error("会话所在的后台已退出，请先重启后台");
    if (conversationStatus(entry) !== "idle") throw new Error("会话正在运行");
    await entry.session.rewind(targetSeq, mode);
    await this.send({ text, attachments: [] });
  }

  async compact(): Promise<void> {
    const entry = this.selected;
    if (entry === undefined) throw new Error("请先打开会话");
    if (entry.dead === true) throw new Error("会话所在的后台已退出，请先重启后台");
    if (conversationStatus(entry) !== "idle") throw new Error("会话正在运行");
    entry.busy = true;
    this.changed();
    try {
      await entry.session.compact();
    } finally {
      entry.busy = false;
      this.changed();
      await this.serial(() => this.closeIfIdle(entry));
    }
  }

  interrupt(): void {
    this.selected?.session.interrupt();
  }

  /**
   * 后台退出：该后台上的会话标 dead（保留 id、view 与 lastSeq，即恢复所需的
   * 会话清单与断点），不删除、不改选中——视图冻结在原位等「重启后台」。
   */
  backendExited(key: string): void {
    for (const entry of this.opened.values()) {
      if (projectKey(entry.workspace) === key) entry.dead = true;
    }
    this.changed();
  }

  /**
   * 重启该工作区的后台并恢复其上标记 dead 的会话：先 resumeSession，
   * 再按崩溃前的 view.lastSeq 续接订阅（attach 的 continuity 路径）。
   * 会话逐个恢复，单个失败不阻塞其余；失败的保持 dead 并随结果返回 id 与原因。
   * 后台本身起不来时整个调用抛错（横幅据此显示重启失败）。
   */
  async resumeBackend(workspace: string): Promise<{ failed: { id: string; message: string }[] }> {
    return this.serial(async () => {
      const key = projectKey(workspace);
      const dead = [...this.opened.values()].filter(
        (entry) => entry.dead === true && projectKey(entry.workspace) === key,
      );
      const client = await this.pool.ensure(workspace);
      const failed: { id: string; message: string }[] = [];
      for (const entry of dead) {
        const id = entry.session.id;
        try {
          await this.attach(client, workspace, await client.runtime.resumeSession(id), {
            view: entry.view,
            afterSeq: entry.view.lastSeq,
          });
        } catch (error) {
          // attach 抛错时已删掉新条目：把死条目放回去，会话仍可再次尝试
          this.opened.set(id, entry);
          failed.push({ id, message: error instanceof Error ? error.message : String(error) });
        }
      }
      this.changed();
      return { failed };
    });
  }

  private async closeIfIdle(entry: OpenConversation): Promise<void> {
    if (
      entry.session.id === this.selectedId ||
      entry.dead === true ||
      conversationStatus(entry) !== "idle" ||
      this.opened.get(entry.session.id) !== entry
    )
      return;
    // 关闭成功后才从集合移除，失败时仍保留可观察的锁与后台。
    await entry.tracker?.stop();
    await entry.session.close();
    this.opened.delete(entry.session.id);
    this.changed();
    await this.releaseIfUnused(entry.workspace);
  }

  private async releaseIfUnused(workspace: string): Promise<void> {
    const key = projectKey(workspace);
    const plain = this.plainWorkspace();
    if (plain !== null && key === projectKey(plain)) return;
    if ([...this.opened.values()].some((entry) => projectKey(entry.workspace) === key)) return;
    await this.pool.release(workspace);
  }
}
