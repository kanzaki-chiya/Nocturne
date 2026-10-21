/**
 * 子代理只读观察的客户端状态（ADR-0060 修订（五）第 2、6、9 条）：每个 (父会话, 子会话)
 * 一个独立的 SessionView，用同一份 reducer 折叠 `subagent.event` 交来的事件。
 *
 * - 只观察当前显示的子标签：start 开始、stop 退订（保留视图和最后持久 seq），回看时按
 *   seq 补读；换了后台连接（runtime 变了）从保留的 seq 续接，没有缓存才从 0 重放，
 *   重连前先清掉瞬态内容（流式增量、提示、提问）——它们不可重放，不补造；
 * - 持久事件按 seq 去重；已退订、被替换或过期的观察，迟到的回调一概丢弃；
 * - 不创建 RpcSession，没有任何命令入口。
 */
import {
  createSessionView,
  reduceSessionView,
  type RuntimeEvent,
  type SessionView,
  type SubagentObservation,
  type SubagentObserver,
  type SubagentReadEnd,
  type SubagentSummary,
} from "@nocturne/core/protocol";

/** RpcRuntime.observeSubagent 的最小形状；测试里换成假实现 */
export interface WatchRuntime {
  observeSubagent(
    input: { parentSessionId: string; childSessionId: string; afterSeq?: number | undefined },
    observer: SubagentObserver,
  ): Promise<SubagentObservation>;
}

export type WatchPhase =
  /** 还没开始，或已退订（视图保留） */
  | "idle"
  /** 订阅请求在途 */
  | "connecting"
  /** 订阅成功，持续接收 */
  | "open"
  /** 本次观察自然结束（见 end） */
  | "closed"
  | "error";

export interface WatchState {
  /** 在原地折叠的视图；渲染前以 version 触发刷新 */
  view: SessionView;
  phase: WatchPhase;
  summary: SubagentSummary | undefined;
  mode: "live" | "snapshot" | undefined;
  end: SubagentReadEnd | undefined;
  error: { code: string | undefined; message: string } | undefined;
}

interface Run {
  cancelled: boolean;
  /** 本次观察已自然结束（收到 closed）；再 start 会重新观察 */
  ended: boolean;
  runtime: WatchRuntime;
  observation: SubagentObservation | undefined;
}

interface Entry {
  state: WatchState;
  run: Run | undefined;
  eventListeners: Set<(event: RuntimeEvent) => void>;
}

export const watchKey = (parentSessionId: string, childSessionId: string): string =>
  `${parentSessionId}\u0000${childSessionId}`;

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/** 重连前清掉不可重放的瞬态：流式增量、提示、待回答的提问、重试提示 */
export function clearTransient(view: SessionView): void {
  view.live = { assistants: [], tools: [] };
  view.notices = [];
  view.pendingQuestion = undefined;
  view.retry = undefined;
  view.mcpServers = {};
  view.status = "idle";
  for (const entry of view.entries) {
    if (entry.kind === "tool") entry.liveOutput = "";
  }
}

export class SubagentWatcher {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  /** useSyncExternalStore 的订阅与快照：任一观察状态变化都递增 */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  readonly getVersion = (): number => this.version;

  private bump(): void {
    this.version += 1;
    for (const listener of [...this.listeners]) listener();
  }

  state(parentSessionId: string, childSessionId: string): WatchState | undefined {
    return this.entries.get(watchKey(parentSessionId, childSessionId))?.state;
  }

  /** 是否有在途或已建立的订阅（测试与诊断用） */
  observing(parentSessionId: string, childSessionId: string): boolean {
    const run = this.entries.get(watchKey(parentSessionId, childSessionId))?.run;
    return run !== undefined && !run.cancelled && !run.ended;
  }

  /**
   * 每个收进视图的事件（含临时事件）的监听：思考时长簿记用。
   * 重放期间的事件同样会触发，与主对话 subscribeEvents 一致。
   */
  events(
    parentSessionId: string,
    childSessionId: string,
    listener: (event: RuntimeEvent) => void,
  ): () => void {
    const entry = this.ensure(watchKey(parentSessionId, childSessionId));
    entry.eventListeners.add(listener);
    return () => {
      entry.eventListeners.delete(listener);
    };
  }

  private ensure(key: string): Entry {
    let entry = this.entries.get(key);
    if (entry === undefined) {
      entry = {
        state: {
          view: createSessionView(),
          phase: "idle",
          summary: undefined,
          mode: undefined,
          end: undefined,
          error: undefined,
        },
        run: undefined,
        eventListeners: new Set(),
      };
      this.entries.set(key, entry);
    }
    return entry;
  }

