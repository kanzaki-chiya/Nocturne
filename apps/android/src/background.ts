import {
  createSessionView,
  reduceSessionView,
  type RuntimeEvent,
  type SessionView,
} from "@nocturne/core/protocol";
import { conversationStatus } from "../../desktop/src/conversations";
import { sessionMarkFor, sessionTitle, type NotifySession } from "../../desktop/src/notify";
import type { SessionMark, SessionStatus } from "../../desktop/src/session-tree";
import type { ConnectionState } from "../../desktop/src/web/connection";
import type { PhoneObserver } from "../../desktop/src/web/platform";
import type { PairedHost } from "../../desktop/src/web/storage";
import type { AppHost, ServiceNotification } from "./host";
import type { ProbeLog } from "./probe";

const KEY = "nocturne.android.keepConnected";

export function connectedText(host: PairedHost | undefined, state: ConnectionState): string {
  return state === "online" && host
    ? `Nocturne 远程：已连接 ${host.name}`
    : "Nocturne 远程：正在连接…";
}

export interface LiveUpdateSession {
  id: string;
  status: SessionStatus;
  mark?: SessionMark | undefined;
  title?: string | undefined;
  firstText?: string | undefined;
}

export interface LiveUpdateSummary {
  shortCriticalText?: "待确认" | "出错" | "已完成" | "运行中" | "正在连接" | "电脑离线" | undefined;
  promoted: boolean;
  sessionId?: string | undefined;
  body?: string | undefined;
}

/**
 * 汇总常驻通知的超级岛（Live Updates）状态：按优先级取当前连接电脑上最高的一项。
 * 已连接且没有会话待确认、未看出错、未看已完成或运行中时不上岛。
 */
export function summarizeLiveUpdate(input: {
  state: ConnectionState;
  sessions: readonly LiveUpdateSession[];
  marks?: Readonly<Record<string, SessionMark>> | undefined;
}): LiveUpdateSummary {
  if (input.state === "online") {
    const pick = (match: (session: LiveUpdateSession, mark: SessionMark | undefined) => boolean) =>
      input.sessions.find((session) => match(session, session.mark ?? input.marks?.[session.id]));
    const hit = (
      shortCriticalText: NonNullable<LiveUpdateSummary["shortCriticalText"]>,
      session: LiveUpdateSession,
    ): LiveUpdateSummary => ({
      shortCriticalText,
      promoted: true,
      sessionId: session.id,
      body: sessionTitle(session),
    });
    const pending = pick((session) => session.status === "pending");
    if (pending) return hit("待确认", pending);
    const error = pick((session, mark) => session.status === "idle" && mark === "error");
    if (error) return hit("出错", error);
    const done = pick((session, mark) => session.status === "idle" && mark === "done");
    if (done) return hit("已完成", done);
    const running = pick((session) => session.status === "running");
    if (running) return hit("运行中", running);
    return { promoted: false };
  }
  if (input.state === "connecting") {
    return { shortCriticalText: "正在连接", promoted: true };
  }
  if (input.state === "offline") {
    return { shortCriticalText: "电脑离线", promoted: true };
  }
  return { promoted: false };
}

/**
 * 未看标记（出错 / 已完成）纯函数：与桌面侧栏 rowTag 一致——
 * 实时事件在没在看该会话时结束才记；打开/在看该会话即清除；新一轮开始时清除。
 */
export function reduceSessionMarks(
  marks: Readonly<Record<string, SessionMark>>,
  action:
    | { kind: "event"; sessionId: string; event: RuntimeEvent; live: boolean; watching: boolean }
    | { kind: "seen"; sessionId: string },
): Readonly<Record<string, SessionMark>> {
  if (action.kind === "seen") {
    if (!(action.sessionId in marks)) return marks;
    const { [action.sessionId]: _seen, ...rest } = marks;
    return rest;
  }
  const { sessionId, event, live, watching } = action;
  if (event.type === "turn.started") {
    if (!live || !(sessionId in marks)) return marks;
    const { [sessionId]: _stale, ...rest } = marks;
    return rest;
  }
  if (!live || watching) return marks;
  const mark = sessionMarkFor(event);
  if (mark === null || marks[sessionId] === mark) return marks;
  return { ...marks, [sessionId]: mark };
}

function sameNotice(a: ServiceNotification | undefined, b: ServiceNotification): boolean {
  return (
    a?.title === b.title &&
    (a.body ?? "") === (b.body ?? "") &&
    (a.shortCriticalText ?? "") === (b.shortCriticalText ?? "") &&
    a.promoted === b.promoted &&
    (a.target?.hostId ?? "") === (b.target?.hostId ?? "") &&
    (a.target?.sessionId ?? "") === (b.target?.sessionId ?? "")
  );
}

interface TrackedSession {
  view: SessionView;
}

/**
 * 「后台保持连接」：已配对电脑且开关打开时让前台服务运行，常驻通知跟随连接状态与会话状态；
 * 关闭则停止服务，页面隐藏时的行为与网页版一致（不主动断开、不重连，回前台再连）。
 */
