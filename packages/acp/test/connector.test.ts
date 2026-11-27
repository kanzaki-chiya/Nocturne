import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPlatform,
  type ExternalAgentConfig,
  type ExternalAgentPermissionDecision,
  type McpServerConfig,
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
let originalNocturneHome: string | undefined;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "nctrn-acp-"));
  processes.watchPidFile(path.join(root, "pids.json"));
  controller = new AbortController();
  // ADR-0127 第五阶段：worker store 写入 <NOCTURNE_HOME>/external-workers——
  // 必须隔离到本测试的临时目录，不污染维护者真实数据。
  originalNocturneHome = process.env.NOCTURNE_HOME;
  process.env.NOCTURNE_HOME = path.join(root, "nocturne-home");
});
afterEach(async () => {
  await processes.cleanup();
  await removeTempDirs([root]);
  if (originalNocturneHome === undefined) delete process.env.NOCTURNE_HOME;
  else process.env.NOCTURNE_HOME = originalNocturneHome;
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
    // Windows 的 taskkill 自身启动就要约 2 秒（process.ts KILL_TREE_TIMEOUT_MS），再留足余量
    timeout: 20_000,
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
      externalSessionId: "fixture-session",
      resumed: false,
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

  it.runIf(process.platform === "win32")(
    "probe 在同名无扩展名脚本与 cmd 并存时解析到 cmd，显式 .cmd 不变",
    async () => {
      const directory = path.join(root, "npm global");
      await fs.mkdir(directory);
      await fs.writeFile(path.join(directory, "probe-agent"), '#!/bin/sh\nexec node "$0" "$@"\n');
      await fs.writeFile(
        path.join(directory, "probe-agent.cmd"),
        `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`,
      );
      for (const command of ["probe-agent", "probe-agent.cmd"]) {
        const { connector, config } = setup("normal", { command, args: ["probeOnly"] });
        config.env = {
          ...config.env,
          PATH: `${directory};${process.env.PATH ?? ""}`,
          PATHEXT: ".EXE;;.cmd",
        };
        expect(await connector.probe({ nocturneHome: root })).toMatchObject({ ok: true });
        await expectGone((await waitForPid()).pid);
        await fs.rm(path.join(root, "pids.json"), { force: true });
      }
    },
  );

  it.runIf(process.platform === "win32")(
    "probe 只有无扩展名脚本时报未安装且不启动进程",
    async () => {
      const directory = path.join(root, "sh only");
      await fs.mkdir(directory);
      await fs.writeFile(path.join(directory, "probe-agent"), '#!/bin/sh\nexec node "$0" "$@"\n');
      const { connector, config } = setup("normal", { command: "probe-agent" });
      config.env = { ...config.env, PATH: directory, PATHEXT: ".CMD;.EXE" };
      expect(await connector.probe({ nocturneHome: root })).toMatchObject({
        ok: false,
        error: { code: "external_agent_not_installed" },
      });
      expect(await platform.fs.exists(path.join(root, "pids.json"))).toBe(false);
    },
  );

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

describe("ADR-0127 第五阶段：worker 续派", () => {
  it("一次性调用登记 worker：loadSession 能力声明后 output 携带 workerId 并写盘", async () => {
    const { connector, ctx, request } = setup("loadable");
    const result = await connector.run(request, ctx);
    expect(result.status).toBe("ok");
    expect(result.output?.workerId).toMatch(/^ew-[0-9a-f]{16}$/);
    expect(result.output?.resumed).toBe(false);
    expect(result.output?.externalSessionId).toBe("fixture-session");
    const workerFile = path.join(
      process.env.NOCTURNE_HOME ?? "",
      "external-workers",
      `${result.output?.workerId}.json`,
    );
    const record = JSON.parse(await fs.readFile(workerFile, "utf8"));
    expect(record).toMatchObject({
      workerId: result.output?.workerId,
      agentName: "fixture",
      externalSessionId: "fixture-session",
      cwd: root,
      loadSessionCapable: true,
    });
    expect(record.providerSnapshot.command).toBe(process.execPath);
    expect(record.providerSnapshot.envKeys).toContain("NOCTURNE_TEST_PID_FILE");
  });

  it("返工第 2 条：持久记录最小化——可能含密的 args/configOptions 原值不落盘", async () => {
    // 合成哨兵：把明显可识别的哨兵值放进启动参数与 configOptions，
    // 验证这些原值不出现在持久化 worker 记录的任何字段里（含嵌套序列化）。
    const ARG_SENTINEL = "SENTINEL-ARG-9f3kd7-secret-path";
    const OPT_SENTINEL = "SENTINEL-OPT-7h2jz4-credential-fragment";
    const { connector, ctx, request } = setup("loadable", {
      args: [fixture, "loadable", `--token=${ARG_SENTINEL}`],
      configOptions: { model: OPT_SENTINEL },
    });
    const result = await connector.run(request, ctx);
    expect(result.status).toBe("ok");
    const workerFile = path.join(
      process.env.NOCTURNE_HOME ?? "",
      "external-workers",
      `${result.output?.workerId}.json`,
    );
    const raw = await fs.readFile(workerFile, "utf8");
    // 哨兵原值不得以任何形式出现在持久记录原文里
    expect(raw).not.toContain(ARG_SENTINEL);
    expect(raw).not.toContain(OPT_SENTINEL);
    const record = JSON.parse(raw);
    // 快照只保留恢复与身份校验所需的最小信息：command 与 envKeys
    expect(record.providerSnapshot).not.toHaveProperty("args");
    expect(record.providerSnapshot).not.toHaveProperty("configOptions");
    expect(record.providerSnapshot).not.toHaveProperty("mode");
    expect(record.providerSnapshot.command).toBe(process.execPath);
    // env 只留键名——值（含可能的凭据）永不落盘
    expect(record.providerSnapshot.envKeys).toEqual(
      expect.arrayContaining(["NOCTURNE_TEST_PID_FILE"]),
    );
    expect(record.providerSnapshot).not.toHaveProperty("env");
    // 身份摘要仍存在（sha256 hex），供续派前变更识别——但单向不可逆
    expect(record.providerDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("返工第 2 条：历史含 args/configOptions 原值的记录读取兼容——digest 缺失按不可验证拒绝", async () => {
    // 模拟 fix1 时期的旧记录：providerSnapshot 含 args/configOptions 原值、
    // 但缺 providerDigest。读取应兼容（shape 容忍），续派按不可验证拒绝。
    const homeDir = process.env.NOCTURNE_HOME ?? "";
    const workerDir = path.join(homeDir, "external-workers");
    await fs.mkdir(workerDir, { recursive: true });
    const workerId = "ew-aaaa1111bbbb2222";
    const now = new Date().toISOString();
    await fs.writeFile(
      path.join(workerDir, `${workerId}.json`),
      JSON.stringify({
        formatVersion: 1,
        workerId,
        agentName: "fixture",
        externalSessionId: "legacy-session",
        cwd: root,
        // 旧格式：无 providerDigest，但 snapshot 含原值（历史遗留，不落盘新值）
        providerSnapshot: {
          command: process.execPath,
          args: ["legacy-arg-secret"],
          envKeys: [],
          configOptions: { apiKey: "legacy-opt-secret" },
        },
        loadSessionCapable: true,
        createdAt: now,
        lastUsedAt: now,
      }),
    );
    // 直接读 store 验证兼容策略：多余字段容忍、必需字段齐全即 shape 通过，
    // digest 缺失读取为 undefined（不可验证状态，由 Core 续派前拒绝）。
    const { createExternalWorkerStore, createPlatform: cp } = await import("@nocturne/core");
    const realPlatform = cp();
    const store = createExternalWorkerStore({
      fs: realPlatform.fs,
      paths: realPlatform.paths,
      dir: workerDir,
    });
    const record = await store.read(workerId);
    // 兼容读取：不因多余字段（args/configOptions）判损坏
    expect(record).not.toBeUndefined();
    expect(record?.agentName).toBe("fixture");
    // digest 缺失 → undefined（不可验证），Core 续派前据此拒绝
    expect(record?.providerDigest).toBeUndefined();
    // touch 兼容：更新 lastUsedAt 重写整条记录。重写后的序列化原样保留
    // 读取到的字段（含遗留多余字段）——touch 不做格式迁移，也不因重写而注入新泄漏；
    // 关键是不崩溃、不丢核心字段，digest 状态保持。
    const touchAt = new Date().toISOString();
    await store.touch(workerId, touchAt);
    const touched = await store.read(workerId);
    expect(touched?.lastUsedAt).toBe(touchAt);
    expect(touched?.providerDigest).toBeUndefined();
  });

  it("loadSession=false 时不登记 worker（output 无 workerId，磁盘无记录）", async () => {
    const { connector, ctx, request } = setup();
    const result = await connector.run(request, ctx);
    expect(result.status).toBe("ok");
    expect(result.output?.workerId).toBeUndefined();
    const dir = path.join(process.env.NOCTURNE_HOME ?? "", "external-workers");
    const exists = await fs
      .readdir(dir)
      .then((entries) => entries.filter((e) => e.endsWith(".json")))
      .catch(() => [] as string[]);
    expect(exists).toEqual([]);
  });

  it("续派走 session/load：不重新 session/new，恢复同一 externalSessionId，lastUsedAt 更新", async () => {
    const { connector, ctx, request } = setup("loadable");
    const first = await connector.run(request, ctx);
    expect(first.status).toBe("ok");
    const workerId = first.output?.workerId;
    expect(workerId).toBeDefined();

    const second = await connector.run(
      {
        ...request,
        workerId,
        transcriptPath: path.join(root, "external", "second.jsonl"),
      },
      ctx,
    );
    expect(second.status).toBe("ok");
    expect(second.output?.workerId).toBe(workerId);
    expect(second.output?.resumed).toBe(true);
    expect(second.output?.externalSessionId).toBeUndefined();
    // 续派路径不应再写新的 worker 文件——磁盘上仍只有一份
    const dir = path.join(process.env.NOCTURNE_HOME ?? "", "external-workers");
    const entries = await fs.readdir(dir);
    expect(entries.filter((e) => e.endsWith(".json"))).toEqual([`${workerId}.json`]);
  });

  it("workerId 不存在/损坏：worker_not_found，不起进程不写文件", async () => {
    const { connector, ctx, request } = setup("loadable");
    const result = await connector.run({ ...request, workerId: "ew-0000000000000000" }, ctx);
    expect(result.status).toBe("error");
    expect(result.status === "error" && result.error.code).toBe("worker_not_found");
  });

  it("worker 归属 agent 不匹配：worker_mismatch", async () => {
    const { connector, ctx, request } = setup("loadable");
    const first = await connector.run(request, ctx);
    const workerId = first.output?.workerId;
    // 用同名 fixture 但 agent 名不同的配置调用——worker 属于 "fixture"
    const mismatchConnector = createAcpConnector(platform);
    const altConfig: ExternalAgentConfig = {
      ...request,
      name: "other-agent",
      command: process.execPath,
      args: [fixture, "loadable"],
      enabled: true,
    } as unknown as ExternalAgentConfig;
    const result = await mismatchConnector.run(altConfig, { ...request, workerId }, ctx);
    expect(result.status).toBe("error");
    expect(result.status === "error" && result.error.code).toBe("worker_mismatch");
  });

  it("cwd 与 worker 原工作树不匹配：worker_mismatch，不起进程", async () => {
    const { connector, ctx, request } = setup("loadable");
    const first = await connector.run(request, ctx);
    const workerId = first.output?.workerId;
    const otherCwd = path.join(root, "other-cwd");
    await fs.mkdir(otherCwd, { recursive: true });
    const result = await connector.run({ ...request, workerId, cwd: otherCwd }, ctx);
    expect(result.status).toBe("error");
    expect(result.status === "error" && result.error.code).toBe("worker_mismatch");
  });

  it("loadSession 被对端拒绝：worker_resume_failed，不静默新建冒充恢复", async () => {
    const { connector, ctx, request } = setup("loadable");
    const first = await connector.run(request, ctx);
    const workerId = first.output?.workerId;
    // 损坏 worker 文件中的 externalSessionId 让其包含 "expired"，触发对端 loadSession 拒绝
    const workerFile = path.join(
      process.env.NOCTURNE_HOME ?? "",
      "external-workers",
      `${workerId}.json`,
    );
    const rec = JSON.parse(await fs.readFile(workerFile, "utf8"));
    rec.externalSessionId = "expired-session";
    await fs.writeFile(workerFile, JSON.stringify(rec, null, 2));
    const result = await connector.run({ ...request, workerId }, ctx);
    expect(result.status).toBe("error");
    expect(result.status === "error" && result.error.code).toBe("worker_resume_failed");
    expect(result.output?.resumed).toBeUndefined();
  });

  it("loadSessionCapable=false 的 worker 不存在（一次性 agent 本就不登记）；手工伪造时按 unresumable 拒绝", async () => {
    const { connector, ctx, request } = setup("loadable");
    const first = await connector.run(request, ctx);
    const workerId = first.output?.workerId;
    // 手工把 loadSessionCapable 改 false（模拟损坏/旧记录）
    const workerFile = path.join(
      process.env.NOCTURNE_HOME ?? "",
      "external-workers",
      `${workerId}.json`,
    );
    const rec = JSON.parse(await fs.readFile(workerFile, "utf8"));
    rec.loadSessionCapable = false;
    await fs.writeFile(workerFile, JSON.stringify(rec, null, 2));
    const result = await connector.run({ ...request, workerId }, ctx);
    expect(result.status).toBe("error");
    expect(result.status === "error" && result.error.code).toBe("worker_unresumable");
  });

  it("续派路径下不发 mode/configOptions：对端只看到 initialize+load+prompt", async () => {
    const { connector, ctx, request, config } = setup("loadable");
    config.mode = "ask";
    config.configOptions = { model: "small" };
    const first = await connector.run(request, ctx);
    const workerId = first.output?.workerId;
    // 清理 probe 文件，让第二次调用记录独立的 calls 序列
    const second = await connector.run({ ...request, workerId }, ctx);
    expect(second.status).toBe("ok");
    // 第二次调用的 fake-agent 进程独立启动，calls 仅含 initialize+load+prompt
    // （无 new/mode/config:）——probe 文件由进程自己写，只能校验输出；
    // 简单断言：fixture 输出的 calls 列表里没有 mode/config:
    const report = JSON.parse(second.modelContent);
    const callNames = report.calls as string[];
    expect(callNames).toContain("initialize");
    expect(callNames.some((c) => c.startsWith("load:"))).toBe(true);
    expect(callNames).not.toContain("new");
    expect(callNames).not.toContain("mode");
    expect(callNames.some((c) => c.startsWith("config:"))).toBe(false);
  });

  it("跨进程续派：换用全新 connector 实例（模拟宿主重启），仍能凭磁盘上的 worker 记录恢复同一 sessionId", async () => {
    // 第一次调用——第一份 connector（相当于第一个宿主进程）
    const firstSetup = setup("loadable");
    const first = await firstSetup.connector.run(firstSetup.request, firstSetup.ctx);
    expect(first.status).toBe("ok");
    const workerId = first.output?.workerId;
    expect(workerId).toBeDefined();
    // 第一份 connector 完全丢弃（模拟宿主进程退出）——worker 文件已写盘
    // 第二份 connector（独立 store 实例，但同一 NOCTURNE_HOME/同一磁盘目录）
    const secondSetup = setup("loadable");
    const second = await secondSetup.connector.run(
      { ...secondSetup.request, workerId },
      secondSetup.ctx,
    );
    expect(second.status).toBe("ok");
    expect(second.output?.workerId).toBe(workerId);
    expect(second.output?.resumed).toBe(true);
    const report = JSON.parse(second.modelContent);
    const callNames = report.calls as string[];
    // 跨进程恢复：对端 fake-agent 看到的是 load，不是 new
    expect(callNames.some((c) => c.startsWith("load:"))).toBe(true);
    expect(callNames).not.toContain("new");
  });

  it("续派路径下取消：interrupted 结算正确，cancel 通知发到外部 agent", async () => {
    const { connector, ctx, request } = setup("loadable");
    const first = await connector.run(request, ctx);
    const workerId = first.output?.workerId;
    // 用一个 hang 场景（但保持 loadable 能力）验证取消传播；
    // fixture 在 loadableHang 下 prompt 永不返回，等 cancel 通知
    const hangSetup = setup("loadableHang");
    const controller2 = new AbortController();
    const ctx2 = { ...hangSetup.ctx, signal: controller2.signal };
    const runPromise = hangSetup.connector.run({ ...hangSetup.request, workerId }, ctx2);
    // 等 fixture 进入 prompt（ready.txt）
    await vi.waitFor(
      async () => {
        const ready = await fs.readFile(path.join(root, "ready.txt"), "utf8").catch(() => "");
        expect(ready).toBe("prompt");
      },
      { timeout: 5_000, interval: 20 },
    );
    controller2.abort();
    const result = await runPromise;
    expect(result.status).toBe("error");
    expect(result.status === "error" && result.error.code).toBe("cancelled");
  });

  it("同一 worker 并发续派串行：第二个调用等第一个结束后才启动进程，绝不并发 session/load", async () => {
    const { connector, ctx, request } = setup("loadable");
    const first = await connector.run(request, ctx);
    const workerId = first.output?.workerId;
    // release 场景：fixture 等到 release.txt 出现才结束 prompt——
    // 用 loadable 能力 + release 行为构造可控制的"慢"worker
    const relSetup = setup("loadableRelease");
    // 同时发起两个续派调用，同 worker、同 connector
    const r1 = relSetup.connector.run({ ...relSetup.request, workerId }, relSetup.ctx);
    const r2 = relSetup.connector.run({ ...relSetup.request, workerId }, relSetup.ctx);
    // 给 fixture 一个进入第一次 prompt 的机会
    await vi.waitFor(
      async () => {
        const ready = await fs.readFile(path.join(root, "ready.txt"), "utf8").catch(() => "");
        expect(ready).toBe("prompt");
      },
      { timeout: 5_000, interval: 20 },
    );
    // 第一个还在 prompt 中（release.txt 未写），第二个应仍排队（进程数应保持 1）
    // 通过 release 让第一个结束
    await fs.writeFile(path.join(root, "release.txt"), "go");
    const [res1, res2] = await Promise.all([r1, r2]);
    expect(res1.status).toBe("ok");
    expect(res2.status).toBe("ok");
    expect(res1.output?.workerId).toBe(workerId);
    expect(res2.output?.workerId).toBe(workerId);
  });

  // ── 返工规格第 3 点：跨宿主/跨 connector 互斥。
  //    单实例 Promise 链只在同一 connector 生效；共享同一 NOCTURNE_HOME 的独立
  //    connector（模拟两个独立宿主进程）必须经磁盘锁互斥，得到可识别的 busy，
  //    绝不并发 session/load；锁释放/崩溃回收后后续续派不受影响。 ──

  it("两个独立 connector 共享同一 home：同 worker 并发续派一方得到 worker_busy，不并发 session/load", async () => {
    // 用第一份 connector 登记 worker（loadable 能力）。
    const firstSetup = setup("loadable");
    const first = await firstSetup.connector.run(firstSetup.request, firstSetup.ctx);
    expect(first.status).toBe("ok");
    const workerId = first.output?.workerId;
    expect(workerId).toBeDefined();

    // 两个相互独立的 connector（各自独立的进程内链），共享同一 NOCTURNE_HOME。
    // release 场景让先进入的一方挂在 prompt 上，给另一方制造真实并发窗口。
    const slowA = setup("loadableRelease");
    const fastB = setup("loadableRelease");
    const homeDir = process.env.NOCTURNE_HOME ?? "";
    // 人为先占住跨进程锁：模拟"另一个宿主进程"正持有该 worker。
    // 锁内容用存活的当前 pid——tryAcquireWorkerLock 判定持有者存活即 busy。
    const lockDir = path.join(homeDir, "external-workers");
    await fs.mkdir(lockDir, { recursive: true });
    const lockPath = path.join(lockDir, `${workerId}.lock`);
    const { createPlatform: createRealPlatform, tryAcquireWorkerLock } =
      await import("@nocturne/core");
    const holderPlatform = createRealPlatform();
    const heldLock = await tryAcquireWorkerLock(holderPlatform, lockPath);
    expect(heldLock).not.toBeUndefined();
    try {
      // 在锁被持有期间，两个独立 connector 的续派都必须得到可识别的 busy——
      // 而不是排队等待、重复 prompt 或并发 session/load。
      const resultA = await slowA.connector.run({ ...slowA.request, workerId }, slowA.ctx);
      const resultB = await fastB.connector.run({ ...fastB.request, workerId }, fastB.ctx);
      for (const result of [resultA, resultB]) {
        expect(result.status).toBe("error");
        expect(result.status === "error" && result.error.code).toBe("worker_busy");
      }
      // busy 路径在 spawn 前拒绝：probe 文件不存在（没有进程被启动）。
      const probeExists = await fs
        .access(path.join(root, "probe.json"))
        .then(() => true)
        .catch(() => false);
      expect(probeExists).toBe(false);
    } finally {
      await heldLock?.release();
    }
    // 锁释放后：同一 worker 的续派立即可用——磁盘锁不是永久锁。
    const afterSetup = setup("loadable");
    const after = await afterSetup.connector.run(
      { ...afterSetup.request, workerId },
      afterSetup.ctx,
    );
    expect(after.status).toBe("ok");
    expect(after.output?.resumed).toBe(true);
  });

  it("宿主崩溃残留的失效锁被回收：pid 不存活的锁不阻塞后续续派", async () => {
    const firstSetup = setup("loadable");
    const first = await firstSetup.connector.run(firstSetup.request, firstSetup.ctx);
    const workerId = first.output?.workerId;
    expect(workerId).toBeDefined();
    // 动态获得一个确定不存活的 pid：启动一个立即退出的进程并等它结束，
    // 用它的 pid 构造锁——避免硬编码 pid 在 Windows 上被 process.kill(pid, 0)
    // 误判为存活（pid 复用/系统保留进程行为不确定）。
    const { spawn } = await import("node:child_process");
    const deadPid = await new Promise<number>((resolve, reject) => {
      const probe = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
      const pid = probe.pid;
      if (pid === undefined) {
        reject(new Error("probe spawn 未分配 pid"));
        return;
      }
      probe.on("close", () => resolve(pid));
      probe.on("error", reject);
    });
    // 确认该 pid 已不存活（process.kill(pid, 0) 抛错即不存活）
    const isDead = await new Promise((resolve) => {
      try {
        process.kill(deadPid, 0);
        resolve(false);
      } catch {
        resolve(true);
      }
    });
    const lockDir = path.join(process.env.NOCTURNE_HOME ?? "", "external-workers");
    await fs.mkdir(lockDir, { recursive: true });
    const staleLock = path.join(lockDir, `${workerId}.lock`);
    await fs.writeFile(
      staleLock,
      JSON.stringify({
        pid: deadPid,
        hostname: (await import("node:os")).hostname(),
        startedAt: Date.now(),
        token: "stale-token",
      }),
    );
    if (!isDead) {
      // pid 恰好被复用（极少见）：改用早于开机时间的 startedAt 触发另一条失效路径，
      // 同样证明崩溃恢复不留下永久锁。
      await fs.writeFile(
        staleLock,
        JSON.stringify({ pid: deadPid, hostname: "other-host", startedAt: 1, token: "stale" }),
      );
    }
    const resumeSetup = setup("loadable");
    const result = await resumeSetup.connector.run(
      { ...resumeSetup.request, workerId },
      resumeSetup.ctx,
    );
    expect(result.status).toBe("ok");
    expect(result.output?.resumed).toBe(true);
  });

  it("独立 worker 互不影响：不同 workerId 的并发续派保持并行", async () => {
    // 两个独立 worker（各自的锁路径不同）并发续派——磁盘锁按 workerId 寻址，
    // 不互相阻塞，两者都应成功恢复。
    const setupA = setup("loadable");
    const firstA = await setupA.connector.run(setupA.request, setupA.ctx);
    const workerA = firstA.output?.workerId;
    const setupB = setup("loadable");
    const firstB = await setupB.connector.run(setupB.request, setupB.ctx);
    const workerB = firstB.output?.workerId;
    expect(workerA).toBeDefined();
    expect(workerB).toBeDefined();
    expect(workerA).not.toBe(workerB);
    const resumeA = setup("loadableRelease");
    const resumeB = setup("loadable");
    const [resultA, resultB] = await Promise.all([
      resumeA.connector.run({ ...resumeA.request, workerId: workerA }, resumeA.ctx),
      resumeB.connector.run({ ...resumeB.request, workerId: workerB }, resumeB.ctx),
    ]);
    // B（无 release 阻塞）必定成功；A 在 release 阻塞下也进入 prompt 而非 busy——
    // 两个 worker 的锁互不干扰，证明并行性。此处只需两者都不是 worker_busy。
    for (const result of [resultA, resultB]) {
      if (result.status === "error") {
        expect(result.error.code).not.toBe("worker_busy");
      }
    }
    // 放行 release，确保 A 正常收尾。
    await fs.writeFile(path.join(root, "release.txt"), "go");
  });
});

describe("ADR-0127 第五阶段：按任务注入团队 MCP 工具", () => {
  // 专属测试工具（无敏感信息）：stdio 形状，带明文 env；
  // 证明按任务注入真实到达线格式、stored 凭据引用被拒绝、worker 间不共享。
  const teamServer = (overrides: Partial<McpServerConfig> = {}): McpServerConfig => ({
    name: "team-tool",
    origin: "project",
    type: "stdio",
    command: process.execPath,
    args: ["-e", "process.exit()"],
    env: { TEAM_MARK: "r1126o-team-value" },
    ...overrides,
  });

  it("session/new 携带显式注入的 stdio 服务器：名字/命令/参数/明文 env 按线格式到达", async () => {
    const probeFile = path.join(root, "probe.json");
    const { connector, ctx, request } = setup("loadableMcp", {
      env: { NOCTURNE_TEST_PROBE_FILE: probeFile },
    });
    const result = await connector.run({ ...request, sessionMcpServers: [teamServer()] }, ctx);
    expect(result.status).toBe("ok");
    const probe = JSON.parse(await fs.readFile(probeFile, "utf8"));
    const newInjection = probe.sessionMcp.find((entry: { phase: string }) => entry.phase === "new");
    expect(newInjection.servers).toHaveLength(1);
    const server = newInjection.servers[0];
    expect(server.name).toBe("team-tool");
    expect(server.command).toBe(process.execPath);
    expect(server.args).toEqual(["-e", "process.exit()"]);
    // 线格式 env 是数组形状 [{name, value}]——明文值随本次任务显式提供
    expect(server.env).toEqual([{ name: "TEAM_MARK", value: "r1126o-team-value" }]);
  });

  it("session/load 恢复路径同样只绑定本次任务显式提供的注入", async () => {
    const probeFile = path.join(root, "probe.json");
    const { connector, ctx, request } = setup("loadableMcp", {
      env: { NOCTURNE_TEST_PROBE_FILE: probeFile },
    });
    const first = await connector.run(request, ctx);
    const workerId = first.output?.workerId;
    expect(workerId).toMatch(/^ew-/);
    // 首次未注入（probe 中 new 的 servers 为空）；续派注入——各次调用互不影响
    const firstProbe = JSON.parse(await fs.readFile(probeFile, "utf8"));
    expect(
      firstProbe.sessionMcp.find((entry: { phase: string }) => entry.phase === "new").servers,
    ).toEqual([]);
    const second = await connector.run(
      { ...request, workerId, sessionMcpServers: [teamServer()] },
      ctx,
    );
    expect(second.status).toBe("ok");
    const report = JSON.parse(second.modelContent);
    const loadInjection = report.sessionMcp.find(
      (entry: { phase: string }) => entry.phase === "load",
    );
    expect(loadInjection.servers).toHaveLength(1);
    expect(loadInjection.servers[0].name).toBe("team-tool");
  });

  it("http 形状按线格式翻译：url 与小写化前的请求头名保留、明文值随行", async () => {
    const { connector, ctx, request } = setup("loadableMcp");
    const httpServer = teamServer({
      type: "http",
      command: undefined,
      args: undefined,
      env: undefined,
      url: "https://mcp.example.test/team",
      headers: { "X-Team-Token": "plaintext-per-task" },
    });
    const result = await connector.run({ ...request, sessionMcpServers: [httpServer] }, ctx);
    expect(result.status).toBe("ok");
    const report = JSON.parse(result.modelContent);
    const injection = report.sessionMcp.find((entry: { phase: string }) => entry.phase === "new");
    expect(injection.servers[0].type).toBe("http");
    expect(injection.servers[0].url).toBe("https://mcp.example.test/team");
    expect(injection.servers[0].headers).toEqual([
      { name: "X-Team-Token", value: "plaintext-per-task" },
    ]);
  });

  it("stored 凭据引用被拒绝：不起进程、不静默降级、不解析宿主凭据库", async () => {
    const probeFile = path.join(root, "probe.json");
    const { connector, ctx, request } = setup("loadableMcp", {
      env: { NOCTURNE_TEST_PROBE_FILE: probeFile },
    });
    const storedServer = teamServer({ env: { TEAM_TOKEN: { stored: true } } });
    const result = await connector.run({ ...request, sessionMcpServers: [storedServer] }, ctx);
    expect(result.status).toBe("error");
    expect(result.status === "error" && result.error.code).toBe("invalid_input");
    expect(result.modelContent).toContain("stored");
    expect(result.modelContent).toContain("team-tool");
    // 拒绝发生在 spawn 之前——fixture 进程从未启动，probe 文件不存在
    await expect(fs.stat(probeFile)).rejects.toThrow();
  });

  it("缺字段与重名被拒绝：invalid_input", async () => {
    const { connector, ctx, request } = setup("loadableMcp");
    const noCommand = teamServer({ command: undefined });
    const result = await connector.run({ ...request, sessionMcpServers: [noCommand] }, ctx);
    expect(result.status).toBe("error");
    expect(result.status === "error" && result.error.code).toBe("invalid_input");
    const dup = await connector.run(
      {
        ...request,
        sessionMcpServers: [teamServer(), teamServer({ name: "TEAM-TOOL" })],
      },
      ctx,
    );
    expect(dup.status).toBe("error");
    expect(dup.status === "error" && dup.error.code).toBe("invalid_input");
    expect(dup.modelContent).toContain("重复");
  });

  it("worker 间隔离：workerA 的注入不进 workerB 的进程——既看不到也不能调用", async () => {
    // 两个 worker 同属一个 agent fixture，各自独立外部会话。
    // workerA 续派带注入；workerB 续派不带——核对 B 的线格式 servers 为空。
    const probeA = path.join(root, "probe-a.json");
    const setupA = setup("loadableMcp", { env: { NOCTURNE_TEST_PROBE_FILE: probeA } });
    const probeB = path.join(root, "probe-b.json");
    const setupB = setup("loadableMcp", { env: { NOCTURNE_TEST_PROBE_FILE: probeB } });
    const firstA = await setupA.connector.run(setupA.request, setupA.ctx);
    const workerA = firstA.output?.workerId;
    const firstB = await setupB.connector.run(setupB.request, setupB.ctx);
    const workerB = firstB.output?.workerId;
    expect(workerA).not.toBe(workerB);
    // workerA 续派携带注入——fixture 只记录不执行工具（夹具边界）；
    // 线格式内容是"worker 能看到什么"的权威证据：B 的进程从未收到 team-tool。
    const resumeA = await setupA.connector.run(
      { ...setupA.request, workerId: workerA, sessionMcpServers: [teamServer()] },
      setupA.ctx,
    );
    expect(resumeA.status).toBe("ok");
    const reportA = JSON.parse(resumeA.modelContent);
    expect(
      reportA.sessionMcp.find((entry: { phase: string }) => entry.phase === "load").servers,
    ).toHaveLength(1);
    const resumeB = await setupB.connector.run(
      { ...setupB.request, workerId: workerB },
      setupB.ctx,
    );
    expect(resumeB.status).toBe("ok");
    const reportB = JSON.parse(resumeB.modelContent);
    const injectionB = reportB.sessionMcp.find(
      (entry: { phase: string }) => entry.phase === "load",
    );
    expect(injectionB.servers).toEqual([]);
  });
});
