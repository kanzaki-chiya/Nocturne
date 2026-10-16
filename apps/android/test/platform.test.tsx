import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PhoneExtensionApi } from "../../desktop/src/web/platform";
import {
  BACK_EVENT,
  PAUSE_EVENT,
  RESUME_EVENT,
  TARGET_EVENT,
  shellHost,
  type AppHost,
} from "../src/host";
import { ProbeLog } from "../src/probe";
import { APP_PAIR_HINT, APP_TRUST_TEXT, appPlatform } from "../src/platform";

let root: Root | undefined;
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(async () => {
  await act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});
const api = (overrides: Partial<PhoneExtensionApi> = {}): PhoneExtensionApi => ({
  open: vi.fn(),
  host: undefined,
  connected: false,
  refresh: vi.fn(),
  ...overrides,
});
async function mount(node: React.ReactNode): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(node);
  });
  await act(async () => {
    await new Promise((done) => setTimeout(done, 20));
  });
  return container;
}
const withBackground = (running: boolean, extra: Partial<AppHost> = {}): AppHost => ({
  ...shellHost,
  backgroundStatus: () =>
    Promise.resolve({ supported: true, running, ignoringBatteryOptimizations: false }),
  ...extra,
});

it("App 平台：中继来自配对链接，信任说明不再说页面由中继下发", () => {
  const platform = appPlatform(shellHost);
  expect(platform.relay).toBe("link");
  expect(platform.trustText).toBe(APP_TRUST_TEXT);
  expect(platform.pairHint).toBe(APP_PAIR_HINT);
  expect(APP_TRUST_TEXT).toContain("随安装包");
  expect(APP_TRUST_TEXT).not.toContain("手机网页");
});

it("没有原生插件的外壳：没有后台服务", async () => {
  const platform = appPlatform(shellHost);
  const container = await mount(platform.background(api()));
  expect(container.textContent).toContain("此版本没有后台服务");
  expect(container.textContent).toContain("会话提醒");
});

it("后台服务状态与开关：默认开，关掉后 keepConnected 随之变化并通知页面刷新", async () => {
  const probe = new ProbeLog(() => true);
  const platform = appPlatform(withBackground(true), probe);
  expect(platform.keepConnected).toBe(true);
  const refresh = vi.fn();
  const container = await mount(platform.background(api({ refresh })));
  expect(container.textContent).toContain("后台服务运行中");
  const toggle = container.querySelector<HTMLInputElement>('input[aria-label="后台保持连接"]');
  expect(toggle?.checked).toBe(true);
  await act(async () => {
    toggle?.click();
  });
  expect(platform.keepConnected).toBe(false);
  expect(refresh).toHaveBeenCalled();
  expect(probe.all().some((entry) => entry[2] === "keepConnected=off")).toBe(true);
});

it("电池优化与自启动按钮打开对应系统设置，失败时提示", async () => {
  const openSettings = vi
    .fn<AppHost["openSettings"]>()
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("无法打开系统设置"));
  const platform = appPlatform(withBackground(false, { openSettings }));
  const container = await mount(platform.background(api()));
  const buttons = [
    ...container.querySelectorAll<HTMLButtonElement>('section[aria-label="后台保持连接"] button'),
  ];
  expect(buttons.map((button) => button.textContent)).toEqual(["电池优化设置", "自启动设置"]);
  await act(async () => {
    buttons[0]?.click();
    buttons[1]?.click();
  });
  expect(openSettings.mock.calls.map(([target]) => target)).toEqual(["battery", "autostart"]);
  await act(async () => {
    buttons[0]?.click();
  });
  expect(container.textContent).toContain("无法打开系统设置");
});

it("连接诊断里有后台探针入口，探针页能复制与清除记录", async () => {
  const probe = new ProbeLog(() => true);
  probe.event("session-1", "message.delta", 1, true);
  const clear = vi.fn(() => Promise.resolve());
  const platform = appPlatform(
    withBackground(true, {
      nativeLog: () => Promise.resolve(`${Date.now()}\tservice_start\n`),
      clearNativeLog: clear,
    }),
    probe,
  );
  const open = vi.fn();
  const entry = await mount(platform.diagnostics?.(api({ open })));
  await act(async () => {
    entry.querySelector("button")?.click();
  });
  expect(open).toHaveBeenCalledWith("probe");
  expect(platform.pages?.probe?.title).toBe("后台探针");
  const writeText = vi.fn(() => Promise.resolve());
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  await act(async () => {
    root?.unmount();
  });
  root = undefined;
  document.body.innerHTML = "";
  const page = await mount(platform.pages?.probe?.render(api()));
  expect(page.textContent).toContain("前台服务启 1 次");
  const [copy, clearButton] = [...page.querySelectorAll("button")];
  await act(async () => {
    copy?.click();
  });
  expect(writeText).toHaveBeenCalledOnce();
  const exported = (writeText.mock.calls[0] as unknown as [string])[0];
  expect(exported).toContain("Nocturne 后台探针");
  expect(exported).toContain("event fg live session-1 message.delta 1");
  await act(async () => {
    clearButton?.click();
  });
  expect(probe.all()).toHaveLength(0);
  expect(clear).toHaveBeenCalled();
});

