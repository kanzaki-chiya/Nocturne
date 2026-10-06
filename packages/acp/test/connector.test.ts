import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPlatform,
  type ExternalAgentConfig,
  type ExternalAgentPermissionDecision,
  type SubjectRequest,
  type ToolContext,
} from "@nocturne/core";
import { createAcpConnector } from "../src/index.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url));
const platform = createPlatform();
let root: string;
let controller: AbortController;
const children: number[] = [];

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "nctrn-acp-"));
  controller = new AbortController();
});
afterEach(async () => {
  for (const pid of children.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already stopped */
    }
  }
  await fs.rm(root, { recursive: true, force: true });
});

function setup(scenario = "normal", extra: Partial<ExternalAgentConfig> = {}) {
  const progress = vi.fn();
  const records: { kind: string; data: Record<string, unknown> | undefined }[] = [];
  const config: ExternalAgentConfig = {
    name: "fixture",
    command: process.execPath,
    args: [fixture, scenario],
    enabled: true,
    env: {
      NOCTURNE_TEST_PID_FILE: path.join(root, "pids.json"),
      NOCTURNE_TEST_CANCEL_FILE: path.join(root, "cancel.txt"),
      NOCTURNE_TEST_READY_FILE: path.join(root, "ready.txt"),
    },
    ...extra,
  };
  const ctx: ToolContext = {
    cwd: root,
    workspaceRoot: root,
    paths: platform.paths,
    sessionId: "parent",
    turnId: "turn",
    callId: "call",
    signal: controller.signal,
    subjects: [],
    permissions: { check: () => "deny" },
    fs: platform.fs,
    process: platform.process,
    readState: {
      record() {
        /* 外部 agent 不走内置已读追踪。 */
      },
      get: () => undefined,
    },
    progress,
  };
  const connector = createAcpConnector(
    platform,
    [config, { ...config, name: "disabled", enabled: false }],
    {
      record(kind, data) {
        records.push({ kind, data });
      },
    },
  );
  const permission = vi.fn<
    (subjects: SubjectRequest[]) => Promise<ExternalAgentPermissionDecision>
  >(async () => ({ decision: "allow", source: "rule" }));
  const request = {
    agent: "fixture",
    task: "Read only fixture task",
    cwd: root,
    transcriptPath: path.join(root, "external", "call.jsonl"),
    timeoutMs: 10_000,
    requestPermission: permission,
  };
  return { connector, ctx, request, permission, progress, records };
}

async function waitForPid(): Promise<{ pid: number; child?: number }> {
  // 跨真实进程等待落盘信号，不能使用只推进父进程的 fake timers。
  const pids = await vi.waitFor(
    async () =>
      JSON.parse(await fs.readFile(path.join(root, "pids.json"), "utf8")) as {
        pid: number;
        child?: number;
      },
    { timeout: 10_000, interval: 10 },
  );
  children.push(pids.pid);
  if (pids.child) children.push(pids.child);
  return pids;
}

async function expectGone(pid: number | undefined): Promise<void> {
  if (pid === undefined) throw new Error("Fixture did not report the expected process PID");
  await vi.waitFor(() => expect(platform.processAlive(pid)).toBe(false), {
    timeout: 2_000,
    interval: 20,
  });
}

