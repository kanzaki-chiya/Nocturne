import { expect, it, vi } from "vitest";
import { parseCode } from "../src/code-parse";
import { highlightCode } from "../src/code-highlight-client";

it("大文件分帧着色，不改变原文，每帧保持在预算内", async () => {
  const text = Array.from(
    { length: 2000 },
    (_, i) => `${i + 1}|const value${i} = "line ${i}"; // comment`,
  ).join("\n");
  const lines = await parseCode({ path: "huge.ts", text, kind: "numbered" });
  const frames: FrameRequestCallback[] = [];
  const root = document.createElement("pre");
  root.textContent = text;
  const controller = new AbortController();
  const originalRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  }) as typeof requestAnimationFrame;
  const durations: number[] = [];
  try {
    vi.spyOn(await import("../src/code-parse"), "parseCode").mockResolvedValueOnce(lines);
    highlightCode(root, { path: "huge.ts", text, kind: "numbered" }, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    while (frames.length > 0) {
      const next = frames.shift();
      const start = performance.now();
      next?.(start);
      durations.push(performance.now() - start);
    }
  } finally {
    globalThis.requestAnimationFrame = originalRaf;
    vi.restoreAllMocks();
  }
  expect(durations.length).toBeGreaterThan(1);
  expect(Math.max(...durations)).toBeLessThan(50);
  expect(root.textContent).toBe(text);
  expect(root.querySelectorAll(".syntax-keyword").length).toBe(2000);
});

it("读取行号前缀保留原文，跨行注释在去前缀后解析", async () => {
  const text = '10|/* comment\n11|still comment */\n12|const value = "hello";\n…（其后还有 5 行）';
  const lines = await parseCode({ path: "demo.ts", text, kind: "numbered" });
  expect(lines?.map((line) => line.text).join("\n")).toBe(text);
  expect(lines?.[0]?.spans.every((span) => span.from >= 3)).toBe(true);
  expect(lines?.[1]?.spans.some((span) => span.classes === "syntax-comment")).toBe(true);
  expect(lines?.[2]?.spans.some((span) => span.classes === "syntax-string")).toBe(true);
  expect(lines?.[3]?.spans).toEqual([]);
});

it("旧侧删除跨行注释，新侧新增字符串，不能按行独立解析或把两侧混在一起", async () => {
  const diff =
    "@@ -1,4 +1,3 @@\n-/* old\n-deleted comment */\n+const value = `new\n+multiline`;\n const end = 1;";
  const lines = await parseCode({ path: "demo.ts", text: diff, kind: "diff" });
  expect(lines?.[1]?.spans.some((span) => span.classes === "syntax-comment")).toBe(true);
  expect(lines?.[3]?.spans.some((span) => span.classes === "syntax-string")).toBe(true);
  expect(lines?.[4]?.spans.some((span) => span.classes === "syntax-keyword")).toBe(true);
  expect(lines?.[4]?.spans.some((span) => span.classes === "syntax-comment")).toBe(false);
});

it("hunk 间缺失的上下文不向后传播解析状态", async () => {
  const lines = await parseCode({
    path: "a.ts",
    kind: "diff",
    text: "@@ -1 +1 @@\n /* unknown start\n@@ -20 +20 @@\n+const value = 1;",
  });
  expect(lines?.[2]?.spans.some((span) => span.classes === "syntax-keyword")).toBe(true);
});

it("未知语言不着色", async () => {
  expect(await parseCode({ path: "Makefile", text: "all: build", kind: "text" })).toBeUndefined();
});
