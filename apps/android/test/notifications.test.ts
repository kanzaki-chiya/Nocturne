import { beforeEach, expect, it, vi } from "vitest";
import type { RuntimeEvent } from "@nocturne/core/protocol";
import { NOTIFY_DEFAULTS } from "../../desktop/src/notify";
import { shellHost } from "../src/host";
import { LocalNotifications, readNotifyPrefs, saveNotifyPrefs } from "../src/notifications";

beforeEach(() => localStorage.clear());

const start = Date.parse("2026-10-16T00:00:00Z");
function done(seconds: number, recovered = false): RuntimeEvent {
  return {
    type: "turn.completed",
    sessionId: "s",
    seq: 3,
    time: new Date(start + seconds * 1000).toISOString(),
    payload: {
      reason: "done",
      steps: 3,
      usage: { inputTokens: 1, outputTokens: 2 },
      ...(recovered ? { recovered: true } : {}),
    },
  };
}

it("默认本地偏好与独立持久化，不读桌面 settings", () => {
  expect(readNotifyPrefs()).toEqual(NOTIFY_DEFAULTS);
  saveNotifyPrefs({ ...NOTIFY_DEFAULTS, done: false, doneAfterSeconds: 180 });
  expect(readNotifyPrefs()).toMatchObject({ done: false, doneAfterSeconds: 180 });
  localStorage.setItem(
    "nocturne.android.notifications.v1",
    '{"attention":"no","doneAfterSeconds":-5}',
  );
  expect(readNotifyPrefs()).toMatchObject({ attention: true, doneAfterSeconds: 60 });
});

it("仅实时、没在看且达到阈值通知；重放/恢复/用户查看不发，并按电脑会话撤回", () => {
  const showNotification = vi.fn(() => Promise.resolve());
  const dismissNotification = vi.fn(() => Promise.resolve());
  const local = new LocalNotifications({ ...shellHost, showNotification, dismissNotification });
  const emit = (event: RuntimeEvent, live: boolean, watching: boolean) =>
    local.event("computer", "s", event, live, { title: "项目" }, watching, start);
  emit(done(59), true, false);
  emit(done(60), false, false);
  emit(done(60), true, true);
  emit(done(60, true), true, false);
  expect(showNotification).not.toHaveBeenCalled();
  emit(done(60), true, false);
  expect(showNotification).toHaveBeenCalledWith({
    hostId: "computer",
    sessionId: "s",
    kind: "done",
    title: "项目",
    body: "已完成，用时 1 分钟，3 步",
  });
  local.dismiss("computer", "s");
  expect(dismissNotification).toHaveBeenCalledWith("computer", "s");
});