describe("ACP 单调用生命周期", () => {
  it("启用列表、新进程、最终文本、原文审计与仅工具单行进度", async () => {
    const { connector, ctx, request, progress } = setup();
    expect(connector.list().map((agent) => agent.name)).toEqual(["fixture"]);
    const result = await connector.run(request, ctx);
    expect(result.status).toBe("ok");
    const report = JSON.parse(result.modelContent);
    expect(report).toMatchObject({
      task: request.task,
      cwd: root,
      calls: ["initialize", "new", "prompt"],
    });
    expect(report.capabilities).toMatchObject({
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    });
    expect(result.output).toEqual({
      agent: "fixture",
      agentVersion: "1.2.3",
      transcriptPath: request.transcriptPath,
      stopReason: "end_turn",
      permissionDecisions: { allowed: 0, denied: 0 },
    });
    expect(result).not.toHaveProperty("usage");
    expect(progress.mock.calls).toEqual([
      ["fixture：Read file", "info"],
      ["fixture：completed", "info"],
    ]);
    const transcript = (await fs.readFile(request.transcriptPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(transcript[0].update.content.text).toBe("private thought");
    expect(transcript[1].update.rawInput).toEqual({ fixture: true });
    expect(transcript[1].fixtureExtension).toBe("raw-preserved");
    const first = await waitForPid();
    await expectGone(first.pid);
    const again = await connector.run(
      { ...request, transcriptPath: path.join(root, "external", "again.jsonl") },
      ctx,
    );
    expect(again.status).toBe("ok");
    expect((await waitForPid()).pid).not.toBe(first.pid);
  });

  it("即便 agent 主动调用客户端 fs/terminal，也返回 method_not_found 且不写文件", async () => {
    const { connector, ctx, request } = setup();
    request.task = JSON.stringify({ probeClient: true });
    const result = await connector.run(request, ctx);
    expect(result.status).toBe("ok");
    expect(JSON.parse(result.modelContent).clientMethods).toEqual([
      { method: "fs/read_text_file", allowed: false, code: -32601 },
      { method: "fs/write_text_file", allowed: false, code: -32601 },
      { method: "terminal/create", allowed: false, code: -32601 },
    ]);
    expect(await platform.fs.exists(path.join(root, "written.txt"))).toBe(false);
  });

  it("mode 在 new 与 prompt 之间传递不透明 id", async () => {
    const { connector, ctx, request } = setup("normal", { mode: "ask" });
    const result = await connector.run(request, ctx);
    expect(JSON.parse(result.modelContent)).toMatchObject({
      mode: "ask",
      calls: ["initialize", "new", "mode", "prompt"],
    });
  });

  it.each(["authInitialize", "authNew", "authPrompt"])(
    "%s 提示外部登录且只记一次失败",
    async (scenario) => {
      const { connector, ctx, request, records } = setup(scenario);
      const result = await connector.run(request, ctx);
      expect(result).toMatchObject({
        status: "error",
        error: { code: "external_agent_auth_required" },
      });
      expect(result.modelContent).toContain("登录");
      expect(records.filter((entry) => entry.kind === "external_agent.failed")).toHaveLength(1);
      await expectGone((await waitForPid()).pid);
    },
  );

  it.each(["crash", "badMode"])("%s 有界失败并清进程", async (scenario) => {
    const { connector, ctx, request, records } = setup(scenario, { mode: "ask" });
    const result = await connector.run(request, ctx);
    expect(result.status).toBe("error");
    expect(records.filter((entry) => entry.kind === "external_agent.failed")).toHaveLength(1);
    await expectGone((await waitForPid()).pid);
  });

  it("未知名称不启动进程", async () => {
    const { connector, ctx, request } = setup();
    expect(await connector.run({ ...request, agent: "disabled" }, ctx)).toMatchObject({
      status: "error",
      error: { code: "invalid_input" },
    });
    expect(await platform.fs.exists(path.join(root, "pids.json"))).toBe(false);
  });

  it.each(["normalTree", "ignoreCancelTree"])(
    "%s 正常/timeout 均结束根和子树",
    async (scenario) => {
      const { connector, ctx, request } = setup(scenario);
      const running = connector.run(
        { ...request, timeoutMs: scenario === "normalTree" ? 10_000 : 2_000 },
        ctx,
      );
      const pids = await waitForPid();
      const result = await running;
      expect(result.status).toBe(scenario === "normalTree" ? "ok" : "error");
      if (scenario === "ignoreCancelTree") {
        expect(result).toMatchObject({ error: { code: "timeout" } });
        expect(await fs.readFile(path.join(root, "cancel.txt"), "utf8")).toBe("cancel");
      }
      await expectGone(pids.pid);
      await expectGone(pids.child);
    },
  );

  it.each(["hangTree", "ignoreCancelTree"])("%s abort 先 cancel，宽限后清树", async (scenario) => {
    const { connector, ctx, request } = setup(scenario);
    const running = connector.run(request, ctx);
    const pids = await waitForPid();
    await vi.waitFor(
      async () => expect(await fs.readFile(path.join(root, "ready.txt"), "utf8")).toBe("prompt"),
      { timeout: 10_000, interval: 10 },
    );
    controller.abort();
    const result = await running;
    expect(result).toMatchObject({ status: "error", error: { code: "cancelled" } });
    expect(await fs.readFile(path.join(root, "cancel.txt"), "utf8")).toBe("cancel");
    await expectGone(pids.pid);
    await expectGone(pids.child);
  });

  it("启动前 abort 不创建进程", async () => {
    const { connector, ctx, request } = setup();
    controller.abort();
    expect(await connector.run(request, ctx)).toMatchObject({ error: { code: "cancelled" } });
    expect(await platform.fs.exists(path.join(root, "pids.json"))).toBe(false);
  });

  it("展开用户 env 引用，不把 stderr/message chunks 当进度", async () => {
    const previous = process.env.NOCTURNE_TEST_ENV;
    process.env.NOCTURNE_TEST_ENV = "expanded";
    try {
      const { connector, ctx, request } = setup("normal", {
        env: { NOCTURNE_TEST_VALUE: "${NOCTURNE_TEST_ENV}" },
      });
      expect(JSON.parse((await connector.run(request, ctx)).modelContent).env).toBe("expanded");
    } finally {
      if (previous === undefined) delete process.env.NOCTURNE_TEST_ENV;
      else process.env.NOCTURNE_TEST_ENV = previous;
    }
  });

  it.runIf(process.platform === "win32")("cmd shim 的 ACP 正常调用与 abort 清树", async () => {
    const directory = path.join(root, "shim space");
    await fs.mkdir(directory);
    const shim = path.join(directory, "agent.cmd");
    await fs.writeFile(shim, `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`);
    const normal = setup("normal", { command: shim, args: ["normalTree"] });
    const result = await normal.connector.run(normal.request, normal.ctx);
    expect(result.status).toBe("ok");
    const first = await waitForPid();
    await expectGone(first.pid);
    await expectGone(first.child);
    const hanging = setup("normal", { command: shim, args: ["ignoreCancelTree"] });
    const running = hanging.connector.run(hanging.request, hanging.ctx);
    await vi.waitFor(
      async () => expect(await fs.readFile(path.join(root, "ready.txt"), "utf8")).toBe("prompt"),
      { timeout: 10_000, interval: 10 },
    );
    const second = await waitForPid();
    controller.abort();
    expect(await running).toMatchObject({ error: { code: "cancelled" } });
    await expectGone(second.pid);
    await expectGone(second.child);
  });

  it.runIf(process.platform !== "win32")(
    "根崩溃且子进程占管道时，exit 早检测并终止进程组",
    async () => {
      const { connector, ctx, request } = setup("crashTree");
      const result = await connector.run(request, ctx);
      expect(result).toMatchObject({ status: "error", error: { code: "external_agent_crashed" } });
      await expectGone((await waitForPid()).child);
    },
  );
});

describe("执行期权限与审计", () => {
  it("覆盖全部 kind 与无路径/多路径，危险未知 kind 不调用 gate", async () => {
    const { connector, ctx, request, permission, records } = setup();
    request.task = JSON.stringify({
      permissions: [
        { kind: "read", locations: [{ path: "src/a.ts" }, { path: "src/b.ts" }] },
        { kind: "search" },
        { kind: "edit" },
        { kind: "delete" },
        { kind: "move" },
        { kind: "execute", rawInput: { command: "must not authorize this string" } },
        { kind: "fetch", locations: [{ path: "https://example.com" }] },
        { kind: "switch_mode" },
        { kind: "think" },
        { kind: "other" },
        { kind: "future_kind" },
        {},
      ],
    });
    const result = await connector.run(request, ctx);
    expect(result.status).toBe("ok");
    expect(permission.mock.calls.map(([subjects]) => subjects)).toEqual([
      [
        { kind: "read", target: path.join(root, "src/a.ts") },
        { kind: "read", target: path.join(root, "src/b.ts") },
      ],
      [{ kind: "read", target: "*" }],
      [{ kind: "edit", target: "*" }],
      [{ kind: "edit", target: "*" }],
      [{ kind: "edit", target: "*" }],
      [{ kind: "shell", target: "*" }],
      [{ kind: "network", target: "*" }],
    ]);
    expect(result.output?.permissionDecisions).toEqual({ allowed: 7, denied: 5 });
    const entries = (await fs.readFile(request.transcriptPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.type === "permission");
    expect(entries).toHaveLength(12);
    expect(entries[0]).toMatchObject({
      decision: "allow",
      source: "rule",
      subjects: permission.mock.calls[0]?.[0],
    });
    expect(entries[7]).toMatchObject({ decision: "deny", source: "unsupported_kind" });
    expect(records.filter((entry) => entry.kind === "external_agent.permission")).toHaveLength(12);
  });

  it("gate deny 选择 reject_once，写决定/source 与 denied计数", async () => {
    const { connector, ctx, request, permission } = setup();
    permission.mockResolvedValue({ decision: "deny", source: "non_interactive" });
    request.task = JSON.stringify({ permissions: [{ kind: "edit" }] });
    const result = await connector.run(request, ctx);
    expect(JSON.parse(result.modelContent).permissions).toEqual([
      { outcome: "selected", optionId: "deny" },
    ]);
    expect(result.output?.permissionDecisions).toEqual({ allowed: 0, denied: 1 });
    expect(await fs.readFile(request.transcriptPath, "utf8")).toContain(
      '"source":"non_interactive"',
    );
  });
  it.each([
    {
      options: [
        { optionId: "always", kind: "allow_always", name: "Always" },
        { optionId: "deny", kind: "reject_once", name: "Deny" },
      ],
      outcome: { outcome: "selected", optionId: "deny" },
    },
    {
      options: [{ optionId: "always", kind: "allow_always", name: "Always" }],
      outcome: { outcome: "cancelled" },
    },
    { options: [], outcome: { outcome: "cancelled" } },
  ])("缺少 allow_once 时不升级永久授权：$options", async ({ options, outcome }) => {
    const { connector, ctx, request } = setup();
    request.task = JSON.stringify({ permissions: [{ kind: "edit" }], options });
    const result = await connector.run(request, ctx);
    expect(JSON.parse(result.modelContent).permissions).toEqual([outcome]);
    expect(result.output?.permissionDecisions).toEqual({ allowed: 0, denied: 1 });
    expect(await fs.readFile(request.transcriptPath, "utf8")).toContain(
      '"source":"missing_allow_once"',
    );
  });
});
