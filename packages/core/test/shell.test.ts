/**
 * ADR-0022 端到端（会话层）：shellInfo / listShells / setShell、
 * settings.json 原子写、config_changed 事件与历史说明、env 覆盖提示、
 * 逐次解析（切换对下一次 shell 调用生效，不在 Turn 开始快照）。
 * 全部使用隔离 NOCTURNE_HOME 与临时会话目录。
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig, type RuntimeConfig } from "../src/config/index.js";
import { buildContext } from "../src/context/index.js";
import { createPlatform, type Platform } from "../src/platform/index.js";
import type * as platformModule from "../src/platform/platform.js";
import { createExecutionScope } from "../src/tools/index.js";
import type { ExecutionEnvironment, TurnCallScope } from "../src/tools/index.js";

import { createRuntime, type Runtime, type RuntimeSession } from "../src/index.js";
import { foldEvents } from "../src/session/index.js";
import { FakeProvider, type FakeScript } from "../src/provider/index.js";
import type { DurableEvent, RuntimeEvent } from "../src/protocol/index.js";
import { createProcessCleanup, removeTempDirs } from "../../../scripts/test/process-cleanup.mjs";

const processes = createProcessCleanup();
const platform: Platform = processes.platform(createPlatform());
vi.mock("../src/platform/platform.js", async (original) => {
  const module = await original<typeof platformModule>();
  return { ...module, createPlatform: () => processes.platform(module.createPlatform()) };
});
const isWin = process.platform === "win32";
const tmpRoots: string[] = [];

afterEach(async () => {
  await processes.cleanup();
  await removeTempDirs(tmpRoots.splice(0));
  Reflect.deleteProperty(process.env, "NOCTURNE_SHELL");
});

function makeTmpDir(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}

async function makeRuntime(opts?: {
  scripts?: FakeScript[];
  withConfig?: boolean;
  env?: (n: string) => string | undefined;
}): Promise<{ runtime: Runtime; config?: RuntimeConfig; home?: string }> {
  const workspace = makeTmpDir("nct-sh-ws-");
  const sessionsDir = makeTmpDir("nct-sh-sessions-");
  let config: RuntimeConfig | undefined;
  let home: string | undefined;
  if (opts?.withConfig === true) {
    home = makeTmpDir("nct-sh-home-");
    config = await loadConfig(platform, {
      nocturneHome: home,
      env: opts.env ?? (() => undefined),
    });
  }
  const runtime = await createRuntime({
    cwd: workspace,
    sessionsDir,
    providers: [new FakeProvider({ scripts: opts?.scripts ?? [] })],
    ...(config !== undefined ? { config } : {}),
    permissions: { autoApproveAsk: true },
  });
  return {
    runtime,
    ...(config !== undefined ? { config } : {}),
    ...(home !== undefined ? { home } : {}),
  };
}

const makeSession = (runtime: Runtime) => runtime.createSession({ model: "fake/fake-model" });

function collect(session: RuntimeSession): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  session.subscribe((e) => {
    events.push(e);
  });
  return events;
}

/** 探测结果中除当前生效外的第一个可用 shell；没有时返回 undefined 供测试跳过 */
function otherAvailable(session: RuntimeSession): string | undefined {
  const current = session.shellInfo().effective?.kind;
  return session.listShells().find((d) => d.available && d.kind !== current)?.kind;
}

