/**
 * 会话级工作区（ADR-0051）：一个 Runtime 服务多个工作区。
 * createSession 的 cwd/workspaceRoot 决定该会话的项目指令、项目配置、
 * 权限规则与执行 cwd；缺省回到 Runtime 启动目录。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig, type RuntimeConfig } from "../src/config/index.js";
import { createPlatform } from "../src/platform/index.js";
import { createRuntime, type Runtime, type RuntimeSession } from "../src/index.js";
import { FakeProvider, type FakeScript, type ModelRequest } from "../src/provider/index.js";
import type { RuntimeEvent } from "../src/protocol/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function tmpDir(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(d);
  return d;
}

const textScript = (text: string): FakeScript => [
  { type: "text_delta", text },
  { type: "finish", reason: "stop" },
];

const readScript = (file: string): FakeScript => [
  { type: "tool_call", toolCallId: "call-1", name: "read", input: { path: file } },
  { type: "finish", reason: "tool_calls" },
];

// 角色请求（标题等）独立记录在 roleRequests，requests 只含主对话
const turnRequests = (provider: FakeProvider): ModelRequest[] => provider.requests;

const systemText = (req: ModelRequest | undefined): string =>
  req?.system.map((b) => b.text).join("\n") ?? "";

interface Setup {
  runtime: Runtime;
  provider: FakeProvider;
  config: RuntimeConfig;
  wsA: string;
  wsB: string;
  wsC: string;
  sessionsDir: string;
}

async function setup(scripts: FakeScript[] = []): Promise<Setup> {
  const platform = createPlatform();
  const home = tmpDir("nct-scope-home-");
  const sessionsDir = tmpDir("nct-scope-sessions-");
  const wsA = tmpDir("nct-scope-a-");
  const wsB = tmpDir("nct-scope-b-");
  const wsC = tmpDir("nct-scope-c-");

  writeFileSync(path.join(wsA, "AGENTS.md"), "指令-ALPHA");
  writeFileSync(path.join(wsB, "AGENTS.md"), "指令-BETA");
  writeFileSync(path.join(wsC, "AGENTS.md"), "指令-GAMMA");

  // wsB：可信项目配置（项目模型 + 一条 deny 规则）；wsC：同形但未信任
  for (const ws of [wsB, wsC]) {
    mkdirSync(path.join(ws, ".nocturne"), { recursive: true });
    writeFileSync(
      path.join(ws, ".nocturne", "config.json"),
      JSON.stringify({
        model: "proj/forbidden-model",
        permissions: { rules: [{ kind: "read", pattern: "**", action: "deny" }] },
      }),
    );
  }

  const config = await loadConfig(platform, {
    nocturneHome: home,
    env: () => undefined,
  });
  await config.setWorkspaceTrusted(wsB, true);

  const provider = new FakeProvider({ scripts });
  const runtime = await createRuntime({
    cwd: wsA,
    sessionsDir,
    config,
    providers: [provider],
    permissions: { autoApproveAsk: true },
  });
  return { runtime, provider, config, wsA, wsB, wsC, sessionsDir };
}

const makeSession = (runtime: Runtime, ws?: string): Promise<RuntimeSession> =>
  runtime.createSession({
    model: "fake/fake-model",
    ...(ws !== undefined ? { cwd: ws, workspaceRoot: ws } : {}),
  });

describe("会话级工作区（ADR-0051）", () => {
  it("同一 Runtime 内两个工作区的会话各自拿到自己的项目指令与 cwd", async () => {
    const s = await setup([textScript("a"), textScript("b")]);
    const a = await makeSession(s.runtime, s.wsA);
    const b = await makeSession(s.runtime, s.wsB);
    await a.submit({ text: "hi" });
    await b.submit({ text: "hi" });

    const [reqA, reqB] = turnRequests(s.provider);
    expect(systemText(reqA)).toContain("指令-ALPHA");
    expect(systemText(reqA)).not.toContain("指令-BETA");
    expect(systemText(reqB)).toContain("指令-BETA");
    expect(systemText(reqB)).not.toContain("指令-ALPHA");
    expect(systemText(reqB)).toContain(`Working directory: ${s.wsB}`);
    await a.close();
    await b.close();
  });

  it("不传 cwd 时行为与原来一致（Runtime 启动目录）", async () => {
    const s = await setup([textScript("a")]);
    const session = await makeSession(s.runtime);
    await session.submit({ text: "hi" });
    const [req] = turnRequests(s.provider);
    expect(systemText(req)).toContain("指令-ALPHA");
    expect(systemText(req)).toContain(`Working directory: ${s.wsA}`);
    const meta = session.state().meta;
    expect(meta.workspaceRoot).toBe(await createPlatform().resolveReal(s.wsA));
    await session.close();
  });

  it("项目配置随会话工作区：可信工作区生效，未信任只留收紧规则", async () => {
    const s = await setup([readScript("a.txt"), textScript("denied"), readScript("a.txt")]);
    // 可信 wsB：项目 deny 生效；未信任 wsC：deny 仍生效（收紧方向）
    const b = await makeSession(s.runtime, s.wsB);
    const eventsB: RuntimeEvent[] = [];
    b.subscribe((e) => eventsB.push(e));
    await b.submit({ text: "read" });
    const denied = eventsB.find((e) => e.type === "tool.completed");
    expect(denied?.type === "tool.completed" && denied.payload.status).toBe("denied");
    await b.close();

    const c = await makeSession(s.runtime, s.wsC);
    const eventsC: RuntimeEvent[] = [];
    c.subscribe((e) => eventsC.push(e));
    await c.submit({ text: "read" });
    const deniedC = eventsC.find((e) => e.type === "tool.completed");
    expect(deniedC?.type === "tool.completed" && deniedC.payload.status).toBe("denied");
    await c.close();

    // 运行时级查询按工作区合并项目层。工作区层缓存以会话记录的
    // meta.workspaceRoot（真实路径）为键，查询方与会话用同一字符串。
    const platform = createPlatform();
    const rootB = await platform.resolveReal(s.wsB);
    const rootC = await platform.resolveReal(s.wsC);
    expect(s.runtime.defaultModel({ workspaceRoot: rootB })).toEqual({
      provider: "proj",
      model: "forbidden-model",
    });
    // 未信任工作区的项目 model 不生效
    expect(s.runtime.defaultModel({ workspaceRoot: rootC })).toBeUndefined();
    // 缺省仍是启动目录（wsA 无项目配置）
    expect(s.runtime.defaultModel()).toBeUndefined();
  });

  it("恢复另一个工作区的会话：指令与权限按该会话的工作区加载", async () => {
    const s = await setup([textScript("first"), textScript("resumed")]);
    const b = await makeSession(s.runtime, s.wsB);
    const id = b.id;
    await b.submit({ text: "hi" });
    await b.close();

    const resumed = await s.runtime.resumeSession(id);
    expect(resumed.state().meta.workspaceRoot).toBe(await createPlatform().resolveReal(s.wsB));
    await resumed.submit({ text: "again" });
    const req = turnRequests(s.provider).at(-1);
    expect(systemText(req)).toContain("指令-BETA");
    expect(systemText(req)).toContain(`Working directory: ${s.wsB}`);
    await resumed.close();
  });

  it("同一工作区的会话共用指令缓存（文件只读一次）", async () => {
    const s = await setup([textScript("a"), textScript("b")]);
    const a = await makeSession(s.runtime, s.wsB);
    const b = await makeSession(s.runtime, s.wsB);
    // 删掉 AGENTS.md：第二个会话若重读文件就会丢掉指令
    rmSync(path.join(s.wsB, "AGENTS.md"));
    await a.submit({ text: "hi" });
    await b.submit({ text: "hi" });
    for (const req of turnRequests(s.provider)) {
      expect(systemText(req)).toContain("指令-BETA");
    }
    await a.close();
    await b.close();
  });
});
