/**
 * Hook 上下文注入集成与单元契约测试（ADR-0096、hooks.md、context.md 第 3/6 节）。
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createPlatform,
  createRuntime,
  loadConfig,
  type ExternalAgentConnector,
  type Runtime,
  type RuntimeSession,
} from "../src/index.js";
import { buildContext, type InstructionSet } from "../src/context/index.js";
import { createHookRunner } from "../src/hooks/index.js";
import {
  MAX_HOOK_CONTEXT_ENTRY_CHARS,
  MAX_HOOK_CONTEXT_TOTAL_CHARS,
  replaySessionView,
  type Diagnostics,
  type HookEntry,
} from "../src/protocol/index.js";
import {
  FakeProvider,
  type FakeScript,
  type ModelInfo,
  type ModelRequest,
} from "../src/provider/index.js";
import { foldEvents } from "../src/session/index.js";
import { createProcessCleanup, removeTempDirs } from "../../../scripts/test/process-cleanup.mjs";

const processes = createProcessCleanup();
const basePlatform = processes.platform(createPlatform());
const tmpRoots: string[] = [];
const openRuntimes: Runtime[] = [];
const openSessions: RuntimeSession[] = [];

afterEach(async () => {
  for (const s of openSessions.splice(0)) {
    await s.close().catch(() => undefined);
  }
  for (const rt of openRuntimes.splice(0)) {
    await rt.close().catch(() => undefined);
  }
  await processes.cleanup();
  await removeTempDirs(tmpRoots.splice(0));
});

function isolatedPlatform(home: string) {
  return {
    ...basePlatform,
    homeDir: () => home,
    nocturneHome: () => home,
  };
}

function tmpDir(prefix = "nct-hook-ctx-"): string {
  const d = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  tmpRoots.push(d);
  return d;
}

/** 构造在指定目录写一条 JSON stdin 并从动态文件读取输出的 Hook 命令 */
function dynamicHookEntry(
  dir: string,
  name: string,
  opts?: { logInputs?: boolean },
): {
  entry: HookEntry;
  setResponse: (body: unknown, exitCode?: number) => void;
  readInputs: () => Record<string, unknown>[];
} {
  const responseFile = path.join(dir, `${name}.resp.json`);
  const inputLogFile = path.join(dir, `${name}.inputs.jsonl`);
  writeFileSync(responseFile, JSON.stringify({ code: 0, body: {} }));
  const scriptFile = path.join(dir, `${name}.cjs`);
  writeFileSync(
    scriptFile,
    `
const fs = require("node:fs");
let raw = "";
process.stdin.on("data", (d) => { raw += d; }).on("end", () => {
  ${opts?.logInputs !== false ? `fs.appendFileSync(${JSON.stringify(inputLogFile)}, raw.trim() + "\\n");` : ""}
  const cfg = JSON.parse(fs.readFileSync(${JSON.stringify(responseFile)}, "utf8"));
  if (cfg.code !== 0) process.exit(cfg.code);
  if (cfg.body !== undefined) {
    process.stdout.write(typeof cfg.body === "string" ? cfg.body : JSON.stringify(cfg.body));
  }
});
`,
  );
  return {
    entry: { command: "node", args: [scriptFile] },
    setResponse: (body: unknown, exitCode = 0) => {
      writeFileSync(responseFile, JSON.stringify({ code: exitCode, body }));
    },
    readInputs: () => {
      try {
        return readFileSync(inputLogFile, "utf8")
          .trim()
          .split("\n")
          .filter((l) => l !== "")
          .map((l) => JSON.parse(l) as Record<string, unknown>);
      } catch {
        return [];
      }
    },
  };
}

function echoScript(expr: string): string[] {
  return [
    "-e",
    `let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const i=JSON.parse(s);process.stdout.write(JSON.stringify((${expr})(i)))})`,
  ];
}

const done: FakeScript = [
  { type: "text_delta", text: "ok" },
  { type: "finish", reason: "stop" },
];

