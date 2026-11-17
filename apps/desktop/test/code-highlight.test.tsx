import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { marked, type Tokens } from "marked";
import { afterEach, expect, it, vi } from "vitest";
import { DiffBody, Markdown, isClosedCodeFence } from "../src/Conversation";
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

it("确认 marked 未闭合与闭合围栏的 raw 结尾特征及闭合判断", () => {
  const firstCodeToken = (src: string) => {
    const token = marked.lexer(src, { gfm: true, breaks: true }).find((t) => t.type === "code");
    if (token === undefined) throw new Error("expected code token");
    return token as Tokens.Code;
  };

  for (const unclosed of [
    "```python",
    "```python\n",
    "```python\ndef f():\n    return 1",
    "```python\ndef f():\n    return 1\n",
    "```python\ndef f():\n    return 1\n``",
    "~~~~ts\nconst x = 1",
    "````md\n```py\nx = 1\n```\n",
    "```python\ncode\n    ```",
  ]) {
    const token = firstCodeToken(unclosed);
    expect(isClosedCodeFence(token)).toBe(false);
  }

  for (const closed of [
    "```python\ndef f():\n    return 1\n```",
    "```python\ndef f():\n    return 1\n```\n",
    "```python\ndef f():\n    return 1\n```  \n\n后续说明",
    "```python\n   ```",
    "~~~~ts\nconst x = 1\n~~~~",
    "````md\n```py\nx = 1\n```\n````",
    "```python\n```",
  ]) {
    const token = firstCodeToken(closed);
    expect(isClosedCodeFence(token)).toBe(true);
  }

  const indented = firstCodeToken("    const x = 1");
  expect(indented.codeBlockStyle).toBe("indented");
  expect(isClosedCodeFence(indented)).toBe(false);
});

const noop = () => undefined;

it("Markdown python 与 py 代码块闭合后着色且逐字保留原文", async () => {
  const pySource = 'def greet(name):\n    # 问候\n    return f"hi {name}"';
  const view = render(<Markdown text={`\`\`\`python\n${pySource}\n\`\`\``} openUrl={noop} />);
  await waitFor(
    () => {
      const code = view.container.querySelector(".conversation-code pre code");
      expect(code?.querySelector(".syntax-keyword")).not.toBeNull();
    },
    { timeout: 5000 },
  );
  const pythonCode = view.container.querySelector(".conversation-code pre code");
  expect(pythonCode?.textContent).toBe(pySource);
  expect(pythonCode?.querySelector(".syntax-comment")?.textContent).toBe("# 问候");

  view.unmount();
  const pyView = render(<Markdown text={`\`\`\`py\n${pySource}\n\`\`\``} openUrl={noop} />);
  await waitFor(
    () => {
      const code = pyView.container.querySelector(".conversation-code pre code");
      expect(code?.querySelector(".syntax-keyword")).not.toBeNull();
    },
    { timeout: 5000 },
  );
  expect(pyView.container.querySelector(".conversation-code pre code")?.textContent).toBe(pySource);
});

it("无语言标记、text、认不出的语言保持纯文本且不启动语法解析", async () => {
  const parseSpy = vi.spyOn(parseModule, "parseCode");
  const view = render(
    <Markdown text={"```\nconst a = 1\n```\n\n```text\ndef f(): pass\n```"} openUrl={noop} />,
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(parseSpy).not.toHaveBeenCalled();

  view.rerender(<Markdown text={"```nonexistent-lang-xyz\nconst a = 1\n```"} openUrl={noop} />);
  await waitFor(() => expect(parseSpy).toHaveBeenCalledTimes(1));
  await new Promise((resolve) => setTimeout(resolve, 40));
  const code = view.container.querySelector(".conversation-code pre code");
  expect(code?.textContent).toBe("const a = 1");
  expect(code?.querySelector("span")).toBeNull();
});

it("未闭合围栏不发起解析，补上结尾围栏后才发起，之后追加段落不再重跑", async () => {
  const parseSpy = vi.spyOn(parseModule, "parseCode");
  const source = "def add(a, b):\n    return a + b";

  const view = render(<Markdown text={`\`\`\`python\n${source}`} openUrl={noop} />);
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(parseSpy).not.toHaveBeenCalled();
  expect(view.container.querySelector(".conversation-code pre code")?.textContent).toBe(source);
  expect(view.container.querySelector(".conversation-code pre code span")).toBeNull();

  view.rerender(<Markdown text={`\`\`\`python\n${source}\n\`\`\``} openUrl={noop} />);
  await waitFor(() => expect(parseSpy).toHaveBeenCalledTimes(1));
  await waitFor(
    () => {
      expect(
        view.container.querySelector(".conversation-code pre code .syntax-keyword"),
      ).not.toBeNull();
    },
    { timeout: 5000 },
  );

  view.rerender(
    <Markdown
      text={`\`\`\`python\n${source}\n\`\`\`\n\n后面流式追加的一段解释文字`}
      openUrl={noop}
    />,
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(parseSpy).toHaveBeenCalledTimes(1);
  expect(view.container.querySelector(".conversation-code pre code")?.textContent).toBe(source);
  expect(
    view.container.querySelector(".conversation-code pre code .syntax-keyword"),
  ).not.toBeNull();
});

it("代码块复制按钮始终复制代码原文", async () => {
  const writeText = vi.fn(async (_text: string) => undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const source = "const x = 1;\nconsole.log(x);";

  const view = render(<Markdown text={`\`\`\`ts\n${source}\n\`\`\``} openUrl={noop} />);
  await waitFor(
    () => {
      expect(
        view.container.querySelector(".conversation-code pre code .syntax-keyword"),
      ).not.toBeNull();
    },
    { timeout: 5000 },
  );

  fireEvent.click(screen.getByRole("button", { name: "复制代码" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(source));
});
