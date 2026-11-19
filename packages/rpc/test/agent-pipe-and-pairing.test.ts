import { execFileSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntimeStub } from "@nocturne/core/testing";
import { connectChannel, generateIdentity } from "@nocturne/remote";
import {
  createMemoryTransportPair,
  createRpcClient,
  RpcError,
  trackSessionView,
  type AgentSelfInfo,
} from "../src/client/index.js";
import {
  AGENT_READONLY_METHODS,
  AGENT_RUN_METHODS,
  connectAgentPipe,
  createRpcServer,
  currentUserSid,
  listenAgentPipe,
  readWindowsPipeAclRules,
  resetCurrentUserSidCache,
  setCurrentUserSidResolverForTest,
  WindowsSidError,
} from "../src/server/index.js";
import { RPC_METHOD_NAMES } from "../src/shared/methods.js";
import { cleanupTmp, connectWithConfig, MODEL, tmpDir } from "./harness.js";

function readIndependentWindowsSid(): string {
  const sysRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
  const psExe = join(sysRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.toUpperCase() === "PSMODULEPATH") continue;
    env[k] = v;
  }
  const out = execFileSync(
    psExe,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    ],
    { encoding: "utf8", env, timeout: 10_000, windowsHide: true },
  ).trim();
  expect(out).toMatch(/^S-1-\d+(?:-\d+)+$/);
  return out;
}

afterEach(async () => {
  vi.useRealTimers();
  setCurrentUserSidResolverForTest(undefined);
  resetCurrentUserSidCache();
  cleanupTmp();
});

