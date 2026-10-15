import {
  createSessionView,
  type ModelRef,
  type ReasoningEffort,
  type RewindMode,
  type SessionView,
  type TurnChangeDiff,
  type TurnChanges,
} from "@nocturne/core/protocol";
import {
  trackSessionView,
  type RpcClient,
  type RpcSession,
  type SessionViewTracker,
} from "@nocturne/rpc/client";
import { conversationStatus } from "../conversations";
import type { SessionSummary, SessionStatus } from "../session-tree";

export interface PhoneSession {
  session: RpcSession;
  client: RpcClient;
  workspace: string;
  view: SessionView;
  tracker?: SessionViewTracker;
  dead: boolean;
  /** 每次视图折叠后回调（发送时等待 Turn 被接受） */
  readonly listeners: Set<() => void>;
  /** 本轮改动摘要（按用户消息 seq），Turn 结束与回退后刷新，同桌面 */
  turnChanges: Map<number, TurnChanges>;
  changeDiffs: Map<string, Promise<TurnChangeDiff>>;
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
  private tracked: Promise<void> = Promise.resolve();
  constructor(
    private readonly changed: () => void,
    /** 平台观察者（App 探针）：只给事件类型与序号，live=false 表示重连后的回放 */
    private readonly onEvent?: (
      sessionId: string,
      type: string,
      seq: number | undefined,
      live: boolean,
    ) => void,
  ) {}
  async connected(client: RpcClient): Promise<void> {
    this.client = client;
    const generation = ++this.generation;
    for (const [id, entry] of this.opened) {
      const result = await client.runtime.resumeSession(id);
      if (generation !== this.generation) return;
      await this.attach(client, result.session, entry.workspace, entry.view);
    }
    await this.refresh();
  }
  disconnected(): void {
    this.generation++;
    this.loaded = false;
    this.opening.clear();
    this.client = undefined;
    for (const entry of this.opened.values()) entry.dead = true;
    this.changed();
  }
  clear(): void {
    this.generation++;
    this.loaded = false;
    this.opening.clear();
    this.client = undefined;
    this.opened.clear();
    this.list = [];
    this.changed();
  }
  async refresh(): Promise<void> {
    const client = this.client;
    const generation = this.generation;
    if (!client) return;
    const list = await client.runtime.listSessions();
    if (generation !== this.generation) return;
    this.list = list.sort((a, b) => b.mtimeMs - a.mtimeMs);
    this.loaded = true;
    this.changed();
    this.tracked = this.track(list.filter((item) => item.locked));
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
  // 没有锁的会话不可能在运行，点开时再订阅；全部回放会让上百个会话的电脑迟迟连不上。
  // 锁只说明后台持有会话，不代表正在运行；在后台订阅同一视图判定准确状态，不阻塞连接。
  private async track(items: SessionSummary[]): Promise<void> {
    const generation = this.generation;
    for (const item of items) {
      if (generation !== this.generation) return;
      if (!this.opened.has(item.id)) await this.open(item.id).catch(() => undefined);
    }
  }
  private async attach(
    client: RpcClient,
    session: RpcSession,
    workspace: string,
    view = createSessionView(),
  ): Promise<PhoneSession> {
    const previous = this.opened.get(session.id);
    const listeners = previous?.listeners ?? new Set<() => void>();
    const entry: PhoneSession = {
      client,
      session,
      workspace,
      view,
      dead: false,
      listeners,
      turnChanges: previous?.turnChanges ?? new Map<number, TurnChanges>(),
      changeDiffs: new Map(),
    };
    this.opened.set(session.id, entry);
    // 订阅建立前到达的是回放，只在订阅完成后统一查一次改动
    let subscribed = false;
    entry.tracker = await trackSessionView(
      session,
      (_view, event) => {
        this.onEvent?.(session.id, event.type, "seq" in event ? event.seq : undefined, subscribed);
        for (const listener of entry.listeners) listener();
        this.changed();
        if (subscribed && event.type === "turn.completed") void this.refreshTurnChanges(entry);
      },
      {
        view,
        afterSeq: view.lastSeq,
      },
    );
    subscribed = true;
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
    const { session } = await client.runtime.resumeSession(id);
    const forked = await this.attach(client, session, entry.workspace);
    void this.refresh().catch(() => undefined);
    return forked;
  }
  async open(id: string): Promise<PhoneSession> {
    const old = this.opened.get(id);
    if (old && !old.dead) return old;
    const pending = this.opening.get(id);
    if (pending) return pending;
    const client = this.requireClient();
    const generation = this.generation;
    const item = this.list.find((s) => s.id === id);
    const run = (async () => {
      const { session } = await client.runtime.resumeSession(id);
      if (generation !== this.generation) throw new Error("电脑连接已切换");
      return this.attach(client, session, item?.cwd ?? "", old?.view);
    })();
    this.opening.set(id, run);
    try {
      return await run;
    } finally {
      if (this.opening.get(id) === run) this.opening.delete(id);
    }
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
    const { session } = await client.runtime.createSession({
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
    const entry = await this.attach(client, session, workspace);
    void this.refresh().catch(() => undefined);
    return entry;
  }
  private requireClient(): RpcClient {
    if (!this.client) throw new Error("电脑尚未连接，请稍后重试");
    return this.client;
  }
}
