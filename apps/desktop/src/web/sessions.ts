import {
  allPendingPermissions,
  createSessionView,
  reduceSessionView,
  type ModelRef,
  type PendingInputsSnapshot,
  type ReasoningEffort,
  type RuntimeEvent,
  type RewindMode,
  type SessionReadSnapshot,
  type SessionView,
  type SuiteRecord,
  type TurnChangeDiff,
  type TurnChanges,
} from "@nocturne/core/protocol";
import {
  RpcError,
  trackSessionView,
  type RpcClient,
  type RpcSession,
  type SessionOpened,
  type SessionViewTracker,
} from "@nocturne/rpc/client";
import type { ComposerSubmit } from "../Composer";
import { conversationStatus } from "../conversations";
import {
  acceptOutgoing,
  bindPending,
  draftTextOf,
  dropOutgoing,
  emptyOutgoing,
  nextLocalId,
  pushOutgoing,
  reconcileOutgoing,
  retargetOutgoing,
  submitBody,
  userSeqs,
  type LocalOutgoing,
  type OutgoingBook,
} from "../outgoing";
import { syncShellSnapshot } from "../shell-snapshot";
import { forkDraftText } from "../fork-session";
import { activityMs, type SessionSummary, type SessionStatus } from "../session-tree";
import type { ObservedPhoneSession } from "./platform";

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
  /** 点发送后、正式条目到达前的本地消息 */
  outgoing: OutgoingBook;
  /** 本地发送尚未被 Core 接受 */
  busy: boolean;
  /** Ensemble / 组曲线程子会话句柄（经 `session.open` 打开，退出页面即 `session.close` 释放，不中断子会话） */
  member?: boolean;
  /** 组曲指挥会话对应的组曲 id（重连时经 `openSuite` 恢复） */
  suiteId?: string;
  /**
   * 只读快照观察态（ADR-0099）：通过 `session.observe` 免唤醒打开，服务端尚未 resume/取锁。
   * 需要交互（发送、批准、回答等）或服务端变为 `openHere` 时经 `ensureLive` 按 `afterSeq` 无损升级。
   */
  observed?: boolean;
}

function isObserveUnsupportedError(error: unknown): boolean {
  return (
    error instanceof RpcError && (error.code === "method_not_found" || error.rpcCode === -32601)
  );
}

interface ObservedSessionHandle {
  session: RpcSession;
  attachLive(live: RpcSession): void;
  live(): RpcSession | undefined;
}

/**
 * 为只读观察态会话构造稳定的 `RpcSession` 包装器（ADR-0099）：
 * - `readAttachment` 在只读态走 `runtime.readSessionAttachment`，不唤醒会话、不取锁；
 * - `onEvent` 直接挂到 `client.onEvent` 按 `sessionId` 过滤，同步返回取消函数且不唤醒会话；
 * - `close` / `interrupt` 在只读态为空操作；
 * - 其他任何会话方法首次调用时先 `ensureLive()` 按 `afterSeq` 无损升级，再透传给真实句柄；
 * - 升级前后 `session` 对象引用不变，避免控件和面板状态重置。
 */
function createObservedSession(
  id: string,
  client: RpcClient,
  ensureLive: () => Promise<RpcSession>,
): ObservedSessionHandle {
  let live: RpcSession | undefined;
  const template = client.session(id) as unknown as Record<string, unknown>;
  const wrapper: Record<string, unknown> = { id };
  for (const key of Object.keys(template)) {
    if (key === "id") continue;
    if (key === "readAttachment") {
      wrapper[key] = (file: string) =>
        live !== undefined
          ? live.readAttachment(file)
          : client.runtime.readSessionAttachment({ sessionId: id, file });
      continue;
    }
    if (key === "onEvent") {
      wrapper[key] = (listener: (event: RuntimeEvent) => void) =>
        client.onEvent((eventSessionId, event) => {
          if (eventSessionId === id) listener(event);
        });
      continue;
    }
    if (key === "close") {
      wrapper[key] = () => (live !== undefined ? live.close() : Promise.resolve());
      continue;
    }
    if (key === "interrupt") {
      wrapper[key] = () => {
        live?.interrupt();
      };
      continue;
    }
    if (typeof template[key] === "function") {
      const invoke = (target: RpcSession, args: unknown[]) => {
        const fn = (target as unknown as Record<string, unknown>)[key];
        if (typeof fn !== "function") {
          throw new Error(`会话不支持方法：${key}`);
        }
        return (fn as (...a: unknown[]) => unknown).apply(target, args);
      };
      wrapper[key] = (...args: unknown[]) => {
        if (live !== undefined) {
          return invoke(live, args);
        }
        return ensureLive().then((real) => invoke(real, args));
      };
    }
  }
  return {
    session: wrapper as unknown as RpcSession,
    attachLive(real) {
      live = real;
    },
    live: () => live,
  };
}

