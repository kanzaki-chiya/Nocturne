import {
  createSessionView,
  type ModelRef,
  type PendingInputsSnapshot,
  type ReasoningEffort,
  type RuntimeEvent,
  type RewindMode,
  type SessionView,
  type TurnChangeDiff,
  type TurnChanges,
} from "@nocturne/core/protocol";
import {
  trackSessionView,
  type RpcClient,
  type RpcSession,
  type SessionOpened,
  type SessionViewTracker,
} from "@nocturne/rpc/client";
import { conversationStatus } from "../conversations";
import type { SessionSummary, SessionStatus } from "../session-tree";

export interface PhoneSession {
  session: RpcSession;
  client: RpcClient;
  workspace: string;
  view: SessionView;
  /** 打开时的警告（`SessionOpened.warnings`）；对话页顶部显示 */
  warnings: string[];
  tracker?: SessionViewTracker;
  dead: boolean;
  /** `trackSessionView` 完成前为 true；控件和上下文圆环在此期间不随回放条目刷新。 */
  replaying?: boolean;
  /** 每次视图折叠后回调（发送时等待 Turn 被接受） */
  readonly listeners: Set<() => void>;
  /** 本轮改动摘要（按用户消息 seq），Turn 结束与回退后刷新，同桌面 */
  turnChanges: Map<number, TurnChanges>;
  changeDiffs: Map<string, Promise<TurnChangeDiff>>;
  /** 待发输入快照（ADR-0070）：运行中插话与排队，临时状态不写日志 */
  pendingInputs: PendingInputsSnapshot;
}
export interface PhoneCreateOptions {
  model?: ModelRef | undefined;
  reasoningEffort?: string;
  permissionPreset?: string;
}
export function phoneStatus(entry: PhoneSession): SessionStatus {
  return conversationStatus({ view: entry.view, busy: false });
}
/**
 * 发送一条消息：返回时 Turn 已被后台接受（视图出现新 Turn 或新用户条目，或 submit
 * 已结束），与桌面 Conversations.send 的接受判定相同；接受前被拒绝则抛出，
 * 输入框保留草稿。Turn 本身在后台继续，结束时调用 finished。
 */
export async function submitAccepted(
  entry: PhoneSession,
  input: Parameters<RpcSession["submit"]>[0],
  finished: (error: unknown) => void,
): Promise<void> {
  const baseline = entry.view.entries.length;
  const isAccepted = () =>
    entry.view.currentTurn !== undefined || entry.view.entries.length > baseline;
  let listener: (() => void) | undefined;
  const accepted = new Promise<void>((resolve) => {
    listener = () => {
      if (isAccepted()) resolve();
    };
    entry.listeners.add(listener);
  });
  const submission = entry.session.submit(input);
  try {
    await Promise.race([accepted, submission]);
  } finally {
    if (listener) entry.listeners.delete(listener);
  }
  submission.then(
    () => {
      finished(undefined);
    },
    (error: unknown) => {
      finished(error);
    },
  );
}
export class PhoneSessions {
  readonly opened = new Map<string, PhoneSession>();
  list: SessionSummary[] = [];
  /** 本次连接已拿到会话列表 */
  loaded = false;
  client: RpcClient | undefined;
  private generation = 0;
  private readonly opening = new Map<string, Promise<PhoneSession>>();
  private readonly turnStarts = new Map<string, number>();
  private selectedId: string | undefined;
  private readonly closing = new Map<string, Promise<void>>();

  setSelected(id: string | undefined): void {
    this.selectedId = id;
    for (const entry of this.opened.values()) {
      void this.closeIfIdle(entry).catch(() => undefined);
    }
  }

