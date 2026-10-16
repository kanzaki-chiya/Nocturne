import type { RuntimeEvent } from "@nocturne/core/protocol";
import {
  decideNotification,
  NOTIFY_DEFAULTS,
  DONE_THRESHOLD_CHOICES,
  type NotifyPrefs,
  type NotifySession,
} from "../../desktop/src/notify";
import type { AppHost } from "./host";

const KEY = "nocturne.android.notifications.v1";
export { DONE_THRESHOLD_CHOICES };

export function readNotifyPrefs(): NotifyPrefs {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<NotifyPrefs> | null;
    if (!value || typeof value !== "object") return { ...NOTIFY_DEFAULTS };
    return {
      ...NOTIFY_DEFAULTS,
      ...Object.fromEntries(
        (["enabled", "attention", "error", "done"] as const)
          .filter((key) => typeof value[key] === "boolean")
          .map((key) => [key, value[key]]),
      ),
      doneAfterSeconds:
        typeof value.doneAfterSeconds === "number" &&
        Number.isInteger(value.doneAfterSeconds) &&
        value.doneAfterSeconds >= 0
          ? value.doneAfterSeconds
          : NOTIFY_DEFAULTS.doneAfterSeconds,
    };
  } catch {
    return { ...NOTIFY_DEFAULTS };
  }
}

export function saveNotifyPrefs(prefs: NotifyPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* 本次运行仍有效 */
  }
}

export class LocalNotifications {
  prefs = readNotifyPrefs();
  constructor(private readonly host: AppHost) {}

  event(
    hostId: string,
    sessionId: string,
    event: RuntimeEvent,
    live: boolean,
    session: NotifySession,
    watching: boolean,
    turnStartedAt?: number,
  ): void {
    const decision = decideNotification({
      event,
      live,
      session,
      watching,
      prefs: this.prefs,
      turnStartedAt,
    });
    if (!decision) return;
    // 失败（未授权、渠道被关）静默，不把权限弹窗放在事件路径上。
    void this.host.showNotification({ hostId, sessionId, ...decision }).catch(() => undefined);
  }

  dismiss(hostId: string, sessionId: string): void {
    void this.host.dismissNotification(hostId, sessionId).catch(() => undefined);
  }
}