describe("本机外部 agent 管道 (--agent-pipe)", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (fn) await fn();
    }
  });

  it("未开启 agentPipe 时不监听本机管道；开启后监听并复用 remote 握手加密通道", async () => {
    // 1. 默认不传 agentPipe：agentPipeAddress 为 undefined
    const hNoPipe = await connectWithConfig();
    cleanups.push(async () => {
      hNoPipe.client.close();
      await hNoPipe.served;
    });
    expect(hNoPipe.server.agentPipeAddress).toBeUndefined();

    // 2. 开启 agentPipe：本机 initialize 后开始监听管道
    const hPipe = await connectWithConfig({ agentPipe: true, enableRemote: true });
    cleanups.push(async () => {
      hPipe.client.close();
      await hPipe.served;
    });
    expect(hPipe.server.agentPipeAddress).toBeDefined();

    // 桥通过管道连接并完成 remote 加密通道握手
    const bridgeIdentity = await generateIdentity({ extractable: false });
    const pairingEvents: unknown[] = [];
    hPipe.client.onNotification("agent.pairingRequested", (req) => {
      pairingEvents.push(req);
    });

    const rawPipe = await connectAgentPipe({ home: hPipe.home });
    const secureChannel = await connectChannel(rawPipe, { identity: bridgeIdentity });
    const agentClient = createRpcClient(secureChannel, {
      clientName: "Claude Code",
      interactive: false,
      processInfo: { pid: 12345, command: "nctrn mcp" },
    });
    cleanups.push(async () => {
      agentClient.close();
    });

    const initRes = await agentClient.initialize();
    expect(initRes.nocturneVersion).toBe("0.0.0-test");
    expect(pairingEvents).toHaveLength(1);
    expect(pairingEvents[0]).toMatchObject({
      agentId: bridgeIdentity.id,
      name: "Claude Code",
      processInfo: { pid: 12345, command: "nctrn mcp" },
    });
  });

  it.skipIf(process.platform !== "win32")(
    "Windows 命名管道 DACL 只允许当前用户 SID，不含 Everyone 或 Anonymous",
    async () => {
      const home = tmpDir("nocturne-win-acl-");
      const listener = await listenAgentPipe({
        home,
        onConnection: (t) => t.close(),
      });
      cleanups.push(() => listener.close());

      expect(listener.address.startsWith("\\\\.\\pipe\\nocturne-agent-")).toBe(true);
      const expectedSid = readIndependentWindowsSid();
      expect(currentUserSid()).toBe(expectedSid);
      const rules = readWindowsPipeAclRules(listener.address);
      expect(rules).toHaveLength(1);
      expect(rules[0]).toEqual({
        sid: expectedSid,
        accessType: "Allow",
        rights: "FullControl",
      });
    },
  );

  it.skipIf(process.platform !== "win32")(
    "PATH 最前面有假 whoami（调用即失败）时，仍得到真 SID 且与管道 ACL 一致",
    async () => {
      const home = tmpDir("nocturne-win-fake-whoami-");
      const fakeBinDir = tmpDir("nocturne-fake-bin-");
      writeFileSync(join(fakeBinDir, "whoami.exe"), "not-a-valid-pe-binary");
      writeFileSync(join(fakeBinDir, "whoami.cmd"), "@echo off\r\nexit /b 1\r\n");
      writeFileSync(join(fakeBinDir, "whoami.bat"), "@echo off\r\nexit /b 1\r\n");
      writeFileSync(join(fakeBinDir, "whoami"), "#!/bin/sh\nexit 1\n");
      chmodSync(join(fakeBinDir, "whoami"), 0o755);

      const expectedSid = readIndependentWindowsSid();
      const savedPathEntries = Object.entries(process.env).filter(
        ([key]) => key.toUpperCase() === "PATH",
      );
      try {
        for (const [key, val] of savedPathEntries) {
          process.env[key] = `${fakeBinDir}${delimiter}${val ?? ""}`;
        }
        resetCurrentUserSidCache();

        const sid = currentUserSid();
        expect(sid).toBe(expectedSid);

        const listener = await listenAgentPipe({
          home,
          onConnection: (t) => t.close(),
        });
        cleanups.push(() => listener.close());

        const rules = readWindowsPipeAclRules(listener.address);
        expect(rules).toHaveLength(1);
        expect(rules[0]).toEqual({
          sid: expectedSid,
          accessType: "Allow",
          rights: "FullControl",
        });
      } finally {
        for (const [key, val] of savedPathEntries) {
          process.env[key] = val;
        }
        resetCurrentUserSidCache();
      }
    },
  );

  it.skipIf(process.platform !== "win32")(
    "whoami.exe 不可用时退回 PowerShell 取 SID；两种方法都失败时抛错并记日志",
    async () => {
      const emptyRoot = tmpDir("nocturne-empty-sysroot-");
      const expectedSid = readIndependentWindowsSid();
      const origSystemRoot = process.env.SystemRoot;
      const origUpperSystemRoot = process.env.SYSTEMROOT;
      const savedPathEntries = Object.entries(process.env).filter(
        ([key]) => key.toUpperCase() === "PATH",
      );

      try {
        // 1. whoami.exe 失败时，通过 PowerShell 后备取得真 SID
        expect(currentUserSid({ whoamiExe: join(emptyRoot, "missing-whoami.exe") })).toBe(
          expectedSid,
        );

        // 2. 两种方法都失败时，抛出 WindowsSidError，绝不退回用户名
        resetCurrentUserSidCache();
        process.env.SystemRoot = emptyRoot;
        process.env.SYSTEMROOT = emptyRoot;
        for (const [key] of savedPathEntries) {
          process.env[key] = emptyRoot;
        }
        expect(() => currentUserSid()).toThrow(WindowsSidError);

        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        await expect(
          listenAgentPipe({
            home: emptyRoot,
            onConnection: (t) => t.close(),
          }),
        ).rejects.toThrow(WindowsSidError);
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining("[agent-pipe] 无法启动本机外部 agent 管道"),
        );
        errorSpy.mockRestore();
      } finally {
        if (origSystemRoot !== undefined) process.env.SystemRoot = origSystemRoot;
        if (origUpperSystemRoot !== undefined) process.env.SYSTEMROOT = origUpperSystemRoot;
        for (const [key, val] of savedPathEntries) {
          process.env[key] = val;
        }
        resetCurrentUserSidCache();
      }
    },
  );

  it("currentUserSid 缓存：成功取到的 SID 会缓存，第二次调用不再起子进程；失败不缓存，下次调用重试", () => {
    let calls = 0;
    setCurrentUserSidResolverForTest(() => {
      calls += 1;
      if (calls === 1) {
        throw new WindowsSidError("first call failed");
      }
      return "S-1-5-21-111-222-333-1001";
    });

    // 第一次调用失败：抛错且不缓存
    expect(() => currentUserSid()).toThrow(WindowsSidError);
    expect(calls).toBe(1);

    // 第二次调用重试：成功并写入缓存
    expect(currentUserSid()).toBe("S-1-5-21-111-222-333-1001");
    expect(calls).toBe(2);

    // 第三次调用命中缓存：不再调用底层解析器
    expect(currentUserSid()).toBe("S-1-5-21-111-222-333-1001");
    expect(calls).toBe(2);
  });

  it("同一 home 先起一个带 --agent-pipe 的后台，再起第二个：第二个 initialize 成功且能建会话，describe() 为 address_in_use，第一个管道仍可用", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const h1 = await connectWithConfig({ agentPipe: true, enableRemote: true });
      cleanups.push(async () => {
        h1.client.close();
        await h1.served;
      });
      const firstStatus = await h1.client.call("agent.describe", {});
      expect(firstStatus.pipe?.state).toBe("listening");

      const s1 = await h1.client.runtime.createSession({ model: MODEL });
      expect(s1.opened.sessionId).toBeTruthy();

      // 同一 home 起第二个带 --agent-pipe 的后台
      const h2 = await connectWithConfig({
        config: h1.config,
        agentPipe: true,
        enableRemote: true,
      });
      cleanups.push(async () => {
        h2.client.close();
        await h2.served;
      });

      // 第二个后台 initialize 已成功，且可正常创建会话
      const s2 = await h2.client.runtime.createSession({ model: MODEL });
      expect(s2.opened.sessionId).toBeTruthy();

      // describe() 中管道状态为 address_in_use，原因具体说明另一个后台已占用
      const secondAgentStatus = await h2.client.call("agent.describe", {});
      expect(secondAgentStatus.pipe?.state).toBe("address_in_use");
      expect(secondAgentStatus.pipe?.reason).toBe("address_in_use");
      expect(secondAgentStatus.pipe?.message).toContain("另一个 Nocturne 后台");

      const secondRemoteStatus = await h2.client.call("remote.describe", {});
      expect(secondRemoteStatus.agentPipe?.state).toBe("address_in_use");

      // 第一个后台的管道仍然可用：外部 agent 连接管道能触发第一个后台的配对并看到第一个后台的会话
      const bridgeIdentity = await generateIdentity({ extractable: false });
      const h1Pairings: string[] = [];
      h1.client.onNotification("agent.pairingRequested", (req) => {
        h1Pairings.push(req.requestId);
      });

      const rawPipe = await connectAgentPipe({ home: h1.home });
      const secureChannel = await connectChannel(rawPipe, { identity: bridgeIdentity });
      const agentClient = createRpcClient(secureChannel, {
        clientName: "Claude Code",
        interactive: false,
      });
      cleanups.push(async () => {
        agentClient.close();
      });

      await agentClient.initialize();
      expect(h1Pairings).toHaveLength(1);
      await h1.client.call("agent.respondPairing", {
        requestId: h1Pairings[0] ?? "",
        approved: true,
        scope: "read-only",
      });

      const sessionsOnFirst = await agentClient.runtime.listSessions();
      expect(sessionsOnFirst.some((item) => item.id === s1.opened.sessionId)).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("注入 currentUserSid 失败（抛 WindowsSidError）：initialize 仍成功，describe() 状态为 sid_unavailable", async () => {
    setCurrentUserSidResolverForTest(() => {
      throw new WindowsSidError("模拟 SID 获取失败");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const h = await connectWithConfig({ agentPipe: true, enableRemote: true });
      cleanups.push(async () => {
        h.client.close();
        await h.served;
      });

      const session = await h.client.runtime.createSession({ model: MODEL });
      expect(session.opened.sessionId).toBeTruthy();

      const status = await h.client.call("agent.describe", {});
      expect(status.pipe?.state).toBe("sid_unavailable");
      expect(status.pipe?.reason).toBe("sid_unavailable");
      expect(status.pipe?.message).toContain("本机 agent 管道未启动");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it.skipIf(process.platform === "win32")("POSIX Unix 域套接字权限为 0600", async () => {
    const home = tmpDir("nocturne-posix-sock-");
    const listener = await listenAgentPipe({
      home,
      onConnection: (t) => t.close(),
    });
    cleanups.push(() => listener.close());

    expect(listener.address).toBe(join(home, "agent.sock"));
    const st = await stat(listener.address);
    expect(st.mode & 0o777).toBe(0o600);
  });
});

describe("外部 agent 配对、范围、白名单、权限上限与会话来源标记", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (fn) await fn();
    }
  });

  it("配对全流程：首次连接推 pairingRequested → 等待期返回明确文案 → 拒绝不登记可再次发起 → 超时视为拒绝 → 批准后登记 kind:agent → 吊销立即断开并回到配对流程", async () => {
    const h = await connectWithConfig({
      agentPairingTimeoutMs: 150,
      enableRemote: true,
    });
    cleanups.push(async () => {
      h.client.close();
      await h.served;
    });
    const rt = h.runtimes[0];
    if (!rt) throw new Error("missing runtime");

    const pairingRequests: { requestId: string; agentId: string; name: string }[] = [];
    h.client.onNotification("agent.pairingRequested", (req) => {
      pairingRequests.push(req);
    });

    // 连接一个未登记的外部 agent
    const [agentClientT, agentServerT] = createMemoryTransportPair();
    void h.server.serve(agentServerT, {
      origin: "agent",
      agent: {
        id: "agent-1",
        name: "Codex CLI",
        fingerprint: "1122:3344:5566:7788",
        processInfo: { pid: 4321 },
      },
    });
    const agentClient = createRpcClient(agentClientT, {
      clientName: "Codex CLI",
      interactive: false,
      processInfo: { pid: 4321 },
    });
    cleanups.push(async () => agentClient.close());

    await agentClient.initialize();
    expect(pairingRequests).toHaveLength(1);
    expect(pairingRequests[0]?.name).toBe("Codex CLI");

    // 1. 等待确认期间调用工具：返回等待提示，不调用 Core
    const listSpy = vi.spyOn(rt, "listSessions");
    await expect(agentClient.runtime.listSessions()).rejects.toMatchObject({
      code: "agent_pairing_pending",
      message: "Waiting for the user to approve this agent in Nocturne.",
    });
    expect(listSpy).not.toHaveBeenCalled();

    // 2. 桌面端拒绝：不记入设备列表
    const afterReject = await h.client.call("agent.respondPairing", {
      requestId: pairingRequests[0]?.requestId ?? "",
      approved: false,
    });
    expect(afterReject.agents).toHaveLength(0);
    expect(afterReject.pendingPairings).toHaveLength(0);

    // 3. 拒绝后再次发起调用：重新触发 pairingRequested，等待 150ms 超时自动视为拒绝
    await expect(agentClient.runtime.listSessions()).rejects.toMatchObject({
      code: "agent_pairing_pending",
    });
    expect(pairingRequests).toHaveLength(2);
    await vi.waitFor(async () => {
      const described = await h.client.call("agent.describe", {});
      expect(described.agents).toHaveLength(0);
      expect(described.pendingPairings).toHaveLength(0);
    });

    // 4. 再次调用重新发起配对，并由桌面端批准为只读
    await expect(agentClient.runtime.listSessions()).rejects.toMatchObject({
      code: "agent_pairing_pending",
    });
    expect(pairingRequests).toHaveLength(3);
    const afterApprove = await h.client.call("agent.respondPairing", {
      requestId: pairingRequests[2]?.requestId ?? "",
      approved: true,
      scope: "read-only",
    });
    expect(afterApprove.agents).toHaveLength(1);
    expect(afterApprove.agents[0]).toMatchObject({
      kind: "agent",
      id: "agent-1",
      name: "Codex CLI",
      scope: "read-only",
      online: true,
    });

    // 验证写入了同一份用户级 remote.json 且带 kind: "agent"
    const rawJson = JSON.parse(await readFile(join(h.home, "remote.json"), "utf8")) as {
      devices: { kind: string; id: string; scope: string }[];
    };
    expect(rawJson.devices).toEqual([
      expect.objectContaining({ kind: "agent", id: "agent-1", scope: "read-only" }),
    ]);

    // 批准后同一连接立即可以调用只读方法
    const sessions = await agentClient.runtime.listSessions();
    expect(Array.isArray(sessions)).toBe(true);
    expect(listSpy).toHaveBeenCalledTimes(1);

    // 5. 吊销：立即断开当前连接，之后重连回到配对流程
    await h.client.call("agent.revoke", { id: "agent-1" });
    await agentClient.closed;

    const [agentClientT2, agentServerT2] = createMemoryTransportPair();
    void h.server.serve(agentServerT2, {
      origin: "agent",
      agent: { id: "agent-1", name: "Codex CLI", fingerprint: "1122:3344:5566:7788" },
    });
    const agentClient2 = createRpcClient(agentClientT2, {
      clientName: "Codex CLI",
      interactive: false,
    });
    cleanups.push(async () => agentClient2.close());
    await agentClient2.initialize();
    expect(pairingRequests).toHaveLength(4);
    await expect(agentClient2.runtime.listSessions()).rejects.toMatchObject({
      code: "agent_pairing_pending",
    });
  });

  it("白名单严格收窄：只读范围禁止 createSession/submit；可运行范围禁止审批、提问回复、提权、回退、分叉、定时任务、读文件与全部设置方法，且不调用 Core", async () => {
    const h = await connectWithConfig({ enableRemote: true });
    cleanups.push(async () => {
      h.client.close();
      await h.served;
    });
    const rt = h.runtimes[0];
    if (!rt) throw new Error("missing runtime");

    // 先由本机创建一个会话，供工作区信任和只读观察使用
    const { opened: hostSession } = await h.client.runtime.createSession({
      cwd: h.ws,
      model: MODEL,
    });

    const [agentClientT, agentServerT] = createMemoryTransportPair();
    void h.server.serve(agentServerT, {
      origin: "agent",
      agent: { id: "agent-ro", name: "RO Agent" },
    });
    const agentClient = createRpcClient(agentClientT, {
      clientName: "RO Agent",
      interactive: false,
    });
    cleanups.push(async () => agentClient.close());
    await agentClient.initialize();

    // 批准为 read-only
    await h.client.call("agent.respondPairing", {
      agentId: "agent-ro",
      approved: true,
      scope: "read-only",
    });

    const createSpy = vi.spyOn(rt, "createSession");
    const forkSpy = vi.spyOn(rt, "forkSession");
    const readFileSpy = vi.spyOn(rt, "readFile");
    const updateSettingsSpy = vi.spyOn(rt, "updateSettings");
    const saveScheduleSpy = vi.spyOn(rt, "saveSchedule");

    // 只读范围允许 session.open 和 runtime.listSessions
    const openedRo = await agentClient.call("session.open", { sessionId: hostSession.sessionId });
    expect(openedRo.sessionId).toBe(hostSession.sessionId);

    // 只读范围拒绝 createSession 与 submit
    await expect(
      agentClient.runtime.createSession({
        cwd: h.ws,
        model: MODEL,
      }),
    ).rejects.toMatchObject({ code: "agent_not_allowed", rpcCode: -32004 });
    await expect(
      agentClient.call("session.submit", { sessionId: hostSession.sessionId, text: "hi" }),
    ).rejects.toMatchObject({ code: "agent_not_allowed", rpcCode: -32004 });
    expect(createSpy).not.toHaveBeenCalled();

    // 在设置中将范围改为可运行（上限 default）
    await h.client.call("agent.setScope", {
      id: "agent-ro",
      scope: "run",
      maxPermissionPreset: "default",
    });

    // 可运行范围下，测试所有被禁止的方法均报 agent_not_allowed 且不调用 Core
    const forbiddenCalls: [string, Record<string, unknown>][] = [
      [
        "session.respondPermission",
        {
          sessionId: hostSession.sessionId,
          requestId: "r1",
          reply: { decision: "allow" },
        },
      ],
      [
        "session.respondSubagentPermission",
        {
          sessionId: hostSession.sessionId,
          childSessionId: "c1",
          requestId: "r1",
          reply: { decision: "allow" },
        },
      ],
      [
        "session.respondQuestion",
        {
          sessionId: hostSession.sessionId,
          requestId: "q1",
          reply: { kind: "answered", answers: {} },
        },
      ],
      ["session.setPermissionPreset", { sessionId: hostSession.sessionId, preset: "bypass" }],
      [
        "session.rewind",
        {
          sessionId: hostSession.sessionId,
          target: { kind: "turn", turnIndex: 0 },
          mode: "conversation",
        },
      ],
      ["runtime.forkSession", { fromSessionId: hostSession.sessionId }],
      ["session.updateInput", { sessionId: hostSession.sessionId, id: "i1", text: "x" }],
      ["session.cancelInput", { sessionId: hostSession.sessionId, id: "i1" }],
      ["session.resumeInputs", { sessionId: hostSession.sessionId }],
      ["session.deletePendingInput", { sessionId: hostSession.sessionId, id: "i1" }],
      ["session.editPendingInput", { sessionId: hostSession.sessionId, id: "i1", text: "x" }],
      ["session.movePendingInput", { sessionId: hostSession.sessionId, id: "i1", direction: "up" }],
      ["session.sendPendingInputsNow", { sessionId: hostSession.sessionId }],
      ["schedule.list", {}],
      [
        "schedule.save",
        {
          task: {
            name: "evil",
            prompt: "rm -rf",
            schedule: { type: "hourly" },
            permissionPreset: "bypass",
            enabled: true,
          },
        },
      ],
      ["runtime.readFile", { path: "package.json" }],
      ["runtime.updateSettings", { patch: { permissionPreset: "bypass" } }],
      ["runtime.describeSettings", {}],
      ["provider.list", {}],
      ["mcp.list", {}],
      ["agents.list", {}],
      ["remote.describe", {}],
      ["agent.describe", {}],
      ["agent.setScope", { id: "agent-ro", scope: "run", maxPermissionPreset: "bypass" }],
    ];

    for (const [method, params] of forbiddenCalls) {
      await expect(agentClient.call(method as never, params as never)).rejects.toMatchObject({
        code: "agent_not_allowed",
        rpcCode: -32004,
      });
    }

    // 校验 RPC_METHOD_NAMES 中除 AGENT_RUN_METHODS 外的全部方法均在白名单外
    const runSet = new Set<string>(AGENT_RUN_METHODS);
    const readonlySet = new Set<string>(AGENT_READONLY_METHODS);
    expect(runSet.size).toBeGreaterThan(readonlySet.size);
    for (const m of RPC_METHOD_NAMES) {
      if (!runSet.has(m)) {
        await expect(agentClient.call(m as never, {} as never)).rejects.toMatchObject({
          code: "agent_not_allowed",
          rpcCode: -32004,
        });
      }
    }

    expect(forkSpy).not.toHaveBeenCalled();
    expect(readFileSpy).not.toHaveBeenCalled();
    expect(updateSettingsSpy).not.toHaveBeenCalled();
    expect(saveScheduleSpy).not.toHaveBeenCalled();

    // 远程连接同样不能调用 agent.* 方法
    const [remoteClientT, remoteServerT] = createMemoryTransportPair();
    void h.server.serve(remoteServerT, { origin: "remote" });
    const remoteClient = createRpcClient(remoteClientT, { clientName: "Phone" });
    cleanups.push(async () => remoteClient.close());
    await remoteClient.initialize();
    await expect(remoteClient.call("agent.describe", {})).rejects.toMatchObject({
      code: "remote_not_allowed",
      rpcCode: -32004,
    });
  });

  it("权限上限与会话来源标记：超过上限报 invalid_params；不传时取较低者；session.created.client 由服务端填入且忽略客户端同名参数；子代理会话被拒", async () => {
    const h = await connectWithConfig({ enableRemote: true });
    cleanups.push(async () => {
      h.client.close();
      await h.served;
    });
    const rt = h.runtimes[0];
    if (!rt) throw new Error("missing runtime");

    // 先由本机创建一个会话，使 h.ws 成为已有会话使用过的工作区
    const { opened: initialHost } = await h.client.runtime.createSession({
      cwd: h.ws,
      model: MODEL,
    });

    const [agentClientT, agentServerT] = createMemoryTransportPair();
    void h.server.serve(agentServerT, {
      origin: "agent",
      agent: { id: "agent-claude", name: "Claude Code" },
    });
    const agentClient = createRpcClient(agentClientT, {
      clientName: "Claude Code",
      interactive: false,
    });
    cleanups.push(async () => agentClient.close());
    await agentClient.initialize();

    // 批准为 run，权限上限为 default
    await h.client.call("agent.respondPairing", {
      agentId: "agent-claude",
      approved: true,
      scope: "run",
      maxPermissionPreset: "default",
    });

    const createSpy = vi.spyOn(rt, "createSession");

    // 1. 传入 auto-edit 超过上限 default -> 报 invalid_params (-32602)，且不调用 Core
    await expect(
      agentClient.runtime.createSession({
        cwd: h.ws,
        model: MODEL,
        permissionPreset: "auto-edit",
      }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(RpcError);
      expect((err as RpcError).code).toBe("invalid_params");
      expect((err as RpcError).rpcCode).toBe(-32602);
      return true;
    });
    expect(createSpy).not.toHaveBeenCalled();

    // 2. 用户默认预设设为 auto-edit，桥上限为 default，不传 permissionPreset -> 取较低者 default
    await h.client.call("runtime.updateSettings", {
      patch: { "permissions.preset": "auto-edit" },
    });
    // 同时客户端尝试伪造 client 字段，验证服务端忽略伪造值并填入真实的 agent 身份
    const opened1 = await agentClient.call("runtime.createSession", {
      cwd: h.ws,
      model: MODEL,
      client: { kind: "agent", id: "spoofed-id", name: "Spoofed Name" },
    } as never);
    expect(opened1.config.permissionPreset).toBe("default");
    expect(opened1.meta.client).toEqual({
      kind: "agent",
      name: "Claude Code",
      deviceId: "agent-claude",
      id: "agent-claude",
    });

    // 3. 用户默认预设设为 read-only，桥上限升为 auto-edit，不传 permissionPreset -> 取较低者 read-only
    await h.client.call("runtime.updateSettings", {
      patch: { "permissions.preset": "read-only" },
    });
    await h.client.call("agent.setScope", {
      id: "agent-claude",
      scope: "run",
      maxPermissionPreset: "auto-edit",
    });
    const opened2 = await agentClient.call("runtime.createSession", {
      cwd: h.ws,
      model: MODEL,
    });
    expect(opened2.config.permissionPreset).toBe("read-only");

    // 4. listSessions 返回的摘要同样携带 client 来源标记
    const summaries = await h.client.runtime.listSessions();
    const s1 = summaries.find((s) => s.id === opened1.sessionId);
    expect(s1?.client).toEqual({
      kind: "agent",
      name: "Claude Code",
      deviceId: "agent-claude",
      id: "agent-claude",
    });

    // 5. 子代理会话（parent !== undefined）禁止被 agent 直接打开
    const subSession = await rt.createSession({
      cwd: h.ws,
      model: MODEL,
      parent: { sessionId: initialHost.sessionId, callId: "call-1" },
    });
    const subId = subSession.id;
    await subSession.close();

    await expect(agentClient.call("session.open", { sessionId: subId })).rejects.toMatchObject({
      code: "subagent_session_not_allowed",
    });
    await expect(agentClient.runtime.resumeSession(subId)).rejects.toMatchObject({
      code: "subagent_session_not_allowed",
    });
  });

  it("外部 agent（run 范围）给自己创建的会话改名成功", async () => {
    const h = await connectWithConfig({ enableRemote: true });
    cleanups.push(async () => {
      h.client.close();
      await h.served;
    });
    // 使 h.ws 成为已有会话使用过的工作区
    await h.client.runtime.createSession({ cwd: h.ws, model: MODEL });

    const [agentClientT, agentServerT] = createMemoryTransportPair();
    void h.server.serve(agentServerT, {
      origin: "agent",
      agent: { id: "agent-owner", name: "Owner Agent" },
    });
    const agentClient = createRpcClient(agentClientT, {
      clientName: "Owner Agent",
      interactive: false,
    });
    cleanups.push(async () => agentClient.close());
    await agentClient.initialize();

    await h.client.call("agent.respondPairing", {
      agentId: "agent-owner",
      approved: true,
      scope: "run",
      maxPermissionPreset: "default",
    });

    const { session: ownedSession, opened } = await agentClient.runtime.createSession({
      cwd: h.ws,
      model: MODEL,
    });

    // 会话打开状态下改名成功
    await expect(
      agentClient.runtime.renameSession(opened.sessionId, "任务 A：精简返回"),
    ).resolves.toBeUndefined();
    const list1 = await h.client.runtime.listSessions();
    expect(list1.find((s) => s.id === opened.sessionId)?.firstText).toBe("任务 A：精简返回");

    // 会话关闭后（走磁盘元数据查找）仍可给自己创建的会话改名
    await ownedSession.close();
    await expect(
      agentClient.runtime.renameSession(opened.sessionId, "任务 A：离线重命名"),
    ).resolves.toBeUndefined();
    const list2 = await h.client.runtime.listSessions();
    expect(list2.find((s) => s.id === opened.sessionId)?.firstText).toBe("任务 A：离线重命名");
  });

  it("外部 agent 给用户或其他 agent 创建的会话改名返回 agent_not_allowed", async () => {
    const h = await connectWithConfig({ enableRemote: true });
    cleanups.push(async () => {
      h.client.close();
      await h.served;
    });
    const rt = h.runtimes[0];
    if (!rt) throw new Error("missing runtime");

    // 用户（本机）创建的会话
    const { opened: userSession } = await h.client.runtime.createSession({
      cwd: h.ws,
      model: MODEL,
    });
    await h.client.runtime.renameSession(userSession.sessionId, "用户原始标题");

    // 连接两个不同的外部 agent（A 与 B）
    const [agentAT, serverAT] = createMemoryTransportPair();
    void h.server.serve(serverAT, {
      origin: "agent",
      agent: { id: "agent-a", name: "Agent A" },
    });
    const agentA = createRpcClient(agentAT, { clientName: "Agent A", interactive: false });
    cleanups.push(async () => agentA.close());
    await agentA.initialize();
    await h.client.call("agent.respondPairing", {
      agentId: "agent-a",
      approved: true,
      scope: "run",
      maxPermissionPreset: "default",
    });

    const [agentBT, serverBT] = createMemoryTransportPair();
    void h.server.serve(serverBT, {
      origin: "agent",
      agent: { id: "agent-b", name: "Agent B" },
    });
    const agentB = createRpcClient(agentBT, { clientName: "Agent B", interactive: false });
    cleanups.push(async () => agentB.close());
    await agentB.initialize();
    await h.client.call("agent.respondPairing", {
      agentId: "agent-b",
      approved: true,
      scope: "run",
      maxPermissionPreset: "default",
    });

    // Agent B 创建一个会话并改名
    const { opened: bSession } = await agentB.runtime.createSession({
      cwd: h.ws,
      model: MODEL,
    });
    await agentB.runtime.renameSession(bSession.sessionId, "Agent B 标题");

    const renameSpy = vi.spyOn(rt, "renameSession");

    // 1. Agent A 给用户会话改名 -> agent_not_allowed (-32004)
    await expect(
      agentA.runtime.renameSession(userSession.sessionId, "篡改用户标题"),
    ).rejects.toMatchObject({
      code: "agent_not_allowed",
      rpcCode: -32004,
    });

    // 2. Agent A 给 Agent B 的会话改名 -> agent_not_allowed (-32004)
    await expect(
      agentA.runtime.renameSession(bSession.sessionId, "篡改 B 标题"),
    ).rejects.toMatchObject({
      code: "agent_not_allowed",
      rpcCode: -32004,
    });

    // 3. 只读范围下的 agent 即使给自己曾经创建的会话改名也被拒绝
    const { opened: aSession } = await agentA.runtime.createSession({
      cwd: h.ws,
      model: MODEL,
    });
    await h.client.call("agent.setScope", {
      id: "agent-a",
      scope: "read-only",
      maxPermissionPreset: "default",
    });
    await expect(
      agentA.runtime.renameSession(aSession.sessionId, "只读改名"),
    ).rejects.toMatchObject({
      code: "agent_not_allowed",
      rpcCode: -32004,
    });

    expect(renameSpy).not.toHaveBeenCalled();

    const list = await h.client.runtime.listSessions();
    expect(list.find((s) => s.id === userSession.sessionId)?.firstText).toBe("用户原始标题");
    expect(list.find((s) => s.id === bSession.sessionId)?.firstText).toBe("Agent B 标题");
  });

  it("外部 agent（run 范围）回答自己会话的提问成功；用户/其他 agent 会话、只读档位返回 agent_not_allowed；过期 requestId 返回 unknown_request", async () => {
    const h = await connectWithConfig({
      enableRemote: true,
      scripts: [
        [
          {
            type: "tool_call",
            toolCallId: "tc-q-1",
            name: "ask_user",
            input: {
              questions: [
                {
                  question: "选择目标环境？",
                  options: [{ label: "staging" }, { label: "prod" }],
                },
                {
                  question: "是否附带备注？",
                },
              ],
            },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text_delta", text: "已按 staging 继续完成" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    cleanups.push(async () => {
      h.client.close();
      await h.served;
    });

    // 用户（本机）先建一个会话，使 h.ws 成为已有会话用过的工作区，同时也作为非本 agent 会话样本
    const { session: userSession, opened: userOpened } = await h.client.runtime.createSession({
      cwd: h.ws,
      model: MODEL,
    });
    cleanups.push(async () => userSession.close().catch(() => undefined));

    const connectAgent = async (id: string, name: string, scope: "run" | "read-only") => {
      const [cT, sT] = createMemoryTransportPair();
      void h.server.serve(sT, { origin: "agent", agent: { id, name } });
      const client = createRpcClient(cT, { clientName: name, interactive: false });
      cleanups.push(async () => client.close());
      const selfUpdates: AgentSelfInfo[] = [];
      client.onNotification("agent.selfChanged", (info) => selfUpdates.push(info));
      const initBefore = await client.initialize();
      expect(initBefore.agent).toBeUndefined();
      await h.client.call("agent.respondPairing", {
        agentId: id,
        approved: true,
        scope,
        maxPermissionPreset: "default",
      });
      await vi.waitFor(() => {
        expect(selfUpdates).toEqual([{ id, scope, maxPermissionPreset: "default" }]);
      });
      return { client, selfUpdates };
    };

    const { client: agentA, selfUpdates: aUpdates } = await connectAgent(
      "agent-q-a",
      "Agent A",
      "run",
    );
    const { client: agentB } = await connectAgent("agent-q-b", "Agent B", "run");
    const { client: agentRo } = await connectAgent("agent-q-ro", "Agent RO", "read-only");

    // 已登记的 agent 重新连接时，initialize 直接返回 agent 范围与权限上限
    const [reconnCT, reconnST] = createMemoryTransportPair();
    void h.server.serve(reconnST, { origin: "agent", agent: { id: "agent-q-a", name: "Agent A" } });
    const reconnA = createRpcClient(reconnCT, { clientName: "Agent A", interactive: false });
    cleanups.push(async () => reconnA.close());
    const initAfter = await reconnA.initialize();
    expect(initAfter.agent).toEqual({
      id: "agent-q-a",
      scope: "run",
      maxPermissionPreset: "default",
    });

    // Agent A 创建自己的会话并触发 ask_user
    const { session: aSess, opened: aOpened } = await agentA.runtime.createSession({
      cwd: h.ws,
      model: MODEL,
    });
    const events: { type: string; payload: Record<string, unknown> }[] = [];
    let pendingRequestId: string | undefined;
    let doneResolve: (() => void) | undefined;
    const donePromise = new Promise<void>((r) => {
      doneResolve = r;
    });
    await aSess.subscribe((ev) => {
      events.push({ type: ev.type, payload: ev.payload as unknown as Record<string, unknown> });
      if (ev.type === "question.requested") {
        pendingRequestId = ev.payload.requestId;
      }
      if (ev.type === "turn.completed") {
        doneResolve?.();
      }
    });

    const submitPromise = aSess.submit({ text: "请先问我部署环境" });
    await vi.waitFor(() => {
      expect(pendingRequestId).toBeDefined();
    });
    if (pendingRequestId === undefined) throw new Error("missing pendingRequestId");
    const reqId = pendingRequestId;

    // 1. Agent B（其他 agent）回答 Agent A 的会话 -> agent_not_allowed
    await expect(
      agentB.call("session.respondQuestion", {
        sessionId: aOpened.sessionId,
        requestId: reqId,
        reply: { answers: [{ selected: ["staging"] }, { declined: true }] },
      }),
    ).rejects.toMatchObject({ code: "agent_not_allowed", rpcCode: -32004 });

    // 2. Agent A 回答用户会话 -> agent_not_allowed
    await expect(
      agentA.call("session.respondQuestion", {
        sessionId: userOpened.sessionId,
        requestId: "q-user-1",
        reply: { answers: [{ selected: ["staging"] }] },
      }),
    ).rejects.toMatchObject({ code: "agent_not_allowed", rpcCode: -32004 });

    // 3. 只读 agent 调用 session.respondQuestion -> agent_not_allowed
    await expect(
      agentRo.call("session.respondQuestion", {
        sessionId: aOpened.sessionId,
        requestId: reqId,
        reply: { answers: [{ selected: ["staging"] }, { declined: true }] },
      }),
    ).rejects.toMatchObject({ code: "agent_not_allowed", rpcCode: -32004 });

    // 4. 自己的会话传入不存在/过期的 requestId -> unknown_request
    await expect(
      aSess.respondQuestion("q-stale-999", {
        answers: [{ selected: ["staging"] }, { declined: true }],
      }),
    ).rejects.toMatchObject({ code: "unknown_request" });

    // 5. 自己的会话以正确 requestId 作答（选题 + 放弃第二题）-> 成功，会话继续并完成
    await expect(
      aSess.respondQuestion(reqId, {
        answers: [{ selected: ["staging"], text: "优先灰度" }, { declined: true }],
      }),
    ).resolves.toBeUndefined();
    await submitPromise;
    await donePromise;

    // 6. 提问已处理后再次用同一（过期）requestId 作答 -> unknown_request
    await expect(
      aSess.respondQuestion(reqId, {
        answers: [{ selected: ["staging"] }, { declined: true }],
      }),
    ).rejects.toMatchObject({ code: "unknown_request" });

    // 7. setScope 更新后推送 agent.selfChanged
    await h.client.call("agent.setScope", {
      id: "agent-q-a",
      scope: "run",
      maxPermissionPreset: "bypass",
    });
    await vi.waitFor(() => {
      expect(aUpdates.at(-1)).toEqual({
        id: "agent-q-a",
        scope: "run",
        maxPermissionPreset: "bypass",
      });
    });

    // 8. 切回 read-only 后，连自己的会话也不能调 session.respondQuestion
    await h.client.call("agent.setScope", {
      id: "agent-q-a",
      scope: "read-only",
      maxPermissionPreset: "default",
    });
    await expect(
      aSess.respondQuestion(reqId, {
        answers: [{ selected: ["staging"] }, { declined: true }],
      }),
    ).rejects.toMatchObject({ code: "agent_not_allowed", rpcCode: -32004 });
  });

  it("使用 createRuntimeStub：非本人会话调用 session.respondQuestion 在接入层拦截且不调用 Core", async () => {
    const respondSpy = vi.fn(async () => undefined);
    const home = tmpDir("rpc-agent-q-stub-");
    const stubSession = {
      id: "sess-user-1",
      state: () => ({
        meta: {
          id: "sess-user-1",
          createdAt: "2026-11-20T00:00:00.000Z",
          cwd: home,
          workspaceRoot: home,
          formatVersion: 1,
        },
        config: {
          model: { provider: "fake", model: "fake-model" },
          permissionPreset: "default",
        },
        status: "idle",
        turnCount: 0,
        lastSeq: 0,
      }),
      subscribe: () => () => undefined,
      durableEvents: () => [],
      isIdle: () => true,
      onIdle: () => () => undefined,
      warnings: [],
      pendingInputs: () => ({ items: [], paused: false }),
      interrupt: () => undefined,
      respondQuestion: respondSpy,
      close: async () => undefined,
    };
    const stubRuntime = createRuntimeStub({
      resumeSession: async () => stubSession as never,
      listSessions: async () => [
        {
          id: "sess-user-1",
          createdAt: "2026-11-20T00:00:00.000Z",
          cwd: home,
          workspaceRoot: home,
          model: { provider: "fake", model: "fake-model" },
          mtimeMs: Date.now(),
        },
      ],
      close: async () => undefined,
    });
    const server = createRpcServer({
      nocturneVersion: "test",
      createRuntime: async () => ({ runtime: stubRuntime }),
    });
    const [localCT, localST] = createMemoryTransportPair();
    const localServed = server.serve(localST);
    const localClient = createRpcClient(localCT, { clientName: "desktop", interactive: true });
    cleanups.push(async () => {
      localClient.close();
      await localServed;
    });
    await localClient.initialize();

    const [agentCT, agentST] = createMemoryTransportPair();
    void server.serve(agentST, {
      origin: "agent",
      agent: { id: "agent-stub", name: "Stub Agent" },
    });
    const agentClient = createRpcClient(agentCT, { clientName: "Stub Agent", interactive: false });
    cleanups.push(async () => agentClient.close());
    await agentClient.initialize();
    await localClient.call("agent.respondPairing", {
      agentId: "agent-stub",
      approved: true,
      scope: "run",
      maxPermissionPreset: "default",
    });

    await agentClient.runtime.resumeSession("sess-user-1");
    await expect(
      agentClient.call("session.respondQuestion", {
        sessionId: "sess-user-1",
        requestId: "q-1",
        reply: { answers: [{ selected: ["A"] }] },
      }),
    ).rejects.toMatchObject({ code: "agent_not_allowed", rpcCode: -32004 });
    expect(respondSpy).not.toHaveBeenCalled();
  });

  it("外部 agent 处理权限审批：拒绝在任意上限成功；允许仅在 bypass 上限成功；持久变体、非本人会话与只读档位一律 agent_not_allowed", async () => {
    const h = await connectWithConfig({
      enableRemote: true,
      scripts: [
        // Turn 1: 尝试写入文件 -> 触发权限确认（在较低上限下允许被拒，最终用 deny 拒绝并继续）
        [
          {
            type: "tool_call",
            toolCallId: "tc-w-1",
            name: "write",
            input: { path: "deny-test.txt", content: "blocked" },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text_delta", text: "收到拒绝反馈，不写入" },
          { type: "finish", reason: "stop" },
        ],
        // Turn 2: 再次尝试写入 -> 触发权限确认（升为 bypass 上限后，测试 project/always 被拒，再用 allow + session 放行）
        [
          {
            type: "tool_call",
            toolCallId: "tc-w-2",
            name: "write",
            input: { path: "allow-test.txt", content: "ok" },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text_delta", text: "已放行并写入完成" },
          { type: "finish", reason: "stop" },
        ],
        // Turn 3: 再触发一次审批，测试 deny + stop: true 立即中止轮次
        [
          {
            type: "tool_call",
            toolCallId: "tc-w-3",
            name: "write",
            input: { path: "stop-test.txt", content: "stop" },
          },
          { type: "finish", reason: "tool_calls" },
        ],
      ],
    });
    cleanups.push(async () => {
      h.client.close();
      await h.served;
    });

    // 用户会话
    const { session: userSession, opened: userOpened } = await h.client.runtime.createSession({
      cwd: h.ws,
      model: MODEL,
    });
    cleanups.push(async () => userSession.close().catch(() => undefined));

    const connectAgent = async (
      id: string,
      name: string,
      scope: "run" | "read-only",
      maxPermissionPreset: "read-only" | "default" | "auto-edit" | "guarded" | "smart" | "bypass",
    ) => {
      const [cT, sT] = createMemoryTransportPair();
      void h.server.serve(sT, { origin: "agent", agent: { id, name } });
      const client = createRpcClient(cT, { clientName: name, interactive: false });
      cleanups.push(async () => client.close());
      await client.initialize();
      await h.client.call("agent.respondPairing", {
        agentId: id,
        approved: true,
        scope,
        maxPermissionPreset,
      });
      return client;
    };

    const agentOwner = await connectAgent("agent-perm-owner", "Perm Owner", "run", "read-only");
    const agentOther = await connectAgent("agent-perm-other", "Perm Other", "run", "bypass");
    const agentRo = await connectAgent("agent-perm-ro", "Perm RO", "read-only", "bypass");

    // 用 default 预设开一个需要审批 write 的会话（先给 default 上限再开会话，再测更低上限）
    await h.client.call("agent.setScope", {
      id: "agent-perm-owner",
      scope: "run",
      maxPermissionPreset: "default",
    });
    const { session: ownerSess, opened: ownerOpened } = await agentOwner.runtime.createSession({
      cwd: h.ws,
      model: MODEL,
      permissionPreset: "default",
    });

    let latestPermId: string | undefined;
    let turnCompletedCount = 0;
    await ownerSess.subscribe((ev) => {
      if (ev.type === "permission.requested") {
        latestPermId = ev.payload.requestId;
      } else if (ev.type === "turn.completed") {
        turnCompletedCount++;
      }
    });

    // Turn 1：触发 write 权限审批
    const t1 = ownerSess.submit({ text: "写 deny-test.txt" });
    await vi.waitFor(() => {
      expect(latestPermId).toBeDefined();
    });
    if (latestPermId === undefined) throw new Error("missing permId 1");
    const perm1 = latestPermId;

    // 1. 较低上限（read-only / default / auto-edit / guarded / smart）下，allow 和 allow+session 均返回 agent_not_allowed
    for (const lowPreset of ["read-only", "default", "auto-edit", "guarded", "smart"] as const) {
      await h.client.call("agent.setScope", {
        id: "agent-perm-owner",
        scope: "run",
        maxPermissionPreset: lowPreset,
      });
      await expect(ownerSess.respondPermission(perm1, { decision: "allow" })).rejects.toMatchObject(
        { code: "agent_not_allowed", rpcCode: -32004 },
      );
      await expect(
        ownerSess.respondPermission(perm1, { decision: "allow", remember: "session" }),
      ).rejects.toMatchObject({ code: "agent_not_allowed", rpcCode: -32004 });
    }

    // 2. 其他 agent（即使上限 bypass）与只读 agent（即使上限 bypass）均被拒绝
    await expect(
      agentOther.call("session.respondPermission", {
        sessionId: ownerOpened.sessionId,
        requestId: perm1,
        reply: { decision: "allow" },
      }),
    ).rejects.toMatchObject({ code: "agent_not_allowed", rpcCode: -32004 });
    await expect(
      agentOther.call("session.respondPermission", {
        sessionId: ownerOpened.sessionId,
        requestId: perm1,
        reply: { decision: "deny" },
      }),
    ).rejects.toMatchObject({ code: "agent_not_allowed", rpcCode: -32004 });
    await expect(
      agentRo.call("session.respondPermission", {
        sessionId: ownerOpened.sessionId,
        requestId: perm1,
        reply: { decision: "deny" },
      }),
    ).rejects.toMatchObject({ code: "agent_not_allowed", rpcCode: -32004 });
    // 本 agent 尝试处理用户会话也被拒绝
    await expect(
      agentOwner.call("session.respondPermission", {
        sessionId: userOpened.sessionId,
        requestId: "p-user-1",
        reply: { decision: "deny" },
      }),
    ).rejects.toMatchObject({ code: "agent_not_allowed", rpcCode: -32004 });

    // 3. 在最低上限 read-only 下，拒绝（deny）成功且会话继续完成
    await h.client.call("agent.setScope", {
      id: "agent-perm-owner",
      scope: "run",
      maxPermissionPreset: "read-only",
    });
    await expect(
      ownerSess.respondPermission(perm1, { decision: "deny", feedback: "禁止写入此文件" }),
    ).resolves.toBeUndefined();
    await t1;
    await vi.waitFor(() => {
      expect(turnCompletedCount).toBe(1);
    });

    // Turn 2：提升权限上限为 bypass，验证持久授权变体一律被拒，非持久 allow (remember: "session") 成功
    await h.client.call("agent.setScope", {
      id: "agent-perm-owner",
      scope: "run",
      maxPermissionPreset: "bypass",
    });
    latestPermId = undefined;
    const t2 = ownerSess.submit({ text: "写 allow-test.txt" });
    await vi.waitFor(() => {
      expect(latestPermId).toBeDefined();
    });
    if (latestPermId === undefined) throw new Error("missing permId 2");
    const perm2 = latestPermId;

    await expect(
      ownerSess.respondPermission(perm2, { decision: "allow", remember: "project" }),
    ).rejects.toMatchObject({ code: "agent_not_allowed", rpcCode: -32004 });
    await expect(
      ownerSess.respondPermission(perm2, { decision: "allow", remember: "always" }),
    ).rejects.toMatchObject({ code: "agent_not_allowed", rpcCode: -32004 });

    // 非持久 allow (remember: "session") 在 bypass 上限下成功
    await expect(
      ownerSess.respondPermission(perm2, { decision: "allow", remember: "session" }),
    ).resolves.toBeUndefined();
    await t2;
    await vi.waitFor(() => {
      expect(turnCompletedCount).toBe(2);
    });

    // Turn 3：验证 deny + stop: true 在 default 上限下成功中止轮次
    await h.client.call("agent.setScope", {
      id: "agent-perm-owner",
      scope: "run",
      maxPermissionPreset: "default",
    });
    latestPermId = undefined;
    const t3 = ownerSess.submit({ text: "写 stop-test.txt" });
    await vi.waitFor(() => {
      expect(latestPermId).toBeDefined();
    });
    if (latestPermId === undefined) throw new Error("missing permId 3");
    await expect(
      ownerSess.respondPermission(latestPermId, { decision: "deny", stop: true }),
    ).resolves.toBeUndefined();
    await t3;
    await vi.waitFor(() => {
      expect(turnCompletedCount).toBe(3);
    });
  });

  it("桌面端与外部 agent 同时面对同一审批：一方先回复即生效，另一方视图同步更新且再回复报 unknown_request", async () => {
    const h = await connectWithConfig({
      enableRemote: true,
      scripts: [
        // Turn 1: 桌面端先批准，agent 视图清空且再回复报 unknown_request
        [
          {
            type: "tool_call",
            toolCallId: "tc-race-1",
            name: "write",
            input: { path: "race-1.txt", content: "from desktop" },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text_delta", text: "第一轮完成" },
          { type: "finish", reason: "stop" },
        ],
        // Turn 2: agent 先批准，桌面端视图清空且再回复报 unknown_request
        [
          {
            type: "tool_call",
            toolCallId: "tc-race-2",
            name: "write",
            input: { path: "race-2.txt", content: "from agent" },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text_delta", text: "第二轮完成" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    cleanups.push(async () => {
      h.client.close();
      await h.served;
    });
    // 使 h.ws 成为已有会话使用过的工作区
    const initHost = await h.client.runtime.createSession({ cwd: h.ws, model: MODEL });
    await initHost.session.close();

    const [agentCT, agentST] = createMemoryTransportPair();
    void h.server.serve(agentST, {
      origin: "agent",
      agent: { id: "agent-race", name: "Race Agent" },
    });
    const agentClient = createRpcClient(agentCT, { clientName: "Race Agent", interactive: false });
    cleanups.push(async () => agentClient.close());
    await agentClient.initialize();
    await h.client.call("agent.respondPairing", {
      agentId: "agent-race",
      approved: true,
      scope: "run",
      maxPermissionPreset: "bypass",
    });

    // Agent 创建 default 预设会话，桌面端同时打开并跟踪 SessionView
    const { session: agentSess, opened } = await agentClient.runtime.createSession({
      cwd: h.ws,
      model: MODEL,
      permissionPreset: "default",
    });
    const { session: desktopSess } = await h.client.runtime.resumeSession(opened.sessionId);
    const desktopTracker = await trackSessionView(desktopSess);
    const agentTracker = await trackSessionView(agentSess);
    cleanups.push(async () => {
      await desktopTracker.stop().catch(() => undefined);
      await agentTracker.stop().catch(() => undefined);
    });

    // Case 1: 桌面端先回复 -> agent 视图清除 pendingPermission，agent 再回复报 unknown_request
    const turn1 = agentSess.submit({ text: "写 race-1.txt" });
    await vi.waitFor(() => {
      expect(desktopTracker.view.pendingPermission).toBeDefined();
      expect(agentTracker.view.pendingPermission).toBeDefined();
    });
    const req1 = desktopTracker.view.pendingPermission?.requestId ?? "";
    expect(req1).toBe(agentTracker.view.pendingPermission?.requestId);

    await desktopSess.respondPermission(req1, { decision: "allow" });
    await expect(agentSess.respondPermission(req1, { decision: "deny" })).rejects.toMatchObject({
      code: "unknown_request",
    });
    await turn1;
    await vi.waitFor(() => {
      expect(desktopTracker.view.pendingPermission).toBeUndefined();
      expect(agentTracker.view.pendingPermission).toBeUndefined();
      expect(agentTracker.view.status).toBe("idle");
    });

    // Case 2: agent 先回复 -> 桌面端视图清除 pendingPermission，桌面端再回复报 unknown_request
    const turn2 = agentSess.submit({ text: "写 race-2.txt" });
    await vi.waitFor(() => {
      expect(desktopTracker.view.pendingPermission).toBeDefined();
      expect(agentTracker.view.pendingPermission).toBeDefined();
    });
    const req2 = agentTracker.view.pendingPermission?.requestId ?? "";
    expect(req2).toBe(desktopTracker.view.pendingPermission?.requestId);

    await agentSess.respondPermission(req2, { decision: "allow" });
    await expect(desktopSess.respondPermission(req2, { decision: "allow" })).rejects.toMatchObject({
      code: "unknown_request",
    });
    await turn2;
    await vi.waitFor(() => {
      expect(desktopTracker.view.pendingPermission).toBeUndefined();
      expect(agentTracker.view.pendingPermission).toBeUndefined();
      expect(desktopTracker.view.status).toBe("idle");
    });
  });

  it("使用 createRuntimeStub：子代理转发审批按父会话归属、权限上限与禁止持久授权校验", async () => {
    const home = tmpDir("rpc-agent-subperm-stub-");
    const ownSubPermSpy = vi.fn(async () => undefined);
    const otherSubPermSpy = vi.fn(async () => undefined);

    const makeStubSession = (
      id: string,
      client: { kind: "agent"; name: string; deviceId: string; id: string } | undefined,
      spy: ReturnType<typeof vi.fn>,
    ) => ({
      id,
      state: () => ({
        meta: {
          id,
          createdAt: "2026-11-20T00:00:00.000Z",
          cwd: home,
          workspaceRoot: home,
          formatVersion: 1,
          ...(client !== undefined ? { client } : {}),
        },
        config: {
          model: { provider: "fake", model: "fake-model" },
          permissionPreset: "default",
        },
        status: "idle",
        turnCount: 0,
        lastSeq: 0,
      }),
      subscribe: () => () => undefined,
      durableEvents: () => [],
      isIdle: () => true,
      onIdle: () => () => undefined,
      warnings: [],
      pendingInputs: () => ({ items: [], paused: false }),
      interrupt: () => undefined,
      respondSubagentPermission: spy,
      close: async () => undefined,
    });

    const ownParent = makeStubSession(
      "parent-own",
      { kind: "agent", name: "SubPerm Agent", deviceId: "agent-sub-owner", id: "agent-sub-owner" },
      ownSubPermSpy,
    );
    const otherParent = makeStubSession(
      "parent-other",
      { kind: "agent", name: "Other Agent", deviceId: "agent-other", id: "agent-other" },
      otherSubPermSpy,
    );

    const stubRuntime = createRuntimeStub({
      resumeSession: async (id) => {
        if (id === "parent-own") return ownParent as never;
        if (id === "parent-other") return otherParent as never;
        throw new Error(`unexpected session ${id}`);
      },
      listSessions: async () => [
        {
          id: "parent-own",
          createdAt: "2026-11-20T00:00:00.000Z",
          cwd: home,
          workspaceRoot: home,
          model: { provider: "fake", model: "fake-model" },
          mtimeMs: Date.now(),
          client: {
            kind: "agent",
            name: "SubPerm Agent",
            deviceId: "agent-sub-owner",
            id: "agent-sub-owner",
          },
        },
        {
          id: "parent-other",
          createdAt: "2026-11-20T00:00:00.000Z",
          cwd: home,
          workspaceRoot: home,
          model: { provider: "fake", model: "fake-model" },
          mtimeMs: Date.now(),
          client: {
            kind: "agent",
            name: "Other Agent",
            deviceId: "agent-other",
            id: "agent-other",
          },
        },
      ],
      close: async () => undefined,
    });

    const server = createRpcServer({
      nocturneVersion: "test",
      createRuntime: async () => ({ runtime: stubRuntime }),
    });
    const [localCT, localST] = createMemoryTransportPair();
    const localServed = server.serve(localST);
    const localClient = createRpcClient(localCT, { clientName: "desktop", interactive: true });
    cleanups.push(async () => {
      localClient.close();
      await localServed;
    });
    await localClient.initialize();

    const [agentCT, agentST] = createMemoryTransportPair();
    void server.serve(agentST, {
      origin: "agent",
      agent: { id: "agent-sub-owner", name: "SubPerm Agent" },
    });
    const agentClient = createRpcClient(agentCT, {
      clientName: "SubPerm Agent",
      interactive: false,
    });
    cleanups.push(async () => agentClient.close());
    await agentClient.initialize();
    await localClient.call("agent.respondPairing", {
      agentId: "agent-sub-owner",
      approved: true,
      scope: "run",
      maxPermissionPreset: "default",
    });

    await agentClient.runtime.resumeSession("parent-own");
    await agentClient.runtime.resumeSession("parent-other");

    // 1. 别人父会话上的子代理审批：允许与拒绝均报 agent_not_allowed，不调 Core
    await expect(
      agentClient.call("session.respondSubagentPermission", {
        sessionId: "parent-other",
        childSessionId: "child-1",
        requestId: "req-1",
        reply: { decision: "deny" },
      }),
    ).rejects.toMatchObject({ code: "agent_not_allowed", rpcCode: -32004 });
    expect(otherSubPermSpy).not.toHaveBeenCalled();

    // 2. 自己父会话在 default 上限下：allow 被拒，deny 成功
    await expect(
      agentClient.call("session.respondSubagentPermission", {
        sessionId: "parent-own",
        childSessionId: "child-1",
        requestId: "req-1",
        reply: { decision: "allow" },
      }),
    ).rejects.toMatchObject({ code: "agent_not_allowed", rpcCode: -32004 });
    expect(ownSubPermSpy).not.toHaveBeenCalled();

    await expect(
      agentClient.call("session.respondSubagentPermission", {
        sessionId: "parent-own",
        childSessionId: "child-1",
        requestId: "req-1",
        reply: { decision: "deny", feedback: "子代理不可写此路径" },
      }),
    ).resolves.toBeNull();
    expect(ownSubPermSpy).toHaveBeenCalledWith("child-1", "req-1", {
      decision: "deny",
      feedback: "子代理不可写此路径",
    });

    // 3. 升级为 bypass 后：project/always 仍被拒，allow 与 allow+session 成功
    await localClient.call("agent.setScope", {
      id: "agent-sub-owner",
      scope: "run",
      maxPermissionPreset: "bypass",
    });
    await expect(
      agentClient.call("session.respondSubagentPermission", {
        sessionId: "parent-own",
        childSessionId: "child-1",
        requestId: "req-2",
        reply: { decision: "allow", remember: "project" },
      }),
    ).rejects.toMatchObject({ code: "agent_not_allowed", rpcCode: -32004 });
    await expect(
      agentClient.call("session.respondSubagentPermission", {
        sessionId: "parent-own",
        childSessionId: "child-1",
        requestId: "req-2",
        reply: { decision: "allow", remember: "always" },
      }),
    ).rejects.toMatchObject({ code: "agent_not_allowed", rpcCode: -32004 });

    await expect(
      agentClient.call("session.respondSubagentPermission", {
        sessionId: "parent-own",
        childSessionId: "child-1",
        requestId: "req-2",
        reply: { decision: "allow", remember: "session" },
      }),
    ).resolves.toBeNull();
    expect(ownSubPermSpy).toHaveBeenCalledWith("child-1", "req-2", {
      decision: "allow",
      remember: "session",
    });

    // 4. 切为 read-only 档位：即使上限为 bypass 也被拒
    await localClient.call("agent.setScope", {
      id: "agent-sub-owner",
      scope: "read-only",
      maxPermissionPreset: "bypass",
    });
    await expect(
      agentClient.call("session.respondSubagentPermission", {
        sessionId: "parent-own",
        childSessionId: "child-1",
        requestId: "req-3",
        reply: { decision: "deny" },
      }),
    ).rejects.toMatchObject({ code: "agent_not_allowed", rpcCode: -32004 });
  });
});
