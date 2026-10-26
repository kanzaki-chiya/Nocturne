/**
 * 面板浏览器的网页全屏（desktop.md 5.10）：全屏期间 webview 盖满窗口，主界面不做
 * 浮层遮挡截图（截图后隐藏会让外壳把网页退出全屏）；退出全屏后恢复遮挡。
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { BrowserPane } from "../src/BrowserPane";
import { BrowserPool } from "../src/browser-pool";
import type { BrowserBounds, BrowserHost, BrowserMessage } from "../src/host";
import type { BrowserTab } from "../src/side-panel";

const rect = (width: number, height: number) =>
  ({
    x: 0,
    y: 0,
    width,
    height,
    top: 0,
    left: 900,
    right: 900 + width,
    bottom: height,
    toJSON: () => ({}),
  }) as DOMRect;

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const tick = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

it("全屏期间浮层伸进占位区不截图、不隐藏 webview；退出全屏后照常遮挡", async () => {
  let push: (m: BrowserMessage) => void = () => undefined;
  const layouts: (BrowserBounds | null)[] = [];
  const host: BrowserHost = {
    create: vi.fn(async (_url, _bounds, onMessage) => {
      push = onMessage;
      return 7;
    }),
    navigate: vi.fn(async () => undefined),
    layout: vi.fn(async (_id, bounds) => {
      layouts.push(bounds);
    }),
    action: vi.fn(async () => undefined),
    capture: vi.fn(async () => new Uint8Array([1, 2, 3])),
    destroy: vi.fn(async () => undefined),
  };
  const pool = new BrowserPool(host, {
    onUrl: () => undefined,
    onTitle: () => undefined,
    onNewWindow: () => undefined,
    onShortcut: () => undefined,
  });
  const native = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.classList.contains("sp-browser-slot")) return rect(480, 640);
    if (this.getAttribute("role") === "dialog") return rect(200, 200);
    return native.call(this);
  });
  const tab: BrowserTab = { id: "user", kind: "browser", url: "https://example.test/" };
  render(
    <BrowserPane
      tab={tab}
      pool={pool}
      visible
      workspace={undefined}
      openExternal={async () => undefined}
    />,
  );
  await tick();
  expect(host.create).toHaveBeenCalledTimes(1);

  act(() => {
    push({ kind: "fullscreen", on: true });
  });
  document.body.insertAdjacentHTML("beforeend", '<div role="dialog"></div>');
  await tick();
  expect(host.capture).not.toHaveBeenCalled();
  expect(layouts).not.toContain(null);

  // 退出全屏：浮层还在，回到截图占位那一套
  act(() => {
    push({ kind: "fullscreen", on: false });
  });
  await tick();
  expect(host.capture).toHaveBeenCalledTimes(1);
});
