import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config/index.js";
import { createRuntime, type Runtime, type RuntimeSession } from "../src/index.js";
import { createPlatform } from "../src/platform/index.js";
import { FakeProvider, type FakeScript, type ModelRequest } from "../src/provider/index.js";
import {
  MEMORY_WRITE_GUIDANCE,
  replaySessionView,
  type SessionSchedule,
} from "../src/protocol/index.js";

const dirs: string[] = [];
const runtimes: Runtime[] = [];
const sessions: RuntimeSession[] = [];

function makeTmp(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const s of sessions.splice(0)) {
    await s.close().catch(() => undefined);
  }
  for (const rt of runtimes.splice(0)) {
    await rt.close().catch(() => undefined);
  }
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

async function setupEnv(options?: {
  interactive?: boolean;
  handler?: (req: ModelRequest) => FakeScript;
  scripts?: FakeScript[];
  settings?: Record<string, unknown>;
  defaultWorkspace?: boolean;
  subagent?: { background?: boolean };
}) {
  const platform = createPlatform();
  const root = await platform.resolveReal(makeTmp("nct-mem-rt-"));
  const home = path.join(root, "home");
  const ws = options?.defaultWorkspace ? path.join(home, "workspace") : path.join(root, "ws");
  const sessionsDir = path.join(root, "sessions");
  mkdirSync(home, { recursive: true });
  mkdirSync(ws, { recursive: true });
  if (options?.settings !== undefined) {
    writeFileSync(path.join(home, "settings.json"), JSON.stringify(options.settings));
  }
  const config = await loadConfig(platform, {
    nocturneHome: home,
    env: () => undefined,
  });
  const requests: ModelRequest[] = [];
  const roleRequests: ModelRequest[] = [];
  const provider = new FakeProvider({
    roleHandler: (req) => {
      roleRequests.push(structuredClone(req));
      return [
        { type: "text_delta", text: req.purpose === "title" ? "Test Title" : "摘要：已完成两轮" },
        { type: "finish", reason: "stop" },
      ];
    },
    handler: (req) => {
      requests.push(structuredClone(req));
      if (options?.handler) return options.handler(req);
      const next = options?.scripts?.shift();
      return (
        next ?? [
          { type: "text_delta", text: "ok" },
          { type: "finish", reason: "stop" },
        ]
      );
    },
  });
  const runtime = await createRuntime({
    cwd: ws,
    workspaceRoot: ws,
    sessionsDir,
    config,
    providers: [provider],
    interactive: options?.interactive ?? true,
    ...(options?.subagent !== undefined ? { subagent: options.subagent } : {}),
  });
  runtimes.push(runtime);
  return { platform, root, home, ws, sessionsDir, config, runtime, requests, roleRequests };
}

function memorySystemText(req: { system: { text: string }[] }): string | undefined {
  return req.system.find((b) => b.text.includes("<memory scope="))?.text;
}