function hasActiveSuiteThreads(entry: PhoneSession): boolean {
  return (
    entry.view.suite?.threads.some(
      (t) => t.status === "working" || t.pendingPermissions.length > 0 || t.hasPendingQuestion,
    ) ?? false
  );
}
export interface PhoneCreateOptions {
  model?: ModelRef | undefined;
  reasoningEffort?: string;
  permissionPreset?: string;
}
export function phoneStatus(entry: PhoneSession): SessionStatus {
  return conversationStatus({ view: entry.view, busy: entry.busy });
}

export function trackPhoneOutgoing(
  entry: PhoneSession,
  input: ComposerSubmit,
  place: "turn" | "pending",
  mode: "steer" | "queue",
): LocalOutgoing {
  const local: LocalOutgoing = {
    id: nextLocalId(),
    place,
    mode,
    draftText: draftTextOf(input),
    input,
    sentAt: new Date().toISOString(),
    excludeUserSeqs: userSeqs(entry.view.entries),
    excludePendingIds: entry.pendingInputs.items.map((item) => item.id),
  };
  entry.outgoing = reconcileOutgoing(
    pushOutgoing(entry.outgoing, local),
    entry.view.entries,
    entry.pendingInputs,
  );
  return local;
}

export function failPhoneOutgoing(entry: PhoneSession, id: string): void {
  entry.outgoing = dropOutgoing(entry.outgoing, id);
}

/** 交给 Core 的手机输入：没有附件时不带 attachments 字段（与改动前的线上形状一致） */
export function phoneSubmitBody(input: ComposerSubmit): Parameters<RpcSession["submit"]>[0] {
  const { attachments, ...rest } = submitBody(input);
  return attachments.length > 0 ? { ...rest, attachments } : rest;
}

/** Core 已接受：之后新出现的第一条用户条目就归这次发送，不再比正文 */
export function acceptPhoneOutgoing(entry: PhoneSession, id: string): void {
  entry.outgoing = reconcileOutgoing(
    acceptOutgoing(entry.outgoing, id),
    entry.view.entries,
    entry.pendingInputs,
  );
}

/** `enqueueInput` 返回了 id：本地行交给快照（或已被取走），不再按正文去找 */
export function bindPhoneOutgoing(entry: PhoneSession, id: string, pendingId: string): void {
  entry.outgoing = bindPending(entry.outgoing, id, pendingId);
}

export function retargetPhoneOutgoing(entry: PhoneSession, id: string): void {
  entry.outgoing = reconcileOutgoing(
    retargetOutgoing(entry.outgoing, id, "turn"),
    entry.view.entries,
    entry.pendingInputs,
  );
}

function syncPhoneOutgoing(entry: PhoneSession): void {
  entry.outgoing = reconcileOutgoing(entry.outgoing, entry.view.entries, entry.pendingInputs);
}

/**
 * 发送一条消息：返回时 Turn 已被后台接受。接受前被拒绝则抛出。
 * 监听在注册后再查一次，避免更新落在检查和注册之间时永远等不到。
 * 接受之后 Turn 自己的失败交给 finished，不算拒收。
 */
