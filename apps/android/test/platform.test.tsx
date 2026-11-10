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

it("没有原生插件的外壳：不显示后台保持连接，通知照常", async () => {
  const platform = appPlatform(shellHost);
  const container = await mount(platform.background(api()));
  expect(container.querySelector('section[aria-label="后台保持连接"]')).toBeNull();
  expect(container.querySelector('section[aria-label="通知"] h3')?.textContent).toBe("通知");
  expect(container.querySelector('input[type="checkbox"]')).toBeNull();
});

it("后台服务状态与开关：默认开，关掉后 keepConnected 随之变化并通知页面刷新", async () => {
  const probe = new ProbeLog(() => true);
  const platform = appPlatform(withBackground(true), probe);
  expect(platform.keepConnected).toBe(true);
  const refresh = vi.fn();
  const container = await mount(platform.background(api({ refresh })));
  expect(container.textContent).not.toContain("后台服务运行中");
  const toggle = container.querySelector<HTMLButtonElement>(
    '[role="switch"][aria-label="后台保持连接"]',
  );
  expect(toggle?.getAttribute("aria-checked")).toBe("true");
  await act(async () => {
    toggle?.click();
  });
  expect(platform.keepConnected).toBe(false);
  expect(refresh).toHaveBeenCalled();
  expect(probe.all().some((entry) => entry[2] === "keepConnected=off")).toBe(true);
});

it("电池优化与自启动行打开对应系统设置，失败时提示；已放行电池优化时不显示该行", async () => {
  const openSettings = vi
    .fn<AppHost["openSettings"]>()
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("无法打开系统设置"));
  const platform = appPlatform(withBackground(false, { openSettings }));
  const container = await mount(platform.background(api()));
  const buttons = [
    ...container.querySelectorAll<HTMLButtonElement>(
      'section[aria-label="后台保持连接"] button:not([role="switch"])',
    ),
  ];
  expect(buttons.map((button) => button.textContent)).toEqual(["电池优化设置›", "自启动设置›"]);
  expect(container.querySelector('section[aria-label="后台保持连接"] p')).toBeNull();
  await act(async () => {
    buttons[0]?.click();
    buttons[1]?.click();
  });
  expect(openSettings.mock.calls.map(([target]) => target)).toEqual(["battery", "autostart"]);
  await act(async () => {
    buttons[0]?.click();
  });
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("无法打开系统设置");
  await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  const allowed = appPlatform({
    ...shellHost,
    backgroundStatus: () =>
      Promise.resolve({ supported: true, running: true, ignoringBatteryOptimizations: true }),
  });
  const after = await mount(allowed.background(api()));
  const rows = [
    ...after.querySelectorAll<HTMLButtonElement>(
      'section[aria-label="后台保持连接"] button:not([role="switch"])',
    ),
  ];
  expect(rows.map((button) => button.textContent)).toEqual(["自启动设置›"]);
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

it("通知设置：开关不是原生复选框，子项与时长持久化，关闭总开关时子项与时长禁用", async () => {
  const platform = appPlatform(
    withBackground(false, { notificationStatus: () => Promise.resolve({ enabled: true }) }),
  );
  const container = await mount(platform.background(api()));
  const section = container.querySelector('section[aria-label="通知"]');
  expect(section?.querySelector("h3")?.textContent).toBe("通知");
  expect(section?.querySelector('input[type="checkbox"]')).toBeNull();
  expect(
    [...(section?.querySelectorAll(".phone-item-label") ?? [])].map((item) => item.textContent),
  ).toEqual(["通知", "需要确认（权限、提问）", "出错停止", "完成", "提醒触发时长"]);
  expect(section?.textContent).not.toContain("打开系统应用设置");
  const sw = (label: string) =>
    container.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${label}"]`);
  const threshold = container.querySelector<HTMLSelectElement>('select[aria-label="提醒触发时长"]');
  expect(sw("需要确认")?.getAttribute("aria-checked")).toBe("true");
  await act(() => sw("需要确认")?.click());
  expect(sw("需要确认")?.getAttribute("aria-checked")).toBe("false");
  await act(() => {
    if (!threshold) return;
    threshold.value = "300";
    threshold.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(threshold?.value).toBe("300");
  await act(() => sw("通知")?.click());
  expect(sw("需要确认")?.disabled).toBe(true);
  expect(sw("出错停止")?.disabled).toBe(true);
  expect(sw("完成")?.disabled).toBe(true);
  expect(threshold?.disabled).toBe(true);
  await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  const reloaded = await mount(platform.background(api()));
  const again = (label: string) =>
    reloaded.querySelector(`[role="switch"][aria-label="${label}"]`)?.getAttribute("aria-checked");
  expect(again("通知")).toBe("false");
  expect(again("需要确认")).toBe("false");
  expect(
    reloaded.querySelector<HTMLSelectElement>('select[aria-label="提醒触发时长"]')?.value,
  ).toBe("300");
});

it("系统通知被关闭时才出现打开系统应用设置", async () => {
  const openSettings = vi.fn<AppHost["openSettings"]>().mockResolvedValue(undefined);
  const platform = appPlatform(
    withBackground(false, {
      notificationStatus: () => Promise.resolve({ enabled: false }),
      openSettings,
    }),
  );
  const container = await mount(platform.background(api()));
  const section = container.querySelector('section[aria-label="通知"]');
  expect(section?.textContent).toContain("系统通知已关闭");
  expect(section?.textContent).not.toContain("请到系统");
  const button = [...(section?.querySelectorAll("button") ?? [])].find(
    (item) => item.textContent === "打开系统应用设置",
  );
  await act(async () => {
    button?.click();
  });
  expect(openSettings).toHaveBeenCalledWith("app");
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

it("生效主题变化时同步系统状态栏与导航栏深浅", () => {
  const setSystemBars = vi.fn(() => Promise.resolve());
  const platform = appPlatform({ ...shellHost, setSystemBars });
  platform.observer?.theme?.("light");
  platform.observer?.theme?.("dark");
  expect(setSystemBars.mock.calls).toEqual([[true], [false]]);
});
