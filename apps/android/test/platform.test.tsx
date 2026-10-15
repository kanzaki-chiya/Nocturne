import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PhoneExtensionApi } from "../../desktop/src/web/platform";
import { shellHost, type AppHost } from "../src/host";
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
  expect(container.querySelector("button")).toBeNull();
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
  const buttons = [...container.querySelectorAll("button")];
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
