/**
 * r1114c：Ensemble 成员不再进入子代理目录（`subagentRegistry` / `listSubagents`），
 * 同时验证分支切换保护、会话树授权、工作树删除保护、成员会话标签、关闭/重启恢复及普通 `task` 子代理不受影响。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { worktreeGit } from "../src/agent/worktree.js";
import { createRuntime, type RuntimeSession } from "../src/index.js";
import { replaySessionView, type RuntimeEvent } from "../src/protocol/index.js";
import {
  FakeProvider,
  ProviderError,
  type FakeScript,
  type ModelRequest,
} from "../src/provider/index.js";
import type { RuntimeConfig } from "../src/config/index.js";

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected value to be defined");
  return value;
}

const roots: string[] = [];
const sessions: RuntimeSession[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of sessions.splice(0)) {
    await s.close().catch(() => undefined);
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = "nocturne-r1114c-"): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

async function initGitRepo(dir: string): Promise<void> {
  await worktreeGit(dir, ["init", "-b", "main"]);
  await worktreeGit(dir, ["config", "user.name", "Test"]);
  await worktreeGit(dir, ["config", "user.email", "test@localhost"]);
  await worktreeGit(dir, ["config", "commit.gpgsign", "false"]);
  await worktreeGit(dir, ["config", "core.autocrlf", "false"]);
  writeFileSync(path.join(dir, "README.md"), "# Test Repo\n", "utf8");
  await worktreeGit(dir, ["add", "-A"]);
  await worktreeGit(dir, ["commit", "-m", "initial commit"]);
}

const callTool = (id: string, name: string, input: unknown): FakeScript[number] => ({
  type: "tool_call",
  toolCallId: id,
  name,
  input,
});

const stopText = (text = "ok"): FakeScript => [
  { type: "text_delta", text },
  { type: "finish", reason: "stop" },
];

function requestRole(req: ModelRequest): string {
  const sys = req.system.map((b) => b.text).join("\n");
  const match = /persistent ensemble member `@([a-z0-9-]+)`/.exec(sys);
  return match?.[1] ? `member:${match[1]}` : "maestro";
}

function makeProvider(
  handler: (req: ModelRequest, who: string) => FakeScript | Promise<FakeScript>,
) {
  return new FakeProvider({
    id: "fake",
    models: [
      {
        ref: { provider: "fake", model: "m1" },
        protocol: "openai-compatible" as const,
        contextWindow: 128_000,
        maxOutputTokens: 8_192,
        capabilities: {
          toolCalls: true,
          parallelToolCalls: true,
          reasoning: "none" as const,
          imageInput: false,
          promptCache: false,
          editTool: "edit" as const,
        },
      },
    ],
    roleHandler: () => stopText("Title"),
    handler: (req) => handler(req, requestRole(req)),
  });
}

function makeConfig(): RuntimeConfig {
  return {
    base: {
      providers: [],
      externalAgents: [],
    },
    disabledProviders: () => [],
    disabledModels: () => [],
    disabledSkills: () => [],
    skillConfig: () => undefined,
    shellSetting: () => undefined,
    recentModels: () => [],
    recordRecentModel: async () => undefined,
    getPreference: () => undefined,
    setPreference: async () => undefined,
    forWorkspace: async () => ({
      resolved: {
        providers: [],
        rules: [],
        untrustedRules: [],
        mcpServers: [],
        hooks: {},
        warnings: [],
        providerThinkingWarnings: [],
        providerAuthWarnings: [],
      },
      projectConfig: { present: false, trusted: true },
    }),
    resolvedSettings: () => ({
      providers: [],
      subagentProfiles: {
        gemini: {
          enabled: true,
          description: "Gemini profile",
          tools: "explore" as const,
        },
      },
    }),
    describeSettings: () => [],
  } as unknown as RuntimeConfig;
}

describe("Ensemble 成员不再算作运行中或已结束的子代理（r1114c）", { timeout: 45_000 }, () => {
  it("Ensemble 成员在 working、waiting、paused、移除后与结束后均不出现在 listSubagents 中", async () => {
    const ws = makeTempDir();
    const sessionsDir = makeTempDir("nocturne-r1114c-sessions-");

    let releaseWorking: (() => void) | undefined;
    const workingGate = new Promise<void>((resolve) => {
      releaseWorking = resolve;
    });
    let inWorking = false;
    let notifyInWorking: (() => void) | undefined;
    const enteredWorking = new Promise<void>((resolve) => {
      notifyInWorking = resolve;
    });

    let coordStep = 0;
    let workerStep = 0;

    const provider = makeProvider(async (req, who) => {
      if (who === "maestro") {
        coordStep++;
        if (coordStep === 1) {
          return [
            callTool("i1", "ensemble_init", { title: "Exclusion Test" }),
            callTool("a1", "ensemble_add_member", {
              name: "cli-1",
              profile: "gemini",
              charter: { owns: "cli", handsOff: "data", doneWhen: "done" },
            }),
            callTool("a2", "ensemble_add_member", {
              name: "data-1",
              profile: "gemini",
              charter: { owns: "data", handsOff: "cli", doneWhen: "done" },
            }),
            callTool("p1", "ensemble_post", { text: "@cli-1 please work" }),
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return stopText("coord idle");
      }
      if (who === "member:cli-1") {
        workerStep++;
        if (workerStep === 1) {
          inWorking = true;
          notifyInWorking?.();
          await workingGate;
          return [
            callTool("mp1", "ensemble_post", { text: "@maestro finished" }),
            { type: "finish", reason: "tool_calls" },
          ];
        }
        if (workerStep === 2) {
          return stopText("cli-1 waiting");
        }
        throw new ProviderError({
          kind: "rate_limit",
          message: "paused for test",
          retryable: false,
        });
      }
      return stopText("data-1 ok");
    });

    const rt = await createRuntime({
      cwd: ws,
      workspaceRoot: ws,
      sessionsDir,
      config: makeConfig(),
      providers: [provider],
      interactive: true,
      subagent: { background: true },
    });

    const coord = await rt.createSession({ model: "fake/m1", permissionPreset: "bypass" });
    sessions.push(coord);

    const memberStates = new Map<string, string>();
    coord.subscribe((ev: RuntimeEvent) => {
      if (ev.type === "ensemble.member_updated") {
        memberStates.set(ev.payload.name, ev.payload.status);
      }
    });

    await coord.submit({ text: "start ensemble", workMode: "ensemble" });
    await enteredWorking;
    expect(inWorking).toBe(true);

    // 1. working 状态：不在 listSubagents 中
    await vi.waitFor(() => expect(memberStates.get("cli-1")).toBe("working"));
    expect(await rt.listSubagents({ parentSessionId: coord.id })).toEqual([]);

    // 2. waiting 状态：放行后完成并进入 waiting，仍不在 listSubagents 中
    releaseWorking?.();
    await vi.waitFor(() => {
      expect(memberStates.get("cli-1")).toBe("waiting");
      expect(coord.isIdle()).toBe(true);
    });
    expect(await rt.listSubagents({ parentSessionId: coord.id })).toEqual([]);

    // 确认 observeSubagent 也拒绝把成员当子代理观察
    const members = replaySessionView(coord.durableEvents()).ensemble?.members ?? [];
    const cliChildId = must(members.find((m) => m.name === "cli-1")).childSessionId;
    await expect(
      rt.observeSubagent(
        { parentSessionId: coord.id, childSessionId: cliChildId },
        { onEvent: () => undefined, onEnd: () => undefined },
      ),
    ).rejects.toMatchObject({ code: "subagent_parent_mismatch" });

    // 3. paused 状态：触发 provider 错误进入 paused，仍不在 listSubagents 中
    await coord.postToEnsemble({ text: "@cli-1 trigger error" });
    await vi.waitFor(() => {
      expect(memberStates.get("cli-1")).toBe("paused");
      expect(coord.isIdle()).toBe(true);
    });
    expect(await rt.listSubagents({ parentSessionId: coord.id })).toEqual([]);

    // 4. 移除成员后：不在已结束子代理列表里
    await coord.removeEnsembleMember({ name: "cli-1" });
    expect(await rt.listSubagents({ parentSessionId: coord.id })).toEqual([]);

    // 5. Ensemble 结束后：全部成员均不出现在已结束子代理列表里
    await coord.endEnsemble();
    expect(await rt.listSubagents({ parentSessionId: coord.id })).toEqual([]);
    expect(replaySessionView(coord.durableEvents()).ensemble?.status).toBe("ended");
  });

  it("分支切换保护：非隔离成员在工作区中（working/waiting/paused）时挡住切分支，移除或结束后放行；仅隔离成员不挡主仓库", async () => {
    const ws = makeTempDir();
    await initGitRepo(ws);
    const sessionsDir = makeTempDir("nocturne-r1114c-sessions-");

    let addedIso = false;
    let allowAddShared = false;
    let addedShared = false;
    let workerCalls = 0;
    const provider = makeProvider((_req, who) => {
      if (who === "maestro") {
        if (!addedIso) {
          addedIso = true;
          return [
            callTool("i1", "ensemble_init", { title: "Branch Protection" }),
            callTool("a1", "ensemble_add_member", {
              name: "iso-only",
              isolated: true,
              charter: { owns: "iso", handsOff: "main", doneWhen: "done" },
            }),
            { type: "finish", reason: "tool_calls" },
          ];
        }
        if (allowAddShared && !addedShared) {
          addedShared = true;
          return [
            callTool("a2", "ensemble_add_member", {
              name: "shared-1",
              charter: { owns: "shared", handsOff: "other", doneWhen: "done" },
            }),
            callTool("p1", "ensemble_post", { text: "@shared-1 check" }),
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return stopText("coord idle");
      }
      if (who === "member:shared-1") {
        workerCalls++;
        if (workerCalls === 1) return stopText("shared waiting");
        throw new ProviderError({
          kind: "rate_limit",
          message: "paused",
          retryable: false,
        });
      }
      return stopText("ok");
    });

    const rt = await createRuntime({
      cwd: ws,
      workspaceRoot: ws,
      sessionsDir,
      providers: [provider],
      interactive: true,
      subagent: { background: true },
    });
    const coord = await rt.createSession({ model: "fake/m1", permissionPreset: "bypass" });
    sessions.push(coord);

    const memberStates = new Map<string, string>();
    coord.subscribe((ev: RuntimeEvent) => {
      if (ev.type === "ensemble.member_updated") {
        memberStates.set(ev.payload.name, ev.payload.status);
      }
    });

    // 只有隔离成员时：不挡主仓库切分支
    await coord.submit({ text: "add isolated", workMode: "ensemble" });
    await vi.waitFor(() => {
      expect(coord.isIdle()).toBe(true);
    });
    expect((await rt.workspaceBranches({ workspace: ws })).busy).toBe(false);

    // 加入非隔离成员：waiting 状态仍挡住切分支
    allowAddShared = true;
    await coord.submit({ text: "add shared" });
    await vi.waitFor(() => {
      expect(coord.isIdle()).toBe(true);
    });
    expect((await rt.workspaceBranches({ workspace: ws })).busy).toBe(true);
    await expect(
      rt.switchBranch({ workspace: ws, branch: "feat-blocked", create: true }),
    ).rejects.toMatchObject({ code: "session_busy" });

    // 非隔离成员进入 paused 状态：仍挡住切分支
    await coord.postToEnsemble({ text: "@shared-1 pause" });
    await vi.waitFor(() => {
      expect(memberStates.get("shared-1")).toBe("paused");
      expect(coord.isIdle()).toBe(true);
    });
    expect((await rt.workspaceBranches({ workspace: ws })).busy).toBe(true);
    await expect(
      rt.switchBranch({ workspace: ws, branch: "feat-blocked-2", create: true }),
    ).rejects.toMatchObject({ code: "session_busy" });

    // 移除非隔离成员后（只剩隔离成员）：不再挡住主仓库切分支
    await coord.removeEnsembleMember({ name: "shared-1" });
    expect((await rt.workspaceBranches({ workspace: ws })).busy).toBe(false);
    await rt.switchBranch({ workspace: ws, branch: "feat-ok", create: true });

    await coord.endEnsemble();
  });

  it("成员共享父会话授权、sessionGrantRoot 沿父链解析、且成员会话标签权限确认与私信正常", async () => {
    const ws = makeTempDir();
    const outside = makeTempDir("nocturne-outside-");
    const secretFile = path.join(outside, "note.txt");
    writeFileSync(secretFile, "outside-secret\n", "utf8");
    const sessionsDir = makeTempDir("nocturne-r1114c-sessions-");

    let coordStep = 0;
    let memberStep = 0;
    const memberMessages: string[] = [];

    const provider = makeProvider((req, who) => {
      if (who === "maestro") {
        coordStep++;
        if (coordStep === 1) {
          return [
            callTool("i1", "ensemble_init", { title: "Grants & Tab" }),
            callTool("a1", "ensemble_add_member", {
              name: "reader",
              charter: { owns: "read", handsOff: "write", doneWhen: "done" },
            }),
            callTool("p1", "ensemble_post", { text: "@reader read outside" }),
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return stopText("coord idle");
      }
      memberMessages.push(JSON.stringify(req.messages));
      memberStep++;
      if (memberStep === 1) {
        return [
          callTool("r1", "read", { path: secretFile }),
          { type: "finish", reason: "tool_calls" },
        ];
      }
      if (memberStep === 2) {
        return stopText("read complete");
      }
      if (memberStep === 3) {
        // 第二次读同一外部文件，应命中父会话共享的 session grant，不再弹出确认
        return [
          callTool("r2", "read", { path: secretFile }),
          { type: "finish", reason: "tool_calls" },
        ];
      }
      return stopText("private ok");
    });

    const rt = await createRuntime({
      cwd: ws,
      workspaceRoot: ws,
      sessionsDir,
      config: makeConfig(),
      providers: [provider],
      interactive: true,
      subagent: { background: true },
    });

    const coord = await rt.createSession({ model: "fake/m1", permissionPreset: "default" });
    sessions.push(coord);

    const awaitingIds: string[] = [];
    coord.subscribe((ev: RuntimeEvent) => {
      if (
        ev.type === "ensemble.member_updated" &&
        (ev.payload.pendingPermissions?.length ?? 0) > 0
      ) {
        for (const p of ev.payload.pendingPermissions ?? []) {
          awaitingIds.push(p.requestId);
        }
      }
    });

    await coord.submit({ text: "start", workMode: "ensemble" });
    await vi.waitFor(() => {
      expect(awaitingIds.length).toBeGreaterThan(0);
    });

    const childSessionId = must(
      replaySessionView(coord.durableEvents()).ensemble?.members[0]?.childSessionId,
    );

    // 通过 session.open (resumeSession) 打开成员会话标签并确认权限（带 remember: "session"）
    const memberHandle = await rt.resumeSession(childSessionId);
    const reqId = must(awaitingIds[0]);
    await memberHandle.respondPermission(reqId, { decision: "allow", remember: "session" });

    await vi.waitFor(() => {
      expect(coord.isIdle()).toBe(true);
      expect(memberStep).toBe(2);
    });

    // 成员与指挥共享同一份 sessionGrants，且 runtime.listSessionGrants(memberId) 解析到指挥根
    const grantsFromCoord = coord.listGrants();
    const grantsFromMemberRuntime = rt.listSessionGrants({ sessionId: childSessionId });
    expect(grantsFromCoord.length).toBeGreaterThan(0);
    expect(grantsFromMemberRuntime).toEqual(grantsFromCoord);

    // 私信（不触发新的 permission.requested，因为复用共享的 session grant）
    let secondPromptCount = 0;
    memberHandle.subscribe((ev: RuntimeEvent) => {
      if (ev.type === "permission.requested") secondPromptCount++;
    });
    await memberHandle.submit({ text: "PRIVATE-DM-CHECK" });
    await vi.waitFor(() => {
      expect(memberStep).toBe(4);
      expect(coord.isIdle()).toBe(true);
    });
    expect(secondPromptCount).toBe(0);
    expect(memberMessages.some((m) => m.includes("PRIVATE-DM-CHECK"))).toBe(true);
    // 私信不上指挥留言板
    expect(
      replaySessionView(coord.durableEvents()).ensemble?.posts.some((p) =>
        p.text.includes("PRIVATE-DM-CHECK"),
      ),
    ).toBe(false);

    // 从成员句柄撤销全部会话授权，指挥侧同步失效
    await rt.revokeAllSessionGrants({ sessionId: childSessionId });
    expect(coord.listGrants()).toEqual([]);

    await memberHandle.close();
    await coord.endEnsemble();
  });

  it("工作树删除保护：活动隔离成员不在 listSubagentWorktrees 中且 deleteSubagentWorktree 报「子代理仍在运行」；Ensemble 结束后未并回工作树可清理", async () => {
    const ws = makeTempDir();
    await initGitRepo(ws);
    const sessionsDir = makeTempDir("nocturne-r1114c-sessions-");

    let coordStep = 0;
    let isoStep = 0;
    const provider = makeProvider((_req, who) => {
      if (who === "maestro") {
        coordStep++;
        if (coordStep === 1) {
          return [
            callTool("i1", "ensemble_init", { title: "Worktree Guard" }),
            callTool("a1", "ensemble_add_member", {
              name: "iso-1",
              isolated: true,
              charter: { owns: "feature.txt", handsOff: "README.md", doneWhen: "committed" },
            }),
            callTool("p1", "ensemble_post", { text: "@iso-1 create feature.txt" }),
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return stopText("coord idle");
      }
      isoStep++;
      if (isoStep === 1) {
        return [
          callTool("w1", "write", { path: "feature.txt", content: "from iso-1\n" }),
          { type: "finish", reason: "tool_calls" },
        ];
      }
      if (isoStep === 2) {
        return [
          callTool("mp1", "ensemble_post", { text: "@maestro feature.txt ready" }),
          { type: "finish", reason: "tool_calls" },
        ];
      }
      return stopText("iso done");
    });

    const rt = await createRuntime({
      cwd: ws,
      workspaceRoot: ws,
      sessionsDir,
      providers: [provider],
      interactive: true,
      subagent: { background: true },
    });
    const coord = await rt.createSession({ model: "fake/m1", permissionPreset: "bypass" });
    sessions.push(coord);

    await coord.submit({ text: "start", workMode: "ensemble" });
    await vi.waitFor(
      () => {
        expect(coord.isIdle()).toBe(true);
        expect(isoStep).toBeGreaterThanOrEqual(2);
      },
      { timeout: 10_000 },
    );

    const member = must(replaySessionView(coord.durableEvents()).ensemble?.members[0]);
    const wtPath = must(member.worktree).path;
    expect(existsSync(path.join(wtPath, "feature.txt"))).toBe(true);

    // Ensemble 仍在进行（成员进入 waiting）：listSubagentWorktrees 不列出活动成员工作树，deleteSubagentWorktree 拒绝删除
    expect(await rt.listSubagentWorktrees({ parentSessionId: coord.id })).toEqual([]);
    await expect(
      rt.deleteSubagentWorktree({
        parentSessionId: coord.id,
        childSessionId: member.childSessionId,
      }),
    ).rejects.toMatchObject({ code: "invalid_command", message: "子代理仍在运行" });

    // 结束 Ensemble（保留未并回的工作树）后：不再报运行中，可列出并清理
    const ended = await coord.endEnsemble();
    expect(ended.unmerged).toHaveLength(1);
    const retained = await rt.listSubagentWorktrees({ parentSessionId: coord.id });
    expect(retained).toHaveLength(1);
    await rt.deleteSubagentWorktree({
      parentSessionId: coord.id,
      childSessionId: member.childSessionId,
    });
    expect(await rt.listSubagentWorktrees({ parentSessionId: coord.id })).toEqual([]);
  });

  it("关闭与重启恢复：maestro.close() 收尾成员，重启后不复活、不在 listSubagents，且仍保留分支与工作树删除保护", async () => {
    const ws = makeTempDir();
    await initGitRepo(ws);
    const sessionsDir = makeTempDir("nocturne-r1114c-sessions-");

    let coordStep = 0;
    let isoStep = 0;
    const provider1 = makeProvider((_req, who) => {
      if (who === "maestro") {
        coordStep++;
        if (coordStep === 1) {
          return [
            callTool("i1", "ensemble_init", { title: "Restart Recovery" }),
            callTool("a1", "ensemble_add_member", {
              name: "shared-m",
              charter: { owns: "shared", handsOff: "iso", doneWhen: "done" },
            }),
            callTool("a2", "ensemble_add_member", {
              name: "iso-m",
              isolated: true,
              charter: { owns: "iso", handsOff: "shared", doneWhen: "done" },
            }),
            callTool("p1", "ensemble_post", { text: "@iso-m write iso.txt" }),
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return stopText("coord idle");
      }
      if (who === "member:iso-m") {
        isoStep++;
        if (isoStep === 1) {
          return [
            callTool("w1", "write", { path: "iso.txt", content: "v1\n" }),
            { type: "finish", reason: "tool_calls" },
          ];
        }
      }
      return stopText("member done");
    });

    const rt1 = await createRuntime({
      cwd: ws,
      workspaceRoot: ws,
      sessionsDir,
      providers: [provider1],
      interactive: true,
      subagent: { background: true },
    });
    const coord1 = await rt1.createSession({ model: "fake/m1", permissionPreset: "bypass" });
    sessions.push(coord1);
    await coord1.submit({ text: "run", workMode: "ensemble" });
    await vi.waitFor(() => {
      expect(coord1.isIdle()).toBe(true);
    });
    const coordId = coord1.id;
    const isoId = must(
      replaySessionView(coord1.durableEvents()).ensemble?.members.find((m) => m.name === "iso-m"),
    ).childSessionId;

    // 关闭指挥：收尾全部成员，之后主仓库不再被已关闭会话锁住
    await coord1.close();
    sessions.pop();
    expect((await rt1.workspaceBranches({ workspace: ws })).busy).toBe(false);

    // 模拟重启恢复
    const provider2Calls: string[] = [];
    const provider2 = makeProvider((_req, who) => {
      provider2Calls.push(who);
      return stopText("resumed");
    });
    const rt2 = await createRuntime({
      cwd: ws,
      workspaceRoot: ws,
      sessionsDir,
      providers: [provider2],
      interactive: true,
      subagent: { background: true },
    });
    const coord2 = await rt2.resumeSession(coordId);
    sessions.push(coord2);

    // 重启不自动唤醒成员，也不进 listSubagents / listSubagentWorktrees
    expect(provider2Calls).toEqual([]);
    expect(await rt2.listSubagents({ parentSessionId: coordId })).toEqual([]);
    expect(await rt2.listSubagentWorktrees({ parentSessionId: coordId })).toEqual([]);

    // 重启恢复后即使尚未懒打开成员会话，保护仍然成立
    expect((await rt2.workspaceBranches({ workspace: ws })).busy).toBe(true);
    await expect(
      rt2.switchBranch({ workspace: ws, branch: "blocked-after-restart", create: true }),
    ).rejects.toMatchObject({ code: "session_busy" });
    await expect(
      rt2.deleteSubagentWorktree({ parentSessionId: coordId, childSessionId: isoId }),
    ).rejects.toMatchObject({ code: "invalid_command", message: "子代理仍在运行" });

    await coord2.endEnsemble();
    expect((await rt2.workspaceBranches({ workspace: ws })).busy).toBe(false);
    expect(await rt2.listSubagents({ parentSessionId: coordId })).toEqual([]);
  });

  it("普通 task 后台子代理（含隔离工作树与自定义档位）的登记、显示与保护不受影响", async () => {
    const ws = makeTempDir();
    await initGitRepo(ws);
    const sessionsDir = makeTempDir("nocturne-r1114c-sessions-");

    let releaseTask: (() => void) | undefined;
    const taskGate = new Promise<void>((resolve) => {
      releaseTask = resolve;
    });
    let taskRunning = false;
    let notifyTaskRunning: (() => void) | undefined;
    const enteredTask = new Promise<void>((resolve) => {
      notifyTaskRunning = resolve;
    });

    let parentStep = 0;
    const provider = new FakeProvider({
      id: "fake",
      models: [
        {
          ref: { provider: "fake", model: "m1" },
          protocol: "openai-compatible" as const,
          contextWindow: 128_000,
          maxOutputTokens: 8_192,
          capabilities: {
            toolCalls: true,
            parallelToolCalls: true,
            reasoning: "none" as const,
            imageInput: false,
            promptCache: false,
            editTool: "edit" as const,
          },
        },
      ],
      roleHandler: () => stopText("Title"),
      handler: async (req) => {
        if (req.tools.some((t) => t.name === "finish")) {
          taskRunning = true;
          notifyTaskRunning?.();
          await taskGate;
          return [
            callTool("f1", "finish", { result: "task finished" }),
            { type: "finish", reason: "tool_calls" },
          ];
        }
        parentStep++;
        if (parentStep === 1) {
          return [
            callTool("t1", "task", {
              task: "normal background work",
              profile: "gemini",
              background: true,
            }),
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return stopText("parent done");
      },
    });

    const rt = await createRuntime({
      cwd: ws,
      workspaceRoot: ws,
      sessionsDir,
      config: makeConfig(),
      providers: [provider],
      interactive: true,
      subagent: { background: true },
    });
    const session = await rt.createSession({ model: "fake/m1", permissionPreset: "bypass" });
    sessions.push(session);

    await session.submit({ text: "launch normal task" });
    await enteredTask;
    expect(taskRunning).toBe(true);

    // 运行中的普通后台子代理正常出现在 listSubagents 中，且挡住切分支
    const running = await rt.listSubagents({ parentSessionId: session.id });
    expect(running).toHaveLength(1);
    expect(running[0]).toMatchObject({
      state: "running",
      background: true,
      profile: "gemini",
      taskSummary: "normal background work",
    });
    expect((await rt.workspaceBranches({ workspace: ws })).busy).toBe(true);

    releaseTask?.();
    await vi.waitFor(async () => {
      const list = await rt.listSubagents({ parentSessionId: session.id });
      expect(list[0]?.state).toBe("ended");
      expect(session.isIdle()).toBe(true);
    });
    expect((await rt.workspaceBranches({ workspace: ws })).busy).toBe(false);
    expect(readFileSync(path.join(ws, "README.md"), "utf8")).toContain("Test Repo");
  });
});