describe("memory 上下文、工具装配与 Runtime 管理", () => {
  it("开关全开 / 全关 / 只开一个时 memory section 的有无与内容，以及默认工作区无 project", async () => {
    // 1. 全开
    const full = await setupEnv();
    const sFull = await full.runtime.createSession({ model: "fake/m1" });
    sessions.push(sFull);
    const descFull = sFull.describeContext();
    const fullNames = descFull.report.sections.map((s) => s.name);
    expect(fullNames.indexOf("memory")).toBeGreaterThan(fullNames.indexOf("tools"));
    expect(fullNames.indexOf("memory")).toBeLessThan(fullNames.indexOf("environment"));
    const memFull = memorySystemText(descFull.request);
    expect(memFull).toContain('<memory scope="global">\n(empty)\n</memory>');
    expect(memFull).toContain('<memory scope="project">\n(empty)\n</memory>');
    expect(memFull).toContain(MEMORY_WRITE_GUIDANCE);

    // 2. 只开 global
    const onlyGlobal = await setupEnv({
      settings: { memory: { global: true, project: false } },
    });
    const sGlobal = await onlyGlobal.runtime.createSession({ model: "fake/m1" });
    sessions.push(sGlobal);
    const memGlobal = memorySystemText(sGlobal.describeContext().request);
    expect(memGlobal).toContain('<memory scope="global">');
    expect(memGlobal).not.toContain('<memory scope="project">');

    // 3. 只开 project
    const onlyProj = await setupEnv({
      settings: { memory: { global: false, project: true } },
    });
    const sProj = await onlyProj.runtime.createSession({ model: "fake/m1" });
    sessions.push(sProj);
    const memProj = memorySystemText(sProj.describeContext().request);
    expect(memProj).not.toContain('<memory scope="global">');
    expect(memProj).toContain('<memory scope="project">');

    // 4. 全关：不注入 memory section
    const off = await setupEnv({
      settings: { memory: { global: false, project: false } },
    });
    const sOff = await off.runtime.createSession({ model: "fake/m1" });
    sessions.push(sOff);
    const offCtx = sOff.describeContext();
    expect(offCtx.report.sections.some((s) => s.name === "memory")).toBe(false);
    expect(memorySystemText(offCtx.request)).toBeUndefined();

    // 5. 默认工作区：即使全开也只有 global
    const defWs = await setupEnv({ defaultWorkspace: true });
    const sDef = await defWs.runtime.createSession({ model: "fake/m1" });
    sessions.push(sDef);
    const memDef = memorySystemText(sDef.describeContext().request);
    expect(memDef).toContain('<memory scope="global">');
    expect(memDef).not.toContain('<memory scope="project">');
  });

  it("工具读写删、read-only 下免确认、scope 非法报 invalid_input 并列出可用范围、中途写入不改 system、L2 压缩后重新快照", async () => {
    let phase = 0;
    const env = await setupEnv({
      settings: { memory: { global: true, project: false } },
      handler: () => {
        phase += 1;
        if (phase === 1) {
          // 1) 调用禁用范围 project 应报错并列出可用范围 global
          // 2) 调用 global 写入一条记忆（即使 read-only 预设也不弹权限确认）
          return [
            {
              type: "tool_call",
              toolCallId: "bad-scope",
              name: "memory_write",
              input: {
                scope: "project",
                name: "bad",
                description: "bad",
                type: "project",
                content: "bad",
              },
            },
            {
              type: "tool_call",
              toolCallId: "good-write",
              name: "memory_write",
              input: {
                scope: "global",
                name: "user-style",
                description: "Prefer concise replies",
                type: "user",
                content: "Keep responses concise.",
              },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        if (phase === 2) {
          // 读取刚才写的记忆
          return [
            {
              type: "tool_call",
              toolCallId: "read-1",
              name: "memory_read",
              input: { scope: "global", name: "user-style" },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        if (phase === 3) {
          return [
            { type: "text_delta", text: "第一轮完成" },
            { type: "finish", reason: "stop" },
          ];
        }
        if (phase === 4) {
          return [
            { type: "text_delta", text: "第二轮完成" },
            { type: "finish", reason: "stop" },
          ];
        }
        if (phase === 5) {
          // compact 摘要
          return [
            { type: "text_delta", text: "摘要：已完成两轮" },
            { type: "finish", reason: "stop" },
          ];
        }
        return [
          { type: "text_delta", text: "压缩后完成" },
          { type: "finish", reason: "stop" },
        ];
      },
    });

    const session = await env.runtime.createSession({
      model: "fake/m1",
      permissionPreset: "read-only",
    });
    sessions.push(session);
    const initialMem = memorySystemText(session.describeContext().request);
    expect(initialMem).toContain("(empty)");

    await session.submit({ text: "写一条偏好记忆" });

    // 验证 tool.completed：bad-scope 报 invalid_input 且列出 Available scopes: global；good-write 成功且无 permission.requested
    const events = session.durableEvents();
    expect(events.some((e) => e.type === "permission.requested")).toBe(false);
    const badCompleted = events.find(
      (e) =>
        e.type === "tool.completed" &&
        e.payload.name === "memory_write" &&
        e.payload.status === "error",
    );
    expect(badCompleted?.type === "tool.completed" && badCompleted.payload.status).toBe("error");
    expect(badCompleted?.type === "tool.completed" && badCompleted.payload.error?.code).toBe(
      "invalid_input",
    );
    expect(badCompleted?.type === "tool.completed" && badCompleted.payload.modelContent).toContain(
      "global",
    );

    const readCompleted = events.find(
      (e) => e.type === "tool.completed" && e.payload.name === "memory_read",
    );
    expect(readCompleted?.type === "tool.completed" && readCompleted.payload.status).toBe("ok");
    expect(
      readCompleted?.type === "tool.completed" && readCompleted.payload.modelContent,
    ).toContain("Keep responses concise.");

    // 中途写入不改当前会话的 system（第 2 轮请求仍用初始快照）
    await session.submit({ text: "继续第二轮" });
    const turn2Req = env.requests.find((r) =>
      r.messages.some((m) => m.role === "user" && m.content.some((b) => b.text === "继续第二轮")),
    );
    expect(turn2Req).toBeDefined();
    if (turn2Req === undefined) throw new Error("turn2Req missing");
    expect(memorySystemText(turn2Req)).toBe(initialMem);

    // 手动 L2 压缩：摘要请求沿用主前缀且压缩指令在最后一条消息，压缩后刷新快照
    await session.compact();
    const compactReq = env.requests.find((r) =>
      r.messages.some(
        (m) =>
          m.role === "user" && m.content.some((b) => b.text.includes("请把以上对话压缩为摘要")),
      ),
    );
    expect(compactReq).toBeDefined();
    const afterCompactMem = memorySystemText(session.describeContext().request);
    expect(afterCompactMem).toContain("- user-style (user): Prefer concise replies");

    // 压缩后的下一轮请求使用新快照
    await session.submit({ text: "压缩后的对话" });
    const afterCompactReq = env.requests.find((r) =>
      r.messages.some((m) => m.role === "user" && m.content.some((b) => b.text === "压缩后的对话")),
    );
    expect(afterCompactReq).toBeDefined();
    if (afterCompactReq === undefined) throw new Error("afterCompactReq missing");
    expect(memorySystemText(afterCompactReq)).toBe(afterCompactMem);

    // 开关改动只影响之后打开的会话，不影响已打开会话
    await env.runtime.updateSettings({ "memory.global": false });
    expect(memorySystemText(session.describeContext().request)).toBe(afterCompactMem);
    const sAfterOff = await env.runtime.createSession({ model: "fake/m1" });
    sessions.push(sAfterOff);
    expect(sAfterOff.describeContext().report.sections.some((s) => s.name === "memory")).toBe(
      false,
    );
  });

  it("工具装配表逐行验证：交互顶层、client.kind=agent、schedule、非交互、合奏指挥与成员、task 子代理与 explore", async () => {
    const recorded: { req: ModelRequest }[] = [];
    const env = await setupEnv({
      subagent: { background: true },
      handler: (req) => {
        recorded.push({ req: structuredClone(req) });
        const sys = req.system[0]?.text ?? "";
        // subagent
        if (sys.includes("你是一个子代理")) {
          return [
            { type: "tool_call", toolCallId: "fin", name: "finish", input: { result: "sub-ok" } },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        // ensemble member
        if (sys.includes("persistent ensemble member")) {
          if (!req.messages.some((m) => m.role === "tool")) {
            return [
              {
                type: "tool_call",
                toolCallId: "reply-maestro",
                name: "ensemble_post",
                input: { text: "@maestro member ok" },
              },
              { type: "finish", reason: "tool_calls" },
            ];
          }
          return [
            { type: "text_delta", text: "member ok" },
            { type: "finish", reason: "stop" },
          ];
        }
        // ensemble maestro
        if (req.tools.some((t) => t.name === "ensemble_add_member")) {
          const toolCount = req.messages.filter((m) => m.role === "tool").length;
          if (toolCount === 0) {
            return [
              {
                type: "tool_call",
                toolCallId: "init-ens",
                name: "ensemble_init",
                input: { title: "Memory Ensemble" },
              },
              {
                type: "tool_call",
                toolCallId: "add-exp",
                name: "ensemble_add_member",
                input: {
                  name: "scout",
                  preset: "explore",
                  charter: {
                    owns: "read-only exploration",
                    handsOff: "all files",
                    doneWhen: "report sent",
                  },
                },
              },
              {
                type: "tool_call",
                toolCallId: "post-exp",
                name: "ensemble_post",
                input: { text: "@scout check" },
              },
              { type: "finish", reason: "tool_calls" },
            ];
          }
          if (
            !req.messages.some(
              (m) => m.role === "user" && m.content.some((b) => b.text.includes("member ok")),
            )
          ) {
            return [
              { type: "text_delta", text: "waiting for scout" },
              { type: "finish", reason: "stop" },
            ];
          }
          return [
            {
              type: "tool_call",
              toolCallId: "end-ens",
              name: "ensemble_end",
              input: { summary: "finished" },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return [
          { type: "text_delta", text: "ok" },
          { type: "finish", reason: "stop" },
        ];
      },
    });

    // 1. 交互顶层会话
    const sTop = await env.runtime.createSession({ model: "fake/m1" });
    sessions.push(sTop);
    const topTools = sTop.describeContext().request.tools.map((t) => t.name);
    expect(topTools).toEqual(
      expect.arrayContaining(["memory_read", "memory_write", "memory_delete"]),
    );
    expect(memorySystemText(sTop.describeContext().request)).toContain(MEMORY_WRITE_GUIDANCE);

    // 2. client.kind === "agent"
    const sAgent = await env.runtime.createSession({
      model: "fake/m1",
      client: { kind: "agent", name: "codex", deviceId: "dev-1" },
    });
    sessions.push(sAgent);
    const agentTools = sAgent.describeContext().request.tools.map((t) => t.name);
    expect(agentTools).toContain("memory_read");
    expect(agentTools).not.toContain("memory_write");
    expect(agentTools).not.toContain("memory_delete");
    const agentMem = memorySystemText(sAgent.describeContext().request);
    expect(agentMem).toBeDefined();
    expect(agentMem).not.toContain(MEMORY_WRITE_GUIDANCE);

    // 3. schedule 会话
    const schedule: SessionSchedule = {
      taskId: "t-1",
      scheduledAt: "2026-11-19T00:00:00.000Z",
      trigger: "schedule",
    };
    const sSched = await env.runtime.createSession({
      model: "fake/m1",
      interactive: false,
      schedule,
    });
    sessions.push(sSched);
    const schedTools = sSched.describeContext().request.tools.map((t) => t.name);
    expect(schedTools).toContain("memory_read");
    expect(schedTools).not.toContain("memory_write");
    expect(schedTools).not.toContain("memory_delete");
    expect(memorySystemText(sSched.describeContext().request)).not.toContain(MEMORY_WRITE_GUIDANCE);

    // 4. 非交互 Runtime（nctrn -p 等）
    const nonInt = await setupEnv({ interactive: false });
    const sNi = await nonInt.runtime.createSession({ model: "fake/m1" });
    sessions.push(sNi);
    const niTools = sNi.describeContext().request.tools.map((t) => t.name);
    expect(niTools).toContain("memory_read");
    expect(niTools).not.toContain("memory_write");
    expect(niTools).not.toContain("memory_delete");
    expect(memorySystemText(sNi.describeContext().request)).not.toContain(MEMORY_WRITE_GUIDANCE);

    // 5. 合奏指挥与合奏成员（含 explore 成员）
    await sTop.submit({ text: "run ensemble", workMode: "ensemble" });
    await vi.waitFor(() => {
      expect(replaySessionView(sTop.durableEvents()).ensemble?.status).toBe("ended");
    });
    const maestroReq = recorded.find((r) =>
      r.req.tools.some((t) => t.name === "ensemble_add_member"),
    )?.req;
    expect(maestroReq?.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["memory_read", "memory_write", "memory_delete"]),
    );
    const memberReq = recorded.find(
      (r) =>
        r.req.tools.some((t) => t.name === "ensemble_post") &&
        !r.req.tools.some((t) => t.name === "ensemble_add_member"),
    )?.req;
    expect(memberReq).toBeDefined();
    if (memberReq === undefined) throw new Error("memberReq missing");
    expect(memberReq.tools.map((t) => t.name)).toContain("memory_read");
    expect(memberReq.tools.map((t) => t.name)).not.toContain("memory_write");
    expect(memberReq.tools.map((t) => t.name)).not.toContain("memory_delete");
    expect(memorySystemText(memberReq)).toBeDefined();
    expect(memorySystemText(memberReq)).not.toContain(MEMORY_WRITE_GUIDANCE);

    // 6. task 子代理（general 与 explore）
    let subPhase = 0;
    const subEnv = await setupEnv({
      handler: (req) => {
        if (req.system[0]?.text.includes("你是一个子代理")) {
          return [
            { type: "tool_call", toolCallId: "f", name: "finish", input: { result: "done" } },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        subPhase += 1;
        if (subPhase === 1) {
          return [
            {
              type: "tool_call",
              toolCallId: "t-gen",
              name: "task",
              input: { task: "general subagent task", preset: "general" },
            },
            {
              type: "tool_call",
              toolCallId: "t-exp",
              name: "task",
              input: { task: "explore subagent task", preset: "explore" },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return [
          { type: "text_delta", text: "all done" },
          { type: "finish", reason: "stop" },
        ];
      },
    });
    const sParent = await subEnv.runtime.createSession({
      model: "fake/m1",
      permissionPreset: "bypass",
    });
    sessions.push(sParent);
    await sParent.submit({ text: "launch subagents" });
    const subReqs = subEnv.requests.filter((r) => r.system[0]?.text.includes("你是一个子代理"));
    expect(subReqs).toHaveLength(2);
    for (const req of subReqs) {
      expect(memorySystemText(req)).toBeUndefined();
      const names = req.tools.map((t) => t.name);
      expect(names).not.toContain("memory_read");
      expect(names).not.toContain("memory_write");
      expect(names).not.toContain("memory_delete");
    }
    // 恢复一次性子代理会话同样不注入记忆也不挂载记忆工具
    const subList = await subEnv.runtime.listSubagents({ parentSessionId: sParent.id });
    const firstSub = subList[0];
    if (firstSub === undefined) throw new Error("subList empty");
    const resumedSub = await subEnv.runtime.resumeSession(firstSub.childSessionId);
    sessions.push(resumedSub);
    const resumedSubCtx = resumedSub.describeContext();
    expect(resumedSubCtx.report.sections.some((s) => s.name === "memory")).toBe(false);
    expect(resumedSubCtx.request.tools.map((t) => t.name)).not.toContain("memory_read");
  });

  it("回退与分叉不改记忆文件；Runtime describeMemory / readMemory / deleteMemory / clearMemory 完整闭环", async () => {
    let step = 0;
    const env = await setupEnv({
      handler: () => {
        step += 1;
        if (step === 1) {
          return [
            {
              type: "tool_call",
              toolCallId: "mw1",
              name: "memory_write",
              input: {
                scope: "project",
                name: "build-rule",
                description: "Always run pnpm typecheck",
                type: "project",
                content: "Run pnpm typecheck before commit.",
              },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        if (step === 2) {
          return [
            { type: "text_delta", text: "saved" },
            { type: "finish", reason: "stop" },
          ];
        }
        return [
          {
            type: "tool_call",
            toolCallId: "md1",
            name: "memory_delete",
            input: { scope: "project", name: "build-rule" },
          },
          { type: "finish", reason: "tool_calls" },
        ];
      },
    });
    const changedEvents: number[] = [];
    const unsub = env.runtime.onMemoryChanged(() => {
      changedEvents.push(Date.now());
    });

    const session = await env.runtime.createSession({ model: "fake/m1" });
    sessions.push(session);
    await session.submit({ text: "记住构建命令" });
    const firstUserEvent = session.durableEvents().find((e) => e.type === "message.user");
    if (firstUserEvent === undefined) throw new Error("firstUserEvent missing");
    const firstSeq = firstUserEvent.seq;
    expect(changedEvents).toHaveLength(1);

    const desc1 = await env.runtime.describeMemory();
    expect(desc1.project?.entries.map((e) => e.name)).toEqual(["build-rule"]);
    if (desc1.project === undefined) throw new Error("desc1.project missing");
    const memFile = path.join(desc1.project.dir, "build-rule.md");
    expect(existsSync(memFile)).toBe(true);
    const beforeRewindContent = readFileSync(memFile, "utf8");

    // 回退会话（session.rewind）不删也不改记忆文件
    await session.rewind(firstSeq, "both");
    expect(existsSync(memFile)).toBe(true);
    expect(readFileSync(memFile, "utf8")).toBe(beforeRewindContent);

    // 分叉会话（forkSession）不复制也不改动记忆文件
    const forkedId = await env.runtime.forkSession(session.id);
    const forked = await env.runtime.resumeSession(forkedId);
    sessions.push(forked);
    expect(existsSync(memFile)).toBe(true);

    // Runtime readMemory / deleteMemory / clearMemory
    const readEntry = await env.runtime.readMemory({ scope: "project", name: "build-rule" });
    expect(readEntry.content).toBe("Run pnpm typecheck before commit.");

    // 另建一个其他项目目录并写入记忆，验证 otherProjects 与按 key 读写删
    const otherWs = path.join(env.root, "other-ws");
    mkdirSync(otherWs, { recursive: true });
    const sOther = await env.runtime.createSession({ model: "fake/m1", workspaceRoot: otherWs });
    sessions.push(sOther);
    // 用 FakeProvider step=1 写一条记忆到 other-ws
    step = 0;
    await sOther.submit({ text: "写到另一个项目" });

    const descFromMain = await env.runtime.describeMemory({ workspaceRoot: env.ws });
    expect(descFromMain.otherProjects).toHaveLength(1);
    const otherEntry = descFromMain.otherProjects[0];
    if (otherEntry === undefined) throw new Error("otherProjects empty");
    const otherKey = otherEntry.key;
    expect(otherEntry.count).toBe(1);

    const readOther = await env.runtime.readMemory({
      scope: "project",
      key: otherKey,
      name: "build-rule",
    });
    expect(readOther.name).toBe("build-rule");

    await env.runtime.deleteMemory({ scope: "project", key: otherKey, name: "build-rule" });
    const descAfterDel = await env.runtime.describeMemory({ workspaceRoot: env.ws });
    expect(descAfterDel.otherProjects).toEqual([]);

    await env.runtime.clearMemory({ scope: "project", workspaceRoot: env.ws });
    expect(existsSync(memFile)).toBe(false);
    unsub();
  });
});
