import {
  createSessionView,
  type ModelRef,
  type ReasoningEffort,
  type RewindMode,
  type SessionView,
  type TurnChanges,
  type TurnChangeDiff,
} from "@nocturne/core/protocol";
import {
  RpcError,
  trackSessionView,
  type RpcClient,
  type RpcSession,
  type SessionOpened,
  type SessionViewTracker,
} from "@nocturne/rpc/client";

import type { ComposerSubmit } from "./Composer";
import type { SessionStatus } from "./session-tree";

/**
 * 单后台（ADR-0051）：整个窗口共用一个 nctrn 后台。池子自行取普通对话
 * 工作区作为后台 cwd；会话的工作区随会话参数走。
 */
export interface ConversationBackendPool {
  ensure(): Promise<RpcClient>;
  get(): RpcClient | undefined;
}

export interface OpenConversation {
  session: RpcSession;
  client: RpcClient;
  workspace: string;
  view: SessionView;
  warnings: string[];
  busy: boolean;
  turnChanges: Map<number, TurnChanges>;
  changeDiffs: Map<string, Promise<TurnChangeDiff>>;
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

/**
 * 打开失败的记录。code 取 RPC 错误的 data.code（RpcError.code），界面按它
 * 分支，不匹配文案：invalid_model 进「换模型」卡片，其余是「打开会话失败 + 重试」。
 * model 是这次打开携带的替代模型（换模型后仍失败时卡片沿用这个选择）。
 */
export interface OpenError {
  message: string;
  workspace: string;
  code?: string;
  model?: ModelRef | string;
}

function openError(error: unknown, workspace: string, model?: ModelRef | string): OpenError {
  return {
    message: error instanceof Error ? error.message : String(error),
    workspace,
    ...(error instanceof RpcError ? { code: error.code } : {}),
    ...(model !== undefined ? { model } : {}),
  };
}

export class Conversations {
  readonly opened = new Map<string, OpenConversation>();
  selectedId: string | null = null;
  draftWorkspace: string | null = null;
  /**
   * 正在执行「打开」的会话 id：界面据此显示「正在打开…」占位。
   * 只有最后一次点击的目标保留这个标记（open 的 token 守卫）。
   */
  openingId: string | null = null;
  /**
   * 最近一次打开失败按会话记录（消息、工作区与错误码）：该会话的占位区
   * 按错误码显示「换模型」卡片或错误与「重试」，不退回上一个会话。
   */
  readonly openErrors = new Map<string, OpenError>();
  private queue: Promise<unknown> = Promise.resolve();
  /** 每次 open 递增；被更新的点击取代的打开在串行队列里直接跳过 */
  private openToken = 0;

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
      turnChanges: new Map(),
      changeDiffs: new Map(),
      listeners: new Set(),
    };
    this.opened.set(entry.session.id, entry);
    let replaying = true;
    try {
      entry.tracker = await trackSessionView(
        entry.session,
        (_view, event) => {
          for (const listener of entry.listeners) listener();
          this.changed();
          if (!replaying && event.type === "turn.completed") void this.refreshTurnChanges(entry);
          // 非当前会话完成后释放锁；submit/compact 的 promise 收束前仍保持 busy。
          void this.serial(() => this.closeIfIdle(entry)).catch(this.failed);
        },
        {
          view: entry.view,
          ...(continuity !== undefined ? { afterSeq: continuity.afterSeq } : {}),
        },
      );
      replaying = false;
      await this.refreshTurnChanges(entry);
      return entry;
    } catch (error) {
      this.opened.delete(entry.session.id);
      await entry.session.close();
      throw error;
    }
  }

  private async refreshTurnChanges(entry: OpenConversation): Promise<void> {
    if (entry.dead === true || entry.view.currentTurn !== undefined) return;
    const boundary = entry.view.lastSeq;
    try {
      const changes = await entry.session.turnChanges();
      if (
        this.opened.get(entry.session.id) !== entry ||
        conversationStatus(entry) === "pending" ||
        entry.view.lastSeq !== boundary
      )
        return;
      const next = new Map(changes.map((turn) => [turn.seq, turn]));
      for (const [seq, turn] of entry.turnChanges) {
        for (const file of turn.files) {
          const updated = next.get(seq)?.files.find((f) => f.path === file.path);
          if (
            !updated ||
            JSON.stringify([file.added, file.removed, file.approximate, file.unavailable]) !==
              JSON.stringify([
                updated.added,
                updated.removed,
                updated.approximate,
                updated.unavailable,
              ])
          )
            entry.changeDiffs.delete(JSON.stringify([seq, file.path]));
        }
      }
      entry.turnChanges = next;
    } catch (error) {
      entry.turnChanges = new Map();
      entry.changeDiffs.clear();
      console.warn("[turnChanges] 查询失败", error);
    }
    this.changed();
  }

  turnChangeDiff(entry: OpenConversation, seq: number, path: string): Promise<TurnChangeDiff> {
    const key = JSON.stringify([seq, path]);
    let pending = entry.changeDiffs.get(key);
    if (!pending) {
      pending = entry.session.turnChangeDiff(seq, path);
      entry.changeDiffs.set(key, pending);
      void pending.catch(() => {
        if (entry.changeDiffs.get(key) === pending) entry.changeDiffs.delete(key);
      });
    }
    return pending;
  }

  /**
   * 选中并打开会话（ADR-0051）：选中立即生效，占位区显示「正在打开…」，
   * 会话就绪后内容替换占位。失败写 openErrors[id]，界面在该会话内显示
   * 错误与「重试」，不回退选中项。连续快速点击时 token 让被取代的打开
   * 在串行队列里跳过，先发出的请求晚返回不会覆盖界面。
   * model：会话记录的模型已无法解析（invalid_model）时携带的替代模型，原样
   * 交给 resumeSession，由 Core 先写 config_changed 再开放（sessions.md 4.2）。
   */
  open(id: string, workspace: string, force = false, model?: ModelRef | string): Promise<void> {
    const token = ++this.openToken;
    const previous = this.selected;
    this.selectedId = id;
    this.draftWorkspace = null;
    this.openingId = id;
    this.openErrors.delete(id);
    this.changed();
    if (previous !== undefined && previous.session.id !== id) {
      void this.serial(() => this.closeIfIdle(previous)).catch(this.failed);
    }
    return this.serial(async () => {
      // 已被更新的点击取代且会话还没接上：这个请求的结果无人等待，跳过
      if (token !== this.openToken && this.opened.get(id) === undefined) return;
      const dead0 = this.opened.get(id);
      const dead = dead0?.dead === true ? dead0 : undefined;
      const target = dead?.workspace ?? workspace;
      try {
        let entry = dead0;
        if (entry === undefined || dead !== undefined) {
          const continuity =
            dead !== undefined ? { view: dead.view, afterSeq: dead.view.lastSeq } : undefined;
          const client = await this.pool.ensure();
          entry = await this.attach(
            client,
            target,
            await client.runtime.resumeSession(id, {
              force,
              ...(model !== undefined ? { model } : {}),
            }),
            continuity,
          );
        }
        this.openErrors.delete(id);
        // 打开期间被更新的点击取代：接上的会话不再被选中，按空闲路径关掉不留锁
        if (entry.session.id !== this.selectedId) {
          await this.closeIfIdle(entry);
        }
      } catch (error) {
        // attach 抛错时已删掉半成品条目：死会话放回原位，横幅仍可重试
        if (dead !== undefined && this.opened.get(id) === undefined) {
          this.opened.set(id, dead);
        }
        this.openErrors.set(id, openError(error, target, model));
        throw error;
      } finally {
        if (this.openingId === id) this.openingId = null;
        this.changed();
      }
    });
  }

  newConversation(workspace: string): Promise<void> {
    return this.serial(async () => {
      const previous = this.selected;
      this.selectedId = null;
      this.openingId = null;
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
        // 选中会话打开失败时不要把消息落到新建的草稿会话上
        const failedOpen =
          this.selectedId !== null ? this.openErrors.get(this.selectedId) : undefined;
        if (failedOpen !== undefined) throw new Error(failedOpen.message);
        const workspace = this.draftWorkspace ?? this.plainWorkspace();
        if (workspace === null) throw new Error("普通对话工作区尚未就绪");
        const client = await this.pool.ensure();
        const model =
          create?.model ?? (await client.runtime.defaultModel({ workspaceRoot: workspace }));
        if (model === undefined) throw new Error("尚未配置默认模型，请先用 nctrn setup 配置服务商");
        selected = await this.attach(
          client,
          workspace,
          await client.runtime.createSession({
            // 会话的工作区随会话走（ADR-0051）：后台只有一个，项目会话
            // 用自己的目录做 cwd 与工作区根
            cwd: workspace,
            workspaceRoot: workspace,
            model,
            ...(create?.reasoningEffort !== undefined
              ? { reasoningEffort: create.reasoningEffort as ReasoningEffort }
              : {}),
            ...(create?.permissionPreset !== undefined
              ? { permissionPreset: create.permissionPreset }
              : {}),
          }),
        );
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
    await this.rewindEntry(entry, targetSeq, mode);
    await this.send({ text, attachments: [] });
  }

  /** Files-only rewind shares the serialized busy boundary, never the submit path. */
  rewindFiles(targetSeq: number): Promise<void> {
    const entry = this.selected;
    if (entry === undefined) return Promise.reject(new Error("请先打开会话"));
    return this.rewindEntry(entry, targetSeq, "files");
  }

  private rewindEntry(entry: OpenConversation, targetSeq: number, mode: RewindMode): Promise<void> {
    return this.serial(async () => {
      if (entry.dead === true) throw new Error("会话所在的后台已退出，请先重启后台");
      if (conversationStatus(entry) !== "idle") throw new Error("会话正在运行");
      entry.busy = true;
      this.changed();
      try {
        await entry.session.rewind(targetSeq, mode);
        await this.refreshTurnChanges(entry);
      } finally {
        entry.busy = false;
        this.changed();
      }
    });
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
   * 后台退出：全部会话标 dead（保留 id、view 与 lastSeq，即恢复所需的
   * 会话清单与断点），不删除、不改选中——视图冻结在原位等「重启后台」。
   * 单后台只有一个进程，退出影响所有会话（ADR-0051）。
   */
  backendExited(): void {
    for (const entry of this.opened.values()) entry.dead = true;
    this.openingId = null;
    this.changed();
  }

  /**
   * 重启后台并恢复全部标记 dead 的会话（跨项目也在同一个后台恢复，
   * 各会话的工作区由日志元数据携带）：先 resumeSession，再按崩溃前的
   * view.lastSeq 续接订阅（attach 的 continuity 路径）。会话逐个恢复，
   * 单个失败不阻塞其余；失败的保持 dead 并随结果返回 id、原因与错误码。
   * 模型已不可用（invalid_model）的会话另记进 openErrors，点开即是「换模型」
   * 卡片；其余失败点开时照常重试恢复。
   * 后台本身起不来时整个调用抛错（横幅据此显示重启失败）。
   */
  async resumeBackend(): Promise<{ failed: { id: string; message: string; code?: string }[] }> {
    return this.serial(async () => {
      const dead = [...this.opened.values()].filter((entry) => entry.dead === true);
      const client = await this.pool.ensure();
      const failed: { id: string; message: string; code?: string }[] = [];
      for (const entry of dead) {
        const id = entry.session.id;
        try {
          await this.attach(client, entry.workspace, await client.runtime.resumeSession(id), {
            view: entry.view,
            afterSeq: entry.view.lastSeq,
          });
        } catch (error) {
          // attach 抛错时已删掉新条目：把死条目放回去，会话仍可再次尝试
          this.opened.set(id, entry);
          const record = openError(error, entry.workspace);
          if (record.code === "invalid_model") this.openErrors.set(id, record);
          failed.push({
            id,
            message: record.message,
            ...(record.code !== undefined ? { code: record.code } : {}),
          });
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
    // 关闭成功后才从集合移除，失败时仍保留可观察的锁。
    // 单后台常驻，不随会话关闭而退出（ADR-0051）。
    await entry.tracker?.stop();
    await entry.session.close();
    this.opened.delete(entry.session.id);
    this.changed();
  }
}