export async function submitAccepted(
  entry: PhoneSession,
  input: Parameters<RpcSession["submit"]>[0],
  finished: (error: unknown) => void,
  /** 这次发送的本地消息：接受后按位置对上正式条目，submit 落定时一律收掉 */
  localId?: string,
): Promise<void> {
  const baseline = entry.view.entries.length;
  const isAccepted = () =>
    entry.view.currentTurn !== undefined || entry.view.entries.length > baseline;
  let listener: (() => void) | undefined;
  let settled = false;
  const accepted = new Promise<void>((resolve) => {
    const finish = () => {
      if (settled || !isAccepted()) return;
      settled = true;
      resolve();
    };
    listener = finish;
    entry.listeners.add(finish);
    finish();
  });
  const submission = entry.session.submit(input);
  try {
    await new Promise<void>((resolve, reject) => {
      void accepted.then(resolve);
      submission.then(
        () => {
          resolve();
        },
        (error: unknown) => {
          if (isAccepted() || settled) resolve();
          else reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  } finally {
    if (listener) entry.listeners.delete(listener);
  }
  if (localId !== undefined) acceptPhoneOutgoing(entry, localId);
  const settle = () => {
    if (localId !== undefined) failPhoneOutgoing(entry, localId);
  };
  submission.then(
    () => {
      settle();
      finished(undefined);
    },
    (error: unknown) => {
      settle();
      finished(error);
    },
  );
}
export class PhoneSessions {
  readonly opened = new Map<string, PhoneSession>();
  /** 分叉出的会话 id → 待填进输入框的原消息（内存里，会话页取用后删除） */
  readonly forkDrafts = new Map<string, string>();
  list: SessionSummary[] = [];
  /** 本次连接已拿到会话列表 */
  loaded = false;
  client: RpcClient | undefined;
  private generation = 0;
  private readonly opening = new Map<string, Promise<PhoneSession>>();
  private readonly upgrading = new Map<string, Promise<PhoneSession>>();
  private readonly observedHandles = new Map<PhoneSession, ObservedSessionHandle>();
  private readonly turnStarts = new Map<string, number>();
  private observeUnsupported = false;
  private selectedId: string | undefined;
  private pinnedId: string | undefined;
  private readonly closing = new Map<string, Promise<void>>();

  setSelected(id: string | undefined, pinnedId?: string): void {
    this.selectedId = id;
    this.pinnedId = pinnedId;
    for (const entry of this.opened.values()) {
      void this.closeIfIdle(entry).catch(() => undefined);
    }
  }

  /**
   * 导出当前已打开且已就绪的会话状态快照，供平台观察者（如安卓常驻通知）直接复用，
   * 不再在平台侧维护并行 SessionView。
   */
  observedSessions(): ObservedPhoneSession[] {
    const list: ObservedPhoneSession[] = [];
    for (const [id, entry] of this.opened) {
      if (entry.dead || entry.replaying === true) continue;
      const summary = this.list.find((item) => item.id === id);
      const title = entry.view.title;
      const firstText = summary?.firstText ?? entry.view.firstTitle;
      list.push({
        id,
        status: phoneStatus(entry),
        ...(title !== undefined ? { title } : {}),
        ...(firstText !== undefined ? { firstText } : {}),
      });
    }
    return list;
  }

  private async closeIfIdle(entry: PhoneSession): Promise<void> {
    const id = entry.session.id;
    if (entry.observed === true) {
      if (
        id === this.selectedId ||
        id === this.pinnedId ||
        entry.dead ||
        entry.replaying ||
        this.upgrading.has(id) ||
        this.opened.get(id) !== entry
      )
        return;
      this.opened.delete(id);
      this.observedHandles.delete(entry);
      this.turnStarts.delete(id);
      this.changed();
      return;
    }
    if (entry.member === true) {
      if (id === this.selectedId || entry.dead || entry.replaying || this.opened.get(id) !== entry)
        return;
    } else if (
      id === this.selectedId ||
      id === this.pinnedId ||
      entry.dead ||
      entry.replaying ||
      phoneStatus(entry) !== "idle" ||
      // ADR-0070 §6：有待发输入的会话不随切走关掉，否则这些输入会无声丢失
      entry.pendingInputs.items.length > 0 ||
      entry.outgoing.items.some((item) => item.place === "pending") ||
      // ADR-0089：活动 Ensemble 的指挥会话切走时不能关，否则整个 Ensemble 会被收掉
      entry.view.ensemble?.status === "active" ||
      // ADR-0097：组曲有线程运行或等确认时不随切走关掉指挥会话
      hasActiveSuiteThreads(entry) ||
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
    this.observeUnsupported = false;
    this.upgrading.clear();
    const generation = ++this.generation;
    // 电脑上新建或分叉了会话：旧后台没有这条通知，退化为 App 回前台时刷新
    this.unsubscribeChanged?.();
    this.unsubscribeChanged = client.onNotification("runtime.sessionsChanged", () => {
      void this.refresh().catch(() => undefined);
    });
    // 只恢复连接开始时已有的会话：恢复期间通知带来的新会话由 track/open 打开，
    // 遍历活 Map 会把它们再 resume 一次（后台报 session_already_open）
    let pruned = false;
    for (const [id, entry] of [...this.opened]) {
      if (generation !== this.generation) return;
      if (
        id !== this.selectedId &&
        id !== this.pinnedId &&
        (entry.observed === true ||
          entry.member === true ||
          (phoneStatus(entry) === "idle" &&
            entry.pendingInputs.items.length === 0 &&
            entry.view.ensemble?.status !== "active" &&
            !hasActiveSuiteThreads(entry)))
      ) {
        this.opened.delete(id);
        this.observedHandles.delete(entry);
        this.turnStarts.delete(id);
        pruned = true;
        continue;
      }
      // 恢复期间用户已点开它：并入那次打开，不重复 resume
      const inFlight = this.opening.get(id);
      if (inFlight) {
        await inFlight.catch(() => undefined);
        continue;
      }
      if (this.opened.get(id) !== entry) continue;
      const run =
        entry.suiteId !== undefined
          ? this.resumeSuite(client, entry.suiteId, entry.workspace, entry.view, generation)
          : entry.observed === true
            ? this.observe(client, id, entry.workspace, entry.view, generation)
            : this.resume(
                client,
                id,
                entry.workspace,
                entry.view,
                generation,
                entry.member === true,
              );
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
    if (pruned) this.changed();
    await this.refresh();
  }
  disconnected(): void {
    this.generation++;
    this.stopListening();
    this.loaded = false;
    this.opening.clear();
    this.upgrading.clear();
    this.closing.clear();
    this.client = undefined;
    for (const entry of this.opened.values()) entry.dead = true;
    this.changed();
  }
  clear(): void {
    this.generation++;
    this.turnStarts.clear();
    this.selectedId = undefined;
    this.pinnedId = undefined;
    this.closing.clear();
    this.stopListening();
    this.loaded = false;
    this.opening.clear();
    this.upgrading.clear();
    this.observedHandles.clear();
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
    this.list = list.sort((a, b) => activityMs(b) - activityMs(a));
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
        !!entry &&
        !entry.dead &&
        !!(
          entry.view.pendingPermission ??
          entry.view.pendingQuestion ??
          (entry.view.pendingSubagentPermissions.length ? true : undefined) ??
          (entry.view.ensemble?.awaitingPermissionMembers.length ? true : undefined)
        )
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
      const existing = this.opened.get(item.id);
      if (existing?.dead === false) {
        if (existing.observed === true) {
          await this.ensureLive(item.id).catch(() => undefined);
        }
        continue;
      }
      const closing = this.closing.get(item.id);
      if (closing) await closing.catch(() => undefined);
      if (generation !== this.generation) return;
      const entry = await this.open(item.id, false).catch(() => undefined);
      if (entry) await this.closeIfIdle(entry).catch(() => undefined);
    }
  }
  private async bindLiveTracker(
    entry: PhoneSession,
    session: RpcSession,
    removeOnError: boolean,
    onSubscribed?: () => void,
  ): Promise<void> {
    const view = entry.view;
    // 与桌面 conversations.ts 一致：订阅窗口期间的新持久事件按 event.time 判断。
    const subscribeStart = Date.now();
    let subscribed = false;
    let pendingRevision = 0;
    try {
      entry.tracker = await trackSessionView(
        session,
        (_view, event) => {
          // 待发输入快照（ADR-0070）：临时事件，订阅后再取一次当前快照对齐
          if (event.type === "input.pending") {
            pendingRevision += 1;
            entry.pendingInputs = event.payload;
          }
          syncPhoneOutgoing(entry);
          const at = Date.parse(event.time);
          const live =
            subscribed || !("seq" in event) || (!Number.isNaN(at) && at >= subscribeStart);
          if (event.type === "turn.started" && !Number.isNaN(at))
            this.turnStarts.set(session.id, at);
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
    } catch (error) {
      if (removeOnError && this.opened.get(session.id) === entry) {
        this.opened.delete(session.id);
        this.turnStarts.delete(session.id);
        this.changed();
      }
      throw error;
    }
    if (this.opened.get(session.id) !== entry || entry.dead) {
      await entry.tracker.stop().catch(() => undefined);
      return;
    }
    subscribed = true;
    onSubscribed?.();
    entry.replaying = false;
    void syncShellSnapshot(session, view)
      .then(() => {
        if (entry.dead) return;
        for (const listener of entry.listeners) listener();
        this.changed();
      })
      .catch(() => undefined);
    // 订阅后取当前快照；请求在途期间若收到 input.pending，则事件优先。
    const requestedRevision = pendingRevision;
    void Promise.resolve()
      .then(() => session.pendingInputs())
      .then((snapshot) => {
        if (entry.dead || pendingRevision !== requestedRevision) return;
        if (JSON.stringify(entry.pendingInputs) === JSON.stringify(snapshot)) return;
        entry.pendingInputs = snapshot;
        syncPhoneOutgoing(entry);
        for (const listener of entry.listeners) listener();
        this.changed();
      })
      .catch(() => undefined);
    for (const listener of entry.listeners) listener();
    this.changed();
    void this.refreshTurnChanges(entry);
  }
  private async attach(
    client: RpcClient,
    result: { session: RpcSession; opened: SessionOpened },
    workspace: string,
    view = createSessionView(),
    member = false,
    suiteId?: string,
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
      outgoing: emptyOutgoing(),
      busy: false,
      ...(member ? { member: true } : {}),
      ...(suiteId !== undefined ? { suiteId } : {}),
    };
    this.opened.set(session.id, entry);
    await this.bindLiveTracker(entry, session, true);
    return entry;
  }
  /**
   * 顶层会话只读快照打开（ADR-0099）：不调用 `resumeSession`，不取锁；
   * 仅通过 `session.observe` 回放持久事件并折叠出完整 `SessionView`。
   * 旧后台不支持 `session.observe`（`-32601` / `method_not_found`）时自动退回 `resume`。
   */
  private async observe(
    client: RpcClient,
    id: string,
    workspace: string,
    existingView: SessionView | undefined,
    generation: number,
  ): Promise<PhoneSession> {
    const view = existingView ?? createSessionView();
    const previous = this.opened.get(id);
    const listeners = previous?.listeners ?? new Set<() => void>();
    const handle = createObservedSession(id, client, async () => {
      await this.ensureLive(id);
      const live = handle.live();
      if (live === undefined) throw new Error("会话尚未就绪");
      return live;
    });
    const entry: PhoneSession = {
      client,
      session: handle.session,
      workspace,
      view,
      warnings: [],
      dead: false,
      replaying: true,
      observed: true,
      listeners,
      turnChanges: previous?.turnChanges ?? new Map<number, TurnChanges>(),
      changeDiffs: new Map(),
      pendingInputs: { items: [], paused: false },
      outgoing: emptyOutgoing(),
      busy: false,
    };
    this.observedHandles.set(entry, handle);
    this.opened.set(id, entry);
    let snapshot: SessionReadSnapshot;
    try {
      snapshot = await client.runtime.observeSession(
        { sessionId: id, afterSeq: view.lastSeq },
        {
          onEvent: (event) => {
            if (generation !== this.generation || this.opened.get(id) !== entry || entry.dead)
              return;
            reduceSessionView(view, event);
            const at = Date.parse(event.time);
            if (event.type === "turn.started" && !Number.isNaN(at)) {
              this.turnStarts.set(id, at);
            }
            this.onEvent?.(id, event.type, event.seq, false, event.time);
            this.onSessionEvent?.(id, event, false, entry, this.turnStarts.get(id));
          },
        },
      );
    } catch (error) {
      if (this.opened.get(id) === entry) {
        this.opened.delete(id);
        this.observedHandles.delete(entry);
        this.turnStarts.delete(id);
        this.changed();
      }
      if (generation === this.generation && isObserveUnsupportedError(error)) {
        this.observeUnsupported = true;
        return this.resume(client, id, workspace, existingView, generation, false);
      }
      throw error;
    }
    if (generation !== this.generation) throw new Error("电脑连接已切换");
    if (this.opened.get(id) !== entry || entry.dead) return entry;
    if (snapshot.cwd !== "") entry.workspace = snapshot.cwd;
    entry.replaying = false;
    for (const listener of entry.listeners) listener();
    this.changed();
    if (
      snapshot.openHere ||
      view.currentTurn !== undefined ||
      view.status === "compacting" ||
      allPendingPermissions(view).length > 0 ||
      view.pendingQuestion !== undefined
    ) {
      void this.ensureLive(id).catch(() => undefined);
    }
    return entry;
  }
  /**
   * 将只读观察态会话原地无损升级为实时会话（ADR-0099）：
   * 调 `resumeSession` 后按 `afterSeq: entry.view.lastSeq` 续接 `session.subscribe`，
   * 既不重复回放也不丢事件；并发调用合并为同一次升级。
   */
  async ensureLive(id: string): Promise<PhoneSession> {
    const existing = this.opened.get(id);
    if (!existing || existing.dead) throw new Error("电脑尚未连接，请稍后重试");
    if (existing.observed !== true) return existing;
    const inFlight = this.upgrading.get(id);
    if (inFlight) return inFlight;
    const client = this.requireClient();
    const generation = this.generation;
    const handle = this.observedHandles.get(existing);
    const run = (async () => {
      const result = await client.runtime.resumeSession(id);
      if (generation !== this.generation || this.opened.get(id) !== existing || existing.dead) {
        await result.session.close().catch(() => undefined);
        throw new Error("电脑连接已切换");
      }
      const metaCwd = (result.opened as Partial<SessionOpened>).meta?.cwd;
      if (metaCwd !== undefined && metaCwd !== "") existing.workspace = metaCwd;
      existing.warnings = result.opened.warnings;
      existing.replaying = true;
      try {
        await this.bindLiveTracker(existing, result.session, false, () => {
          handle?.attachLive(result.session);
          this.observedHandles.delete(existing);
          existing.observed = false;
        });
      } catch (error) {
        existing.replaying = false;
        await result.session.close().catch(() => undefined);
        throw error;
      }
      if (generation !== this.generation || this.opened.get(id) !== existing) {
        await existing.tracker?.stop().catch(() => undefined);
        await result.session.close().catch(() => undefined);
        throw new Error("电脑连接已切换");
      }
      return existing;
    })();
    this.upgrading.set(id, run);
    try {
      return await run;
    } finally {
      if (this.upgrading.get(id) === run) this.upgrading.delete(id);
    }
  }
  /** 与桌面 Conversations.refreshTurnChanges 相同：Turn 进行中不查，查完视图已前进则丢弃 */
  async refreshTurnChanges(entry: PhoneSession): Promise<void> {
    if (entry.dead || entry.observed === true || entry.view.currentTurn !== undefined) return;
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
   * 对话，工作区文件不动。返回新会话 id，随即打开；原消息在打开前记进 forkDrafts，
   * 由新会话页取用一次（同桌面）。
   */
  async fork(entry: PhoneSession, targetSeq: number): Promise<PhoneSession> {
    const client = this.requireClient();
    const text = await forkDraftText(entry.session, targetSeq);
    const id = await client.runtime.forkSession(entry.session.id, { targetSeq });
    if (text !== "") this.forkDrafts.set(id, text);
    try {
      await this.refresh().catch(() => undefined);
      const result = await client.runtime.resumeSession(id);
      this.setSelected(id);
      const forked = await this.attach(client, result, entry.workspace);
      void this.refresh().catch(() => undefined);
      return forked;
    } catch (error) {
      this.forkDrafts.delete(id);
      throw error;
    }
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
  async openSuite(
    suite: Pick<SuiteRecord, "id" | "coordinatorSessionId" | "workspaces">,
    select = true,
  ): Promise<PhoneSession> {
    const id = suite.coordinatorSessionId;
    if (select) this.setSelected(id);
    for (let attempt = 0; ; attempt += 1) {
      await this.closing.get(id);
      const old = this.opened.get(id);
      if (old && !old.dead) return old;
      const entry = await (this.opening.get(id) ?? this.beginOpenSuite(suite));
      await this.closing.get(id);
      if (!entry.dead && this.opened.get(id) === entry) {
        await this.closeIfIdle(entry);
        return entry;
      }
      if (attempt >= 1) return entry;
    }
  }
  private async beginOpenSuite(
    suite: Pick<SuiteRecord, "id" | "coordinatorSessionId" | "workspaces">,
  ): Promise<PhoneSession> {
    const client = this.requireClient();
    const generation = this.generation;
    const id = suite.coordinatorSessionId;
    const run = this.resumeSuite(
      client,
      suite.id,
      suite.workspaces[0] ?? "",
      this.opened.get(id)?.view,
      generation,
    );
    this.opening.set(id, run);
    try {
      return await run;
    } finally {
      if (this.opening.get(id) === run) this.opening.delete(id);
    }
  }
  private async resumeSuite(
    client: RpcClient,
    suiteId: string,
    workspace: string,
    view: SessionView | undefined,
    generation: number,
  ): Promise<PhoneSession> {
    const result = await client.runtime.openSuite(suiteId);
    if (generation !== this.generation) throw new Error("电脑连接已切换");
    const metaCwd = (result.opened as Partial<SessionOpened>).meta?.cwd;
    const cwd = metaCwd !== undefined && metaCwd !== "" ? metaCwd : workspace;
    return this.attach(client, result, cwd, view, false, suiteId);
  }
  async openMember(
    childSessionId: string,
    workspace: string,
    parentSessionId?: string,
  ): Promise<PhoneSession> {
    this.setSelected(childSessionId, parentSessionId);
    for (let attempt = 0; ; attempt += 1) {
      await this.closing.get(childSessionId);
      const old = this.opened.get(childSessionId);
      if (old && !old.dead) return old;
      const entry = await (this.opening.get(childSessionId) ??
        this.beginOpen(childSessionId, true, workspace));
      await this.closing.get(childSessionId);
      if (!entry.dead && this.opened.get(childSessionId) === entry) {
        await this.closeIfIdle(entry);
        return entry;
      }
      if (attempt >= 1) return entry;
    }
  }
  private async beginOpen(
    id: string,
    member = false,
    fallbackWorkspace?: string,
  ): Promise<PhoneSession> {
    const client = this.requireClient();
    const generation = this.generation;
    const item = this.list.find((s) => s.id === id);
    const workspace = item?.cwd ?? fallbackWorkspace ?? "";
    const existingView = this.opened.get(id)?.view;
    const canObserve = !member && !this.observeUnsupported && item?.openHere === false;
    const run = canObserve
      ? this.observe(client, id, workspace, existingView, generation)
      : this.resume(client, id, workspace, existingView, generation, member);
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
    member = false,
  ): Promise<PhoneSession> {
    const result = member
      ? await client.call("session.open", { sessionId: id }).then((opened) => ({
          opened,
          session: client.session(opened.sessionId),
        }))
      : await client.runtime.resumeSession(id);
    if (generation !== this.generation) throw new Error("电脑连接已切换");
    const metaCwd = (result.opened as Partial<SessionOpened>).meta?.cwd;
    const cwd = metaCwd !== undefined && metaCwd !== "" ? metaCwd : workspace;
    return this.attach(client, result, cwd, view, member);
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
