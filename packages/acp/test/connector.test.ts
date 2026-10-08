import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPlatform,
  type ExternalAgentConfig,
  type ExternalAgentPermissionDecision,
  type Platform,
  type SubjectRequest,
  type ToolContext,
} from "@nocturne/core";
import { createAcpConnector } from "../src/index.js";
import { createProcessCleanup, removeTempDirs } from "../../../scripts/test/process-cleanup.mjs";

const fixture = fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url));
const processes = createProcessCleanup();
const platform = processes.platform(createPlatform());
let root: string;
let controller: AbortController;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "nctrn-acp-"));
  processes.watchPidFile(path.join(root, "pids.json"));
  controller = new AbortController();
});
afterEach(async () => {
  await processes.cleanup();
  await removeTempDirs([root]);
});

function setup(
  scenario = "normal",
  extra: Partial<ExternalAgentConfig> = {},
  runPlatform: Platform = platform,
) {
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
      NOCTURNE_TEST_RELEASE_FILE: path.join(root, "release.txt"),
    },
    ...extra,
  };
  const ctx: ToolContext = {
    cwd: root,
    workspaceRoot: root,
    paths: runPlatform.paths,
    sessionId: "parent",
    turnId: "turn",
    callId: "call",
    signal: controller.signal,
    subjects: [],
    permissions: { check: () => "deny" },
    fs: runPlatform.fs,
    process: runPlatform.process,
    readState: {
      record() {
        /* 外部 agent 不走内置已读追踪。 */
      },
      get: () => undefined,
    },
    progress,
  };
  const acp = createAcpConnector(runPlatform, {
    record(kind, data) {
      records.push({ kind, data });
    },
  });
  const connector = {
    run: (request: Parameters<typeof acp.run>[1], context: ToolContext) =>
      acp.run(config, request, context),
    probe: (input: Parameters<typeof acp.probe>[1]) => acp.probe(config, input),
  };
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
  return { connector, acp, config, ctx, request, permission, progress, records };
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
  processes.trackPid(pids.pid);
  if (pids.child) processes.trackPid(pids.child);
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
  it("无 title 的更新不输出、同标题不重复，failed 使用已有标题仅输出一次", async () => {
    const { connector, ctx, request, progress } = setup("progress");
    expect((await connector.run(request, ctx)).status).toBe("ok");
    expect(progress.mock.calls.slice(0, 2)).toEqual([
      ["fixture：Check files", "info"],
      ["fixture：Check files（失败）", "info"],
    ]);
    expect(progress).toHaveBeenCalledTimes(8);
    expect(
      progress.mock.calls.every(
        ([line]) => !line.includes("in_progress") && !line.includes("completed"),
      ),
    ).toBe(true);
  });

  it.each(["timer", "signal"])(
    "%s 超时包含最近五条进度与工作区检查提示，长度有界",
    async (source) => {
      const { connector, ctx, request, progress } = setup("progressTimeout");
      const resultPromise = connector.run(
        source === "timer" ? { ...request, timeoutMs: 2000 } : { ...request, timeoutMs: undefined },
        ctx,
      );
      await vi.waitFor(() => expect(progress).toHaveBeenCalledTimes(8), { timeout: 1500 });
      if (source === "signal") controller.abort(new DOMException("Timeout", "TimeoutError"));
      const result = await resultPromise;
      expect(result.status === "error" && result.error.code).toBe("timeout");
      expect(result.modelContent).toContain("step 1");
      expect(result.modelContent).toContain("step 5");
      expect(result.modelContent).not.toContain("step 0");
      expect(result.modelContent).toContain("它可能已修改工作区文件，请先检查 git status");
      expect(result.modelContent.length).toBeLessThan(2048);
      expect(result.modelContent).not.toContain("\n");
    },
  );

  it("新进程、最终文本、原文审计与仅工具单行进度", async () => {
    const { connector, ctx, request, progress } = setup();
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
    expect(progress.mock.calls).toEqual([["fixture：Read file", "info"]]);
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

  it("每次调用使用传入配置而非固化列表", async () => {
    const { acp, config, ctx, request } = setup();
    const result = await acp.run({ ...config, name: "changed", mode: "ask" }, request, ctx);
    expect(result).toMatchObject({ status: "ok", output: { agent: "changed" } });
    expect(JSON.parse(result.modelContent).mode).toBe("ask");
  });

  it("逐项设置configOptions并在prompt前生效", async () => {
    const { connector, request, ctx } = setup("normal", {
      mode: "ask",
      configOptions: { model: "large", effort: "high" },
    });
    const result = await connector.run(request, ctx);
    expect(result.status).toBe("ok");
    expect(JSON.parse(result.modelContent)).toMatchObject({
      calls: ["initialize", "new", "mode", "config:model", "config:effort", "prompt"],
      configOptions: [
        { id: "model", currentValue: "large" },
        { id: "effort", currentValue: "high" },
      ],
    });
  });

  it("拒绝配置项时报告原始id且不发送prompt", async () => {
    const probeFile = path.join(root, "probe.json");
    const { connector, request, ctx } = setup("badConfig", {
      configOptions: { "opaque.id": "opaque.value" },
      env: { NOCTURNE_TEST_PROBE_FILE: probeFile },
    });
    expect(await connector.run(request, ctx)).toMatchObject({
      status: "error",
      error: {
        code: "external_agent_config_rejected",
        message: expect.stringContaining("opaque.id"),
      },
    });
    expect(JSON.parse(await fs.readFile(probeFile, "utf8")).calls).toEqual([
      "initialize",
      "new",
      "config:opaque.id",
    ]);
  });

  it("指定项拒绝不影响之前的设置，但阻止prompt", async () => {
    const probeFile = path.join(root, "probe.json");
    const { connector, request, ctx } = setup("normal", {
      configOptions: { model: "large", effort: "high" },
      env: { NOCTURNE_TEST_PROBE_FILE: probeFile, NOCTURNE_TEST_REJECT_CONFIG_ID: "effort" },
    });
    expect(await connector.run(request, ctx)).toMatchObject({
      status: "error",
      error: { code: "external_agent_config_rejected", message: expect.stringContaining("effort") },
    });
    const report = JSON.parse(await fs.readFile(probeFile, "utf8"));
    expect(report.calls).toEqual(["initialize", "new", "config:model", "config:effort"]);
    expect(
      report.configOptions.find((option: { id: string }) => option.id === "model").currentValue,
    ).toBe("large");
  });

  it("probe返回信息和扁平选项、无需认证、不发送prompt并移除临时cwd", async () => {
    const probeFile = path.join(root, "probe.json");
    const { connector } = setup("probeOnly", {
      env: { NOCTURNE_TEST_PROBE_FILE: probeFile },
      configOptions: { model: "large" },
    });
    const result = await connector.probe({ nocturneHome: root });
    expect(result).toMatchObject({
      ok: true,
      durationMs: expect.any(Number),
      agentInfo: { name: "fixture", version: "1.2.3" },
      authMethods: [{ id: "login", name: "CLI login" }],
      configOptions: [
        {
          id: "model",
          currentValue: "small",
          options: [
            { value: "small", name: "Small", group: "Fixture" },
            {
              value: "large",
              name: "Large",
              description: "provider/large",
              group: "Fixture",
            },
          ],
        },
        { id: "effort", currentValue: "low" },
      ],
    });
    const report = JSON.parse(await fs.readFile(probeFile, "utf8"));
    expect(report.calls).toEqual(["initialize", "new"]);
    expect(path.dirname(report.cwd)).toBe(root);
    expect(await platform.fs.exists(report.cwd)).toBe(false);
  });

  it.each(["authInitialize", "authNew"])("probe %s保留认证错误", async (scenario) => {
    const { connector } = setup(scenario);
    expect(await connector.probe({ nocturneHome: root })).toMatchObject({
      ok: false,
      error: { code: "external_agent_auth_required" },
    });
    await expectGone((await waitForPid()).pid);
  });

  it("probe命令缺失时不启动进程", async () => {
    const { connector } = setup("normal", { command: "nocturne-acp-command-that-does-not-exist" });
    expect(await connector.probe({ nocturneHome: root })).toMatchObject({
      ok: false,
      error: { code: "external_agent_not_installed" },
    });
    expect(await platform.fs.exists(path.join(root, "pids.json"))).toBe(false);
  });

  it.each(["hangInitialize", "hangNewTree"])(
    "probe %s有界超时并清理临时目录和树",
    async (scenario) => {
      const { connector } = setup(scenario);
      expect(await connector.probe({ nocturneHome: root, timeoutMs: 2_000 })).toMatchObject({
        ok: false,
        error: { code: "timeout" },
      });
      const pids = await waitForPid();
      await expectGone(pids.pid);
      if (pids.child !== undefined) await expectGone(pids.child);
      expect((await fs.readdir(root)).filter((name) => name.startsWith("acp-probe-"))).toEqual([]);
    },
  );

  it("probe通过PATH解析不带路径的可执行命令", async () => {
    const { connector } = setup("probeOnly", {
      command: path.basename(process.execPath),
      env: { PATH: path.dirname(process.execPath) },
    });
    expect(await connector.probe({ nocturneHome: root })).toMatchObject({ ok: true });
  });

  it.runIf(process.platform === "win32")("probe解析PATH/PATHEXT的cmd shim且超时清树", async () => {
    const directory = path.join(root, "probe shim space");
    await fs.mkdir(directory);
    await fs.writeFile(
      path.join(directory, "probe-agent.cmd"),
      `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`,
    );
    const { connector, config } = setup("normal", {
      command: "probe-agent",
      args: ["probeOnly"],
    });
    config.env = {
      ...config.env,
      PATH: `${directory};${process.env.PATH ?? ""}`,
      PATHEXT: ".CMD;.EXE",
    };
    expect(await connector.probe({ nocturneHome: root })).toMatchObject({ ok: true });
    await expectGone((await waitForPid()).pid);
    config.args = ["hangNewTree"];
    expect(await connector.probe({ nocturneHome: root, timeoutMs: 2_000 })).toMatchObject({
      ok: false,
      error: { code: "timeout" },
    });
    const pids = await waitForPid();
    await expectGone(pids.pid);
    await expectGone(pids.child);
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

  it("省略 timeoutMs 时超过 120 秒仍等待真实 agent 完成", async () => {
    const { connector, ctx, request } = setup("release");
    const { timeoutMs: _timeoutMs, ...withoutTimeout } = request;
    const timers = vi.spyOn(globalThis, "setTimeout");
    const clearedTimers = vi.spyOn(globalThis, "clearTimeout");
    let settled = false;
    const running = connector.run(withoutTimeout, ctx).finally(() => {
      settled = true;
    });
    try {
      const pids = await waitForPid();
      await vi.waitFor(
        async () => expect(await fs.readFile(path.join(root, "ready.txt"), "utf8")).toBe("prompt"),
        { timeout: 10_000, interval: 10 },
      );
      // READY 以前使用真实计时器，不能冻结跨进程 initialize/new/prompt 握手。
      // 将尚未清除的请求期限移入 fake clock，实际触发旧 connector/SDK 超时，
      // 而不是只检查源码或遗漏启动阶段已创建的原生计时器。
      const deadlines = timers.mock.calls.flatMap(([callback, ms, ...args], index) => {
        const handle = timers.mock.results[index]?.value as NodeJS.Timeout;
        if ((ms ?? 0) < 30_000 || clearedTimers.mock.calls.some(([timer]) => timer === handle))
          return [];
        clearTimeout(handle);
        return [{ callback: () => callback(...args), ms }];
      });
      timers.mockRestore();
      clearedTimers.mockRestore();
      vi.useFakeTimers();
      for (const deadline of deadlines) setTimeout(deadline.callback, deadline.ms);
      await vi.advanceTimersByTimeAsync(121_000);
      expect(settled).toBe(false);
      expect(ctx.signal.aborted).toBe(false);
      vi.useRealTimers();
      await fs.writeFile(path.join(root, "release.txt"), "release");
      const result = await running;
      expect(result).toMatchObject({ status: "ok", output: { stopReason: "end_turn" } });
      expect(JSON.parse(result.modelContent)).toMatchObject({
        task: request.task,
        calls: ["initialize", "new", "prompt"],
      });
      await expectGone(pids.pid);
    } finally {
      vi.useRealTimers();
      timers.mockRestore();
      clearedTimers.mockRestore();
      if (!settled) controller.abort();
      await running;
    }
  });

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
  it.each(["mkdir", "writeFile", "appendFile"] as const)(
    "%s 失败仅诊断一次，真实协议、权限统计与最终回复继续且停止写入",
    async (operation) => {
      const auditFs = {
        ...platform.fs,
        mkdir: vi.fn(platform.fs.mkdir),
        writeFile: vi.fn(platform.fs.writeFile),
        appendFile: vi.fn(platform.fs.appendFile),
      };
      auditFs[operation].mockRejectedValue(new Error("fixture transcript failure"));
      const { connector, ctx, request, permission, progress, records } = setup(
        "normal",
        {},
        { ...platform, fs: auditFs },
      );
      if (operation === "appendFile") {
        // 首次 append 等全部 gate 被真实 SDK 调用；其他 permission 写入已排队。
        const approvals = Promise.withResolvers<undefined>();
        let allowed = 0;
        permission.mockImplementation(async () => {
          if (++allowed === 2) approvals.resolve(undefined);
          return { decision: "allow", source: "rule" };
        });
        auditFs.appendFile.mockImplementation(async () => {
          await approvals.promise;
          throw new Error("fixture transcript failure");
        });
      }
      request.task = JSON.stringify({
        concurrentPermissions: true,
        permissions: [{ kind: "think" }, { kind: "read" }, { kind: "edit" }],
      });
      const result = await connector.run(request, ctx);
      expect(result).toMatchObject({
        status: "ok",
        output: {
          agentVersion: "1.2.3",
          transcriptPath: request.transcriptPath,
          transcriptError: true,
          stopReason: "end_turn",
          permissionDecisions: { allowed: 2, denied: 1 },
        },
      });
      expect(JSON.parse(result.modelContent)).toMatchObject({
        task: request.task,
        calls: ["initialize", "new", "prompt"],
        permissions: [
          { outcome: "selected", optionId: "deny" },
          { outcome: "selected", optionId: "allow" },
          { outcome: "selected", optionId: "allow" },
        ],
      });
      expect(permission).toHaveBeenCalledTimes(2);
      expect(progress.mock.calls).toEqual([["fixture：Read file", "info"]]);
      expect(records.filter((entry) => entry.kind === "external_agent.permission")).toHaveLength(3);
      expect(records.filter((entry) => entry.kind === "external_agent.transcript_failed")).toEqual([
        {
          kind: "external_agent.transcript_failed",
          data: { agent: "fixture", callId: "call", transcriptPath: request.transcriptPath },
        },
      ]);
      expect(records.filter((entry) => entry.kind === "external_agent.failed")).toHaveLength(0);
      expect(auditFs.mkdir).toHaveBeenCalledTimes(1);
      expect(auditFs.writeFile).toHaveBeenCalledTimes(operation === "mkdir" ? 0 : 1);
      expect(auditFs.appendFile).toHaveBeenCalledTimes(operation === "appendFile" ? 1 : 0);
      await expectGone((await waitForPid()).pid);
    },
  );

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
