/**
 * 后台探针（ADR-0059 第 1 轮）：只记在手机本地，量后台保活到底行不行。
 * 记录会话事件的到达时间（类型、会话 id、序号，不含内容）与当时在前台还是后台、断线与重连、
 * 计时器延迟、前台服务与渲染进程的原生事件。可导出为纯文本交回维护者。
 */

const KEY = "nocturne.android.probe";
const LIMIT = 20000;
const TICK_MS = 1000;
const TICK_REPORT_MS = 30000;

export type ProbeKind = "app" | "event" | "disconnect" | "connect" | "state" | "tick" | "service";
/** [时间戳, 种类, 细节] */
export type ProbeEntry = [number, ProbeKind, string];

export interface ProbeSummary {
  events: { fg: number; bg: number; replay: number };
  disconnects: number;
  connects: number;
  /** 相邻两条实时事件的最大间隔（毫秒），分别统计前台与后台 */
  maxGap: { fg: number; bg: number };
  /** 实时事件间隔超过 5 秒的次数 */
  gapsOver5s: { fg: number; bg: number };
  /** 一次 ≥3 秒静默后，50 毫秒内连续涌入的事件批次数（成批延迟的迹象） */
  batches: number;
  /** 后台的计时器延迟：30 秒窗口里的最大值（毫秒） */
  maxTimerLag: number;
  native: { serviceStarts: number; serviceStops: number; rendererGone: number; restarts: number };
}

export interface NativeEvent {
  at: number;
  event: string;
}

export function parseNativeLog(text: string): NativeEvent[] {
  const events: NativeEvent[] = [];
  for (const line of text.split("\n")) {
    const [at, ...rest] = line.split("\t");
    const time = Number(at);
    if (at && Number.isFinite(time) && rest.length > 0)
      events.push({ at: time, event: rest.join("\t") });
  }
  return events;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}
export function formatTime(at: number): string {
  const date = new Date(at);
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

export function summarize(
  entries: readonly ProbeEntry[],
  native: readonly NativeEvent[],
): ProbeSummary {
  const summary: ProbeSummary = {
    events: { fg: 0, bg: 0, replay: 0 },
    disconnects: 0,
    connects: 0,
    maxGap: { fg: 0, bg: 0 },
    gapsOver5s: { fg: 0, bg: 0 },
    batches: 0,
    maxTimerLag: 0,
    native: { serviceStarts: 0, serviceStops: 0, rendererGone: 0, restarts: 0 },
  };
  let previous: number | undefined;
  let quietBefore = false;
  for (const [at, kind, detail] of entries) {
    if (kind === "disconnect") summary.disconnects++;
    else if (kind === "connect") summary.connects++;
    else if (kind === "tick") {
      const lag = /max_lag=(\d+)ms/.exec(detail)?.[1];
      if (lag && detail.startsWith("bg"))
        summary.maxTimerLag = Math.max(summary.maxTimerLag, Number(lag));
    } else if (kind === "event") {
      const [state, mode] = detail.split(" ");
      const side = state === "bg" ? "bg" : "fg";
      if (mode === "replay") {
        summary.events.replay++;
        continue;
      }
      summary.events[side]++;
      if (previous !== undefined) {
        const gap = at - previous;
        if (gap > summary.maxGap[side]) summary.maxGap[side] = gap;
        if (gap > 5000) summary.gapsOver5s[side]++;
        if (gap < 50 && quietBefore) summary.batches++;
        quietBefore = gap >= 3000 || (gap < 50 && quietBefore);
      }
      previous = at;
    }
  }
  for (const { event } of native) {
    if (event === "service_start") summary.native.serviceStarts++;
    else if (event === "service_stop") summary.native.serviceStops++;
    else if (event.startsWith("renderer_gone")) summary.native.rendererGone++;
    else if (event === "app_restart") summary.native.restarts++;
  }
  return summary;
}

function readStored(): ProbeEntry[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? (parsed as ProbeEntry[]) : [];
  } catch {
    return [];
  }
}

export class ProbeLog {
  private entries: ProbeEntry[] = readStored();
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  private lastTick = 0;
  private windowLag = 0;
  private windowTicks = 0;
  private windowStart = 0;
  private listeners = new Set<() => void>();

