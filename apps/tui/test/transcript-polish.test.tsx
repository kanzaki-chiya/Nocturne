import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Children, createElement, isValidElement, type ReactNode } from "react";
import { render } from "ink-testing-library";
import stringWidth from "string-width";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRuntime, FakeProvider, type RuntimeSession } from "@nocturne/core";
import {
  createSessionView,
  firstUserText,
  estimateTokens,
  type RuntimeEvent,
} from "@nocturne/core/protocol";
import { App } from "../src/app.js";
import { StatusBar } from "../src/components/status-bar.js";
import { Composer } from "../src/components/composer.js";
import { TuiEnvContext } from "../src/env.js";
import { renderAssistant } from "../src/markdown.js";
import { contextBar } from "../src/status-format.js";
import {
  formatSpeed,
  recordSpeed,
  useGenerationSpeed,
  type GenerationSpeed,
} from "../src/speed.js";
import { anchorFromBottom, selectVisible, type LineBlock } from "../src/viewport.js";
import type { MouseEvent, MouseSource } from "../src/mouse.js";
import { palettes } from "../src/theme.js";

const roots: string[] = [];
function temp() {
  const dir = mkdtempSync(path.join(tmpdir(), "nct-polish-"));
  roots.push(dir);
  return dir;
}
beforeEach(() => vi.stubEnv("NOCTURNE_HOME", temp()));
afterEach(() => {
  vi.unstubAllEnvs();
  roots.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});
async function setup() {
  const runtime = await createRuntime({
    cwd: temp(),
    sessionsDir: temp(),
    providers: [
      new FakeProvider({
        scripts: [
          [
            { type: "reasoning_delta", text: "独立思考首行\n独立思考次行" },
            { type: "text_delta", text: "回答首行\n回答次行" },
            { type: "finish", reason: "stop" },
          ],
        ],
      }),
    ],
  });
  const session = await runtime.createSession({ model: "fake/fake-1" });
  return { runtime, session };
}
function mouseSource(): MouseSource & { emit(event: MouseEvent): void } {
  const listeners = new Set<(event: MouseEvent) => void>();
  return {
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit(event) {
      listeners.forEach((fn) => fn(event));
    },
  };
}
async function changed(screen: ReturnType<typeof render>, action: () => void) {
  const before = screen.lastFrame();
  action();
  await vi.waitFor(() => expect(screen.lastFrame()).not.toBe(before));
  await new Promise<void>((resolve) => setImmediate(resolve));
}
function row(screen: ReturnType<typeof render>, text: string) {
  const y = (screen.lastFrame() ?? "").split("\n").findIndex((line) => line.includes(text)) + 1;
  expect(y).toBeGreaterThan(0);
  return y;
}
function click(mouse: ReturnType<typeof mouseSource>, y: number) {
  mouse.emit({ type: "press", button: 0, x: 3, y });
  mouse.emit({ type: "release", button: 0, x: 3, y });
}