describe("RuntimeSession shell API（ADR-0022 第 2、4 节）", () => {
  it("运行时设置可用 Shell 写盘、已打开会话立即生效并写变化事件，auto 清除", async () => {
    const { runtime, home } = await makeRuntime({ withConfig: true });
    const session = await makeSession(runtime);
    const second = await makeSession(runtime);
    const events = collect(session);
    const secondEvents = collect(second);
    const target = otherAvailable(session);
    expect(target).toBeDefined();
    const items = await runtime.setShellSetting(target as string);
    expect(items.find((item) => item.key === "shell")).toMatchObject({
      effective: target,
      source: "settings",
      saved: target,
    });
    expect(
      JSON.parse(readFileSync(path.join(home as string, "settings.json"), "utf8")),
    ).toMatchObject({ shell: target });
    expect(session.shellInfo().effective?.kind).toBe(target);
    expect(second.shellInfo().effective?.kind).toBe(target);
    expect(events.filter((e) => e.type === "session.config_changed")).toHaveLength(1);
    expect(secondEvents.filter((e) => e.type === "session.config_changed")).toHaveLength(1);
    await runtime.setShellSetting("auto");
    expect(
      JSON.parse(readFileSync(path.join(home as string, "settings.json"), "utf8")),
    ).not.toHaveProperty("shell");
    await second.close();
    await session.close();
  });

  it("运行时拒绝不可用 Shell 不改变文件", async () => {
    const { runtime, home } = await makeRuntime({ withConfig: true });
    await runtime.setShellSetting("auto");
    const before = readFileSync(path.join(home as string, "settings.json"), "utf8");
    const missing = (await runtime.listShells()).find((item) => !item.available)?.kind;
    expect(missing).toBeDefined();
    await expect(runtime.setShellSetting(missing as string)).rejects.toMatchObject({
      code: "invalid_command",
    });
    expect(readFileSync(path.join(home as string, "settings.json"), "utf8")).toBe(before);
  });

  it("运行时 env 覆盖返回来源，已打开会话生效不变、无变化事件", async () => {
    process.env["NOCTURNE_SHELL"] = isWin ? "cmd" : "sh";
    const { runtime } = await makeRuntime({ withConfig: true });
    const session = await makeSession(runtime);
    const events = collect(session);
    const result = await runtime.setShellSetting("auto");
    expect(result.find((item) => item.key === "shell")).toMatchObject({
      source: "env",
      effective: isWin ? "cmd" : "sh",
    });
    expect(session.shellInfo().effective?.kind).toBe(isWin ? "cmd" : "sh");
    expect(events.filter((e) => e.type === "session.config_changed")).toHaveLength(0);
    await session.close();
  });

  it("shellInfo/listShells：auto 生效，五种壳全部列出（含不可用）", async () => {
    const { runtime } = await makeRuntime();
    const session = await makeSession(runtime);
    const info = session.shellInfo();
    expect(info.selected).toBe("auto");
    expect(info.source).toBe("auto");
    expect(info.effective).toBeDefined();
    expect(info.effective?.kind).toBeTruthy();
    const kinds = session.listShells().map((d) => d.kind);
    expect(kinds).toEqual(["pwsh", "powershell", "bash", "cmd", "sh"]);
    // cmd 在 Windows 恒可用；非 Windows 时 sh 可用
    expect(session.listShells().some((d) => d.available)).toBe(true);
  });

  it("setShell 写 settings.json（配置层存在时）并发 session.config_changed.shell", async () => {
    const { runtime, home } = await makeRuntime({ withConfig: true });
    const session = await makeSession(runtime);
    const events = collect(session);
    const target = otherAvailable(session);
    expect(target).toBeDefined(); // Windows 上至少有 cmd + 另一种可用
    await session.setShell(target as string);

    const info = session.shellInfo();
    expect(info.selected).toBe(target);
    expect(info.source).toBe("settings");
    expect(info.effective?.kind).toBe(target);

    const settings = JSON.parse(
      readFileSync(path.join(home as string, "settings.json"), "utf8"),
    ) as {
      shell?: string;
    };
    expect(settings.shell).toBe(target);

    const changed = events.find((e) => e.type === "session.config_changed" && "shell" in e.payload);
    expect(changed).toBeDefined();
    if (changed?.type === "session.config_changed") {
      expect(changed.payload.shell).toEqual({
        kind: target,
        path: info.effective?.path,
      });
    }
    // fold：历史留 note 说明
    const notes = session.state().history.filter((h) => h.kind === "note");
    expect(notes).toHaveLength(1);
    expect(notes[0]?.kind === "note" && notes[0].text).toContain("[Environment change]");
    expect(notes[0]?.kind === "note" && notes[0].text).toContain(String(target));

    // setShell("auto") 清除 settings 字段并回到自动选择
    await session.setShell("auto");
    expect(session.shellInfo().selected).toBe("auto");
    const cleared = JSON.parse(
      readFileSync(path.join(home as string, "settings.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(cleared["shell"]).toBeUndefined();
  });

  it("setShell 未知/未安装种类 → invalid_command 且不落盘、无事件、生效值不变", async () => {
    const { runtime, home } = await makeRuntime({ withConfig: true });
    const session = await makeSession(runtime);
    const events = collect(session);
    await expect(session.setShell("fish")).rejects.toMatchObject({
      code: "invalid_command",
    });
    const missing = session.listShells().find((d) => !d.available)?.kind;
    if (missing === undefined) return; // 全部可用则无可测对象
    const before = session.shellInfo();
    await expect(session.setShell(missing)).rejects.toMatchObject({
      code: "invalid_command",
    });
    // 拒绝发生在写 settings 之前：文件未创建、无 config_changed、生效不变
    expect(existsSync(path.join(home as string, "settings.json"))).toBe(false);
    expect(events.some((e) => e.type === "session.config_changed")).toBe(false);
    const info = session.shellInfo();
    expect(info.selected).toBe(before.selected);
    expect(info.effective?.kind).toBe(before.effective?.kind);
    expect(info.error).toBeUndefined();
  });

  it("env 覆盖下 setShell 未安装种类同样拒绝（先校验后写盘）", async () => {
    // env 声明须指向本机已安装的种类：Windows 恒有 cmd，POSIX 用 sh
    const envShell = isWin ? "cmd" : "sh";
    process.env["NOCTURNE_SHELL"] = envShell;
    const { runtime, home } = await makeRuntime({ withConfig: true });
    const session = await makeSession(runtime);
    const missing = session.listShells().find((d) => !d.available)?.kind;
    if (missing === undefined) return;
    await expect(session.setShell(missing)).rejects.toMatchObject({
      code: "invalid_command",
    });
    expect(existsSync(path.join(home as string, "settings.json"))).toBe(false);
    expect(session.shellInfo().effective?.kind).toBe(envShell);
  });

  it("无配置层时 setShell 仅本会话内存生效（不写文件）", async () => {
    const { runtime } = await makeRuntime();
    const session = await makeSession(runtime);
    const target = otherAvailable(session);
    expect(target).toBeDefined();
    await session.setShell(target as string);
    expect(session.shellInfo().selected).toBe(target);
    // 新会话不受影响
    const s2 = await makeSession(runtime);
    expect(s2.shellInfo().selected).toBe("auto");
  });

  it("恢复会话保留历史中的 shell 切换说明", async () => {
    const { runtime } = await makeRuntime({ withConfig: true });
    const session = await makeSession(runtime);
    const target = otherAvailable(session);
    expect(target).toBeDefined();
    await session.setShell(target as string);
    const id = session.id;
    await session.close();

    const resumed = await runtime.resumeSession(id);
    const notes = resumed.state().history.filter((h) => h.kind === "note");
    expect(notes).toHaveLength(1);
    expect(notes[0]?.kind === "note" && notes[0].text).toContain(String(target));
    // 恢复后 settings 层值继续生效
    expect(resumed.shellInfo().selected).toBe(target);
  });

  it("NOCTURNE_SHELL 覆盖 settings：setShell 写盘但不生效，发 shell_overridden 警告", async () => {
    const envShell = isWin ? "cmd" : "sh";
    process.env["NOCTURNE_SHELL"] = envShell;
    const { runtime, home } = await makeRuntime({ withConfig: true });
    const session = await makeSession(runtime);
    const events = collect(session);
    expect(session.shellInfo().source).toBe("env");
    expect(session.shellInfo().effective?.kind).toBe(envShell);
    // settings.json 尚无值时 overriddenBy 已报告覆盖来源（写入不会生效）
    expect(session.shellInfo().overriddenBy).toBe("env");

    const target = session.listShells().find((d) => d.available && d.kind !== envShell)?.kind;
    expect(target).toBeDefined();
    await session.setShell(target as string);

    const info = session.shellInfo();
    expect(info.effective?.kind).toBe(envShell); // 生效不变
    expect(info.overriddenBy).toBe("env");
    expect(info.selected).toBe(envShell); // selected 为生效层（env）声明值；settings 层选择见 settings.json
    const settings = JSON.parse(
      readFileSync(path.join(home as string, "settings.json"), "utf8"),
    ) as {
      shell?: string;
    };
    expect(settings.shell).toBe(target);
    // 不产生 config_changed（未实际切换）；有覆盖警告
    expect(events.some((e) => e.type === "session.config_changed")).toBe(false);
    const warning = events.find(
      (e) => e.type === "runtime.warning" && e.payload.code === "shell_overridden",
    );
    expect(warning).toBeDefined();
  });

  it("NOCTURNE_SHELL 非法值：回退自动选择 + 警告进 session.warnings（CLI/TUI 打开提示可见）", async () => {
    process.env["NOCTURNE_SHELL"] = "fish";
    const { runtime } = await makeRuntime({ withConfig: true });
    const session = await makeSession(runtime);
    expect(session.shellInfo().source).toBe("env");
    expect(session.shellInfo().effective).toBeDefined();
    // 启动警告经会话警告列表透出（临时事件发出时无订阅者）
    expect(session.warnings.some((w) => w.includes("fish"))).toBe(true);
    expect(session.warnings.some((w) => w.includes("回退自动选择"))).toBe(true);
  });

  it("切换对下一次 shell 调用生效：Turn 中不做快照（逐次解析）", async () => {
    // cmd 与其他 shell 的语法分歧命令：%OS% 在 cmd 展开、pwsh/bash/sh 原样输出
    const scripts: FakeScript[] = [
      [
        {
          type: "tool_call",
          toolCallId: "c1",
          name: "shell",
          input: { command: "echo %OS%" },
        },
        { type: "finish", reason: "tool_calls" },
      ],
      [
        { type: "text_delta", text: "done" },
        { type: "finish", reason: "stop" },
      ],
    ];
    const { runtime } = await makeRuntime({ scripts });
    const session = await makeSession(runtime);
    const events = collect(session);
    const target = otherAvailable(session);
    if (target === undefined) return; // 只有一个可用 shell 时无可切换对象
    await session.setShell(target);
    expect(await session.submit({ text: "run" })).toBe("done");
    const done = events.find((e) => e.type === "tool.completed");
    const echo = target === "cmd" ? "Windows_NT" : "%OS%";
    expect(done?.type === "tool.completed" && done.payload.modelContent).toContain(echo);
    // tool.started 的主体携带 shell 种类（权限方言化依据）
    const started = events.find((e) => e.type === "tool.started");
    if (started?.type === "tool.started") {
      expect(started.payload.subjects[0]?.shell).toBe(target);
    }
  });
});

describe("createExecutionScope 逐次取 shell（ADR-0022：不在 Turn 开始快照）", () => {
  it("env.shell.current() 每次组装 scope 时调用，切换后新值立即可见", () => {
    let calls = 0;
    const env = {
      platform,
      shell: {
        current: () => {
          calls += 1;
          return { source: "auto" as const, selected: "auto" as const };
        },
        list: () => [],
        environmentLine: () => "x",
      },
    } as unknown as ExecutionEnvironment;
    const call = {
      cwd: "C:\\ws",
      workspaceRoot: "C:\\ws",
      sessionId: "s",
      turnId: "t",
      signal: new AbortController().signal,
      events: {
        emit: () => Promise.resolve(),
        emitEphemeral: () => undefined,
      },
    } as unknown as TurnCallScope;
    const s1 = createExecutionScope(env, call);
    const s2 = createExecutionScope(env, call);
    expect(calls).toBe(2);
    expect(s1.shell?.source).toBe("auto");
    expect(s2.shell?.source).toBe("auto");
  });
});

describe("恢复投影：/shell note 不破坏 toolCalls 邻接（ADR-0022 + 协议约束）", () => {
  it("foldEvents 持久序不变；buildContext 投影把 note 排到最后一个结果之后", () => {
    const ev = (
      seq: number,
      type: DurableEvent["type"],
      payload: Record<string, unknown>,
      turnId?: string,
    ): DurableEvent => ({ type, sessionId: "s", seq, time: "t", turnId, payload }) as DurableEvent;
    // 持久化序：/shell 的 config_changed 落在 assistant 工具调用与结果之间
    const events = [
      ev(2, "turn.started", { turnIndex: 1 }, "t1"),
      ev(
        3,
        "message.user",
        { messageId: "u1", content: [{ type: "text", text: "读两个文件" }] },
        "t1",
      ),
      ev(
        4,
        "message.assistant",
        {
          messageId: "a1",
          model: { provider: "test", model: "m1" },
          content: [],
          toolCalls: [
            { callId: "c1", name: "read", input: { path: "a" } },
            { callId: "c2", name: "read", input: { path: "b" } },
          ],
          finishReason: "tool_calls",
        },
        "t1",
      ),
      ev(5, "session.config_changed", { shell: { kind: "bash", path: "/bin/bash" } }, "t1"),
      ev(
        6,
        "tool.completed",
        { callId: "c1", name: "read", status: "ok", modelContent: "A" },
        "t1",
      ),
      ev(
        7,
        "tool.completed",
        { callId: "c2", name: "read", status: "ok", modelContent: "B" },
        "t1",
      ),
    ];
    const state = foldEvents(events);
    // fold 持久序不变：note 留在 seq 5
    const kinds = state.history.map((e) => `${e.kind}@${e.seq}`);
    expect(kinds).toEqual(["user@3", "assistant@4", "note@5", "tool@6", "tool@7"]);

    const built = buildContext({
      history: state.history,
      model: {
        ref: { provider: "test", model: "m1" },
        contextWindow: 100_000,
        maxOutputTokens: 8_000,
        capabilities: {
          toolCalls: true,
          parallelToolCalls: true,
          reasoning: "none",
          imageInput: false,
          promptCache: false,
          editTool: "edit",
        },
      },
      tools: [],
      instructions: { project: [] },
      environment: {
        os: "Windows 11",
        shell: "pwsh",
        cwd: "C:\ws",
        workspaceRoot: "C:\ws",
        sessionDate: "2025-01-01",
      },
    });
    const shape = built.request.messages.map((m) => {
      if (m.role === "tool") return `tool:${m.callId}`;
      if (m.role === "assistant") return "assistant";
      const text = m.content.map((b) => b.text).join("");
      return text.startsWith("[Environment change]") ? "note" : "user";
    });
    // 投影序：note 排到全部并行结果之后，assistant 与结果邻接不被打断
    expect(shape).toEqual(["user", "assistant", "tool:c1", "tool:c2", "note"]);
  });
});
