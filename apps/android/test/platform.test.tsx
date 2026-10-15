import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { shellHost, type AppHost } from "../src/host";
import { APP_PAIR_HINT, APP_TRUST_TEXT, appPlatform } from "../src/platform";

let root: Root | undefined;
afterEach(async () => {
  await act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});
async function section(host: AppHost): Promise<string> {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const platform = appPlatform(host);
  await act(async () => {
    root?.render(platform.background?.({ open: vi.fn(), host: undefined, connected: false }));
  });
  return container.textContent;
}

it("App 平台：中继来自配对链接，信任说明不再说页面由中继下发", () => {
  const platform = appPlatform(shellHost);
  expect(platform.relay).toBe("link");
  expect(platform.trustText).toBe(APP_TRUST_TEXT);
  expect(platform.pairHint).toBe(APP_PAIR_HINT);
  expect(APP_TRUST_TEXT).toContain("随安装包");
  expect(APP_TRUST_TEXT).not.toContain("手机网页");
});
it("没有原生插件的外壳：没有后台服务，不能打开系统设置", async () => {
  expect(await shellHost.backgroundStatus()).toEqual({ supported: false, running: false });
  await expect(shellHost.openSettings("battery")).rejects.toThrow();
  expect(await section(shellHost)).toContain("此版本没有后台服务");
});
it("后台服务状态：运行中与未运行", async () => {
  const host = (running: boolean): AppHost => ({
    backgroundStatus: () => Promise.resolve({ supported: true, running }),
    openSettings: () => Promise.resolve(),
  });
  expect(await section(host(true))).toContain("后台服务运行中");
  await act(() => root?.unmount());
  document.body.innerHTML = "";
  expect(await section(host(false))).toContain("后台服务未运行");
});