it("单段点击展开/收起保持标题行，Ctrl+O 清除单段覆盖，拖动不展开", async () => {
  const { runtime, session } = await setup();
  await session.submit({ text: "首句标题\n第二行" });
  const mouse = mouseSource();
  const out: { current?: (() => string[]) | undefined } = {};
  const screen = render(
    createElement(App, {
      runtime,
      session,
      env: { ascii: false, animated: false },
      mouse,
      transcriptOut: out,
    }),
  );
  await vi.waitFor(() => expect(screen.lastFrame()).toContain("单击或 Ctrl+O 展开"));
  const y = row(screen, "∴ 思考");
  await changed(screen, () => click(mouse, y));
  expect(row(screen, "∴ 思考")).toBe(y);
  expect(screen.lastFrame()).toContain("  独立思考首行");
  expect(screen.lastFrame()).not.toContain("思考已展开");
  expect(out.current?.()).toContain("● 回答首行");
  expect(out.current?.()).toContain("  回答次行");
  await changed(screen, () => click(mouse, y));
  expect(screen.lastFrame()).not.toContain("  独立思考首行");
  await changed(screen, () => screen.stdin.write("\x0f"));
  expect(screen.lastFrame()).toContain("  独立思考首行");
  await changed(screen, () => click(mouse, row(screen, "∴ 思考")));
  expect(screen.lastFrame()).not.toContain("  独立思考首行");
  await changed(screen, () => screen.stdin.write("\x0f"));
  expect(screen.lastFrame()).not.toContain("  独立思考首行");
  await changed(screen, () => screen.stdin.write("\x0f"));
  expect(screen.lastFrame()).toContain("  独立思考首行");
  await changed(screen, () => screen.stdin.write("\x0f"));
  const dragY = row(screen, "∴ 思考");
  mouse.emit({ type: "press", button: 0, x: 3, y: dragY });
  mouse.emit({ type: "drag", button: 0, x: 5, y: dragY });
  mouse.emit({ type: "release", button: 0, x: 3, y: dragY });
  await changed(screen, () => screen.stdin.write("草稿"));
  expect(screen.lastFrame()).not.toContain("  独立思考首行");
  screen.unmount();
  await session.close();
});

it("工具标题展开完整输出并收起；diff 标题和省略行共享状态", async () => {
  const { runtime, session } = await setup();
  const mouse = mouseSource();
  const out: { current?: (() => string[]) | undefined } = {};
  const screen = render(
    createElement(App, {
      runtime,
      session,
      env: { ascii: false, animated: false },
      mouse,
      transcriptOut: out,
    }),
  );
  await vi.waitFor(() => expect(screen.lastFrame()).toContain("Nocturne"));
  await session.session.emit("tool.started", {
    callId: "read1",
    name: "read",
    input: { path: "a.ts" },
    subjects: [],
    permission: { action: "allow", source: "rule" },
  });
  await session.session.emit("tool.completed", {
    callId: "read1",
    name: "read",
    status: "ok",
    modelContent: "完整输出第一行\n第二行\n第三行\n第四行\n末尾第五行",
  });
  await vi.waitFor(() => expect(screen.lastFrame()).toContain("末尾第五行"));
  expect(screen.lastFrame()).not.toContain("完整输出第一行");
  const y = row(screen, "✓ read");
  await changed(screen, () => click(mouse, y));
  expect(row(screen, "✓ read")).toBe(y);
  expect(screen.lastFrame()).toContain("完整输出第一行");
  await changed(screen, () => click(mouse, y));
  expect(screen.lastFrame()).not.toContain("完整输出第一行");
  const diff = `@@ -0,0 +1,50 @@\n${Array.from({ length: 50 }, (_, i) => `+line${i + 1}`).join("\n")}`;
  await session.session.emit("tool.started", {
    callId: "diff1",
    name: "write",
    input: { path: "b.ts", content: "" },
    subjects: [],
    permission: { action: "allow", source: "rule" },
  });
  await session.session.emit("tool.completed", {
    callId: "diff1",
    name: "write",
    status: "ok",
    modelContent: "已创建 b.ts",
    output: { path: "b.ts", created: true, diff },
  });
  await vi.waitFor(() => expect(screen.lastFrame()).toContain("line50"));
  while (!(screen.lastFrame() ?? "").includes("✓ write"))
    await changed(screen, () => mouse.emit({ type: "wheel", dir: "up", x: 1, y: 1 }));
  const titleY = row(screen, "✓ write");
  const length = out.current?.().length ?? 0;
  click(mouse, titleY);
  await vi.waitFor(() => expect(out.current?.().length).toBeGreaterThan(length));
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(row(screen, "✓ write")).toBe(titleY);
  while (!(screen.lastFrame() ?? "").includes("单击收起"))
    await changed(screen, () => mouse.emit({ type: "wheel", dir: "down", x: 1, y: 1 }));
  await changed(screen, () => click(mouse, row(screen, "单击收起")));
  expect(row(screen, "✓ write")).toBe(1); // 标题已在视口上方，收起后放到顶部。
  while (!(screen.lastFrame() ?? "").includes("还有 10 行"))
    await changed(screen, () => mouse.emit({ type: "wheel", dir: "down", x: 1, y: 1 }));
  screen.unmount();
  await session.close();
}, 15000);