  constructor(
    private readonly visible: () => boolean = () => document.visibilityState !== "hidden",
    private readonly now: () => number = Date.now,
  ) {}

  /** 开始计时器延迟测量与「应用启动」记录；重复调用无效 */
  start(): void {
    if (this.tickTimer) return;
    this.add("app", `start ${this.visible() ? "fg" : "bg"}`);
    this.lastTick = this.now();
    this.windowStart = this.lastTick;
    this.tickTimer = setInterval(() => {
      const at = this.now();
      const lag = Math.max(0, at - this.lastTick - TICK_MS);
      this.lastTick = at;
      this.windowLag = Math.max(this.windowLag, lag);
      this.windowTicks++;
      if (at - this.windowStart >= TICK_REPORT_MS) {
        this.add(
          "tick",
          `${this.visible() ? "fg" : "bg"} max_lag=${this.windowLag}ms ticks=${this.windowTicks}`,
        );
        this.windowLag = 0;
        this.windowTicks = 0;
        this.windowStart = at;
      }
    }, TICK_MS);
  }

  stop(): void {
    clearInterval(this.tickTimer);
    this.tickTimer = undefined;
    this.flush();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  add(kind: ProbeKind, detail: string): void {
    this.entries.push([this.now(), kind, detail]);
    if (this.entries.length > LIMIT) this.entries.splice(0, this.entries.length - LIMIT);
    this.dirty = true;
    this.flushTimer ??= setTimeout(() => {
      this.flush();
    }, 3000);
  }

  /** 一条会话事件：只记类型、会话 id、序号，以及是实时事件还是重连后的回放 */
  event(sessionId: string, type: string, seq: number | undefined, live: boolean): void {
    this.add(
      "event",
      `${this.visible() ? "fg" : "bg"} ${live ? "live" : "replay"} ${sessionId} ${type} ${seq ?? "-"}`,
    );
    for (const listener of this.listeners) listener();
  }

  all(): readonly ProbeEntry[] {
    return this.entries;
  }

  flush(): void {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (!this.dirty) return;
    this.dirty = false;
    try {
      localStorage.setItem(KEY, JSON.stringify(this.entries));
    } catch {
      // 存不下就只保留内存里的记录
    }
  }

  clear(): void {
    this.entries = [];
    this.dirty = true;
    this.flush();
    for (const listener of this.listeners) listener();
  }

  /** 导出纯文本：摘要，再按时间合并 JS 与原生两侧的记录 */
  text(native: readonly NativeEvent[], info: { version: string; agent: string }): string {
    const summary = summarize(this.entries, native);
    const lines = [
      `Nocturne 后台探针 v${info.version}`,
      `导出时间 ${formatTime(this.now())}（epoch ${this.now()}）`,
      `设备 ${info.agent}`,
      `事件：前台 ${summary.events.fg}，后台 ${summary.events.bg}，重连回放 ${summary.events.replay}`,
      `最大事件间隔：前台 ${summary.maxGap.fg}ms，后台 ${summary.maxGap.bg}ms；间隔>5s：前台 ${summary.gapsOver5s.fg}，后台 ${summary.gapsOver5s.bg}`,
      `成批涌入：${summary.batches} 批；后台计时器最大延迟：${summary.maxTimerLag}ms`,
      `断线 ${summary.disconnects} 次，连上 ${summary.connects} 次`,
      `前台服务启 ${summary.native.serviceStarts} 次、停 ${summary.native.serviceStops} 次；渲染进程回收 ${summary.native.rendererGone} 次，重启 App ${summary.native.restarts} 次`,
      "---",
    ];
    const merged: { at: number; line: string }[] = [
      ...this.entries.map(([at, kind, detail]) => ({
        at,
        line: `${formatTime(at)} ${kind} ${detail}`,
      })),
      ...native.map(({ at, event }) => ({ at, line: `${formatTime(at)} native ${event}` })),
    ];
    merged.sort((a, b) => a.at - b.at);
    return [...lines, ...merged.map((item) => item.line)].join("\n");
  }
}
