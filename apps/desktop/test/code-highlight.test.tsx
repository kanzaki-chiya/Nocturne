import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DiffBody } from "../src/Conversation";
import { highlightCode } from "../src/code-highlight-client";
import { visibleLineWindow } from "../src/code-lines";
import * as parseModule from "../src/code-parse";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("只有展开并提供路径的 diff 才启动解析，收起或换内容时取消旧任务", async () => {
  const signals: AbortSignal[] = [];
  vi.spyOn(parseModule, "parseCode").mockImplementation((_request, signal) => {
    if (signal !== undefined) signals.push(signal);
    return Promise.resolve(undefined);
  });
  const view = render(<div />);
  expect(signals).toHaveLength(0);
  view.rerender(<DiffBody path="demo.ts" diff={"@@ -1 +1 @@\n-old\n+new"} />);
  await waitFor(() => expect(signals).toHaveLength(1));
  expect(view.container.innerHTML).toContain("old");
  view.rerender(<DiffBody path="demo.ts" diff={"@@ -1 +1 @@\n-before\n+after"} />);
  await waitFor(() => expect(signals).toHaveLength(2));
  expect(signals[0]?.aborted).toBe(true);
  view.unmount();
  expect(signals[1]?.aborted).toBe(true);
});

it("着色保持原文字与行号前缀，取消后的响应不能修改 DOM", async () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const root = document.createElement("pre");
  root.textContent = "42|const n = 1;";
  const controller = new AbortController();
  vi.spyOn(parseModule, "parseCode").mockResolvedValueOnce([
    { text: root.textContent, spans: [{ from: 3, to: 8, classes: "syntax-keyword" }] },
  ]);
  highlightCode(
    root,
    { path: "demo.ts", text: root.textContent, kind: "numbered" },
    controller.signal,
  );
  await waitFor(() => expect(frames).toHaveLength(1));
  frames.shift()?.(0);
  expect(root.textContent).toBe("42|const n = 1;");
  expect(root.querySelector(".syntax-keyword")?.textContent).toBe("const");
  controller.abort();
  const other = new AbortController();
  vi.spyOn(parseModule, "parseCode").mockResolvedValueOnce([{ text: "incorrect", spans: [] }]);
  highlightCode(root, { path: "demo.ts", text: root.textContent, kind: "numbered" }, other.signal);
  other.abort();
  await Promise.resolve();
  expect(root.textContent).toBe("42|const n = 1;");
});

it("可视行范围按实际行位置计算，不受折行和行高影响", () => {
  // 前 100 行每行折成 5 个视觉行（90px），之后每行 18px
  const top = (line: number) => (line <= 100 ? line * 90 : 9000 + (line - 100) * 18);
  expect(visibleLineWindow(1000, top, 9000, 9280, 2)).toEqual({ start: 97, end: 118 });
  expect(visibleLineWindow(1000, top, 0, 280, 2)).toEqual({ start: 0, end: 6 });
  expect(visibleLineWindow(1000, top, 99999, 100279, 2).end).toBe(1000);
  expect(visibleLineWindow(0, top, 0, 280)).toEqual({ start: 0, end: 0 });
});
