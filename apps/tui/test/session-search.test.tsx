/**
 * TUI 跨会话搜索（ADR-0077 修订、tui.md §6）离线集成测试：
 * 最近会话、150ms 防抖与增量不跳选中、取消旧查询、跨会话/本会话打开定位与工具行展开、
 * Esc 保留输入框文字、`没有结果` 空状态与零多余文案。
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";

import { render } from "ink-testing-library";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createRuntime,
  FakeProvider,
  type RuntimeSession,
  type SessionSearchOptions,
  type SessionSearchResult,
} from "@nocturne/core";

import { App } from "../src/app.js";
import { palettes } from "../src/theme.js";
import type { SwitchSessionFn } from "../src/types.js";
import { internalSession } from "./internal-session.js";

const inkChalkPromise = (async (): Promise<{ level: 0 | 1 | 2 | 3 }> => {
  const inkEntry = import.meta.resolve("ink");
  const req = createRequire(inkEntry);
  const chalkPath = req.resolve("chalk");
  const mod = (await import(pathToFileURL(chalkPath).href)) as {
    default: { level: 0 | 1 | 2 | 3 };
  };
  return mod.default;
})();

const tmpRoots: string[] = [];
let savedChalkLevel: 0 | 1 | 2 | 3 = 0;
beforeEach(async () => {
  const chalk = await inkChalkPromise;
  savedChalkLevel = chalk.level;
  chalk.level = 3;
  vi.stubEnv("NOCTURNE_HOME", makeTmp("nct-tui-search-home-"));
});
afterEach(async () => {
  const chalk = await inkChalkPromise;
  chalk.level = savedChalkLevel;
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const r of tmpRoots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function makeTmp(prefix: string): string {
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), prefix)));
  tmpRoots.push(dir);
  return dir;
}

const ENV = { ascii: false, animated: false };

function plainFrame(raw: string | undefined): string {
  return stripVTControlCharacters(raw ?? "");
}

function fgSgr(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
}

function bgSgr(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `\x1b[48;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
}

/**
 * ConfirmBox（confirm-box.tsx §70-85）以 `{ color: theme.selected, backgroundColor: theme.selectionBg }`
 * 渲染当前焦点按钮（`[取消]` 或 `[确认]`），非焦点按钮仅用 `{ color: theme.text }`。
 */
const CONFIRM_FOCUSED_SGR = `${bgSgr(palettes.dark.selectionBg)}${fgSgr(palettes.dark.selected)}`;

function maybeDumpFrame(fileName: string, raw: string | undefined): void {
  const dumpDir = process.env["NOCTURNE_DUMP_FRAMES_DIR"];
  if (!dumpDir) return;
  mkdirSync(dumpDir, { recursive: true });
  writeFileSync(path.join(dumpDir, fileName), `${plainFrame(raw)}\n`, "utf8");
}

async function seedUserText(session: RuntimeSession, text: string): Promise<void> {
  await internalSession(session).emit("message.user", {
    messageId: `u-${Math.random().toString(36).slice(2, 8)}`,
    content: [{ type: "text", text }],
  });
}

async function seedLongToolAndTailTurns(
  session: RuntimeSession,
  markerFirstLine: string,
  turnCountAfter = 18,
): Promise<void> {
  const toolLines = [
    markerFirstLine,
    ...Array.from({ length: 9 }, (_, i) => `tool-output-line-${i + 2}`),
  ].join("\n");
  await internalSession(session).emit("message.user", {
    messageId: "u-seed-0",
    content: [{ type: "text", text: "排查线上日志超时问题" }],
  });
  await internalSession(session).emit("tool.started", {
    callId: "call-target",
    name: "shell",
    input: { command: "rg needle logs/app.log" },
    subjects: [],
    permission: { action: "allow", source: "rule" },
  });
  await internalSession(session).emit("tool.completed", {
    callId: "call-target",
    name: "shell",
    status: "ok",
    modelContent: toolLines,
    output: { exitCode: 0 },
  });
  for (let i = 0; i < turnCountAfter; i++) {
    await internalSession(session).emit("message.user", {
      messageId: `u-tail-${i}`,
      content: [{ type: "text", text: `后续对话轮次 #${i + 1}` }],
    });
    await internalSession(session).emit("message.assistant", {
      messageId: `a-tail-${i}`,
      model: { provider: "fake", model: "fake-model" },
      content: [{ type: "text", text: `已完成步骤说明 #${i + 1}` }],
      toolCalls: [],
      finishReason: "stop",
    });
  }
}