it("标题取首条持久化原文首行，/new 清空", async () => {
  const { runtime, session } = await setup();
  await session.submit({ text: "  持久化原文标题  \n下一行" });
  expect((await runtime.listSessions()).find((item) => item.id === session.id)?.firstText).toBe(
    "持久化原文标题",
  );
  const next = await runtime.createSession({ model: "fake/fake-1" });
  const screen = render(
    createElement(App, {
      runtime,
      session,
      env: { ascii: false, animated: false },
      newSession: async () => ({ kind: "ok" as const, session: next }),
    }),
  );
  await vi.waitFor(() => expect(screen.lastFrame()).toContain("── 持久化原文标题 ─"));
  await changed(screen, () => screen.stdin.write("/new"));
  await changed(screen, () => screen.stdin.write("\r"));
  await vi.waitFor(() => expect(screen.lastFrame()).not.toContain("── 持久化原文标题 ─"));
  screen.unmount();
  await next.close();
});

it("标题宽度截断并随横线省略；共享首行规则与 CJK 估算", async () => {
  expect(
    firstUserText({
      content: [
        { type: "text", text: "  原文首行\r\n后续" },
        { type: "text", text: "别取我" },
      ],
    }),
  ).toBe("原文首行");
  expect(firstUserText({ content: [{ type: "text", text: "\n空首行" }] })).toBeUndefined();
  expect(firstUserText({ content: [] })).toBeUndefined();
  expect(estimateTokens("中文abcd")).toBe(3);
  const props = {
    value: "",
    onChange: vi.fn(),
    onSubmit: vi.fn(),
    active: false,
    width: 20,
    title: "甲".repeat(20),
  };
  const screen = render(createElement(Composer, props));
  await vi.waitFor(() => expect(screen.lastFrame()).toContain("…"));
  const line = (screen.lastFrame() ?? "").split("\n")[0] ?? "";
  expect(line.startsWith("── ")).toBe(true);
  expect(stringWidth(line)).toBe(20);
  screen.rerender(createElement(Composer, { ...props, showRule: false }));
  await vi.waitFor(() => expect(screen.lastFrame()).not.toContain("甲"));
  screen.unmount();
});

it("速度按到达时间估算，结束后改用 outputTokens，短步和历史隐藏", () => {
  const state: GenerationSpeed = { text: "" };
  const delta = (text: string, kind = "text", id = "a") =>
    ({
      type: "message.assistant.delta",
      payload: { messageId: id, kind, delta: text },
    }) as RuntimeEvent;
  expect(formatSpeed(state, 3000)).toBeUndefined();
  recordSpeed(state, delta("中文", "reasoning"), 1000);
  recordSpeed(state, delta("abcd"), 1400);
  expect(formatSpeed(state, 1499)).toBeUndefined();
  expect(formatSpeed(state, 2000)).toBe("~3 tok/s");
  recordSpeed(
    state,
    {
      type: "message.assistant",
      payload: { messageId: "a", usage: { outputTokens: 48 } },
    } as RuntimeEvent,
    2000,
  );
  expect(formatSpeed(state, 8000)).toBe("48 tok/s");
  recordSpeed(state, delta("下一步", "text", "b"), 9000);
  expect(formatSpeed(state, 9200)).toBeUndefined();
  recordSpeed(
    state,
    { type: "message.assistant", payload: { messageId: "b" } } as RuntimeEvent,
    9500,
  );
  expect(formatSpeed(state, 10000)).toBe("~6 tok/s");
  recordSpeed(state, delta("短步", "text", "c"), 11000);
  recordSpeed(
    state,
    {
      type: "message.assistant",
      payload: { messageId: "c", usage: { outputTokens: 48 } },
    } as RuntimeEvent,
    11499,
  );
  expect(formatSpeed(state, 12000)).toBeUndefined();
});

