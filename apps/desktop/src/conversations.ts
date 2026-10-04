import {
  createSessionView,
  type ModelRef,
  type ReasoningEffort,
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

  private async attach(
    client: RpcClient,
    workspace: string,
    result: { session: RpcSession; opened: SessionOpened },
  ): Promise<OpenConversation> {
    const entry: OpenConversation = {
      client,
      workspace,
      session: result.session,
      view: createSessionView(),
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
        { view: entry.view },
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
      if (entry === undefined) {
        const client = await this.pool.ensure(workspace);
        try {
          entry = await this.attach(
            client,
            workspace,
            await client.runtime.resumeSession(id, { force }),
          );
        } catch (error) {
          await this.releaseIfUnused(workspace);
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

  async compact(): Promise<void> {
    const entry = this.selected;
    if (entry === undefined) throw new Error("请先打开会话");
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

  backendExited(key: string): void {
    for (const [id, entry] of this.opened) {
      if (projectKey(entry.workspace) !== key) continue;
      this.opened.delete(id);
      if (id === this.selectedId) this.selectedId = null;
    }
    this.changed();
  }

  private async closeIfIdle(entry: OpenConversation): Promise<void> {
    if (
      entry.session.id === this.selectedId ||
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