it("Activity 恢复事件通知页面回前台，退订后不再通知", () => {
  const platform = appPlatform(shellHost);
  const foreground = vi.fn();
  const unsubscribe = platform.onForeground?.(foreground);
  window.dispatchEvent(new Event(RESUME_EVENT));
  window.dispatchEvent(new Event(RESUME_EVENT));
  expect(foreground).toHaveBeenCalledTimes(2);
  unsubscribe?.();
  window.dispatchEvent(new Event(RESUME_EVENT));
  expect(foreground).toHaveBeenCalledTimes(2);
  // visibilitychange 不再被当成回前台信号（后台页面也认为自己可见）
  const other = vi.fn();
  platform.onForeground?.(other)();
  document.dispatchEvent(new Event("visibilitychange"));
  expect(other).not.toHaveBeenCalled();
});

it("前后台探针和在看状态只用原生事件，Android 返回回调可退订", () => {
  const probe = new ProbeLog();
  const moveTaskToBack = vi.fn(() => Promise.resolve());
  const platform = appPlatform({ ...shellHost, moveTaskToBack }, probe);
  expect(platform.isForeground?.()).toBe(false);
  window.dispatchEvent(new Event(PAUSE_EVENT));
  expect(platform.isForeground?.()).toBe(false);
  probe.event("s", "message.delta", 1, true);
  expect(probe.all().at(-1)?.[2]).toContain("bg live");
  document.dispatchEvent(new Event("visibilitychange"));
  expect(platform.isForeground?.()).toBe(false);
  window.dispatchEvent(new Event(RESUME_EVENT));
  expect(platform.isForeground?.()).toBe(true);
  const back = vi.fn();
  const unsubscribe = platform.onAndroidBack?.(back);
  window.dispatchEvent(new Event(BACK_EVENT));
  expect(back).toHaveBeenCalledOnce();
  unsubscribe?.();
  window.dispatchEvent(new Event(BACK_EVENT));
  expect(back).toHaveBeenCalledOnce();
  platform.moveTaskToBack?.();
  expect(moveTaskToBack).toHaveBeenCalledOnce();
});

it("原生 Activity 初始状态查询决定在看，晚到的查询不能覆盖 pause/resume", async () => {
  let resolve!: (value: boolean) => void;
  const activityForeground = vi.fn(
    () =>
      new Promise<boolean>((done) => {
        resolve = done;
      }),
  );
  const platform = appPlatform({ ...shellHost, activityForeground });
  expect(platform.isForeground?.()).toBe(false);
  resolve(true);
  await vi.waitFor(() => expect(platform.isForeground?.()).toBe(true));
  const racing = appPlatform({
    ...shellHost,
    activityForeground: () =>
      new Promise<boolean>((done) => {
        resolve = done;
      }),
  });
  window.dispatchEvent(new Event(PAUSE_EVENT));
  resolve(true);
  await Promise.resolve();
  expect(racing.isForeground?.()).toBe(false);
  const again = appPlatform({
    ...shellHost,
    activityForeground: () =>
      new Promise<boolean>((done) => {
        resolve = done;
      }),
  });
  window.dispatchEvent(new Event(RESUME_EVENT));
  resolve(false);
  await Promise.resolve();
  expect(again.isForeground?.()).toBe(true);
});

it("会话提醒设置：子项、阈值持久化，禁用主开关时子项不可编辑", async () => {
  const platform = appPlatform(
    withBackground(false, { notificationStatus: () => Promise.resolve({ enabled: true }) }),
  );
  const container = await mount(platform.background(api()));
  const attention = container.querySelector<HTMLInputElement>('input[aria-label="需要确认"]');
  const enabled = container.querySelector<HTMLInputElement>('input[aria-label="会话提醒"]');
  const threshold = container.querySelector<HTMLSelectElement>('select[aria-label="完成阈值"]');
  expect(attention?.checked).toBe(true);
  await act(() => attention?.click());
  expect(attention?.checked).toBe(false);
  await act(() => {
    if (!threshold) return;
    threshold.value = "300";
    threshold.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(threshold?.value).toBe("300");
  await act(() => enabled?.click());
  expect(attention?.disabled).toBe(true);
  expect(threshold?.disabled).toBe(true);
  await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  const reloaded = await mount(platform.background(api()));
  expect(reloaded.querySelector<HTMLInputElement>('input[aria-label="会话提醒"]')?.checked).toBe(
    false,
  );
  expect(reloaded.querySelector<HTMLInputElement>('input[aria-label="需要确认"]')?.checked).toBe(
    false,
  );
  expect(reloaded.querySelector<HTMLSelectElement>('select[aria-label="完成阈值"]')?.value).toBe(
    "300",
  );
});

it("通知目标经原生一次性读取，暖启动事件送到当前页面", async () => {
  const target = { hostId: "computer", sessionId: "s" };
  const consumeNotificationTarget = vi
    .fn()
    .mockResolvedValueOnce(target)
    .mockResolvedValueOnce(target);
  const platform = appPlatform({ ...shellHost, consumeNotificationTarget });
  expect(await platform.notificationTarget?.()).toEqual(target);
  const listener = vi.fn();
  const unsubscribe = platform.onNotificationTarget?.(listener);
  window.dispatchEvent(new Event(TARGET_EVENT));
  await vi.waitFor(() => {
    expect(listener).toHaveBeenCalledWith(target);
  });
  unsubscribe?.();
});