describe("TUI /search 跨会话搜索", () => {
  it("无查询时列出最多 8 条未归档最近会话：同目录不显示路径，异目录显示路径", async () => {
    const cwdA = makeTmp("ws-cur-");
    const cwdB = makeTmp("ws-foreign-");
    const sessionsDir = makeTmp("sd-recent-");

    const runtimeB = await createRuntime({
      cwd: cwdB,
      sessionsDir,
      providers: [new FakeProvider({ scripts: [] })],
    });
    const foreignSession = await runtimeB.createSession({ model: "fake/fake-model" });
    await seedUserText(foreignSession, "异目录部署脚本重构");
    await foreignSession.close();

    const runtime = await createRuntime({
      cwd: cwdA,
      sessionsDir,
      providers: [new FakeProvider({ scripts: [] })],
    });

    // 建 9 个同目录历史会话 + 1 个归档会话，连同当前会话与异目录会话共 > 8 条未归档
    const archived = await runtime.createSession({ model: "fake/fake-model" });
    await seedUserText(archived, "已归档旧方案记录");
    await archived.close();
    await runtime.archiveSession(archived.id);

    for (let i = 0; i < 8; i++) {
      const s = await runtime.createSession({ model: "fake/fake-model" });
      await seedUserText(s, `历史会话条目-${i + 1}`);
      await s.close();
    }

    const current = await runtime.createSession({ model: "fake/fake-model" });
    await seedUserText(current, "当前目录主会话");

    // 让异目录会话与当前会话拥有最新 mtime，排进前 8
    const reopenedForeign = await runtimeB.resumeSession(foreignSession.id);
    await seedUserText(reopenedForeign, "追加异目录进度");
    await reopenedForeign.close();

    const screen = render(createElement(App, { session: current, runtime, env: ENV }));
    try {
      await vi.waitFor(() => expect(plainFrame(screen.lastFrame())).toContain("当前目录主会话"));
      screen.stdin.write("/search");
      await vi.waitFor(() => expect(plainFrame(screen.lastFrame())).toContain("/search"));
      screen.stdin.write("\r");

      await vi.waitFor(() => {
        const frame = plainFrame(screen.lastFrame());
        expect(frame).toContain("› 异目录部署脚本重构");
        expect(frame).toContain(cwdB);
      });

      const frame = plainFrame(screen.lastFrame());
      maybeDumpFrame("01-recent-sessions.txt", screen.lastFrame());

      // 当前目录会话不显示 cwdA 路径（注意状态栏只显示 basename，框内列表行不含完整 cwdA）
      const boxLines = frame.split("\n").filter((line) => line.includes("当前目录主会话"));
      expect(boxLines.length).toBeGreaterThan(0);
      for (const line of boxLines) {
        expect(line).not.toContain(cwdA);
      }
      // 归档会话不在未输入最近列表里
      expect(frame).not.toContain("已归档旧方案记录");
      // 最多 8 条：最早的 历史会话条目-1 与 历史会话条目-2 被挤出前 8
      expect(frame).not.toContain("历史会话条目-1");
      expect(frame).not.toContain("历史会话条目-2");
      // 文案硬约束：无标题、无快捷键说明、无计数
      expect(frame).not.toContain("上下选择");
      expect(frame).not.toContain("搜索中");
    } finally {
      screen.unmount();
      await current.close();
    }
  });

  it("输入后 150ms 防抖、第一批前保留旧列表、增量追加不跳选中、输入变化回到首行", async () => {
    const cwd = makeTmp("ws-debounce-");
    const sessionsDir = makeTmp("sd-debounce-");
    const runtime = await createRuntime({
      cwd,
      sessionsDir,
      providers: [new FakeProvider({ scripts: [] })],
    });

    const s1 = await runtime.createSession({ model: "fake/fake-model" });
    await seedUserText(s1, "一号会话鉴权模块");
    await s1.close();

    const s2 = await runtime.createSession({ model: "fake/fake-model" });
    await seedUserText(s2, "二号会话支付网关");
    await s2.close();

    const s3 = await runtime.createSession({ model: "fake/fake-model" });
    await seedUserText(s3, "三号会话网关重试");
    await s3.close();

    const current = await runtime.createSession({ model: "fake/fake-model" });
    await seedUserText(current, "主控台会话");

    let pushBatch!: (batch: SessionSearchResult[]) => void;
    let finishFirst!: (all: SessionSearchResult[]) => void;
    const searchCalls: { query: string; options?: SessionSearchOptions | undefined }[] = [];

    vi.spyOn(runtime, "searchSessions").mockImplementation((query, options) => {
      searchCalls.push({ query, options });
      if (searchCalls.length === 1) {
        pushBatch = (batch) => options?.onProgress?.(batch);
        return new Promise<SessionSearchResult[]>((resolve) => {
          finishFirst = resolve;
        });
      }
      const secondBatch: SessionSearchResult[] = [
        {
          sessionId: s3.id,
          mtimeMs: 300,
          seq: 1,
          snippet: "命中新词 alpha 重试策略",
          ranges: [{ start: 5, end: 10 }],
        },
        {
          sessionId: s1.id,
          mtimeMs: 100,
        },
      ];
      options?.onProgress?.(secondBatch);
      return Promise.resolve(secondBatch);
    });

    const screen = render(createElement(App, { session: current, runtime, env: ENV }));
    try {
      await vi.waitFor(() => expect(plainFrame(screen.lastFrame())).toContain("主控台会话"));

      screen.stdin.write("/search");
      await vi.waitFor(() => expect(plainFrame(screen.lastFrame())).toContain("/search"));
      screen.stdin.write("\r");
      await vi.waitFor(() => {
        const f = plainFrame(screen.lastFrame());
        expect(f).toContain("› 主控台会话");
        expect(f).toContain("一号会话鉴权模块");
      });

      // 启用假时钟精确校验 150ms 防抖合同
      vi.useFakeTimers();

      // 连续输入 g -> a -> t，每次间隔 80ms（< 150ms），防抖期间不触发 searchSessions，且保留最近列表
      screen.stdin.write("g");
      await vi.advanceTimersByTimeAsync(80);
      expect(plainFrame(screen.lastFrame())).toContain("› g");
      expect(searchCalls).toHaveLength(0);

      screen.stdin.write("a");
      await vi.advanceTimersByTimeAsync(80);
      expect(plainFrame(screen.lastFrame())).toContain("› ga");
      expect(searchCalls).toHaveLength(0);

      screen.stdin.write("t");
      await vi.advanceTimersByTimeAsync(140);
      expect(plainFrame(screen.lastFrame())).toContain("› gat");
      expect(searchCalls).toHaveLength(0);
      expect(plainFrame(screen.lastFrame())).toContain("一号会话鉴权模块");

      // 满 150ms：发起查询 "gat"，第一批尚未到达前仍保留最近列表
      await vi.advanceTimersByTimeAsync(20);
      expect(searchCalls).toHaveLength(1);
      expect(searchCalls[0]?.query).toBe("gat");
      expect(plainFrame(screen.lastFrame())).toContain("一号会话鉴权模块");

      // 恢复真实时钟，后续全以 vi.waitFor 等待具体帧内容
      vi.useRealTimers();

      // 第一批到达（s1、s2）：替换最近列表
      const batch1: SessionSearchResult[] = [
        {
          sessionId: s1.id,
          mtimeMs: 200,
          seq: 1,
          snippet: "鉴权里的 gat 令牌校验",
          ranges: [{ start: 5, end: 8 }],
        },
        {
          sessionId: s2.id,
          mtimeMs: 190,
          seq: 1,
          snippet: "支付网关 gat 路由规则",
          ranges: [{ start: 5, end: 8 }],
        },
      ];
      pushBatch(batch1);
      await vi.waitFor(() => {
        const f = plainFrame(screen.lastFrame());
        expect(f).toContain("› 一号会话鉴权模块");
        expect(f).toContain("鉴权里的 gat 令牌校验");
        expect(f).toContain("支付网关 gat 路由规则");
        expect(f).not.toContain("主控台会话  刚刚");
      });

      // 按 ↓ 选中第 2 项（二号会话支付网关）
      screen.stdin.write("\x1b[B");
      await vi.waitFor(() => expect(plainFrame(screen.lastFrame())).toMatch(/› 二号会话支付网关/));

      // 第二批追加（s3）：选中项仍按 sessionId 停留在「二号会话支付网关」，不跳回第一行
      const batch2: SessionSearchResult[] = [
        {
          sessionId: s3.id,
          mtimeMs: 180,
          seq: 1,
          snippet: "网关重试 gat 退避时间",
          ranges: [{ start: 5, end: 8 }],
        },
      ];
      pushBatch(batch2);
      finishFirst([...batch1, ...batch2]);
      await vi.waitFor(() => {
        const f = plainFrame(screen.lastFrame());
        expect(f).toContain("网关重试 gat 退避时间");
        expect(f).toMatch(/› 二号会话支付网关/);
      });
      maybeDumpFrame("02-results-with-snippet.txt", screen.lastFrame());

      // 继续输入字符改变查询：选中回到第一行
      screen.stdin.write("e");
      await vi.waitFor(() => {
        const f = plainFrame(screen.lastFrame());
        expect(f).toContain("› gate");
        expect(f).toContain("命中新词 alpha 重试策略");
        expect(f).toMatch(/› 三号会话网关重试/);
      });
    } finally {
      screen.unmount();
      await current.close();
    }
  });

  it("新输入立即取消上一次进行中的查询，旧结果不会覆盖新列表", async () => {
    const cwd = makeTmp("ws-abort-");
    const sessionsDir = makeTmp("sd-abort-");
    const runtime = await createRuntime({
      cwd,
      sessionsDir,
      providers: [new FakeProvider({ scripts: [] })],
    });

    const sOld = await runtime.createSession({ model: "fake/fake-model" });
    await seedUserText(sOld, "旧查询专属会话");
    await sOld.close();

    const sNew = await runtime.createSession({ model: "fake/fake-model" });
    await seedUserText(sNew, "新查询命中会话");
    await sNew.close();

    const current = await runtime.createSession({ model: "fake/fake-model" });
    await seedUserText(current, "当前工作会话");

    const signals: AbortSignal[] = [];
    let staleProgress!: (batch: SessionSearchResult[]) => void;

    vi.spyOn(runtime, "searchSessions").mockImplementation((query, options) => {
      if (options?.signal) signals.push(options.signal);
      if (query === "old") {
        staleProgress = (batch) => options?.onProgress?.(batch);
        return new Promise<SessionSearchResult[]>(() => {
          // 模拟慢扫描未完成
        });
      }
      const hit: SessionSearchResult[] = [
        {
          sessionId: sNew.id,
          mtimeMs: 200,
          seq: 1,
          snippet: "最新关键字 oldx 命中内容",
          ranges: [{ start: 6, end: 10 }],
        },
      ];
      options?.onProgress?.(hit);
      return Promise.resolve(hit);
    });

    const screen = render(createElement(App, { session: current, runtime, env: ENV }));
    try {
      await vi.waitFor(() => expect(plainFrame(screen.lastFrame())).toContain("当前工作会话"));
      screen.stdin.write("/search old");
      await vi.waitFor(() => expect(plainFrame(screen.lastFrame())).toContain("/search old"));
      screen.stdin.write("\r");

      await vi.waitFor(() => {
        expect(plainFrame(screen.lastFrame())).toContain("│› old");
        expect(signals).toHaveLength(1);
      });
      expect(signals[0]?.aborted).toBe(false);

      // 追加输入 'x' -> 查询变为 "oldx"，旧查询立即 abort
      screen.stdin.write("x");
      await vi.waitFor(() => {
        expect(plainFrame(screen.lastFrame())).toContain("│› oldx");
        expect(signals[0]?.aborted).toBe(true);
      });

      // 即使旧查询迟到回调触发，也不会污染界面
      staleProgress([{ sessionId: sOld.id, mtimeMs: 100 }]);

      await vi.waitFor(() => {
        const f = plainFrame(screen.lastFrame());
        expect(f).toContain("最新关键字 oldx 命中内容");
        expect(f).not.toContain("旧查询专属会话");
      });
    } finally {
      screen.unmount();
      await current.close();
    }
  });

  it("Enter 打开跨会话结果：经 switchSession 切换、滚到 seq 可见位置并展开默认折叠的工具行", async () => {
    const cwd = makeTmp("ws-open-");
    const sessionsDir = makeTmp("sd-open-");
    const runtime = await createRuntime({
      cwd,
      sessionsDir,
      providers: [new FakeProvider({ scripts: [] })],
    });

    const target = await runtime.createSession({ model: "fake/fake-model" });
    await seedLongToolAndTailTurns(target, "UNIQUE_FOLDED_NEEDLE_LINE_1", 16);
    const targetId = target.id;
    await target.close();

    const current = await runtime.createSession({ model: "fake/fake-model" });
    await seedUserText(current, "起始空会话提问");

    let active = current;
    const switchSession = vi.fn<SwitchSessionFn>(async (id) => {
      const next = await runtime.resumeSession(id);
      await active.close();
      active = next;
      return { kind: "ok", session: next };
    });

    const screen = render(
      createElement(App, {
        session: current,
        runtime,
        env: ENV,
        inline: false,
        switchSession,
      }),
    );
    try {
      await vi.waitFor(() => expect(plainFrame(screen.lastFrame())).toContain("起始空会话提问"));

      // 用 /search <词> 打开，预填并立即搜索到默认被折叠隐藏的第 1 行工具输出
      screen.stdin.write("/search UNIQUE_FOLDED_NEEDLE_LINE_1");
      await vi.waitFor(() =>
        expect(plainFrame(screen.lastFrame())).toContain("/search UNIQUE_FOLDED_NEEDLE_LINE_1"),
      );
      screen.stdin.write("\r");

      await vi.waitFor(() => {
        const f = plainFrame(screen.lastFrame());
        expect(f).toMatch(/› 排查线上日志超时问题/);
        expect(f).toContain("UNIQUE_FOLDED_NEEDLE_LINE_1");
      });

      // 按 Enter 打开该跨会话结果
      screen.stdin.write("\r");

      await vi.waitFor(() => {
        expect(switchSession).toHaveBeenCalledWith(targetId, { allowForeign: false });
        const f = plainFrame(screen.lastFrame());
        // 视口已滚到会话前部的工具条目，且工具已展开（默认只展示最后 4 行，第 1 行只有展开才可见）
        expect(f).toContain("rg needle logs/app.log");
        expect(f).toContain("UNIQUE_FOLDED_NEEDLE_LINE_1");
        expect(f).toContain("tool-output-line-2");
      });
      maybeDumpFrame("04-opened-tool-expanded.txt", screen.lastFrame());
    } finally {
      screen.unmount();
      await active.close();
    }
  });

  it("跨目录结果经确认框切换后仍定位到 seq；只命中标题的结果按正常底部位置打开", async () => {
    const cwdCur = makeTmp("ws-cur-f-");
    const cwdOther = makeTmp("ws-other-f-");
    const sessionsDir = makeTmp("sd-foreign-open-");

    const runtimeOther = await createRuntime({
      cwd: cwdOther,
      sessionsDir,
      providers: [new FakeProvider({ scripts: [] })],
    });
    const foreignHit = await runtimeOther.createSession({ model: "fake/fake-model" });
    await seedLongToolAndTailTurns(foreignHit, "FOREIGN_TOOL_EXPAND_LINE_1", 16);
    await foreignHit.close();

    const runtime = await createRuntime({
      cwd: cwdCur,
      sessionsDir,
      providers: [new FakeProvider({ scripts: [] })],
    });
    const titleOnly = await runtime.createSession({ model: "fake/fake-model" });
    await seedLongToolAndTailTurns(titleOnly, "UNRELATED_TOOL_OUTPUT", 16);
    await runtime.renameSession(titleOnly.id, "专属标题命中词ONLYTITLE");
    await titleOnly.close();

    const current = await runtime.createSession({ model: "fake/fake-model" });
    await seedUserText(current, "初始会话");

    let active = current;
    const switchSession = vi.fn<SwitchSessionFn>(async (id, opts) => {
      if (id === foreignHit.id && opts?.allowForeign !== true) {
        return { kind: "foreign", workspaceRoot: cwdOther };
      }
      const next = await runtime.resumeSession(id);
      await active.close();
      active = next;
      return { kind: "ok", session: next };
    });

    const screen = render(
      createElement(App, {
        session: current,
        runtime,
        env: ENV,
        inline: false,
        switchSession,
      }),
    );
    try {
      await vi.waitFor(() => expect(plainFrame(screen.lastFrame())).toContain("初始会话"));

      // 1. 打开跨目录结果 → 先弹确认框 → 选确认 → 切换并展开工具行定位到 seq
      screen.stdin.write("/search FOREIGN_TOOL_EXPAND_LINE_1");
      await vi.waitFor(() =>
        expect(plainFrame(screen.lastFrame())).toContain("/search FOREIGN_TOOL_EXPAND_LINE_1"),
      );
      screen.stdin.write("\r");
      await vi.waitFor(() =>
        expect(plainFrame(screen.lastFrame())).toMatch(/› 排查线上日志超时问题/),
      );
      screen.stdin.write("\r");

      // 等待 ConfirmBox 渲染：默认焦点在 [取消]
      await vi.waitFor(() => {
        const raw = screen.lastFrame() ?? "";
        expect(plainFrame(raw)).toContain("与当前目录不同");
        expect(raw).toContain(`${CONFIRM_FOCUSED_SGR}[取消]`);
        expect(raw).not.toContain(`${CONFIRM_FOCUSED_SGR}[确认]`);
      });

      // 按 Tab 将焦点切到 [确认]，等到帧里 [确认] 带上焦点 SGR 且 [取消] 失去焦点 SGR 后再按回车
      screen.stdin.write("\t");
      await vi.waitFor(() => {
        const raw = screen.lastFrame() ?? "";
        expect(raw).toContain(`${CONFIRM_FOCUSED_SGR}[确认]`);
        expect(raw).not.toContain(`${CONFIRM_FOCUSED_SGR}[取消]`);
      });
      screen.stdin.write("\r");

      await vi.waitFor(() => {
        const f = plainFrame(screen.lastFrame());
        expect(f).toContain("FOREIGN_TOOL_EXPAND_LINE_1");
        expect(f).toContain("tool-output-line-2");
      });

      // 2. 打开只命中标题的结果（无 seq）：按正常底部位置打开，显示最后一轮 #16
      screen.stdin.write("\x15");
      await vi.waitFor(() =>
        expect(plainFrame(screen.lastFrame())).not.toContain("/search FOREIGN_TOOL_EXPAND_LINE_1"),
      );
      screen.stdin.write("/search ONLYTITLE");
      await vi.waitFor(() => expect(plainFrame(screen.lastFrame())).toContain("/search ONLYTITLE"));
      screen.stdin.write("\r");
      await vi.waitFor(() =>
        expect(plainFrame(screen.lastFrame())).toMatch(/› 专属标题命中词ONLYTITLE/),
      );
      screen.stdin.write("\r");

      await vi.waitFor(() => {
        const f = plainFrame(screen.lastFrame());
        expect(f).toContain("后续对话轮次 #16");
        expect(f).not.toContain("UNRELATED_TOOL_OUTPUT");
      });
    } finally {
      screen.unmount();
      await active.close();
    }
  });

  it("命中当前会话时不调用 switchSession，只原位滚动到 seq 并展开工具行", async () => {
    const cwd = makeTmp("ws-same-");
    const sessionsDir = makeTmp("sd-same-");
    const runtime = await createRuntime({
      cwd,
      sessionsDir,
      providers: [new FakeProvider({ scripts: [] })],
    });

    const current = await runtime.createSession({ model: "fake/fake-model" });
    await seedLongToolAndTailTurns(current, "SAME_SESSION_HIDDEN_HEAD_LINE", 16);

    const switchSession = vi.fn<SwitchSessionFn>(async () => ({
      kind: "error",
      message: "不应触发切换",
    }));

    const screen = render(
      createElement(App, {
        session: current,
        runtime,
        env: ENV,
        inline: false,
        switchSession,
      }),
    );
    try {
      // 初始跟随底部：看到最后一轮，看不到早先折叠的工具第 1 行
      await vi.waitFor(() => expect(plainFrame(screen.lastFrame())).toContain("后续对话轮次 #16"));
      expect(plainFrame(screen.lastFrame())).not.toContain("SAME_SESSION_HIDDEN_HEAD_LINE");

      screen.stdin.write("/search SAME_SESSION_HIDDEN_HEAD_LINE");
      await vi.waitFor(() =>
        expect(plainFrame(screen.lastFrame())).toContain("/search SAME_SESSION_HIDDEN_HEAD_LINE"),
      );
      screen.stdin.write("\r");

      await vi.waitFor(() =>
        expect(plainFrame(screen.lastFrame())).toMatch(/› 排查线上日志超时问题/),
      );

      // 按 Enter：不切换会话，直接在当前会话定位并展开工具行
      screen.stdin.write("\r");

      await vi.waitFor(() => {
        const f = plainFrame(screen.lastFrame());
        expect(f).toContain("SAME_SESSION_HIDDEN_HEAD_LINE");
        expect(f).toContain("tool-output-line-2");
      });
      expect(switchSession).not.toHaveBeenCalled();
      expect(plainFrame(screen.lastFrame())).not.toContain("已切换到会话");
    } finally {
      screen.unmount();
      await current.close();
    }
  });

  it("Esc 关闭浮层后保留输入框文字；扫描结束无结果时显示「没有结果」，扫描中无进度文案", async () => {
    const cwd = makeTmp("ws-empty-");
    const sessionsDir = makeTmp("sd-empty-");
    const runtime = await createRuntime({
      cwd,
      sessionsDir,
      providers: [new FakeProvider({ scripts: [] })],
    });

    const current = await runtime.createSession({ model: "fake/fake-model" });
    await seedUserText(current, "测试保留输入与空状态");

    let finishEmpty!: (rows: SessionSearchResult[]) => void;
    vi.spyOn(runtime, "searchSessions").mockImplementation(
      () =>
        new Promise<SessionSearchResult[]>((resolve) => {
          finishEmpty = resolve;
        }),
    );

    const screen = render(
      createElement(App, { session: current, runtime, env: ENV, inline: false }),
    );
    try {
      await vi.waitFor(() =>
        expect(plainFrame(screen.lastFrame())).toContain("测试保留输入与空状态"),
      );

      screen.stdin.write("/search 绝不存在的词xyz");
      await vi.waitFor(() =>
        expect(plainFrame(screen.lastFrame())).toContain("/search 绝不存在的词xyz"),
      );
      screen.stdin.write("\r");

      // 扫描进行中：查询行已渲染，但不显示「没有结果」、「搜索中」或任何占位/快捷键文字
      await vi.waitFor(() => {
        expect(plainFrame(screen.lastFrame())).toContain("│› 绝不存在的词xyz");
        expect(runtime.searchSessions).toHaveBeenCalledTimes(1);
      });
      const scanningFrame = plainFrame(screen.lastFrame());
      expect(scanningFrame).not.toContain("没有结果");
      expect(scanningFrame).not.toContain("搜索中");
      expect(scanningFrame).not.toContain("上下选择");

      // 扫描结束返回空数组：显示「没有结果」
      finishEmpty([]);
      await vi.waitFor(() => expect(plainFrame(screen.lastFrame())).toContain("没有结果"));
      maybeDumpFrame("03-no-results.txt", screen.lastFrame());

      const emptyFrame = plainFrame(screen.lastFrame());
      expect(emptyFrame).not.toContain("上下选择");
      expect(emptyFrame).not.toContain("搜索中");

      // 按 Esc 关闭搜索浮层：底部输入框原有的 `/search 绝不存在的词xyz` 文字仍在
      screen.stdin.write("\x1b");
      await vi.waitFor(() => {
        const afterEsc = plainFrame(screen.lastFrame());
        expect(afterEsc).not.toContain("没有结果");
        expect(afterEsc).toContain("/search 绝不存在的词xyz");
      });
    } finally {
      screen.unmount();
      await current.close();
    }
  });
});