export class Background {
  private hostCount = 0;
  private currentHost: PairedHost | undefined;
  private connectionState: ConnectionState = "offline";
  private readonly sessions = new Map<string, TrackedSession>();
  private readonly titles = new Map<string, NotifySession>();
  private marks: Readonly<Record<string, SessionMark>> = {};
  private viewingSessionId: string | undefined;
  private started = false;
  private lastSent: ServiceNotification | undefined;
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly host: AppHost,
    private readonly probe: ProbeLog,
    private readonly changed: () => void = () => undefined,
  ) {}

  get enabled(): boolean {
    try {
      return localStorage.getItem(KEY) !== "off";
    } catch {
      return true;
    }
  }

  set enabled(value: boolean) {
    try {
      localStorage.setItem(KEY, value ? "on" : "off");
    } catch {
      // 存不下则本次运行有效
    }
    this.probe.add("service", `keepConnected=${value ? "on" : "off"}`);
    this.sync();
    this.changed();
  }

  readonly observer: PhoneObserver = {
    hosts: (hosts) => {
      this.hostCount = hosts.length;
      this.sync();
    },
    state: (host, state, message) => {
      this.probe.add("state", `${state}${message ? ` ${message}` : ""}`);
      if (state === "online") this.probe.add("connect", host?.name ?? "-");
      const hostChanged = host?.hostId !== this.currentHost?.hostId;
      this.currentHost = host;
      this.connectionState = state;
      if (hostChanged) {
        this.sessions.clear();
        this.titles.clear();
        this.marks = {};
        this.viewingSessionId = undefined;
      } else if (state !== "online") {
        // 断线或重连期间清空旧会话运行态视图，重连后由订阅回放重建；未看标记与会话名保留到用户查看
        this.sessions.clear();
      }
      this.sync();
    },
    disconnected: (host, reason) => {
      this.probe.add("disconnect", `${host.name} ${reason}`);
    },
    event: (sessionId, type, seq, live, eventTime) => {
      this.probe.event(sessionId, type, seq, live, eventTime);
    },
    sessionEvent: (hostId, sessionId, event, live, session, watching) => {
      if (this.currentHost && hostId !== this.currentHost.hostId) return;
      this.trackEvent(sessionId, event, live, session, watching);
      this.sync();
    },
    viewing: (target) => {
      if (!target || (this.currentHost && target.hostId !== this.currentHost.hostId)) {
        this.viewingSessionId = undefined;
        return;
      }
      this.viewingSessionId = target.sessionId;
      const next = reduceSessionMarks(this.marks, { kind: "seen", sessionId: target.sessionId });
      if (next !== this.marks) {
        this.marks = next;
        this.sync();
      }
    },
  };

  private trackEvent(
    sessionId: string,
    event: RuntimeEvent,
    live: boolean,
    session: NotifySession,
    watching: boolean,
  ): void {
    let tracked = this.sessions.get(sessionId);
    if (!tracked || (event.type === "session.created" && event.seq === 1)) {
      tracked = { view: createSessionView() };
      this.sessions.set(sessionId, tracked);
    }
    reduceSessionView(tracked.view, event);
    const prevTitle = this.titles.get(sessionId);
    const title = session.title ?? tracked.view.title ?? prevTitle?.title;
    const firstText = session.firstText ?? tracked.view.firstTitle ?? prevTitle?.firstText;
    if (title !== undefined || firstText !== undefined) {
      this.titles.set(sessionId, {
        ...(title !== undefined ? { title } : {}),
        ...(firstText !== undefined ? { firstText } : {}),
      });
    }
    const effectiveWatching = watching || this.viewingSessionId === sessionId;
    this.marks = reduceSessionMarks(this.marks, {
      kind: "event",
      sessionId,
      event,
      live,
      watching: effectiveWatching,
    });
  }

  private buildNotice(): ServiceNotification {
    const title = connectedText(this.currentHost, this.connectionState);
    const list: LiveUpdateSession[] = [...this.sessions.entries()].map(([id, item]) => {
      const meta = this.titles.get(id);
      return {
        id,
        status: conversationStatus({ view: item.view, busy: false }),
        mark: this.marks[id],
        ...(meta?.title !== undefined ? { title: meta.title } : {}),
        ...(meta?.firstText !== undefined ? { firstText: meta.firstText } : {}),
      };
    });
    // 若未看标记所在的会话因空闲或断线已不在活动 Map 中，仍作为 idle 会话参与汇总
    for (const [id, mark] of Object.entries(this.marks)) {
      if (!this.sessions.has(id)) {
        const meta = this.titles.get(id);
        list.push({
          id,
          status: "idle",
          mark,
          ...(meta?.title !== undefined ? { title: meta.title } : {}),
          ...(meta?.firstText !== undefined ? { firstText: meta.firstText } : {}),
        });
      }
    }
    const summary = summarizeLiveUpdate({
      state: this.connectionState,
      sessions: list,
      marks: this.marks,
    });
    const hostId = this.currentHost?.hostId;
    return {
      title,
      ...(summary.body !== undefined ? { body: summary.body } : {}),
      ...(summary.shortCriticalText !== undefined
        ? { shortCriticalText: summary.shortCriticalText }
        : {}),
      promoted: summary.promoted,
      ...(hostId !== undefined && summary.sessionId !== undefined
        ? { target: { hostId, sessionId: summary.sessionId } }
        : {}),
    };
  }

  private sync(): void {
    const wanted = this.enabled && this.hostCount > 0;
    const notice = this.buildNotice();
    this.pending = this.pending
      .then(async () => {
        if (wanted && !this.started) {
          this.started = true;
          this.lastSent = notice;
          this.probe.add("service", "start requested");
          await this.host.startService(notice);
        } else if (wanted) {
          if (sameNotice(this.lastSent, notice)) return;
          this.lastSent = notice;
          await this.host.updateService(notice);
        } else if (this.started) {
          this.started = false;
          this.lastSent = undefined;
          this.probe.add("service", "stop requested");
          await this.host.stopService();
        }
      })
      .catch((error: unknown) => {
        this.started = false;
        this.lastSent = undefined;
        this.probe.add(
          "service",
          `error ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }
}