it("用量条为八格，正值至少一格，80% 警告与 ASCII 形态", () => {
  expect(contextBar(0, 100, false)).toEqual({ filled: "", empty: "░░░░░░░░", warning: false });
  expect(contextBar(1, 1000, false)?.filled).toBe("█");
  expect(contextBar(21, 100, false)).toEqual({ filled: "██", empty: "░░░░░░", warning: false });
  expect(contextBar(79, 100, false)?.warning).toBe(false);
  expect(contextBar(80, 100, false)?.warning).toBe(true);
  const ascii = contextBar(21, 100, true);
  expect((ascii?.filled ?? "") + (ascii?.empty ?? "")).toBe("[##------]");
  expect(contextBar(1, undefined, false)).toBeUndefined();
});

it("状态栏按速度、用量条、目录的顺序隐藏；ASCII 也保持顺序", async () => {
  const view = createSessionView();
  view.config.model = { provider: "fake", model: "m" };
  view.config.permissionPreset = "default";
  view.meta = {
    cwd: "Z:/repo",
    workspaceRoot: "Z:/repo",
    formatVersion: 1,
    nocturneVersion: "test",
  };
  const props = { view, context: { used: 210, limit: 1000 }, speed: "48 tok/s", width: 100 };
  const screen = render(createElement(StatusBar, props));
  await vi.waitFor(() => expect(screen.lastFrame()).toContain("██░░░░░░ • 48 tok/s"));
  const allWidth = stringWidth(screen.lastFrame() ?? "") + 4;
  const cases = [
    { width: allWidth - 1, speed: false, bar: true, dir: true },
    { width: allWidth - 12, speed: false, bar: false, dir: true },
    { width: allWidth - 21, speed: false, bar: false, dir: false },
  ];
  for (const test of cases) {
    screen.rerender(createElement(StatusBar, { ...props, width: test.width }));
    await vi.waitFor(() => expect((screen.lastFrame() ?? "").includes("tok/s")).toBe(test.speed));
    await vi.waitFor(() => expect((screen.lastFrame() ?? "").includes("░")).toBe(test.bar));
    expect((screen.lastFrame() ?? "").includes("Z:/repo")).toBe(test.dir);
  }
  screen.rerender(
    createElement(
      TuiEnvContext.Provider,
      { value: { ascii: true, animated: false } },
      createElement(StatusBar, props),
    ),
  );
  await vi.waitFor(() => expect(screen.lastFrame()).toContain("[##------] - 48 tok/s"));
  const colors: (string | undefined)[] = [];
  function InspectBar({ used }: { used: number }) {
    const tree = StatusBar({ ...props, context: { used, limit: 100 } });
    colors.length = 0;
    const inspect = (node: ReactNode): void => {
      Children.forEach(node, (child) => {
        if (!isValidElement<{ children?: ReactNode; color?: string }>(child)) return;
        const { children, color } = child.props;
        if (typeof children === "string" && /^[█░]+$/.test(children)) colors.push(color);
        inspect(children);
      });
    };
    inspect(tree);
    return tree;
  }
  screen.rerender(createElement(InspectBar, { used: 79 }));
  await vi.waitFor(() => expect(colors).toEqual([palettes.dark.secondary, palettes.dark.muted]));
  screen.rerender(createElement(InspectBar, { used: 80 }));
  await vi.waitFor(() => expect(colors).toEqual([palettes.dark.warning, palettes.dark.warning]));
  screen.unmount();
});