describe("Hook 上下文注入（ADR-0096）", () => {
  it("无 Hook 不变量：未配置任何 Hook 或点位无匹配条目时不写 hook.context 且请求/ContextReport 一致", async () => {
    const ws = tmpDir("nct-hook-inv-");
    const home = tmpDir("nct-hook-inv-home-");
    const sessionsDirNoHook = tmpDir("nct-hook-inv-s1-");
    const sessionsDirUnmatched = tmpDir("nct-hook-inv-s2-");
    const plat = isolatedPlatform(home);

    const reqs1: ModelRequest[] = [];
    const rt1 = await createRuntime({
      cwd: ws,
      sessionsDir: sessionsDirNoHook,
      config: await loadConfig(plat, { nocturneHome: home }),
      providers: [
        new FakeProvider({
          handler: (req) => {
            reqs1.push(structuredClone(req));
            return done;
          },
        }),
      ],
      turn: { retryBaseDelayMs: 1 },
    });
    openRuntimes.push(rt1);

    const reqs2: ModelRequest[] = [];
    const rt2 = await createRuntime({
      cwd: ws,
      sessionsDir: sessionsDirUnmatched,
      config: await loadConfig(plat, { nocturneHome: home }),
      hooks: {
        // 仅配置不触发本轮的工具点位，SessionStart / UserPromptSubmit 均无条目
        PreToolUse: [
          { matcher: "nonexistent", command: "node", args: ["-e", "process.stdout.write('{}')"] },
        ],
      },
      providers: [
        new FakeProvider({
          handler: (req) => {
            reqs2.push(structuredClone(req));
            return done;
          },
        }),
      ],
      turn: { retryBaseDelayMs: 1 },
    });
    openRuntimes.push(rt2);

    const s1 = await rt1.createSession({ model: "fake/fake-model" });
    const s2 = await rt2.createSession({ model: "fake/fake-model" });
    openSessions.push(s1, s2);

    await s1.submit({ text: "hello" });
    await s2.submit({ text: "hello" });

    expect(s1.durableEvents().some((e) => e.type === "hook.context")).toBe(false);
    expect(s2.durableEvents().some((e) => e.type === "hook.context")).toBe(false);
    expect(s1.durableEvents().map((e) => e.type)).toEqual(s2.durableEvents().map((e) => e.type));

    const d1 = s1.describeContext();
    const d2 = s2.describeContext();
    expect(d1.report.sections.some((sec) => sec.name === "hooks")).toBe(false);
    expect(d2.report.sections.some((sec) => sec.name === "hooks")).toBe(false);
    expect(d1.report.sections).toEqual(d2.report.sections);
    const stripDate = (sys: ModelRequest["system"] | undefined) =>
      sys?.map((b) => ({ text: b.text.replace(/Session date: .*$/m, "Session date: <fixed>") }));
    expect(stripDate(reqs1[0]?.system)).toEqual(stripDate(reqs2[0]?.system));
    expect(reqs1[0]?.messages).toEqual(reqs2[0]?.messages);
  });

  it("SessionStart 恢复与分叉快照去重：相同不写事件、变化则替换、清空写 entries: []，失败不清空", async () => {
    const ws = tmpDir("nct-hook-resume-");
    const home = tmpDir("nct-hook-resume-home-");
    const hookDir = tmpDir("nct-hook-resume-scripts-");
    const sessionsDir = tmpDir("nct-hook-resume-sess-");
    const plat = isolatedPlatform(home);
    const ss = dynamicHookEntry(hookDir, "ss");
    ss.setResponse({ additionalContext: "rule v1" });

    const requests: ModelRequest[] = [];
    const makeRt = async () =>
      createRuntime({
        cwd: ws,
        sessionsDir,
        config: await loadConfig(plat, { nocturneHome: home }),
        hooks: { SessionStart: [ss.entry] },
        providers: [
          new FakeProvider({
            handler: (req) => {
              requests.push(structuredClone(req));
              return done;
            },
          }),
        ],
        turn: { retryBaseDelayMs: 1 },
      });

    // 1. 新建：source = "startup"
    const rt1 = await makeRt();
    openRuntimes.push(rt1);
    const s1 = await rt1.createSession({ model: "fake/fake-model" });
    const sessionId = s1.id;
    const hookCtxEvents1 = s1.durableEvents().filter((e) => e.type === "hook.context");
    expect(hookCtxEvents1).toHaveLength(1);
    expect(hookCtxEvents1[0]?.payload).toEqual({
      point: "SessionStart",
      source: "startup",
      entries: [{ hook: "hook SessionStart node", text: "rule v1" }],
    });
    expect(s1.describeContext().report.sections.find((sec) => sec.name === "hooks")).toMatchObject({
      name: "hooks",
      source: "1 entries",
    });
    const sectionOrder = s1.describeContext().report.sections.map((sec) => sec.name);
    expect(sectionOrder.indexOf("hooks")).toBeGreaterThan(sectionOrder.indexOf("system"));
    expect(sectionOrder.indexOf("hooks")).toBeLessThan(sectionOrder.indexOf("environment"));
    await s1.submit({ text: "turn 1" });
    await s1.close();
    await rt1.close();

    // 2. 恢复，快照相同：不写新事件
    const rt2 = await makeRt();
    openRuntimes.push(rt2);
    const s2 = await rt2.resumeSession(sessionId);
    expect(s2.durableEvents().filter((e) => e.type === "hook.context")).toHaveLength(1);
    await s2.close();
    await rt2.close();

    // 3. 恢复，快照变化：替换快照
    ss.setResponse({ additionalContext: "rule v2" });
    const rt3 = await makeRt();
    openRuntimes.push(rt3);
    const s3 = await rt3.resumeSession(sessionId);
    const events3 = s3.durableEvents().filter((e) => e.type === "hook.context");
    expect(events3).toHaveLength(2);
    expect(events3[1]?.payload).toEqual({
      point: "SessionStart",
      source: "resume",
      entries: [{ hook: "hook SessionStart node", text: "rule v2" }],
    });
    await s3.submit({ text: "turn 2" });
    expect(
      requests
        .at(-1)
        ?.system.some((b) => b.text.includes("rule v2") && !b.text.includes("rule v1")),
    ).toBe(true);
    await s3.close();
    await rt3.close();

    // 4. 恢复，Hook 失败（非零退出）：不清空已有快照，不写 hook.context
    ss.setResponse("", 2);
    const rt4 = await makeRt();
    openRuntimes.push(rt4);
    const s4 = await rt4.resumeSession(sessionId);
    expect(s4.durableEvents().filter((e) => e.type === "hook.context")).toHaveLength(2);
    expect(s4.state().hookContext?.SessionStart?.[0]?.text).toBe("rule v2");

    // 5. 分叉首次打开：source = "fork"
    ss.setResponse({ additionalContext: "rule forked" });
    const forkedId = await rt4.forkSession(sessionId);
    const sFork = await rt4.resumeSession(forkedId);
    const forkEvents = sFork.durableEvents().filter((e) => e.type === "hook.context");
    expect(forkEvents.at(-1)?.payload).toEqual({
      point: "SessionStart",
      source: "fork",
      entries: [{ hook: "hook SessionStart node", text: "rule forked" }],
    });
    await sFork.close();
    await s4.close();
    await rt4.close();

    // 6. 恢复，Hook 成功但返回空：写 entries: [] 清空快照
    ss.setResponse({});
    const rt5 = await makeRt();
    openRuntimes.push(rt5);
    const s5 = await rt5.resumeSession(sessionId);
    openSessions.push(s5);
    const events5 = s5.durableEvents().filter((e) => e.type === "hook.context");
    expect(events5).toHaveLength(3);
    expect(events5[2]?.payload).toEqual({
      point: "SessionStart",
      source: "resume",
      entries: [],
    });
    expect(s5.describeContext().report.sections.some((sec) => sec.name === "hooks")).toBe(false);

    const inputs = ss.readInputs();
    expect(inputs.map((i) => ({ source: i.source, resumed: i.resumed }))).toEqual([
      { source: "startup", resumed: false },
      { source: "resume", resumed: true },
      { source: "resume", resumed: true },
      { source: "resume", resumed: true },
      { source: "fork", resumed: true },
      { source: "resume", resumed: true },
    ]);
  });

  it("手动 /compact 与自动 L2 摘要成功后重跑 SessionStart(source: 'compact')，新快照在下次请求生效", async () => {
    const ws = tmpDir("nct-hook-compact-");
    const home = tmpDir("nct-hook-compact-home-");
    const hookDir = tmpDir("nct-hook-compact-scripts-");
    const sessionsDir = tmpDir("nct-hook-compact-sess-");
    const plat = isolatedPlatform(home);
    const ss = dynamicHookEntry(hookDir, "ss");
    ss.setResponse({ additionalContext: "phase-initial" });

    let callIndex = 0;
    const requests: ModelRequest[] = [];
    const provider = new FakeProvider({
      models: [
        {
          ref: { provider: "fake", model: "small-ctx" },
          displayName: "Small",
          contextWindow: 16_000,
          maxOutputTokens: 500,
          capabilities: {
            toolCalls: true,
            parallelToolCalls: true,
            reasoning: "visible",
            imageInput: false,
            promptCache: false,
            editTool: "edit",
            historyPrune: false,
          },
        },
      ],
      handler: (req) => {
        const lastUser = req.messages.at(-1);
        const lastText =
          lastUser?.role === "user"
            ? lastUser.content.map((c) => (c.type === "text" ? c.text : "")).join("")
            : "";
        if (lastText.includes("总结") || lastText.includes("摘要") || req.tools.length === 0) {
          return [
            { type: "text_delta", text: "压缩摘要：已完成前半段。" },
            { type: "finish", reason: "stop" },
          ];
        }
        requests.push(structuredClone(req));
        callIndex += 1;
        if (callIndex === 1) {
          return [
            { type: "text_delta", text: "reply 1 ".repeat(100) },
            { type: "finish", reason: "stop" },
          ];
        }
        if (callIndex === 2) {
          return [
            { type: "text_delta", text: "reply 2" },
            { type: "finish", reason: "stop" },
          ];
        }
        if (callIndex === 3) {
          return [
            { type: "text_delta", text: "word ".repeat(3_500) },
            { type: "finish", reason: "stop" },
          ];
        }
        return done;
      },
      roleHandler: () => [
        { type: "text_delta", text: "压缩摘要：已完成前半段。" },
        { type: "finish", reason: "stop" },
      ],
    });

    writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({ modelsDev: false, compaction: { threshold: 5000, pruneLimit: 0 } }),
    );
    const config = await loadConfig(plat, { nocturneHome: home });

    const rt = await createRuntime({
      cwd: ws,
      sessionsDir,
      config,
      hooks: { SessionStart: [ss.entry] },
      providers: [provider],
      turn: { retryBaseDelayMs: 1 },
    });
    openRuntimes.push(rt);
    const session = await rt.createSession({ model: "fake/small-ctx" });
    openSessions.push(session);

    await session.submit({ text: "first turn " + "a".repeat(200) });

    // 手动 /compact 前修改 Hook 返回值
    ss.setResponse({ additionalContext: "phase-after-manual-compact" });
    await session.compact();

    const afterManual = session.durableEvents().filter((e) => e.type === "hook.context");
    expect(afterManual.at(-1)?.payload).toEqual({
      point: "SessionStart",
      source: "compact",
      entries: [{ hook: "hook SessionStart node", text: "phase-after-manual-compact" }],
    });

    await session.submit({ text: "second turn" });
    expect(requests[1]?.system.some((b) => b.text.includes("phase-after-manual-compact"))).toBe(
      true,
    );

    // turn 3 产出长回复形成闭合边界，turn 4 触发自动 L2 摘要
    await session.submit({ text: "third turn producing large history" });
    ss.setResponse({ additionalContext: "phase-after-auto-compact" });
    await session.submit({ text: "fourth turn triggering auto summary" });

    const summaryEvents = session
      .durableEvents()
      .filter((e) => e.type === "context.compacted" && e.payload.kind === "summary");
    expect(summaryEvents.length).toBeGreaterThanOrEqual(2);
    const autoCompactSeq = summaryEvents.at(-1)?.seq ?? 0;
    expect(autoCompactSeq).toBeGreaterThan(0);
    const lastHookCtx = session.durableEvents().findLast((e) => e.type === "hook.context");
    expect(lastHookCtx?.seq).toBeGreaterThan(autoCompactSeq);
    expect(lastHookCtx?.payload).toEqual({
      point: "SessionStart",
      source: "compact",
      entries: [{ hook: "hook SessionStart node", text: "phase-after-auto-compact" }],
    });
    // 自动摘要后紧接着的模型请求已使用新快照
    expect(requests.at(-1)?.system.some((b) => b.text.includes("phase-after-auto-compact"))).toBe(
      true,
    );
  });

  it("UserPromptSubmit 携带 submit.text 与 skill 触发，并逐条跳过非用户输入场景", async () => {
    const ws = tmpDir("nct-hook-ups-");
    const home = tmpDir("nct-hook-ups-home-");
    const hookDir = tmpDir("nct-hook-ups-scripts-");
    const sessionsDir = tmpDir("nct-hook-ups-sess-");
    const plat = isolatedPlatform(home);
    // 建立一个用户级技能（<NOCTURNE_HOME>/skills）+ 一个被 @ 引用的文件
    const skillDir = path.join(home, "skills", "alpha");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: alpha\ndescription: alpha skill\n---\nSKILL_SECRET_BODY\n",
    );
    writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({ modelsDev: false, skills: { sources: { agents: false, claude: false } } }),
    );
    const config = await loadConfig(plat, { nocturneHome: home });
    writeFileSync(path.join(ws, "ref.txt"), "REF_FILE_BODY");

    const ups = dynamicHookEntry(hookDir, "ups");
    ups.setResponse({ additionalContext: "ups-injected-hint" });

    const requests: ModelRequest[] = [];
    let turnNo = 0;
    let resolveHold: (() => void) | undefined;
    const holdPromise = new Promise<void>((r) => {
      resolveHold = r;
    });

    const provider = new FakeProvider({
      handler: async (req) => {
        requests.push(structuredClone(req));
        turnNo += 1;
        // 第 1 轮：阻塞一下好让测试往运行中插话 steer
        if (turnNo === 1) {
          await holdPromise;
          return [
            { type: "tool_call", toolCallId: "t_read", name: "read", input: { path: "ref.txt" } },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        // 第 3 轮：触发后台 subagent 与后台 shell
        if (turnNo === 3) {
          return [
            {
              type: "tool_call",
              toolCallId: "bg_task",
              name: "task",
              input: { task: "sub task", preset: "explore", background: true },
            },
            {
              type: "tool_call",
              toolCallId: "bg_shell",
              name: "shell",
              input: { command: "node -e \"console.log('bg_done')\"", background: true },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return done;
      },
    });

    const rt = await createRuntime({
      cwd: ws,
      sessionsDir,
      config,
      hooks: { UserPromptSubmit: [ups.entry] },
      providers: [provider],
      permissions: { autoApproveAsk: true },
      shell: { background: true },
      subagent: { background: true },
      turn: { retryBaseDelayMs: 1 },
    });
    openRuntimes.push(rt);
    const session = await rt.createSession({ model: "fake/fake-model" });
    openSessions.push(session);

    // 场景 A：技能斜杠调用 + @file 引用；插话 steer 不得触发 UserPromptSubmit
    const t1 = session.submit({
      text: "/alpha target @ref.txt",
      skill: { name: "alpha", arguments: "target @ref.txt" },
    });
    // 等第 1 步发进模型后，再 enqueueInput("steer")，然后放行
    await new Promise((r) => setTimeout(r, 80));
    await session.enqueueInput("steer", { text: "steer msg should skip" });
    resolveHold?.();
    await t1;

    // 核对第 1 次 UserPromptSubmit：只有 1 次（steer 未触发），text 不含技能渲染块或文件块
    const inputsAfterT1 = ups.readInputs();
    expect(inputsAfterT1).toHaveLength(1);
    expect(inputsAfterT1[0]?.text).toBe("/alpha target @ref.txt");
    expect(inputsAfterT1[0]?.skill).toEqual({ name: "alpha", arguments: "target @ref.txt" });
    expect(typeof inputsAfterT1[0]?.turnId).toBe("string");
    expect(JSON.stringify(inputsAfterT1[0])).not.toContain("SKILL_SECRET_BODY");
    expect(JSON.stringify(inputsAfterT1[0])).not.toContain("REF_FILE_BODY");

    // note 落在 message.user 之后、assistant 之前，且计入 history.breakdown.user
    const firstMsgs = requests[0]?.messages ?? [];
    expect(firstMsgs[0]?.role).toBe("user");
    expect(firstMsgs[1]?.role).toBe("user");
    const noteText =
      firstMsgs[1]?.role === "user"
        ? firstMsgs[1].content.map((c) => (c.type === "text" ? c.text : "")).join("")
        : "";
    expect(noteText).toContain('<hook-context point="UserPromptSubmit">');
    expect(noteText).toContain("ups-injected-hint");
    const hookCtxEv = session.durableEvents().find((e) => e.type === "hook.context");
    expect(hookCtxEv?.turnId).toBeDefined();
    const historySec = session.describeContext().report.sections.find((s) => s.name === "history");
    expect(historySec?.breakdown?.user.chars).toBeGreaterThan(0);

    // 场景 B：触发后台 subagent 与后台 shell，两者交付结果唤起的新 Turn 均不得触发 UserPromptSubmit
    const beforeBgCount = ups.readInputs().length;
    await session.submit({ text: "launch background work" });
    expect(ups.readInputs()).toHaveLength(beforeBgCount + 1);
    // 等待后台 subagent 和后台 shell 结果各自送达并跑完
    await vi.waitFor(
      () => {
        const evs = session.durableEvents();
        expect(evs.some((e) => e.type === "message.user" && e.payload.subagent !== undefined)).toBe(
          true,
        );
        expect(
          evs.some((e) => e.type === "message.user" && e.payload.backgroundShell !== undefined),
        ).toBe(true);
      },
      { timeout: 8_000 },
    );
    // 等后台交付引发的 Turn 完全收尾
    await vi.waitFor(
      () =>
        expect(
          session.durableEvents().filter((e) => e.type === "turn.completed").length,
        ).toBeGreaterThanOrEqual(4),
      { timeout: 8_000 },
    );
    // 后台 subagent（含子会话内部 Turn）与 backgroundShell 投递的 Turn 都没有再触发 UserPromptSubmit
    expect(ups.readInputs()).toHaveLength(beforeBgCount + 1);

    // 场景 C：workMode.source === "runtime"（/plan 批准后的 runtime Turn）不得触发 UserPromptSubmit
    const beforePlanCount = ups.readInputs().length;
    await session.submit({ text: "plan task", workMode: "plan" });
    expect(ups.readInputs()).toHaveLength(beforePlanCount + 1);
    await session.approvePlan();
    expect(
      session
        .durableEvents()
        .some((e) => e.type === "message.user" && e.payload.workMode?.source === "runtime"),
    ).toBe(true);
    expect(ups.readInputs()).toHaveLength(beforePlanCount + 1);

    // 场景 D：ensemble 安静提醒 / 成员投递消息不触发 UserPromptSubmit
    const beforeEnsembleCount = ups.readInputs().length;
    await session.submit({ text: "ensemble objective", workMode: "ensemble" });
    expect(ups.readInputs()).toHaveLength(beforeEnsembleCount + 1);
  }, 15_000);

  it("UserPromptSubmit block: true 以 hook_blocked 结束并丢弃 additionalContext", async () => {
    const ws = tmpDir("nct-hook-block-");
    const home = tmpDir("nct-hook-block-home-");
    const sessionsDir = tmpDir("nct-hook-block-sess-");
    let modelCalled = false;
    const rt = await createRuntime({
      cwd: ws,
      sessionsDir,
      config: await loadConfig(isolatedPlatform(home), { nocturneHome: home }),
      hooks: {
        UserPromptSubmit: [
          {
            command: "node",
            args: echoScript(`() => ({additionalContext:"discard-me"})`),
          },
          {
            command: "node",
            args: echoScript(
              `() => ({block:true,reason:"政策拦截",additionalContext:"also-discard"})`,
            ),
          },
        ],
      },
      providers: [
        new FakeProvider({
          handler: () => {
            modelCalled = true;
            return done;
          },
        }),
      ],
      turn: { retryBaseDelayMs: 1 },
    });
    openRuntimes.push(rt);
    const session = await rt.createSession({ model: "fake/fake-model" });
    openSessions.push(session);

    const reason = await session.submit({ text: "blocked prompt" });
    expect(reason).toBe("error");
    expect(modelCalled).toBe(false);
    expect(session.durableEvents().some((e) => e.type === "hook.context")).toBe(false);
    const completed = session.durableEvents().findLast((e) => e.type === "turn.completed");
    expect(completed?.payload.error).toEqual({ code: "hook_blocked", message: "政策拦截" });
  });

  it("SubagentStart 在子会话 SessionStart 之后、首个 Turn 前注入上下文，外部 ACP agent 不触发", async () => {
    const ws = tmpDir("nct-hook-sub-");
    const home = tmpDir("nct-hook-sub-home-");
    const hookDir = tmpDir("nct-hook-sub-scripts-");
    const sessionsDir = tmpDir("nct-hook-sub-sess-");
    const eventsLog = path.join(hookDir, "order.jsonl");
    const plat = isolatedPlatform(home);
    writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({
        modelsDev: false,
        externalAgents: [{ name: "acp-bot", command: "noop", args: [], enabled: true }],
      }),
    );
    const config = await loadConfig(plat, { nocturneHome: home });

    const logScript = (pointName: string) => [
      "-e",
      `
const fs = require("node:fs");
let raw = "";
process.stdin.on("data", (d) => { raw += d; }).on("end", () => {
  const i = JSON.parse(raw);
  fs.appendFileSync(${JSON.stringify(eventsLog)}, JSON.stringify({ point: ${JSON.stringify(pointName)}, source: i.source, agentType: i.agentType, subagent: i.subagent }) + "\\n");
  if (${JSON.stringify(pointName)} === "SessionStart") {
    process.stdout.write(JSON.stringify({ additionalContext: i.subagent ? "child-session-start" : "parent-session-start" }));
  } else if (${JSON.stringify(pointName)} === "SubagentStart") {
    process.stdout.write(JSON.stringify({ additionalContext: "subagent-rule-" + i.agentType }));
  }
});
`,
    ];

    const requests: ModelRequest[] = [];
    let call = 0;
    const provider = new FakeProvider({
      handler: (req) => {
        requests.push(structuredClone(req));
        call += 1;
        if (call === 1) {
          return [
            {
              type: "tool_call",
              toolCallId: "sub1",
              name: "task",
              input: { task: "inspect", preset: "explore" },
            },
            {
              type: "tool_call",
              toolCallId: "sub2",
              name: "task",
              input: { task: "delegate external", agent: "acp-bot" },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        if (call === 2) {
          return [
            {
              type: "tool_call",
              toolCallId: "fin1",
              name: "finish",
              input: { result: "child done" },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return done;
      },
    });

    let externalRuns = 0;
    const acpConnector: ExternalAgentConnector = {
      run: async (_cfg, req) => {
        externalRuns += 1;
        return {
          status: "ok",
          modelContent: "external ok",
          output: {
            agent: req.agent,
            transcriptPath: req.transcriptPath,
            stopReason: "end_turn",
            permissionDecisions: { allowed: 0, denied: 0 },
          },
        };
      },
      probe: async () => ({
        ok: true,
        durationMs: 1,
        agentInfo: { name: "acp-bot", version: "1.0" },
        configOptions: [],
      }),
    };

    const rt = await createRuntime({
      cwd: ws,
      sessionsDir,
      config,
      hooks: {
        SessionStart: [{ command: "node", args: logScript("SessionStart") }],
        SubagentStart: [{ command: "node", args: logScript("SubagentStart") }],
      },
      externalAgents: acpConnector,
      providers: [provider],
      permissions: { autoApproveAsk: true },
      turn: { retryBaseDelayMs: 1 },
    });
    openRuntimes.push(rt);
    const session = await rt.createSession({ model: "fake/fake-model" });
    openSessions.push(session);

    await session.submit({ text: "run child and external" });
    expect(externalRuns).toBe(1);

    const recorded = readFileSync(eventsLog, "utf8")
      .trim()
      .split("\n")
      .map(
        (l) =>
          JSON.parse(l) as {
            point: string;
            source?: string;
            agentType?: string;
            subagent?: unknown;
          },
      );
    // 顺序：父 SessionStart → 子 SessionStart → 子 SubagentStart(explore)（外部 ACP 不触发 SubagentStart）
    expect(recorded.map((r) => r.point)).toEqual(["SessionStart", "SessionStart", "SubagentStart"]);
    expect(recorded[1]?.subagent).toBeDefined();
    expect(recorded[1]?.source).toBe("startup");
    expect(recorded[2]?.subagent).toBeDefined();
    expect(recorded[2]?.agentType).toBe("explore");

    // 子会话请求（第 2 个模型请求）同时含 child-session-start 与 subagent-rule-explore
    const childSys = requests[1]?.system.map((s) => s.text).join("\n") ?? "";
    expect(childSys).toContain(
      '<hook-context point="SessionStart">\nchild-session-start\n</hook-context>',
    );
    expect(childSys).toContain(
      '<hook-context point="SubagentStart">\nsubagent-rule-explore\n</hook-context>',
    );

    // 父会话请求不受子会话 SubagentStart 污染
    const parentSys = requests[2]?.system.map((s) => s.text).join("\n") ?? "";
    expect(parentSys).toContain("parent-session-start");
    expect(parentSys).not.toContain("subagent-rule-explore");
  });

  it("单条 10,000 字符截断记 truncated，同事件合计 30,000 字符上限丢弃后续条目并写诊断", async () => {
    const ws = tmpDir("nct-hook-cap-");
    const diagRecords: { event: string; fields: Record<string, unknown> }[] = [];
    const diagnostics: Diagnostics = {
      record: (event, fields) => {
        diagRecords.push({ event, fields: fields ?? {} });
      },
    };
    const r = createHookRunner({
      hooks: {
        SessionStart: [
          {
            command: "node",
            args: echoScript(`() => ({additionalContext:"A".repeat(12500)})`),
          },
          {
            command: "node",
            args: echoScript(`() => ({additionalContext:"B".repeat(10000)})`),
          },
          {
            command: "node",
            args: echoScript(`() => ({additionalContext:"C".repeat(10000)})`),
          },
          {
            command: "node",
            args: echoScript(`() => ({additionalContext:"D".repeat(500)})`),
          },
          {
            command: "node",
            args: echoScript(`() => ({additionalContext:"E".repeat(10)})`),
          },
        ],
      },
      platform: basePlatform,
      sessionId: "s-cap",
      cwd: ws,
      workspaceRoot: ws,
      diagnostics,
    });

    const out = await r.run("SessionStart", { resumed: false, source: "startup" });
    expect(out?.contextEntries).toHaveLength(3);
    expect(out?.contextEntries?.[0]?.text).toHaveLength(MAX_HOOK_CONTEXT_ENTRY_CHARS);
    expect(out?.contextEntries?.[0]?.truncated).toBe(2500);
    expect(out?.contextEntries?.[1]?.truncated).toBeUndefined();
    const total = out?.contextEntries?.reduce((sum, e) => sum + e.text.length, 0) ?? 0;
    expect(total).toBe(MAX_HOOK_CONTEXT_TOTAL_CHARS);
    expect(diagRecords.filter((d) => d.event === "hook.context_dropped")).toHaveLength(2);
  });

  it("重放逐字节一致、回退按有效前缀恢复快照、SessionView 不投影 hook.context、相邻 Step 前缀不变", async () => {
    const ws = tmpDir("nct-hook-replay-");
    const home = tmpDir("nct-hook-replay-home-");
    const hookDir = tmpDir("nct-hook-replay-scripts-");
    const sessionsDir = tmpDir("nct-hook-replay-sess-");
    const plat = isolatedPlatform(home);
    const ss = dynamicHookEntry(hookDir, "ss");
    ss.setResponse({ additionalContext: "steady-session-rule" });
    const ups = dynamicHookEntry(hookDir, "ups");
    ups.setResponse({ additionalContext: "turn-prompt-note" });

    const requests: ModelRequest[] = [];
    let step = 0;
    const provider = new FakeProvider({
      handler: (req) => {
        requests.push(structuredClone(req));
        step += 1;
        if (step === 1) {
          return [
            { type: "tool_call", toolCallId: "c1", name: "read", input: { path: "note.txt" } },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return done;
      },
    });
    writeFileSync(path.join(ws, "note.txt"), "hello");

    const rt = await createRuntime({
      cwd: ws,
      sessionsDir,
      config: await loadConfig(plat, { nocturneHome: home }),
      hooks: { SessionStart: [ss.entry], UserPromptSubmit: [ups.entry] },
      providers: [provider],
      turn: { retryBaseDelayMs: 1 },
    });
    openRuntimes.push(rt);
    const session = await rt.createSession({ model: "fake/fake-model" });
    openSessions.push(session);

    await session.submit({ text: "first turn" });

    // 相邻 Step（requests[0] 与 requests[1]）的 system 前缀完全逐字节一致
    expect(requests).toHaveLength(2);
    expect(requests[0]?.system).toEqual(requests[1]?.system);

    // SessionView 不投影 hook.context（entries 中不含 hook.context 条目，notes 不受影响）
    const events = session.durableEvents();
    const view1 = replaySessionView(events);
    const view2 = replaySessionView(events);
    expect(
      view1.entries.some(
        (e) => e.kind === "notice" && JSON.stringify(e).includes("steady-session-rule"),
      ),
    ).toBe(false);
    expect(view1.notes).toEqual([]);
    expect(view1).toEqual(view2);

    // 从持久事件折叠两次，buildContext 输出逐字节相同
    const modelInfo: ModelInfo = {
      ref: { provider: "fake", model: "fake-model" },
      displayName: "Fake Model",
      contextWindow: 128_000,
      maxOutputTokens: 4_096,
      capabilities: {
        toolCalls: true,
        parallelToolCalls: true,
        reasoning: "visible",
        imageInput: false,
        promptCache: false,
        editTool: "edit",
        historyPrune: true,
      },
    };
    const instructions: InstructionSet = { project: [] };
    const state1 = foldEvents(events);
    const state2 = foldEvents(events);
    const built1 = buildContext({
      history: state1.history,
      hookContext: state1.hookContext,
      model: modelInfo,
      tools: [],
      instructions,
      environment: {
        os: "win32",
        shell: "pwsh",
        cwd: ws,
        workspaceRoot: ws,
        sessionDate: "2026-11-18T00:00:00Z",
      },
      events,
    });
    const built2 = buildContext({
      history: state2.history,
      hookContext: state2.hookContext,
      model: modelInfo,
      tools: [],
      instructions,
      environment: {
        os: "win32",
        shell: "pwsh",
        cwd: ws,
        workspaceRoot: ws,
        sessionDate: "2026-11-18T00:00:00Z",
      },
      events,
    });
    expect(JSON.stringify(built1.request)).toBe(JSON.stringify(built2.request));

    // 回退到第一条消息之后重置了 UserPromptSubmit note，而 SessionStart 快照（seq 在消息前）仍保留
    const firstUserSeq = events.find((e) => e.type === "message.user")?.seq;
    if (firstUserSeq === undefined) throw new Error("missing first user message");
    await session.rewind(firstUserSeq, "conversation");
    expect(session.state().hookContext?.SessionStart?.[0]?.text).toBe("steady-session-rule");
    expect(
      session.state().history.some((h) => h.kind === "note" && h.text.includes("turn-prompt-note")),
    ).toBe(false);
  });
});
