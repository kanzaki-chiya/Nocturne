import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AndroidUpdate } from "../src/update";
import { UpdateAbout, UpdateLifecycle, UpdateNotice } from "../src/update-ui";
import { RESUME_EVENT, shellHost } from "../src/host";

let root: Root;
let container: HTMLElement;
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const mount = async (node: React.ReactNode) => {
  await act(async () => {
    root.render(node);
  });
};

it("关于五种状态及系统下载", async () => {
  let resolve: (value: unknown) => void = () => undefined;
  const fetch = vi.fn().mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const update = new AndroidUpdate({ version: "1.0.0", fetch });
  const openUrl = vi.fn().mockResolvedValue(undefined);
  await mount(<UpdateAbout update={update} version="1.0.0" host={{ ...shellHost, openUrl }} />);
  expect(container.textContent).toBe("版本 1.0.0检查更新");
  await act(async () => {
    container.querySelector("button")?.click();
  });
  expect(container.querySelector("button")?.disabled).toBe(true);
  expect(container.textContent).toContain("检查中");
  await act(async () => {
    resolve({ ok: true, json: async () => ({ tag_name: "v1.0.0", assets: [] }) });
  });
  expect(container.textContent).toContain("已是最新");
  await act(async () => {
    update.computer("2.0.0");
  });
  expect(container.textContent).toContain("下载 2.0.0");
  await act(async () => {
    container.querySelector("button")?.click();
  });
  expect(openUrl).toHaveBeenCalledWith(
    "https://github.com/kanzaki-chiya/Nocturne/releases/download/v2.0.0/nocturne-2.0.0.apk",
  );
  fetch.mockRejectedValue(new Error("offline"));
  await act(async () => {
    update.computer(undefined);
    await update.check(true);
  });
  expect(container.textContent).toContain("检查失败，重试");
});

it("提示条关闭后更高版本重现，不兼容时没有版本不显示下载", async () => {
  const update = new AndroidUpdate({ version: "1.0.0" });
  update.computer("2.0.0");
  await mount(<UpdateNotice update={update} host={shellHost} />);
  expect(container.querySelector(".phone-status")?.textContent).toContain("新版本 2.0.0");
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[aria-label="关闭"]')?.click();
  });
  expect(container.textContent).toBe("");
  await act(async () => {
    update.computer("3.0.0");
  });
  expect(container.textContent).toContain("新版本 3.0.0");
  await mount(<UpdateNotice update={update} host={shellHost} incompatible />);
  expect(container.textContent).toBe("App 版本过旧下载 3.0.0");
  await act(async () => {
    update.computer(undefined);
  });
  expect(container.textContent).toBe("App 版本过旧");
});

it("启动与原生前台信号触发自动检查，卸载退订", async () => {
  const update = new AndroidUpdate({ version: "1.0.0" });
  const check = vi.spyOn(update, "check").mockResolvedValue(undefined);
  await mount(<UpdateLifecycle update={update} />);
  expect(check).toHaveBeenCalledTimes(1);
  window.dispatchEvent(new Event(RESUME_EVENT));
  expect(check).toHaveBeenCalledTimes(2);
  await mount(null);
  window.dispatchEvent(new Event(RESUME_EVENT));
  expect(check).toHaveBeenCalledTimes(2);
});