it.each([false, true])("助手标记与续行缩进，代码、表格和列表按少两列布局（ascii=%s）", (ascii) => {
  const text =
    "第一行很长需要折行甲乙丙丁\n第二行\n\n```ts\nconst answer = 42;\n```\n\n- 列表的长文本需要自动折行\n\n| 名称 | 值 |\n| --- | --- |\n| 比较长的名称 | 很长的值 |";
  const lines = renderAssistant(text, 24, "a", ascii);
  expect(lines[0]?.text.startsWith(ascii ? "o " : "● ")).toBe(true);
  expect(lines[0]?.segments?.[0]?.color).toBe(palettes.dark.accent);
  expect(lines[0]?.segments?.[0]?.bold).not.toBe(true);
  expect(lines.slice(1).every((line) => line.text.startsWith("  "))).toBe(true);
  expect(lines.every((line) => stringWidth(line.text) <= 20)).toBe(true);
  expect(lines.some((line) => line.text.includes("│ const"))).toBe(true);
  expect(lines.some((line) => line.text.includes("• 列表"))).toBe(true);
  expect(lines.some((line) => line.text.includes("名称："))).toBe(true); // 表格按缩窄后的宽度退为逐项。
  expect(renderAssistant("后续正文", 24, "b", ascii, undefined, true)[0]?.text).toBe("  后续正文");
});

it("锚点按标题首行保持屏幕行，视口上方的标题成为新顶部", () => {
  const blocks: LineBlock[] = [
    {
      key: "all",
      revision: "1",
      layout: () => Array.from({ length: 30 }, (_, i) => ({ key: String(i), text: String(i) })),
    },
  ];
  const cache = new Map();
  const offset = anchorFromBottom(blocks, 80, 10, "12", 3, cache);
  expect(selectVisible(blocks, 80, 10, offset, cache).lines[3]?.key).toBe("12");
  const above = anchorFromBottom(blocks, 80, 10, "12", -1, cache);
  expect(selectVisible(blocks, 80, 10, above, cache).lines[0]?.key).toBe("12");
});

it("速度订阅只显示本次到达的生成，最多每秒更新，切换会话清空", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(0);
  try {
    const listeners = new Set<(event: RuntimeEvent) => void>();
    const session = {
      subscribe(fn: (event: RuntimeEvent) => void) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    } as unknown as RuntimeSession;
    function Harness({ source }: { source: RuntimeSession }) {
      const speed = useGenerationSpeed(source);
      return createElement(StatusBar, {
        view: createSessionView(),
        width: 100,
        context: { used: 0 },
        speed,
      });
    }
    const screen = render(createElement(Harness, { source: session }));
    await vi.waitFor(() => expect(screen.lastFrame()).toContain("idle"));
    await vi.waitFor(() => expect(listeners.size).toBe(1));
    const emit = (event: RuntimeEvent) => listeners.forEach((fn) => fn(event));
    const started = Date.now();
    emit({
      type: "message.assistant.delta",
      payload: { messageId: "a", kind: "reasoning", delta: "中文" },
    } as RuntimeEvent);
    await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0));
    vi.advanceTimersByTime(1000);
    await vi.waitFor(() => expect(screen.lastFrame()).toContain("~2 tok/s"));
    emit({
      type: "message.assistant.delta",
      payload: { messageId: "a", kind: "text", delta: "abcd" },
    } as RuntimeEvent);
    expect(screen.lastFrame()).toContain("~2 tok/s");
    vi.setSystemTime(started + 1000);
    emit({
      type: "message.assistant",
      payload: { messageId: "a", usage: { outputTokens: 48 } },
    } as RuntimeEvent);
    await vi.waitFor(() => expect(screen.lastFrame()).toContain("48 tok/s"));
    expect(screen.lastFrame()).not.toContain("~");
    const next = { subscribe: () => vi.fn() } as unknown as RuntimeSession;
    screen.rerender(createElement(Harness, { source: next }));
    await vi.waitFor(() => expect(screen.lastFrame()).not.toContain("tok/s"));
    screen.unmount();
  } finally {
    vi.useRealTimers();
  }
});
