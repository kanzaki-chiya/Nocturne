/**
 * 组曲（Suite）的 TUI 界面测试（ADR-0097 三期、tui.md）：
 * - `/suite` 列表选择器与 `<名称或 id>` 精确 / 前缀 / 不唯一 / 不存在匹配、`/suite overview` 用法提示；
 * - 组曲状态块：非空组计数、只列等你处理与进行中、标题对齐、第二段摘要四种取值、放不下时 `+N`；
 * - 汇报行渲染与全屏展开；
 * - 全屏总览页：五组、空组隐藏、「已完成」默认折叠与 Enter 展开、线程行 Enter 进线程视图、
 *   「指挥」行回指挥、`Alt+D` 调 `resolveThread`（完成 / 重开）；
 * - 线程视图提交调用指挥的 `sendToThread` 而非子会话 `submit`；
 * - 线程新待确认请求或提问时响铃一次。
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { render } from "ink-testing-library";
import { createElement } from "react";
import stringWidth from "string-width";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createRuntime,
  FakeProvider,
  type FakeScript,
  type ModelRequest,
  type Runtime,
  type RuntimeEvent,
} from "@nocturne/core";
import {
  computeSuiteThreadGroup,
  formatSuiteThreadReport,
  type SuiteRecord,
  type SuiteThreadView,
  type SuiteView,
  type ViewEntry,
} from "@nocturne/core/protocol";

import { App } from "../src/app.js";
import { SuiteOverview, type SuiteOverviewProps } from "../src/components/suite-overview.js";
import { SuiteStrip, suiteStripRows } from "../src/components/suite-strip.js";
import { EntryRow } from "../src/components/transcript.js";
import { layoutEntry } from "../src/lines.js";
import {
  BELL,
  NOTIFY_DEFAULTS,
  createSuiteThreadRingState,
  suiteThreadRing,
} from "../src/notify.js";
import {
  matchSuiteTarget,
  parseSuiteThreadReport,
  suiteStatusCounts,
  suiteThreadSecondary,
} from "../src/text-format-suite.js";
import { palettes } from "../src/theme.js";
import type { OpenSuiteFn, SwitchSessionFn } from "../src/types.js";
import { settle as settleRaw } from "./provider-test-utils.js";

const inkChalkPromise = (async (): Promise<{ level: 0 | 1 | 2 | 3 }> => {
  const req = createRequire(import.meta.resolve("ink"));
  const mod = (await import(pathToFileURL(req.resolve("chalk")).href)) as {
    default: { level: 0 | 1 | 2 | 3 };
  };
  return mod.default;
})();
let savedChalkLevel: 0 | 1 | 2 | 3 = 0;
const fg = (hex: string): string => {
  const n = Number.parseInt(hex.slice(1), 16);
  return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
};

const dirs: string[] = [];
const temp = (prefix = "nct-suite-ui-") => {
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};

beforeEach(async () => {
  const chalk = await inkChalkPromise;
  savedChalkLevel = chalk.level;
  chalk.level = 3;
  vi.stubEnv("NOCTURNE_HOME", temp("nct-suite-home-"));
});
afterEach(async () => {
  (await inkChalkPromise).level = savedChalkLevel;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ENV = { ascii: false, animated: false };
const pause = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

let currentFrame: (() => string) | undefined;
async function settle(check: () => boolean): Promise<void> {
  try {
    await settleRaw(check);
  } catch (e) {
    throw new Error(
      `${e instanceof Error ? e.message : String(e)}\n当前帧：\n${currentFrame?.() ?? ""}`,
    );
  }
}

async function press(ui: ReturnType<typeof render>, data: string): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  ui.stdin.write(data);
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function keys(ui: ReturnType<typeof render>, ...seq: string[]): Promise<void> {
  for (const data of seq) await press(ui, data);
}

function makeThread(
  id: string,
  title: string,
  over: Partial<SuiteThreadView> = {},
): SuiteThreadView {
  const base: SuiteThreadView = {
    threadId: id,
    childSessionId: `child-${id}`,
    title,
    task: `完成 ${title}`,
    workspace: "/repo",
    model: { provider: "fake", model: "claude-sonnet-4" },
    preset: "general",
    isolated: false,
    status: "idle",
    group: "idle",
    resolved: false,
    hasUnmergedWorktree: false,
    hasPendingQuestion: false,
    pendingPermissions: [],
    ...over,
  };
  base.group = over.group ?? computeSuiteThreadGroup(base);
  return base;
}

function makeSuiteView(threads: SuiteThreadView[], suiteId = "suite-1"): SuiteView {
  return {
    suiteId,
    threads,
    needsAttentionThreads: threads
      .filter((t) => t.group === "needs_attention")
      .map((t) => t.threadId),
  };
}

function makeSuiteRecord(id: string, name: string, over: Partial<SuiteRecord> = {}): SuiteRecord {
  return {
    version: 1,
    id,
    name,
    workspaces: ["/repo"],
    instructions: "",
    coordinatorSessionId: `coord-${id}`,
    threadDefaults: {},
    createdAt: "2026-11-19T00:00:00.000Z",
    ...over,
  };
}

describe("组曲纯逻辑与匹配", () => {
  it("matchSuiteTarget：名称精确优先、其次唯一前缀、不唯一与不存在分别返回对应结果", () => {
    const suites = [
      makeSuiteRecord("suite-a", "插件兼容"),
      makeSuiteRecord("suite-b", "插件兼容二期"),
      makeSuiteRecord("suite-c", "发版准备"),
    ];
    expect(matchSuiteTarget(suites, "插件兼容")).toEqual({ kind: "ok", suite: suites[0] });
    expect(matchSuiteTarget(suites, "发版")).toEqual({ kind: "ok", suite: suites[2] });
    expect(matchSuiteTarget(suites, "suite-b")).toEqual({ kind: "ok", suite: suites[1] });
    const amb = matchSuiteTarget(suites, "插件");
    expect(amb.kind).toBe("ambiguous");
    if (amb.kind === "ambiguous") {
      expect(amb.matches.map((s) => s.id)).toEqual(["suite-a", "suite-b"]);
    }
    expect(matchSuiteTarget(suites, "不存在的名字")).toEqual({ kind: "not_found" });
  });

  it("suiteThreadSecondary：覆盖待确认、暂停、进行中工具活动、最近汇报首行四种取值", () => {
    const permThread = makeThread("t1", "权限线程", {
      status: "working",
      pendingPermissions: [
        {
          requestId: "r1",
          callId: "c1",
          reason: "执行命令",
          subjects: [{ kind: "shell", target: "pnpm test" }],
          options: [],
        },
      ],
    });
    expect(suiteThreadSecondary(permThread)).toEqual({
      text: "等待确认 · pnpm test",
      warn: true,
    });

    const questionThread = makeThread("t1b", "提问线程", {
      status: "working",
      hasPendingQuestion: true,
    });
    expect(suiteThreadSecondary(questionThread)).toEqual({ text: "等待确认", warn: true });

    const pausedThread = makeThread("t2", "暂停线程", {
      status: "paused",
      pauseError: { code: "upstream", message: "请求超时\n第二行详情" },
    });
    expect(suiteThreadSecondary(pausedThread)).toEqual({ text: "请求超时", warn: true });

    const runningThread = makeThread("t3", "进行中线程", {
      status: "working",
      toolActivity: { tool: "shell", detail: "vitest run" },
    });
    expect(suiteThreadSecondary(runningThread)).toEqual({
      text: "命令 vitest run",
      warn: false,
    });

    const idleThread = makeThread("t4", "空闲线程", {
      status: "idle",
      lastReportLine: "已完成接口改造并通过单测",
    });
    expect(suiteThreadSecondary(idleThread)).toEqual({
      text: "已完成接口改造并通过单测",
      warn: false,
    });
  });

  it("parseSuiteThreadReport：提取标题、首行与正文全文", () => {
    const raw = formatSuiteThreadReport({
      threadId: "t1",
      title: "设置页改造",
      status: "idle",
      body: "第一行摘要\n第二行详细结果",
    });
    expect(parseSuiteThreadReport(raw)).toEqual({
      threadId: "t1",
      title: "设置页改造",
      status: "idle",
      line: "第一行摘要",
      body: "第一行摘要\n第二行详细结果",
    });
  });
});

describe("组曲状态块（SuiteStrip）", () => {
  it("显示非空组计数，只列等你处理与进行中，标题对齐，覆盖四种第二段摘要并在放不下时写 +N", () => {
    const tPerm = makeThread("t1", "权限", {
      status: "working",
      model: { provider: "fake", model: "claude-sonnet-4" },
      pendingPermissions: [
        {
          requestId: "r1",
          callId: "c1",
          reason: "执行",
          subjects: [{ kind: "shell", target: "git push" }],
          options: [],
        },
      ],
    });
    const tPause = makeThread("t2", "很长的线程标题", {
      status: "paused",
      model: { provider: "fake", model: "gpt-5" },
      pauseError: { code: "err", message: "构建失败：缺少依赖" },
    });
    const tWork = makeThread("t3", "补全测试", {
      status: "working",
      model: { provider: "fake", model: "deepseek-chat" },
      toolActivity: { tool: "edit", detail: "src/app.tsx" },
    });
    const tWorkFallback = makeThread("t4", "等待中", {
      status: "working",
      model: { provider: "fake", model: "gpt-5" },
      lastReportLine: "上一轮汇报首行",
    });
    const tUnmerged = makeThread("t5", "待并回任务", {
      status: "idle",
      hasUnmergedWorktree: true,
      lastReportLine: "已提交到分支",
    });
    const tIdle = makeThread("t6", "空闲任务", {
      status: "idle",
      lastReportLine: "已完成",
    });
    const tResolved = makeThread("t7", "已完成任务", {
      status: "idle",
      resolved: true,
      lastReportLine: "已收尾",
    });
    const suite = makeSuiteView([tPerm, tPause, tWork, tWorkFallback, tUnmerged, tIdle, tResolved]);

    expect(suiteStatusCounts(suite.threads)).toBe(
      "等你处理 2 · 进行中 2 · 待并回 1 · 空闲 1 · 已完成 1",
    );
    expect(suiteStripRows(suite)).toBe(5);

    const uiFull = render(
      createElement(SuiteStrip, { suite, name: "插件兼容", width: 100, height: 5 }),
    );
    const rawFull = uiFull.lastFrame() ?? "";
    const plainFull = strip(rawFull);
    const lines = plainFull.split("\n");
    expect(lines[0]).toContain("◆ 插件兼容");
    expect(lines[0]).toContain("等你处理 2 · 进行中 2 · 待并回 1 · 空闲 1 · 已完成 1");
    // 只列等你处理与进行中，不列待并回/空闲/已完成
    expect(plainFull).toContain("权限");
    expect(plainFull).toContain("等待确认 · git push");
    expect(plainFull).toContain("很长的线程标题");
    expect(plainFull).toContain("构建失败：缺少依赖");
    expect(plainFull).toContain("补全测试");
    expect(plainFull).toContain("编辑 src/app.tsx");
    expect(plainFull).toContain("上一轮汇报首行");
    expect(plainFull).not.toContain("待并回任务");
    expect(plainFull).not.toContain("空闲任务");
    expect(plainFull).not.toContain("已完成任务");
    // 警告色与强调色圆点
    expect(rawFull).toContain(`${fg(palettes.dark.warning)}●`);
    expect(rawFull).toContain(`${fg(palettes.dark.accent)}●`);
    // 标题列对齐：各行模型列按终端显示宽度（宽字符占 2 列）起始位置一致
    const colOf = (line: string | undefined, token: string): number => {
      if (line === undefined) return -1;
      const idx = line.indexOf(token);
      return idx < 0 ? -1 : stringWidth(line.slice(0, idx));
    };
    const col1 = colOf(lines[1], "claude-sonnet-4");
    const col2 = colOf(lines[2], "gpt-5");
    const col3 = colOf(lines[3], "deepseek-chat");
    expect(col1).toBeGreaterThan(0);
    expect(col2).toBe(col1);
    expect(col3).toBe(col1);
    uiFull.unmount();

    // 放不下时按 +N 规则
    const uiClipped = render(
      createElement(SuiteStrip, { suite, name: "插件兼容", width: 100, height: 3 }),
    );
    const plainClipped = strip(uiClipped.lastFrame() ?? "");
    expect(plainClipped.split("\n")).toHaveLength(3);
    expect(plainClipped).toContain("+3");
    uiClipped.unmount();

    // 没有等你处理与进行中线程时只留首行
    const idleOnly = makeSuiteView([tUnmerged, tResolved]);
    expect(suiteStripRows(idleOnly)).toBe(1);
    const uiIdle = render(
      createElement(SuiteStrip, { suite: idleOnly, name: "插件兼容", width: 100, height: 1 }),
    );
    expect(strip(uiIdle.lastFrame() ?? "")).toContain("◆ 插件兼容  待并回 1 · 已完成 1");
    uiIdle.unmount();
  });
});

describe("汇报行渲染", () => {
  it("带 suiteReport 的用户消息渲染为单行（状态点 + 加粗标题 + 淡色首行），全屏展开显示汇报全文", () => {
    const thread = makeThread("t1", "设置页插件列表", { status: "idle" });
    const suite = makeSuiteView([thread]);
    const entry: Extract<ViewEntry, { kind: "user" }> = {
      kind: "user",
      key: "u-report-1",
      seq: 5,
      turnId: "turn-5",
      content: [
        {
          type: "text",
          text: formatSuiteThreadReport({
            threadId: "t1",
            title: "设置页插件列表",
            status: "idle",
            body: "已完成列表迁移与筛选\n详情：新增 12 条单测全部通过",
          }),
        },
      ],
      suiteReport: { threadId: "t1", turnId: "child-turn-1", status: "idle" },
    };

    const collapsed = layoutEntry(entry, 80, false, new Map(), 0, false, false, palettes.dark, {
      fullscreen: true,
      suite,
    });
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]?.text).not.toContain("›");
    expect(collapsed[0]?.text).not.toContain("<thread-report");
    expect(collapsed[0]?.text).toContain("● 设置页插件列表");
    expect(collapsed[0]?.text).toContain("已完成列表迁移与筛选");
    expect(collapsed[0]?.segments?.[0]?.color).toBe(palettes.dark.success);
    expect(collapsed[0]?.segments?.[1]?.bold).toBe(true);
    expect(collapsed[0]?.segments?.[2]?.dim).toBe(true);
    expect(collapsed[0]?.toggle?.id).toBe("suite-report:u-report-1");

    const expanded = layoutEntry(entry, 80, false, new Map(), 0, false, false, palettes.dark, {
      fullscreen: true,
      suite,
      reasoningExpanded: new Map([["suite-report:u-report-1", true]]),
    });
    expect(expanded.length).toBeGreaterThan(1);
    expect(expanded.map((l) => l.text).join("\n")).toContain("详情：新增 12 条单测全部通过");

    // --inline 渲染
    const inlineUi = render(createElement(EntryRow, { entry, width: 80, suite }));
    const inlineText = strip(inlineUi.lastFrame() ?? "");
    expect(inlineText).toContain("● 设置页插件列表");
    expect(inlineText).toContain("已完成列表迁移与筛选");
    expect(inlineText).not.toContain("›");
    inlineUi.unmount();
  });
});

describe("全屏总览页（SuiteOverview）", () => {
  it("五组排列、空组隐藏、「已完成」默认折叠与 Enter 展开、Enter 打开线程/指挥、Alt+D 完成/重开与失败显示", async () => {
    const tAttn = makeThread("t1", "鉴权修复", {
      status: "paused",
      pauseError: { code: "err", message: "token 过期" },
    });
    const tRun = makeThread("t2", "接口迁移", {
      status: "working",
      toolActivity: { tool: "shell", detail: "pnpm test" },
    });
    const tMerge = makeThread("t3", "样式整理", {
      status: "idle",
      hasUnmergedWorktree: true,
      lastReportLine: "改动已提交",
    });
    const tDone = makeThread("t4", "文档更新", {
      status: "idle",
      resolved: true,
      lastReportLine: "已补齐说明",
    });
    // 空闲组无线程，应隐藏
    const suite = makeSuiteView([tAttn, tRun, tMerge, tDone]);

    const onOpenThread = vi.fn();
    const onOpenCoordinator = vi.fn();
    const onResolveThread = vi.fn((_id: string, _reopen: boolean) => Promise.resolve());
    const onClose = vi.fn();

    const props: SuiteOverviewProps = {
      suite,
      name: "插件兼容",
      width: 100,
      height: 18,
      active: true,
      onClose,
      onOpenThread,
      onOpenCoordinator,
      onResolveThread,
    };

    const ui = render(createElement(SuiteOverview, props));
    const frame = () => strip(ui.lastFrame() ?? "");
    currentFrame = frame;

    try {
      await settle(() => frame().includes("插件兼容"));
      expect(frame()).toContain("等你处理  1");
      expect(frame()).toContain("进行中  1");
      expect(frame()).toContain("待并回  1");
      expect(frame()).not.toContain("空闲");
      expect(frame()).toContain("▸ 已完成  1");
      expect(frame()).not.toContain("文档更新");
      expect(frame()).toContain("指挥");
      // 界面不显示键位提示
      expect(frame()).not.toContain("Alt+D");
      expect(frame()).not.toContain("Esc");

      // 初始光标在「等你处理」组名行(0)；下移 1 到 t1 线程行(1) → Alt+D 标记完成
      await keys(ui, "\x1b[B", "\x1bd");
      await vi.waitFor(() => expect(onResolveThread).toHaveBeenCalledWith("t1", false));

      // 回车打开线程视图
      await press(ui, "\r");
      expect(onOpenThread).toHaveBeenCalledWith(tAttn);

      // 移到「已完成」组名行（索引 6：g0,t1,g1,t2,g2,t3,g4）并 Enter 展开
      await keys(ui, "\x1b[B", "\x1b[B", "\x1b[B", "\x1b[B", "\x1b[B", "\r");
      await settle(() => frame().includes("▾ 已完成  1") && frame().includes("文档更新"));

      // 下移到已完成线程 t4 → Alt+D 重开
      await keys(ui, "\x1b[B", "\x1bd");
      await vi.waitFor(() => expect(onResolveThread).toHaveBeenCalledWith("t4", true));

      // resolveThread 失败时以 `! ` 显示 Runtime 原文
      onResolveThread.mockRejectedValueOnce(new Error("线程正在运行"));
      await press(ui, "\x1bd");
      await settle(() => frame().includes("! 线程正在运行"));

      // 下移到最后一行「指挥」并 Enter 回指挥
      await keys(ui, "\x1b[B", "\r");
      expect(onOpenCoordinator).toHaveBeenCalledTimes(1);

      // Esc 关闭（Ink 裸 Esc 有序列超时窗口）
      await press(ui, "\x1b");
      await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    } finally {
      ui.unmount();
    }
  });
});

describe("组曲线程响铃（suiteThreadRing）", () => {
  const makeEvent = (
    eseq: number,
    payload: Extract<RuntimeEvent, { type: "suite.thread_updated" }>["payload"],
  ): RuntimeEvent => ({
    type: "suite.thread_updated",
    sessionId: "coord-1",
    runId: "run-1",
    afterSeq: 0,
    eseq,
    time: "2026-11-19T00:00:00.000Z",
    payload,
  });

  it("起始快照只登记不响，新待确认请求与新提问各响一次，重复/正在查看/聚焦时不响", () => {
    const state = createSuiteThreadRingState();
    const perm = (requestId: string) => ({
      requestId,
      callId: `call-${requestId}`,
      reason: "执行命令",
      subjects: [],
      options: [],
    });

    // 起始快照不响
    expect(
      suiteThreadRing(
        makeEvent(0, { threadId: "t1", status: "working", pendingPermissions: [perm("r0")] }),
        state,
        { focused: false },
        NOTIFY_DEFAULTS,
      ),
    ).toBe(false);

    // 已有 r0 再次推不响
    expect(
      suiteThreadRing(
        makeEvent(1, { threadId: "t1", status: "working", pendingPermissions: [perm("r0")] }),
        state,
        { focused: false },
        NOTIFY_DEFAULTS,
      ),
    ).toBe(false);

    // 新权限请求 r1 响一次
    expect(
      suiteThreadRing(
        makeEvent(2, { threadId: "t1", status: "working", pendingPermissions: [perm("r1")] }),
        state,
        { focused: false },
        NOTIFY_DEFAULTS,
      ),
    ).toBe(true);

    // 正在查看 t2 时新请求不重复响
    expect(
      suiteThreadRing(
        makeEvent(3, { threadId: "t2", status: "working", pendingPermissions: [perm("r2")] }),
        state,
        { focused: false, viewing: "t2" },
        NOTIFY_DEFAULTS,
      ),
    ).toBe(false);

    // 新提问响一次，保持状态期间不再响，清除后再次提问再响
    expect(
      suiteThreadRing(
        makeEvent(4, { threadId: "t1", status: "working", hasPendingQuestion: true }),
        state,
        { focused: false },
        NOTIFY_DEFAULTS,
      ),
    ).toBe(true);
    expect(
      suiteThreadRing(
        makeEvent(5, { threadId: "t1", status: "working", hasPendingQuestion: true }),
        state,
        { focused: false },
        NOTIFY_DEFAULTS,
      ),
    ).toBe(false);
    expect(
      suiteThreadRing(
        makeEvent(6, { threadId: "t1", status: "working", hasPendingQuestion: false }),
        state,
        { focused: false },
        NOTIFY_DEFAULTS,
      ),
    ).toBe(false);
    expect(
      suiteThreadRing(
        makeEvent(7, { threadId: "t1", status: "working", hasPendingQuestion: true }),
        state,
        { focused: false },
        NOTIFY_DEFAULTS,
      ),
    ).toBe(true);

    // 聚焦时不响
    expect(
      suiteThreadRing(
        makeEvent(8, { threadId: "t3", status: "working", pendingPermissions: [perm("r3")] }),
        state,
        { focused: true },
        NOTIFY_DEFAULTS,
      ),
    ).toBe(false);
  });
});

const callTool = (id: string, name: string, input: unknown): FakeScript[number] => ({
  type: "tool_call",
  toolCallId: id,
  name,
  input,
});
const stopText = (text: string): FakeScript => [
  { type: "text_delta", text },
  { type: "finish", reason: "stop" },
];

async function createSuiteTestRuntime(
  handler?: (req: ModelRequest) => FakeScript | Promise<FakeScript>,
  cwd = temp("nct-suite-cwd-"),
): Promise<{
  runtime: Runtime;
  cwd: string;
}> {
  const sessionsDir = temp("nct-suite-sd-");
  const runtime = await createRuntime({
    cwd,
    sessionsDir,
    providers: [
      new FakeProvider({
        roleHandler: () => stopText("标题"),
        ...(handler !== undefined ? { handler } : { scripts: [] }),
      }),
    ],
    interactive: true,
    subagent: { background: true },
  });
  return { runtime, cwd };
}

describe("App 集成：/suite、状态块、总览页、线程视图与响铃", () => {
  it("/suite 列表选择器列出未归档组曲并打开指挥会话；/suite <名称> 精确/前缀/不唯一匹配；非指挥会话 /suite overview 给用法提示", async () => {
    const { runtime, cwd } = await createSuiteTestRuntime();
    const plain = await runtime.createSession({ model: "fake/fake-1" });
    const s1 = await runtime.createSuite({
      name: "插件兼容",
      goal: "打通第三方插件协议",
      workspaces: [cwd],
      model: "fake/fake-1",
    });
    const s2 = await runtime.createSuite({
      name: "插件兼容二期",
      goal: "补充插件热加载",
      workspaces: [cwd],
      model: "fake/fake-1",
    });
    const s3 = await runtime.createSuite({
      name: "发版准备",
      goal: "整理 v0.54 更新日志",
      workspaces: [cwd],
      model: "fake/fake-1",
    });
    const archived = await runtime.createSuite({
      name: "旧归档组曲",
      workspaces: [cwd],
      model: "fake/fake-1",
    });
    await runtime.archiveSuite(archived.id);

    let current = plain;
    const openedIds: string[] = [];
    const openSuite: OpenSuiteFn = async (id) => {
      openedIds.push(id);
      const next = await runtime.openSuite(id);
      const prev = current;
      current = next;
      await prev.close();
      return { kind: "ok", session: next };
    };

    const ui = render(createElement(App, { session: plain, runtime, env: ENV, openSuite }));
    const frame = () => strip(ui.lastFrame() ?? "");
    currentFrame = frame;
    const enter = async (value: string) => {
      ui.stdin.write(value);
      await pause(80);
      ui.stdin.write("\r");
    };

    try {
      await settle(() => frame().includes("fake-1"));

      // 非指挥会话执行 /suite overview 给用法提示
      await enter("/suite overview");
      await settle(() => frame().includes("用法：/suite [<名称>]"));

      // 不唯一前缀提示多个匹配
      await enter("/suite 插件");
      await settle(() => frame().includes("有多个匹配"));

      // 匹配不到
      await enter("/suite 不存在的目标");
      await settle(() => frame().includes("组曲不存在：不存在的目标"));

      // 唯一前缀打开 s3
      await enter("/suite 发版");
      await settle(() => frame().includes("◆ 发版准备"));
      expect(openedIds).toEqual([s3.id]);

      // 精确匹配优先打开 s1（尽管 s2 也以「插件兼容」开头）
      await enter("/suite 插件兼容");
      await settle(() => frame().includes("◆ 插件兼容"));
      expect(openedIds).toEqual([s3.id, s1.id]);

      // /suite 弹出列表选择器：列出未归档组曲（不列归档），按 Enter 打开选中项
      await enter("/suite");
      await settle(
        () =>
          frame().includes("组曲") &&
          frame().includes("插件兼容二期") &&
          frame().includes("打通第三方插件协议"),
      );
      expect(frame()).not.toContain("旧归档组曲");
      // 列表按 createdAt 降序，定位到 s2（名称含「插件兼容二期」）并 Enter 打开
      const listed = await runtime.listSuites();
      const idxS2 = listed.findIndex((item) => item.id === s2.id);
      for (let i = 0; i < idxS2; i++) await press(ui, "\x1b[B");
      await press(ui, "\r");
      await settle(() => frame().includes("◆ 插件兼容二期"));
      expect(openedIds.at(-1)).toBe(s2.id);
    } finally {
      ui.unmount();
      await current.close();
      await runtime.close();
    }
  }, 20_000);

  it("线程视图提交调用指挥的 sendToThread 而非子会话 submit，并在新待确认请求时响铃一次", async () => {
    const cwd = temp("nct-suite-cwd-");
    let startedThread = false;
    let shellCount = 0;
    const { runtime } = await createSuiteTestRuntime((req) => {
      const lastUser =
        [...req.messages]
          .reverse()
          .find((m) => m.role === "user")
          ?.content.map((b) => (b.type === "text" ? b.text : ""))
          .join("\n") ?? "";
      if (lastUser.includes("开个线程") && !startedThread) {
        startedThread = true;
        return [
          callTool("tc-start-1", "thread_start", {
            title: "单测修复",
            task: "检查并修复失败用例",
            workspace: cwd,
          }),
          { type: "finish", reason: "tool_calls" },
        ];
      }
      if (lastUser.includes("检查并修复失败用例")) {
        return stopText("第一轮检查完毕，发现 1 处断言偏差。");
      }
      if (lastUser.includes("跑一次构建确认")) {
        const lastMsg = req.messages.at(-1);
        if (lastMsg?.role === "user") {
          shellCount += 1;
          return [
            callTool(`tc-shell-${shellCount}`, "shell", {
              command: "echo suite-ok > suite-check.txt",
            }),
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return stopText("已按指示停止。");
      }
      return stopText("收到。");
    }, cwd);

    const suite = await runtime.createSuite({
      name: "回归测试组曲",
      goal: "修复全部回归",
      workspaces: [cwd],
      model: "fake/fake-1",
      permissionPreset: "default",
    });
    const coord = await runtime.openSuite(suite.id);
    const sendToThreadSpy = vi.spyOn(coord, "sendToThread");
    const resolveThreadSpy = vi.spyOn(coord, "resolveThread");
    const coordCloseSpy = vi.spyOn(coord, "close");

    const oobWrites: string[] = [];
    const writeOob = (data: string) => {
      oobWrites.push(data);
      return true;
    };
    const focus = { focused: () => false };
    const switchSession: SwitchSessionFn = vi.fn(async () => ({
      kind: "error" as const,
      message: "取消切换",
    }));

    const ui = render(
      createElement(App, {
        session: coord,
        runtime,
        env: ENV,
        focus,
        writeOob,
        switchSession,
      }),
    );
    const frame = () => strip(ui.lastFrame() ?? "");
    currentFrame = frame;
    const enter = async (value: string) => {
      ui.stdin.write(value);
      await pause(80);
      ui.stdin.write("\r");
    };

    try {
      await settle(() => frame().includes("◆ 回归测试组曲"));
      await enter("请帮我开个线程");
      // 等待线程自动汇报回到指挥会话（汇报行出现）
      await vi.waitFor(
        () => {
          expect(frame()).toContain("单测修复");
          expect(frame()).toContain("第一轮检查完毕，发现 1 处断言偏差");
        },
        { timeout: 10_000 },
      );

      // 打开总览页，进入线程视图
      await enter("/suite overview");
      await settle(() => frame().includes("回归测试组曲") && frame().includes("空闲  1"));
      // 光标从组名行下移到线程行，Enter 打开线程视图
      await keys(ui, "\x1b[B", "\r");
      await settle(() => frame().includes("── 单测修复 ─"));

      // 取子会话句柄，监视其 submit 不应被直接调用
      const threads = coord.durableEvents().filter((e) => e.type === "suite.thread_started");
      const childId = threads[0]?.payload.childSessionId ?? "";
      const childSession = await runtime.resumeSession(childId);
      const childSubmitSpy = vi.spyOn(childSession, "submit");

      // 在线程视图输入并提交：走指挥的 sendToThread 而非子会话 submit
      await enter("跑一次构建确认");
      await vi.waitFor(
        () =>
          expect(sendToThreadSpy).toHaveBeenCalledWith(
            expect.objectContaining({ text: "跑一次构建确认" }),
          ),
        { timeout: 5000 },
      );
      expect(childSubmitSpy).not.toHaveBeenCalled();

      // 在线程视图中执行 /suite overview 回到总览页，并按「指挥」行返回指挥会话
      // （先等权限框出现后按 x 或先在权限框前看：此时权限框在线程视图弹起，先拒绝再测回总览页）
      await vi.waitFor(() => expect(frame()).toContain("echo suite-ok > suite-check.txt"), {
        timeout: 8000,
      });
      // 在线程视图拒绝权限，等本轮收束
      await press(ui, "x");
      await vi.waitFor(() => expect(frame()).not.toContain("等待权限确认"), { timeout: 8000 });

      // 线程视图里 /suite overview 回总览页
      await enter("/suite overview");
      await settle(() => frame().includes("指挥") && frame().includes("单测修复"));

      // 在总览页按 Alt+D 完成线程
      await keys(ui, "\x1b[B", "\x1bd");
      await vi.waitFor(() => expect(resolveThreadSpy).toHaveBeenCalledTimes(1), { timeout: 5000 });
      await settle(() => frame().includes("▸ 已完成  1"));

      // 此时光标在索引 1（即最后一行「指挥」），Enter 回到指挥会话
      await press(ui, "\r");
      await settle(
        () =>
          !frame().includes("▸ 已完成") &&
          !frame().includes("── 单测修复 ─") &&
          frame().includes("◆ 回归测试组曲"),
      );

      // 在指挥会话下（不查看线程）通过 sendToThread 触发该线程再次请求权限 → 响铃一次
      oobWrites.length = 0;
      const threadId = threads[0]?.payload.threadId ?? "";
      await coord.sendToThread({ thread: threadId, text: "跑一次构建确认" });
      await vi.waitFor(
        () => expect(oobWrites.filter((b) => b === BELL).length).toBeGreaterThanOrEqual(1),
        { timeout: 8000 },
      );
      await pause(120);
      expect(oobWrites.filter((b) => b === BELL)).toHaveLength(1);
      // 线程等待权限确认时指挥输入框不被抢占，状态块显示等待确认且可正常打开 /suite overview
      await vi.waitFor(
        () => expect(frame()).toContain("等待确认 · echo suite-ok > suite-check.txt"),
        {
          timeout: 5000,
        },
      );
      await enter("/suite overview");
      await settle(() => frame().includes("▾ 等你处理  1"));
      await press(ui, "\x1b");

      expect(coordCloseSpy).not.toHaveBeenCalled();
    } finally {
      ui.unmount();
      await coord.close();
      await runtime.close();
    }
  }, 30_000);

  it("--inline 显示状态块且 /suite overview 给用法提示；线程视图下 /resume 与 /new 先换回指挥再走原流程", async () => {
    const cwd = temp("nct-suite-inline-");
    let started = false;
    const { runtime } = await createSuiteTestRuntime((req) => {
      const lastUser =
        [...req.messages]
          .reverse()
          .find((m) => m.role === "user")
          ?.content.map((b) => (b.type === "text" ? b.text : ""))
          .join("\n") ?? "";
      if (lastUser.includes("启动线程") && !started) {
        started = true;
        return [
          callTool("tc-1", "thread_start", {
            title: "路由整理",
            task: "整理路由模块",
            workspace: cwd,
          }),
          { type: "finish", reason: "tool_calls" },
        ];
      }
      if (lastUser.includes("整理路由模块")) return stopText("路由模块整理完成。");
      return stopText("好。");
    }, cwd);

    const suite = await runtime.createSuite({
      name: "路由重构",
      workspaces: [cwd],
      model: "fake/fake-1",
    });
    const coord = await runtime.openSuite(suite.id);

    // 1. --inline 显示状态块，/suite overview 给用法提示
    const inlineUi = render(
      createElement(App, { session: coord, runtime, env: ENV, inline: true }),
    );
    const inlineFrame = () => strip(inlineUi.lastFrame() ?? "");
    currentFrame = inlineFrame;
    try {
      await settle(() => inlineFrame().includes("◆ 路由重构"));
      inlineUi.stdin.write("/suite overview");
      await pause(80);
      inlineUi.stdin.write("\r");
      await settle(() => inlineFrame().includes("用法：/suite [<名称>]"));
    } finally {
      inlineUi.unmount();
    }

    // 2. 全屏下进入线程视图，验证 /resume 与 /new 先换回指挥再走原流程
    const switchCalls: string[] = [];
    const switchSession: SwitchSessionFn = vi.fn(async (id: string) => {
      switchCalls.push(id);
      return { kind: "error" as const, message: "测试中止切换" };
    });
    const newSession = vi.fn(async () => ({ kind: "error" as const, message: "测试中止新建" }));

    const ui = render(
      createElement(App, { session: coord, runtime, env: ENV, switchSession, newSession }),
    );
    const frame = () => strip(ui.lastFrame() ?? "");
    currentFrame = frame;
    const enter = async (value: string) => {
      ui.stdin.write(value);
      await pause(80);
      ui.stdin.write("\r");
    };

    try {
      await settle(() => frame().includes("◆ 路由重构"));
      await enter("请启动线程");
      await vi.waitFor(() => expect(frame()).toContain("路由模块整理完成"), { timeout: 10_000 });

      await enter("/suite overview");
      await settle(() => frame().includes("空闲  1"));
      await keys(ui, "\x1b[B", "\r");
      await settle(() => frame().includes("── 路由整理 ─"));

      // 线程视图里 /resume <id>：先换回指挥视图再调用 switchSession
      await enter("/resume other-session");
      await settle(() => switchCalls.includes("other-session"));
      expect(frame()).not.toContain("── 路由整理 ─");

      // 再次进线程视图，验证 /new 先换回指挥再调用 newSession
      await enter("/suite overview");
      await settle(() => frame().includes("空闲  1"));
      await keys(ui, "\x1b[B", "\r");
      await settle(() => frame().includes("── 路由整理 ─"));

      await enter("/new");
      await settle(() => newSession.mock.calls.length === 1);
      expect(frame()).not.toContain("── 路由整理 ─");
    } finally {
      ui.unmount();
      await coord.close();
      await runtime.close();
    }
  }, 30_000);
});