  private async closeIfIdle(entry: PhoneSession): Promise<void> {
    const id = entry.session.id;
    if (
      id === this.selectedId ||
      entry.dead ||
      entry.replaying ||
      phoneStatus(entry) !== "idle" ||
      // ADR-0070 §6：有待发输入的会话不随切走关掉，否则这些输入会无声丢失
      entry.pendingInputs.items.length > 0 ||
      this.opened.get(id) !== entry
    )
      return;
    const pending = this.closing.get(id);
    if (pending) return pending;
    const generation = this.generation;
    const run = (async () => {
      await entry.session.close();
      await entry.tracker?.stop();
      if (generation !== this.generation || this.opened.get(id) !== entry) return;
      this.opened.delete(id);
      this.turnStarts.delete(id);
      this.changed();
    })();
    this.closing.set(id, run);
    try {
      await run;
    } finally {
      if (this.closing.get(id) === run) this.closing.delete(id);
    }
  }
  private tracked: Promise<void> = Promise.resolve();
  /** 进行中的列表刷新：期间再来的刷新请求并入它的补拉，不并发调用 listSessions */
  private refreshing: { generation: number; requests: number; done: Promise<void> } | undefined;
  private unsubscribeChanged: (() => void) | undefined;
  constructor(
    private readonly changed: () => void,
    /** 平台观察者（App 探针）：只给事件类型与序号，live=false 表示重连后的回放 */
    private readonly onEvent?: (
      sessionId: string,
      type: string,
      seq: number | undefined,
      live: boolean,
      eventTime?: string,
    ) => void,
    private readonly onSessionEvent?: (
      sessionId: string,
      event: RuntimeEvent,
      live: boolean,
      entry: PhoneSession,
      turnStartedAt: number | undefined,
    ) => void,
  ) {}
  async connected(client: RpcClient): Promise<void> {
    this.client = client;
    const generation = ++this.generation;
    // 电脑上新建或分叉了会话：旧后台没有这条通知，退化为 App 回前台时刷新
    this.unsubscribeChanged?.();
    this.unsubscribeChanged = client.onNotification("runtime.sessionsChanged", () => {
      void this.refresh().catch(() => undefined);
    });
    // 只恢复连接开始时已有的会话：恢复期间通知带来的新会话由 track/open 打开，
    // 遍历活 Map 会把它们再 resume 一次（后台报 session_already_open）
    for (const [id, entry] of [...this.opened]) {
      if (generation !== this.generation) return;
      if (id !== this.selectedId && phoneStatus(entry) === "idle") {
        this.opened.delete(id);
        continue;
      }
      // 恢复期间用户已点开它：并入那次打开，不重复 resume
      const inFlight = this.opening.get(id);
      if (inFlight) {
        await inFlight.catch(() => undefined);
        continue;
      }
      if (this.opened.get(id) !== entry) continue;
      const run = this.resume(client, id, entry.workspace, entry.view, generation);
      this.opening.set(id, run);
      try {
        const restored = await run;
        await this.closeIfIdle(restored);
      } catch (error) {
        if (generation !== this.generation) return;
        throw error;
      } finally {
        if (this.opening.get(id) === run) this.opening.delete(id);
      }
    }
    await this.refresh();
  }
  disconnected(): void {
    this.generation++;
    this.stopListening();
    this.loaded = false;
    this.opening.clear();
    this.closing.clear();
    this.client = undefined;
    for (const entry of this.opened.values()) entry.dead = true;
    this.changed();
  }
  clear(): void {
    this.generation++;
    this.turnStarts.clear();
    this.selectedId = undefined;
    this.closing.clear();
    this.stopListening();
    this.loaded = false;
    this.opening.clear();
    this.closing.clear();
    this.client = undefined;
    this.opened.clear();
    this.list = [];
    this.changed();
  }
  private stopListening(): void {
    this.unsubscribeChanged?.();
    this.unsubscribeChanged = undefined;
    this.refreshing = undefined;
  }
  /**
   * 重新拉会话列表并订阅本后台打开的会话（旧后台按锁退回）。合并：正在刷新时再调用，等这次完成后
   * 补拉一次（多次请求合成一次），返回的 Promise 在补拉也完成后才落定。
   */
  refresh(): Promise<void> {
    const running = this.refreshing;
    if (running?.generation === this.generation) {
      running.requests++;
      return running.done;
    }
    const run = { generation: this.generation, requests: 1, done: Promise.resolve() };
    run.done = (async () => {
      try {
        let served: number;
        do {
          served = run.requests;
          await this.fetchList();
        } while (run.requests !== served && run.generation === this.generation);
      } finally {
        if (this.refreshing === run) this.refreshing = undefined;
      }
    })();
    this.refreshing = run;
    return run.done;
  }
  private async fetchList(): Promise<void> {
    const client = this.client;
    const generation = this.generation;
    if (!client) return;
    const list = await client.runtime.listSessions();
    if (generation !== this.generation) return;
    this.list = list.sort((a, b) => b.mtimeMs - a.mtimeMs);
    this.loaded = true;
    this.changed();
    const previous = this.tracked;
    this.tracked = Promise.all([
      previous,
      this.track(list.filter((item) => item.openHere ?? item.locked)),
    ]).then(() => undefined);
  }
  /**
   * 点开推送后要去的会话：推送无载荷，只能在连上后判断。等后台订阅完成，
   * 优先最近一个等待确认或回答的会话，没有就取最近有动静的会话（完成、出错类提醒）。
   */
  async attentionTarget(): Promise<string | undefined> {
    await this.tracked;
    const pending = this.list.find((item) => {
      const entry = this.opened.get(item.id);
      return (
        !!entry && !entry.dead && !!(entry.view.pendingPermission ?? entry.view.pendingQuestion)
      );
    });
    return (pending ?? this.list[0])?.id;
  }
  // 本后台已打开的会话才可能需要跟踪；旧后台缺 openHere 时按锁退回。
  // 订阅回放后再判空闲，避免保留手机自己的历史引用；后台跟踪不阻塞连接。
  private async track(items: SessionSummary[]): Promise<void> {
    const generation = this.generation;
    for (const item of items) {
      if (generation !== this.generation) return;
      if (this.opened.get(item.id)?.dead === false) continue;
      const closing = this.closing.get(item.id);
      if (closing) await closing.catch(() => undefined);
      if (generation !== this.generation) return;
      const entry = await this.open(item.id, false).catch(() => undefined);
      if (entry) await this.closeIfIdle(entry).catch(() => undefined);
    }
  }
  private async attach(
    client: RpcClient,
    result: { session: RpcSession; opened: SessionOpened },
    workspace: string,
    view = createSessionView(),
  ): Promise<PhoneSession> {
    const { session } = result;
    const previous = this.opened.get(session.id);
    const listeners = previous?.listeners ?? new Set<() => void>();
    const entry: PhoneSession = {
      client,
      session,
      workspace,
      view,
      warnings: result.opened.warnings,
      dead: false,
      replaying: true,
      listeners,
      turnChanges: previous?.turnChanges ?? new Map<number, TurnChanges>(),
      changeDiffs: new Map(),
      pendingInputs: { items: [], paused: false },
    };
    this.opened.set(session.id, entry);
    // 与桌面 conversations.ts 一致：订阅窗口期间的新持久事件按 event.time 判断。
    const subscribeStart = Date.now();
    let subscribed = false;
    entry.tracker = await trackSessionView(
      session,
      (_view, event) => {
        // 待发输入快照（ADR-0070）：临时事件，订阅后再取一次当前快照对齐
        if (event.type === "input.pending") entry.pendingInputs = event.payload;
        const at = Date.parse(event.time);
        const live = subscribed || !("seq" in event) || (!Number.isNaN(at) && at >= subscribeStart);
        if (event.type === "turn.started" && !Number.isNaN(at)) this.turnStarts.set(session.id, at);
        this.onEvent?.(
          session.id,
          event.type,
          "seq" in event ? event.seq : undefined,
          live,
          event.time,
        );
        this.onSessionEvent?.(session.id, event, live, entry, this.turnStarts.get(session.id));
        if (entry.replaying !== true) {
          for (const listener of entry.listeners) listener();
          this.changed();
        }
        if (live && event.type === "turn.completed") void this.refreshTurnChanges(entry);
        if (subscribed) void this.closeIfIdle(entry).catch(() => undefined);
      },
      {
        view,
        afterSeq: view.lastSeq,
      },
    );
    subscribed = true;
    entry.replaying = false;
    // 待发输入是临时状态，订阅后单独取一次快照（整份覆盖）。不挡打开：取回后
    // 再通知一次，晚到的快照必定晚于此前发出的 input.pending（服务端按请求时刻生成）
    void Promise.resolve()
      .then(() => session.pendingInputs())
      .then((snapshot) => {
        // 空列表与打开时的初值一致，不必再触发一次通知
        if (entry.dead || snapshot.items.length === 0) return;
        entry.pendingInputs = snapshot;
        for (const listener of entry.listeners) listener();
        this.changed();
      })
      .catch(() => undefined);
    for (const listener of entry.listeners) listener();
    this.changed();
    void this.refreshTurnChanges(entry);
    return entry;
  }
  /** 与桌面 Conversations.refreshTurnChanges 相同：Turn 进行中不查，查完视图已前进则丢弃 */
  async refreshTurnChanges(entry: PhoneSession): Promise<void> {
    if (entry.dead || entry.view.currentTurn !== undefined) return;
    const boundary = entry.view.lastSeq;
    try {
      const changes = await entry.session.turnChanges();
      if (this.opened.get(entry.session.id) !== entry || entry.view.lastSeq !== boundary) return;
      entry.turnChanges = new Map(changes.map((turn) => [turn.seq, turn]));
      entry.changeDiffs.clear();
    } catch {
      entry.turnChanges = new Map();
      entry.changeDiffs.clear();
    }
    this.changed();
  }
  turnChangeDiff(entry: PhoneSession, seq: number, path: string): Promise<TurnChangeDiff> {
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
  /** 回退到 targetSeq 之前（编辑重发、重发、只还原文件共用），完成后刷新改动 */
  async rewind(entry: PhoneSession, targetSeq: number, mode: RewindMode): Promise<void> {
    if (entry.dead) throw new Error("电脑尚未连接");
    if (phoneStatus(entry) !== "idle") throw new Error("会话正在运行");
    await entry.session.rewind(targetSeq, mode);
    await this.refreshTurnChanges(entry);
  }
  /**
   * 从 targetSeq 那条用户消息之前分叉（runtime.forkSession）：新会话复制日志并只回退
   * 对话，工作区文件不动。返回新会话 id，随即打开。
   */
  async fork(entry: PhoneSession, targetSeq: number): Promise<PhoneSession> {
    const client = this.requireClient();
    const id = await client.runtime.forkSession(entry.session.id, { targetSeq });
    await this.refresh().catch(() => undefined);
    const result = await client.runtime.resumeSession(id);
    this.setSelected(id);
    const forked = await this.attach(client, result, entry.workspace);
    void this.refresh().catch(() => undefined);
    return forked;
  }
  async open(id: string, select = true): Promise<PhoneSession> {
    if (select) this.setSelected(id);
    // 后台会把切走时空闲的会话关掉；打开与那次关闭可能交错，所以打开后再核对
    // 一次：句柄已被关掉就重新打开，别把已关闭的会话交给调用方（ADR-0070 前就存在）
    for (let attempt = 0; ; attempt += 1) {
      await this.closing.get(id);
      const old = this.opened.get(id);
      if (old && !old.dead) return old;
      const entry = await (this.opening.get(id) ?? this.beginOpen(id));
      await this.closing.get(id);
      if (!entry.dead && this.opened.get(id) === entry) {
        await this.closeIfIdle(entry);
        return entry;
      }
      if (attempt >= 1) return entry;
    }
  }
  private async beginOpen(id: string): Promise<PhoneSession> {
    const client = this.requireClient();
    const generation = this.generation;
    const item = this.list.find((s) => s.id === id);
    const run = this.resume(client, id, item?.cwd ?? "", this.opened.get(id)?.view, generation);
    this.opening.set(id, run);
    try {
      return await run;
    } finally {
      if (this.opening.get(id) === run) this.opening.delete(id);
    }
  }
  private async resume(
    client: RpcClient,
    id: string,
    workspace: string,
    view: SessionView | undefined,
    generation: number,
  ): Promise<PhoneSession> {
    const result = await client.runtime.resumeSession(id);
    if (generation !== this.generation) throw new Error("电脑连接已切换");
    return this.attach(client, result, workspace, view);
  }
  /**
   * 在 workspace 新建会话（与桌面草稿相同：未选过的档位与预设省略，由 Core 解析
   * 项目默认）。目录不存在或需要在电脑上信任时后台报错，原样抛给界面。
   */
  async create(workspace: string, options: PhoneCreateOptions = {}): Promise<PhoneSession> {
    const client = this.requireClient();
    const model =
      options.model ?? (await client.runtime.defaultModel({ workspaceRoot: workspace }));
    if (!model) throw new Error("电脑未设置默认模型，请在电脑上选择默认模型");
    const result = await client.runtime.createSession({
      model,
      cwd: workspace,
      workspaceRoot: workspace,
      ...(options.reasoningEffort !== undefined
        ? { reasoningEffort: options.reasoningEffort as ReasoningEffort }
        : {}),
      ...(options.permissionPreset !== undefined
        ? { permissionPreset: options.permissionPreset }
        : {}),
    });
    this.setSelected(result.session.id);
    const entry = await this.attach(client, result, workspace);
    void this.refresh().catch(() => undefined);
    return entry;
  }
  private requireClient(): RpcClient {
    if (!this.client) throw new Error("电脑尚未连接，请稍后重试");
    return this.client;
  }
}