  /**
   * 开始观察。幂等：同一 runtime 上已在观察就什么都不做；换了 runtime（后台重启）先丢掉旧的。
   * 已自然结束且终止事实已知（summary.state = ended）的观察不再重开——没有新内容会来。
   */
  start(runtime: WatchRuntime, parentSessionId: string, childSessionId: string): void {
    const key = watchKey(parentSessionId, childSessionId);
    const entry = this.ensure(key);
    if (entry.run !== undefined && !entry.run.cancelled && !entry.run.ended) {
      if (entry.run.runtime === runtime) return;
      this.cancel(entry);
    }
    const { state } = entry;
    if (state.phase === "closed" && state.end?.summary.state === "ended") return;
    this.open(entry, runtime, parentSessionId, childSessionId, true);
  }

  private open(
    entry: Entry,
    runtime: WatchRuntime,
    parentSessionId: string,
    childSessionId: string,
    allowRestart: boolean,
  ): void {
    const run: Run = { cancelled: false, ended: false, runtime, observation: undefined };
    entry.run = run;
    const { state } = entry;
    const afterSeq = state.view.lastSeq > 0 ? state.view.lastSeq : undefined;
    clearTransient(state.view);
    state.phase = "connecting";
    state.error = undefined;
    state.end = undefined;
    this.bump();
    const alive = () => !run.cancelled && entry.run === run;
    const observer: SubagentObserver = {
      onEvent: (event) => {
        if (!alive()) return;
        // 持久事件按 seq 去重：补读与实时衔接、重连续接都可能重复送达
        if ("seq" in event && event.seq <= state.view.lastSeq) return;
        reduceSessionView(state.view, event);
        for (const listener of [...entry.eventListeners]) {
          try {
            listener(event);
          } catch {
            // 监听者异常不影响视图
          }
        }
        this.bump();
      },
      onEnd: (end) => {
        if (!alive()) return;
        state.phase = "closed";
        state.end = end;
        state.summary = end.summary;
        run.ended = true;
        run.observation = undefined;
        this.bump();
      },
    };
    runtime
      .observeSubagent(
        {
          parentSessionId,
          childSessionId,
          ...(afterSeq !== undefined ? { afterSeq } : {}),
        },
        observer,
      )
      .then(
        (observation) => {
          if (!alive()) {
            observation.unsubscribe();
            return;
          }
          state.summary = state.end?.summary ?? observation.summary;
          state.mode = observation.mode;
          if (state.phase === "connecting") {
            state.phase = "open";
            run.observation = observation;
          }
          this.bump();
        },
        (error: unknown) => {
          if (!alive()) return;
          const code = codeOf(error);
          if (allowRestart && afterSeq !== undefined && code === "invalid_params") {
            // 保留的 seq 已超出日志（日志被替换/截断）：丢掉缓存视图，从 0 重放一次
            state.view = createSessionView();
            this.open(entry, runtime, parentSessionId, childSessionId, false);
            return;
          }
          state.phase = "error";
          state.error = {
            code,
            message: error instanceof Error ? error.message : String(error),
          };
          entry.run = undefined;
          this.bump();
        },
      );
  }

  private cancel(entry: Entry): void {
    const run = entry.run;
    if (run === undefined) return;
    run.cancelled = true;
    run.observation?.unsubscribe();
    entry.run = undefined;
    if (entry.state.phase === "connecting" || entry.state.phase === "open") {
      entry.state.phase = "idle";
    }
  }

  /** 退订但保留视图与 seq（切走、关面板、进设置、会话切换）；回看时 start 按 seq 补读 */
  stop(parentSessionId: string, childSessionId: string): void {
    const entry = this.entries.get(watchKey(parentSessionId, childSessionId));
    if (entry?.run === undefined) return;
    this.cancel(entry);
    this.bump();
  }

  /** 重试：清掉错误后按保留的 seq（没有就从 0）重新观察 */
  retry(runtime: WatchRuntime, parentSessionId: string, childSessionId: string): void {
    const entry = this.entries.get(watchKey(parentSessionId, childSessionId));
    if (entry === undefined) {
      this.start(runtime, parentSessionId, childSessionId);
      return;
    }
    this.cancel(entry);
    entry.state.phase = "idle";
    this.start(runtime, parentSessionId, childSessionId);
  }

  /** 关标签/删会话：退订并丢弃视图 */
  release(parentSessionId: string, childSessionId: string): void {
    const key = watchKey(parentSessionId, childSessionId);
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    this.cancel(entry);
    this.entries.delete(key);
    this.bump();
  }

  /** 一个父会话的全部观察（会话被删除） */
  releaseParent(parentSessionId: string): void {
    const prefix = `${parentSessionId}\u0000`;
    for (const key of [...this.entries.keys()]) {
      if (!key.startsWith(prefix)) continue;
      const entry = this.entries.get(key);
      if (entry !== undefined) this.cancel(entry);
      this.entries.delete(key);
    }
    this.bump();
  }

  dispose(): void {
    for (const entry of this.entries.values()) this.cancel(entry);
    this.entries.clear();
  }
}
