import { execFileSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectChannel, generateIdentity } from "@nocturne/remote";
import { createMemoryTransportPair, createRpcClient, RpcError } from "../src/client/index.js";
import {
  AGENT_READONLY_METHODS,
  AGENT_RUN_METHODS,
  connectAgentPipe,
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
    await new Promise((r) => setTimeout(r, 220));
    const afterTimeout = await h.client.call("agent.describe", {});
    expect(afterTimeout.agents).toHaveLength(0);
    expect(afterTimeout.pendingPairings).toHaveLength(0);

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
});
