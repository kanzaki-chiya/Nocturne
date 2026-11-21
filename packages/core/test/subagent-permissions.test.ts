/**
 * 一次性子代理（task）交互式权限转发测试。
 * 覆盖：前/后台、工作树隔离、嵌套 task、树共享 Grant、smart 审查、显式超时暂停、
 * 并发独立回应与混排顺序、interrupt/cancel/close 清理、竞态与越界校验、非交互/ACP/--yes 不回归。
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  allPendingPermissions,
  createPlatform,
  createRuntime,
  createSessionView,
  loadConfig,
  reduceSessionView,
  replaySessionView,
  type ExternalAgentConnector,
  type ExternalAgentPermissionDecision,
  type Grant,
  type RuntimeConfig,
  type RuntimeEvent,
  type RuntimeSession,
  type SessionView,
  type SubagentPendingPermission,
} from "../src/index.js";
import { type SecurityReviewer, createRulePolicy } from "../src/permission/index.js";
import type { ToolDefinition } from "../src/tools/index.js";
import { FakeProvider, type FakeScript, type ModelRequest } from "../src/provider/index.js";
import { workModeBody } from "../src/work-modes/index.js";

const tmpRoots: string[] = [];
afterEach(() => {
  for (const r of tmpRoots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function makeTmp(prefix: string): string {
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), prefix)));
  tmpRoots.push(dir);
  return dir;
}

const msgText = (req: ModelRequest): string =>
  req.messages
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n");

function initGitRepo(dir: string): void {
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Tester"], { cwd: dir, stdio: "ignore" });
  writeFileSync(path.join(dir, "README.md"), "init\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
}

const isChildRequest = (r: ModelRequest) => r.tools.some((t) => t.name === "finish");
const isNestedChild = (r: ModelRequest) =>
  isChildRequest(r) && r.tools.some((t) => t.name === "task");
const isGrandchild = (r: ModelRequest) => isChildRequest(r) && !isNestedChild(r);

function doneScript(text = "完成"): FakeScript {
  return [
    { type: "text_delta", text },
    { type: "finish", reason: "stop" },
  ];
}

function deferred<T = undefined>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function firstOrThrow<T>(arr: readonly T[], label = "item"): T {
  const first = arr[0];
  if (first === undefined) throw new Error(`Missing ${label}`);
  return first;
}

async function waitFor<T>(fn: () => T | undefined | false, timeoutMs = 4000): Promise<T> {
  let result!: T;
  await vi.waitFor(
    () => {
      const val = fn();
      if (!val) throw new Error("waitFor timeout");
      result = val;
    },
    { timeout: timeoutMs, interval: 10 },
  );
  return result;
}

function attachView(session: RuntimeSession): {
  view: SessionView;
  events: RuntimeEvent[];
  unsub: () => void;
} {
  const view = createSessionView();
  const events: RuntimeEvent[] = [];
  const unsub = session.subscribe((e) => {
    events.push(e);
    reduceSessionView(view, e);
  });
  return { view, events, unsub };
}

describe("subagent 权限转发：前后台与隔离", () => {
  it("前台 general 子代理 edit：经父 subagent.permissions 转发、父不落外来 callId、allow 执行且 deny 传 feedback", async () => {
    const ws = makeTmp("nct-sp-fg-");
    const sessionsDir = makeTmp("nct-sp-fg-s-");
    const outsideDir = makeTmp("nct-sp-fg-out-");
    const targetFileAllow = path.join(outsideDir, "a-allow.txt");
    const targetFileDeny = path.join(outsideDir, "a-deny.txt");
    let mode: "allow" | "deny" = "allow";

    const provider = new FakeProvider({
      handler: (req) => {
        if (isChildRequest(req)) {
          const toolMsg = req.messages.find((m) => m.role === "tool");
          if (toolMsg) {
            return [
              {
                type: "tool_call",
                toolCallId: "cf-1",
                name: "finish",
                input: { result: `child-saw:${String(toolMsg.content)}` },
              },
              { type: "finish", reason: "tool_calls" },
            ];
          }
          return [
            {
              type: "tool_call",
              toolCallId: "child-edit-call",
              name: "write",
              input: { path: mode === "allow" ? targetFileAllow : targetFileDeny, content: "new" },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        const lastMsg = req.messages.at(-1);
        if (lastMsg?.role === "tool") return doneScript();
        return [
          {
            type: "tool_call",
            toolCallId: "parent-task-1",
            name: "task",
            input: { task: "修改 a.txt 文件内容" },
          },
          { type: "finish", reason: "tool_calls" },
        ];
      },
    });

    const runtime = await createRuntime({
      cwd: ws,
      sessionsDir,
      providers: [provider],
      interactive: true,
      policy: createRulePolicy({
        workspaceRoot: ws,
        caseSensitive: true,
        preset: "default",
        rules: [{ rule: { kind: "subagent", pattern: "*", action: "allow" }, origin: "user" }],
      }),
    });

    const s1 = await runtime.createSession({ model: "fake/fake-model" });
    const { view: v1, events: ev1 } = attachView(s1);

    let capturedPending: SubagentPendingPermission | undefined;
    s1.subscribe((e) => {
      if (e.type === "subagent.permissions" && e.payload.pending.length > 0) {
        const req = firstOrThrow(e.payload.pending, "pending");
        capturedPending = req;
        void s1.respondSubagentPermission(
          req.childSessionId,
          req.requestId,
          mode === "allow" ? { decision: "allow" } : { decision: "deny", feedback: "不要改 a.txt" },
        );
      }
    });

    await s1.submit({ text: "go allow" });
    expect(readFileSync(targetFileAllow, "utf8")).toBe("new");
    expect(v1.pendingSubagentPermissions).toEqual([]);
    const parentDurable = s1.durableEvents();
    const taskStart1 = parentDurable.find(
      (e) => e.type === "tool.started" && e.payload.name === "task",
    );
    expect(capturedPending).toMatchObject({
      parentCallId: taskStart1?.type === "tool.started" ? taskStart1.payload.callId : undefined,
      profile: "",
      taskSummary: "修改 a.txt 文件内容",
      toolName: "write",
    });

    // 父会话持久日志绝不出现 child 的 permission.requested / permission.resolved 或外来 callId
    expect(
      parentDurable.some(
        (e) =>
          (e.type === "permission.requested" || e.type === "permission.resolved") &&
          e.payload.callId === capturedPending?.callId,
      ),
    ).toBe(false);
    expect(ev1.some((e) => e.type === "subagent.permissions")).toBe(true);

    // 子日志完整记录 permission.requested 与 permission.resolved
    const taskComp1 = parentDurable.find(
      (e) => e.type === "tool.completed" && e.payload.name === "task",
    );
    const childLogPath1 =
      taskComp1?.type === "tool.completed"
        ? (taskComp1.payload.output as { childLogPath?: string } | undefined)?.childLogPath
        : undefined;
    if (childLogPath1 === undefined) throw new Error("Missing childLogPath1");
    const childLog1 = readFileSync(childLogPath1, "utf8");
    expect(childLog1).toContain('"type":"permission.requested"');
    expect(childLog1).toContain('"type":"permission.resolved"');
    expect(childLog1).toContain('"action":"allow"');

    // 再测 deny + feedback
    mode = "deny";
    await s1.submit({ text: "go deny" });
    expect(existsSync(targetFileDeny)).toBe(false);
    const taskComp2 = s1
      .durableEvents()
      .filter((e) => e.type === "tool.completed" && e.payload.name === "task")
      .at(-1);
    expect(
      taskComp2?.type === "tool.completed" && String(taskComp2.payload.modelContent),
    ).toContain("不要改 a.txt");

    // 重放恢复：重启后旧未决不复活
    const replayed = replaySessionView(s1.durableEvents());
    expect(replayed.pendingSubagentPermissions).toEqual([]);

    await s1.close();
  });

  it("前台 explore 子代理越界 read：触发 ask 转发并可回应", async () => {
    const ws = makeTmp("nct-sp-exp-");
    const outsideDir = makeTmp("nct-sp-exp-out-");
    const sessionsDir = makeTmp("nct-sp-exp-s-");
    const outsideFile = path.join(outsideDir, "secret.txt");
    writeFileSync(outsideFile, "outside-secret");

    const provider = new FakeProvider({
      handler: (req) => {
        if (isChildRequest(req)) {
          const toolMsg = req.messages.find((m) => m.role === "tool");
          return toolMsg
            ? [
                {
                  type: "tool_call",
                  toolCallId: "cf",
                  name: "finish",
                  input: { result: `read:${String(toolMsg.content)}` },
                },
                { type: "finish", reason: "tool_calls" },
              ]
            : [
                {
                  type: "tool_call",
                  toolCallId: "ce-read",
                  name: "read",
                  input: { path: outsideFile },
                },
                { type: "finish", reason: "tool_calls" },
              ];
        }
        return req.messages.some((m) => m.role === "tool")
          ? doneScript()
          : [
              {
                type: "tool_call",
                toolCallId: "task-exp",
                name: "task",
                input: { task: "读取外部文件", preset: "explore" },
              },
              { type: "finish", reason: "tool_calls" },
            ];
      },
    });

    const runtime = await createRuntime({
      cwd: ws,
      sessionsDir,
      providers: [provider],
      interactive: true,
      policy: createRulePolicy({
        workspaceRoot: ws,
        caseSensitive: true,
        preset: "default",
        rules: [{ rule: { kind: "subagent", pattern: "*", action: "allow" }, origin: "user" }],
      }),
    });
    const session = await runtime.createSession({ model: "fake/fake-model" });
    let seenProfile: string | undefined;
    session.subscribe((e) => {
      if (e.type === "subagent.permissions" && e.payload.pending.length > 0) {
        const req = firstOrThrow(e.payload.pending, "pending");
        seenProfile = req.profile;
        void session.respondSubagentPermission(req.childSessionId, req.requestId, {
          decision: "allow",
        });
      }
    });
    await session.submit({ text: "go" });
    expect(seenProfile).toBe("explore");
    const completed = session
      .durableEvents()
      .find((e) => e.type === "tool.completed" && e.payload.name === "task");
    expect(
      completed?.type === "tool.completed" && String(completed.payload.modelContent),
    ).toContain("outside-secret");
    await session.close();
  });

  it("后台 task（非隔离与 git worktree 隔离）均支持 ask 等待并直接经父会话回应完成", async () => {
    const ws = makeTmp("nct-sp-bg-wt-");
    initGitRepo(ws);
    const sessionsDir = makeTmp("nct-sp-bg-wt-s-");
    const outsideDir = makeTmp("nct-sp-bg-out-");
    const outsideFile = path.join(outsideDir, "note.txt");
    writeFileSync(outsideFile, "note-ok");

    const provider = new FakeProvider({
      handler: (req) => {
        if (isChildRequest(req)) {
          const toolMsg = req.messages.find((m) => m.role === "tool");
          if (toolMsg) {
            return [
              {
                type: "tool_call",
                toolCallId: "cf",
                name: "finish",
                input: { result: `bg-done:${String(toolMsg.content)}` },
              },
              { type: "finish", reason: "tool_calls" },
            ];
          }
          // 检测是否处于工作树目录（如果是则写 worktree 文件，否则读外部文件）
          const isWorktree = req.messages.some((m) =>
            String(m.content).includes("隔离工作树绝对路径"),
          );
          return isWorktree
            ? [
                {
                  type: "tool_call",
                  toolCallId: "cw-wt",
                  name: "write",
                  input: { path: "wt.txt", content: "wt-allowed" },
                },
                { type: "finish", reason: "tool_calls" },
              ]
            : [
                {
                  type: "tool_call",
                  toolCallId: "cr-ni",
                  name: "read",
                  input: { path: outsideFile },
                },
                { type: "finish", reason: "tool_calls" },
              ];
        }
        const hasTool = req.messages.some((m) => m.role === "tool");
        if (hasTool) return doneScript("已派发");
        return [
          {
            type: "tool_call",
            toolCallId: "task-bg-wt",
            name: "task",
            input: { task: "后台写工作树", background: true },
          },
          {
            type: "tool_call",
            toolCallId: "task-bg-ro",
            name: "task",
            input: { task: "后台读外部文件", preset: "explore", background: true },
          },
          { type: "finish", reason: "tool_calls" },
        ];
      },
    });

    const runtime = await createRuntime({
      cwd: ws,
      sessionsDir,
      providers: [provider],
      interactive: true,
      subagent: { background: true, maxBackground: 3, maxConcurrent: 4 },
      policy: createRulePolicy({
        workspaceRoot: ws,
        caseSensitive: true,
        preset: "default",
        rules: [{ rule: { kind: "subagent", pattern: "*", action: "allow" }, origin: "user" }],
      }),
    });
    const session = await runtime.createSession({ model: "fake/fake-model" });
    const { view } = attachView(session);

    await session.submit({ text: "launch two bg" });
    // 父 Turn 结束但后台仍在等待确认
    const pending = await waitFor(() =>
      view.pendingSubagentPermissions.length === 2 ? [...view.pendingSubagentPermissions] : false,
    );
    for (const p of pending) {
      await session.respondSubagentPermission(p.childSessionId, p.requestId, {
        decision: "allow",
      });
    }
    // 等两个后台结果交付并触发父会话新 Turn
    await waitFor(() => {
      const joined = session
        .durableEvents()
        .filter((e) => e.type === "message.user" && e.payload.subagent !== undefined)
        .map((e) => (e.type === "message.user" ? e.payload.subagent?.status : undefined));
      return joined.length === 2 && joined.every((s) => s === "ok");
    });
    expect(view.pendingSubagentPermissions).toEqual([]);
    await session.close();
  });
});

describe("subagent 权限转发：共享 Grant、app/project、smart 与越界", () => {
  it("session allow 写树共享 Grant：父会话与另一个 child 不再询问", async () => {
    const ws = makeTmp("nct-sp-grant-");
    const outsideDir = makeTmp("nct-sp-grant-out-");
    const sessionsDir = makeTmp("nct-sp-grant-s-");
    const targetFile = path.join(outsideDir, "shared.txt");
    writeFileSync(targetFile, "shared-ok");
    let turnIndex = 0;

    const provider = new FakeProvider({
      handler: (req) => {
        if (isChildRequest(req)) {
          const toolMsg = req.messages.find((m) => m.role === "tool");
          return toolMsg
            ? [
                {
                  type: "tool_call",
                  toolCallId: "cf",
                  name: "finish",
                  input: { result: "done" },
                },
                { type: "finish", reason: "tool_calls" },
              ]
            : [
                {
                  type: "tool_call",
                  toolCallId: "cr-shared",
                  name: "read",
                  input: { path: targetFile },
                },
                { type: "finish", reason: "tool_calls" },
              ];
        }
        const lastMsg = req.messages.at(-1);
        if (lastMsg?.role === "tool") return doneScript();
        turnIndex += 1;
        if (turnIndex === 1) {
          return [
            {
              type: "tool_call",
              toolCallId: "task-1",
              name: "task",
              input: { task: "child1 读外部文件", preset: "explore" },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        if (turnIndex === 2) {
          return [
            {
              type: "tool_call",
              toolCallId: "parent-read",
              name: "read",
              input: { path: targetFile },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return [
          {
            type: "tool_call",
            toolCallId: "task-2",
            name: "task",
            input: { task: "child2 读同一外部文件", preset: "explore" },
          },
          { type: "finish", reason: "tool_calls" },
        ];
      },
    });

    const runtime = await createRuntime({
      cwd: ws,
      sessionsDir,
      providers: [provider],
      interactive: true,
    });
    const session = await runtime.createSession({ model: "fake/fake-model" });
    let subagentAsks = 0;
    let parentReadAsks = 0;
    session.subscribe((e) => {
      if (e.type === "subagent.permissions" && e.payload.pending.length > 0) {
        subagentAsks += 1;
        const req = firstOrThrow(e.payload.pending, "pending");
        void session.respondSubagentPermission(req.childSessionId, req.requestId, {
          decision: "allow",
          remember: "session",
        });
      } else if (e.type === "permission.requested") {
        if (e.payload.subjects.some((s) => s.kind === "read")) {
          parentReadAsks += 1;
        }
        void session.respondPermission(e.payload.requestId, { decision: "allow" });
      }
    });

    await session.submit({ text: "turn 1" });
    expect(subagentAsks).toBe(1);
    await session.submit({ text: "turn 2" });
    expect(parentReadAsks).toBe(0);
    await session.submit({ text: "turn 3" });
    expect(subagentAsks).toBe(1);
    expect(await session.listGrants()).toHaveLength(1);
    await session.close();
  });

  it("smart 审查链不变：allow/block 不转发询问，unsure 转发且携带 review", async () => {
    const ws = makeTmp("nct-sp-smart-");
    const outsideDir = makeTmp("nct-sp-smart-out-");
    const sessionsDir = makeTmp("nct-sp-smart-s-");
    const outsideFile = path.join(outsideDir, "f-new.txt");
    let verdict: "allow" | "block" | "unsure" = "allow";

    const reviewer: SecurityReviewer = {
      async review() {
        return { verdict, reason: `verdict=${verdict}` };
      },
    };
    const provider = new FakeProvider({
      handler: (req) => {
        if (isChildRequest(req)) {
          const toolMsg = req.messages.find((m) => m.role === "tool");
          return toolMsg
            ? [
                {
                  type: "tool_call",
                  toolCallId: "cf",
                  name: "finish",
                  input: { result: "done" },
                },
                { type: "finish", reason: "tool_calls" },
              ]
            : [
                {
                  type: "tool_call",
                  toolCallId: "ce-smart",
                  name: "write",
                  input: { path: outsideFile, content: "y" },
                },
                { type: "finish", reason: "tool_calls" },
              ];
        }
        const lastMsg = req.messages.at(-1);
        if (lastMsg?.role === "tool") return doneScript();
        return [
          {
            type: "tool_call",
            toolCallId: "task-smart",
            name: "task",
            input: { task: "写外部文件" },
          },
          { type: "finish", reason: "tool_calls" },
        ];
      },
    });

    const runtime = await createRuntime({
      cwd: ws,
      sessionsDir,
      providers: [provider],
      interactive: true,
      permissions: { reviewer },
      policy: createRulePolicy({
        workspaceRoot: ws,
        caseSensitive: true,
        preset: "smart",
        rules: [{ rule: { kind: "subagent", pattern: "*", action: "allow" }, origin: "user" }],
      }),
    });
    const session = await runtime.createSession({
      model: "fake/fake-model",
      permissionPreset: "smart",
    });

    let forwardedCount = 0;
    let lastReviewVerdict: string | undefined;
    session.subscribe((e) => {
      if (e.type === "subagent.permissions" && e.payload.pending.length > 0) {
        forwardedCount += 1;
        const req = firstOrThrow(e.payload.pending, "pending");
        lastReviewVerdict = req.review?.verdict;
        void session.respondSubagentPermission(req.childSessionId, req.requestId, {
          decision: "allow",
        });
      }
    });

    verdict = "allow";
    await session.submit({ text: "smart allow" });
    expect(forwardedCount).toBe(0);
    expect(readFileSync(outsideFile, "utf8")).toBe("y");

    verdict = "block";
    await session.submit({ text: "smart block" });
    expect(forwardedCount).toBe(0);

    verdict = "unsure";
    await session.submit({ text: "smart unsure" });
    expect(forwardedCount).toBe(1);
    expect(lastReviewVerdict).toBe("unsure");

    await session.close();
  });

  it("父 deny 规则与无效选项校验：子代理有效权限不得宽于父，非法 reply 拒绝且保留 pending", async () => {
    const ws = makeTmp("nct-sp-bounds-");
    const sessionsDir = makeTmp("nct-sp-bounds-s-");
    writeFileSync(path.join(ws, "a.txt"), "x");

    const provider = new FakeProvider({
      handler: (req) => {
        if (isChildRequest(req)) {
          const toolMsg = req.messages.find((m) => m.role === "tool");
          if (toolMsg) {
            return [
              {
                type: "tool_call",
                toolCallId: "cf",
                name: "finish",
                input: { result: String(toolMsg.content) },
              },
              { type: "finish", reason: "tool_calls" },
            ];
          }
          // 第一次调 edit（被 deny 规则拒绝），如果收到文本 "run-risky-shell" 则调危险 shell
          const askShell = msgText(req).includes("run-risky-shell");
          return askShell
            ? [
                {
                  type: "tool_call",
                  toolCallId: "cs-risky",
                  name: "shell",
                  input: { command: "rm -rf /tmp/nonexistent-x" },
                },
                { type: "finish", reason: "tool_calls" },
              ]
            : [
                {
                  type: "tool_call",
                  toolCallId: "ce-deny",
                  name: "edit",
                  input: { path: "a.txt", old: "x", new: "y" },
                },
                { type: "finish", reason: "tool_calls" },
              ];
        }
        if (req.messages.at(-1)?.role === "tool") return doneScript();
        const taskPrompt = msgText(req).includes("run-risky-shell")
          ? "run-risky-shell"
          : "try-edit";
        return [
          {
            type: "tool_call",
            toolCallId: "task-b",
            name: "task",
            input: { task: taskPrompt },
          },
          { type: "finish", reason: "tool_calls" },
        ];
      },
    });

    const runtime = await createRuntime({
      cwd: ws,
      sessionsDir,
      providers: [provider],
      interactive: true,
      policy: createRulePolicy({
        workspaceRoot: ws,
        caseSensitive: true,
        preset: "default",
        rules: [
          { rule: { kind: "subagent", pattern: "*", action: "allow" }, origin: "user" },
          { rule: { kind: "edit", pattern: "*", action: "deny" }, origin: "user" },
        ],
      }),
    });
    const session = await runtime.createSession({ model: "fake/fake-model" });
    const { view } = attachView(session);
    const otherSession = await runtime.createSession({ model: "fake/fake-model" });

    // edit 被父 deny 规则拦截，不进 pendingSubagentPermissions
    await session.submit({ text: "edit" });
    expect(view.pendingSubagentPermissions).toEqual([]);
    expect(readFileSync(path.join(ws, "a.txt"), "utf8")).toBe("x");

    // 危险 shell 只有 allow_once/deny/deny_stop，不允许 remember="project"；跨会话也拒
    const submitP = session.submit({ text: "run-risky-shell" });
    const pending = await waitFor(() =>
      view.pendingSubagentPermissions.length === 1 ? view.pendingSubagentPermissions[0] : false,
    );
    expect(pending.options).toEqual(["allow_once", "deny", "deny_stop"]);

    // 跨会话越界回应必须报 unknown_request 且不清除 pending
    await expect(
      otherSession.respondSubagentPermission(pending.childSessionId, pending.requestId, {
        decision: "allow",
      }),
    ).rejects.toMatchObject({ code: "unknown_request" });
    expect(view.pendingSubagentPermissions).toHaveLength(1);

    // 不在 confirmationOptions 中的 remember="project" 被拒绝且保留 pending（rpc.md 契约：invalid_reply）
    await expect(
      session.respondSubagentPermission(pending.childSessionId, pending.requestId, {
        decision: "allow",
        remember: "project",
      }),
    ).rejects.toMatchObject({ code: "invalid_reply" });
    expect(view.pendingSubagentPermissions).toHaveLength(1);

    // 正常 deny_stop / deny 结算
    await session.respondSubagentPermission(pending.childSessionId, pending.requestId, {
      decision: "deny",
    });
    await submitP;
    expect(view.pendingSubagentPermissions).toEqual([]);

    await otherSession.close();
    await session.close();
  });
});

describe("subagent 权限转发：显式超时暂停、并发混排、生命周期清理与竞态", () => {
  it("等待期间暂停 task inputTimeoutMs 与 profile/runtime launcher 两层超时（含嵌套祖先）", async () => {
    const ws = makeTmp("nct-sp-to-");
    const sessionsDir = makeTmp("nct-sp-to-s-");
    const targetFile = path.join(ws, "a-new.txt");

    const provider = new FakeProvider({
      handler: (req) => {
        if (isGrandchild(req)) {
          const toolMsg = req.messages.find((m) => m.role === "tool");
          return toolMsg
            ? [
                {
                  type: "tool_call",
                  toolCallId: "gcf",
                  name: "finish",
                  input: { result: "grandchild-ok" },
                },
                { type: "finish", reason: "tool_calls" },
              ]
            : [
                {
                  type: "tool_call",
                  toolCallId: "gc-write",
                  name: "write",
                  input: { path: targetFile, content: "after" },
                },
                { type: "finish", reason: "tool_calls" },
              ];
        }
        if (isNestedChild(req)) {
          const toolMsg = req.messages.find((m) => m.role === "tool");
          return toolMsg
            ? [
                {
                  type: "tool_call",
                  toolCallId: "cf",
                  name: "finish",
                  input: { result: `nested:${String(toolMsg.content)}` },
                },
                { type: "finish", reason: "tool_calls" },
              ]
            : [
                {
                  type: "tool_call",
                  toolCallId: "nested-task",
                  name: "task",
                  input: { task: "孙代理修改文件", timeoutMs: 80 },
                },
                { type: "finish", reason: "tool_calls" },
              ];
        }
        return req.messages.at(-1)?.role === "tool"
          ? doneScript()
          : [
              {
                type: "tool_call",
                toolCallId: "root-task",
                name: "task",
                input: { task: "嵌套任务", profile: "quick", timeoutMs: 80 },
              },
              { type: "finish", reason: "tool_calls" },
            ];
      },
    });

    const basePlatform = {
      ...createPlatform(),
      homeDir: () => ws,
      nocturneHome: () => sessionsDir,
      env: () => undefined,
    };
    writeFileSync(
      path.join(sessionsDir, "config.json"),
      JSON.stringify({
        modelsDev: false,
        skills: { sources: { agents: false, claude: false } },
        subagents: {
          profiles: {
            quick: { description: "快速", enabled: true, timeoutMs: 80 },
          },
        },
      }),
    );
    const config = await loadConfig(basePlatform, {
      nocturneHome: sessionsDir,
      env: () => undefined,
    });
    const runtime = await createRuntime({
      cwd: ws,
      sessionsDir,
      config,
      providers: [provider],
      interactive: true,
      subagent: {
        maxDepth: 2,
        maxConcurrent: 4,
        timeoutMs: 80,
      },
      policy: createRulePolicy({
        workspaceRoot: ws,
        caseSensitive: true,
        preset: "default",
        rules: [{ rule: { kind: "subagent", pattern: "*", action: "allow" }, origin: "user" }],
      }),
    });

    const session = await runtime.createSession({ model: "fake/fake-model" });
    const { view } = attachView(session);
    const submitP = session.submit({ text: "nested timeout test" });

    // 等孙代理进入权限等待；其间等待 250ms（远超 80ms 显式时限）
    const pending = await waitFor(() =>
      view.pendingSubagentPermissions.length === 1 ? view.pendingSubagentPermissions[0] : false,
    );
    // 嵌套转发到根父会话，parentCallId 为根会话最外层 task 的 callId
    const rootTaskStarted = session
      .durableEvents()
      .find((e) => e.type === "tool.started" && e.payload.name === "task");
    expect(pending.parentCallId).toBe(
      rootTaskStarted?.type === "tool.started" ? rootTaskStarted.payload.callId : undefined,
    );

    // eslint-disable-next-line no-restricted-syntax -- 反向断言：权限等待期间 250ms 内三层 80ms 超时不触发
    await new Promise((r) => setTimeout(r, 250));
    // 仍处于等待中，三层超时均未误触发
    expect(view.pendingSubagentPermissions).toHaveLength(1);

    await session.respondSubagentPermission(pending.childSessionId, pending.requestId, {
      decision: "allow",
    });
    await submitP;

    expect(readFileSync(targetFile, "utf8")).toBe("after");
    const completed = session
      .durableEvents()
      .find((e) => e.type === "tool.completed" && e.payload.name === "task");
    expect(completed?.type === "tool.completed" && completed.payload.status).toBe("ok");
    await session.close();
  });

  it("双 child 并发独立回应 + 与父请求按到达顺序混排 + 晚订阅顺序一致", async () => {
    const ws = makeTmp("nct-sp-conc-");
    const outsideDir = makeTmp("nct-sp-conc-out-");
    const sessionsDir = makeTmp("nct-sp-conc-s-");
    const f1 = path.join(outsideDir, "f1.txt");
    const f2 = path.join(outsideDir, "f2.txt");
    const fp = path.join(ws, "fp.txt");
    writeFileSync(f1, "1");
    writeFileSync(f2, "2");
    writeFileSync(fp, "p");

    let parentTurn = 0;
    let parentWrote = false;
    const provider = new FakeProvider({
      handler: (req) => {
        if (isChildRequest(req)) {
          const toolMsg = req.messages.find((m) => m.role === "tool");
          if (toolMsg) {
            return [
              {
                type: "tool_call",
                toolCallId: "cf",
                name: "finish",
                input: { result: "ok" },
              },
              { type: "finish", reason: "tool_calls" },
            ];
          }
          const isChild1 = msgText(req).includes("task-c1");
          return [
            {
              type: "tool_call",
              toolCallId: isChild1 ? "c1-read" : "c2-read",
              name: "read",
              input: { path: isChild1 ? f1 : f2 },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        if (req.messages.at(-1)?.role === "tool") return doneScript();
        parentTurn += 1;
        if (parentTurn === 1) {
          return [
            {
              type: "tool_call",
              toolCallId: "t-c1",
              name: "task",
              input: { task: "task-c1", preset: "explore", background: true, isolation: "none" },
            },
            {
              type: "tool_call",
              toolCallId: "t-c2",
              name: "task",
              input: { task: "task-c2", preset: "explore", background: true, isolation: "none" },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        if (!parentWrote && msgText(req).includes("parent edit")) {
          parentWrote = true;
          return [
            {
              type: "tool_call",
              toolCallId: "parent-write",
              name: "write",
              input: { path: path.join(ws, "fp-new.txt"), content: "p-done" },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return doneScript();
      },
    });

    const runtime = await createRuntime({
      cwd: ws,
      sessionsDir,
      providers: [provider],
      interactive: true,
      subagent: { background: true, maxBackground: 3, maxConcurrent: 4 },
      policy: createRulePolicy({
        workspaceRoot: ws,
        caseSensitive: true,
        preset: "default",
        rules: [{ rule: { kind: "subagent", pattern: "*", action: "allow" }, origin: "user" }],
      }),
    });
    const session = await runtime.createSession({ model: "fake/fake-model" });
    const { view } = attachView(session);

    await session.submit({ text: "start two bg" });
    const two = await waitFor(() =>
      view.pendingSubagentPermissions.length === 2 ? [...view.pendingSubagentPermissions] : false,
    );

    // 紧接着在父会话自己发起一个 edit 请求（到达顺序应在两个 child 之后）
    const pTurn = session.submit({ text: "parent edit" });
    await waitFor(() => view.pendingPermission !== undefined && view.pendingPermission);

    const ordered = allPendingPermissions(view);
    expect(ordered).toHaveLength(3);
    expect(ordered[0]?.kind).toBe("subagent");
    expect(ordered[1]?.kind).toBe("subagent");
    expect(ordered[2]?.kind).toBe("session");

    // 晚订阅视图与实时视图排序必须完全一致
    const lateView = replaySessionView(session.durableEvents());
    const lateSub = session.subscribe((e) => reduceSessionView(lateView, e));
    lateSub();
    expect(allPendingPermissions(lateView).map((x) => x.permission.requestId)).toEqual(
      ordered.map((x) => x.permission.requestId),
    );

    // 独立先回应第 2 个 child，第 1 个 child 与父自身请求保持等待
    const second = two[1];
    const first = two[0];
    if (first === undefined || second === undefined) throw new Error("Missing two pending items");
    await session.respondSubagentPermission(second.childSessionId, second.requestId, {
      decision: "allow",
    });
    expect(view.pendingSubagentPermissions.map((x) => x.requestId)).toEqual([first.requestId]);
    expect(view.pendingPermission).toBeDefined();

    // 再回应父自身与第 1 个 child
    const parentPending = view.pendingPermission;
    if (parentPending === undefined) throw new Error("Missing parentPending");
    await session.respondPermission(parentPending.requestId, { decision: "allow" });
    await pTurn;
    await session.respondSubagentPermission(first.childSessionId, first.requestId, {
      decision: "allow",
    });
    await waitFor(() => view.pendingSubagentPermissions.length === 0);
    await session.close();
  });

  it("父 interrupt 结算等待中的后台 child 且不误取消无等待的后台 child；cancelSubagent 与 close 均结算", async () => {
    const ws = makeTmp("nct-sp-life-");
    const outsideDir = makeTmp("nct-sp-life-out-");
    const sessionsDir = makeTmp("nct-sp-life-s-");
    const secretFile = path.join(outsideDir, "wait.txt");
    writeFileSync(secretFile, "secret");

    const allowNonWaiting = deferred<undefined>();

    const provider = new FakeProvider({
      handler: async (req) => {
        if (isChildRequest(req)) {
          const isWaiting = msgText(req).includes("alpha-wait-task");
          if (isWaiting) {
            const toolMsg = req.messages.find((m) => m.role === "tool");
            return toolMsg
              ? [
                  {
                    type: "tool_call",
                    toolCallId: "cf-w",
                    name: "finish",
                    input: { result: "waiting-finished" },
                  },
                  { type: "finish", reason: "tool_calls" },
                ]
              : [
                  {
                    type: "tool_call",
                    toolCallId: "cw-read",
                    name: "read",
                    input: { path: secretFile },
                  },
                  { type: "finish", reason: "tool_calls" },
                ];
          }
          await allowNonWaiting.promise;
          return [
            {
              type: "tool_call",
              toolCallId: "cf-nw",
              name: "finish",
              input: { result: "non-waiting-ok" },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        if (req.messages.at(-1)?.role === "tool") return doneScript();
        return [
          {
            type: "tool_call",
            toolCallId: "t-wait",
            name: "task",
            input: {
              task: "alpha-wait-task",
              preset: "explore",
              background: true,
              isolation: "none",
            },
          },
          {
            type: "tool_call",
            toolCallId: "t-nowait",
            name: "task",
            input: {
              task: "beta-idle-task",
              preset: "explore",
              background: true,
              isolation: "none",
            },
          },
          { type: "finish", reason: "tool_calls" },
        ];
      },
    });

    const runtime = await createRuntime({
      cwd: ws,
      sessionsDir,
      providers: [provider],
      interactive: true,
      subagent: { background: true, maxBackground: 3, maxConcurrent: 4 },
      policy: createRulePolicy({
        workspaceRoot: ws,
        caseSensitive: true,
        preset: "default",
        rules: [{ rule: { kind: "subagent", pattern: "*", action: "allow" }, origin: "user" }],
      }),
    });
    const session = await runtime.createSession({ model: "fake/fake-model" });
    const { view } = attachView(session);

    await session.submit({ text: "launch waiting + non-waiting" });
    const waitingReq = await waitFor(() =>
      view.pendingSubagentPermissions.length === 1 ? view.pendingSubagentPermissions[0] : false,
    );
    const subs = await runtime.listSubagents({ parentSessionId: session.id });
    const waitingSub = subs.find((s) => s.childSessionId === waitingReq.childSessionId);
    const nonWaitingSub = subs.find((s) => s.childSessionId !== waitingReq.childSessionId);
    if (waitingSub === undefined || nonWaitingSub === undefined) {
      throw new Error("Missing expected subagents");
    }
    const childAskLogPath = path.join(sessionsDir, `${waitingSub.childSessionId}.jsonl`);

    // 父空闲时调用 interrupt：仅取消正在等待的 waitingSub，且保留 nonWaitingSub 继续运行
    session.interrupt();
    await waitFor(() => view.pendingSubagentPermissions.length === 0);
    await waitFor(() => readFileSync(childAskLogPath, "utf8").includes('"source":"cancelled"'));

    // 迟到的回应必须被拒绝
    await expect(
      session.respondSubagentPermission(waitingReq.childSessionId, waitingReq.requestId, {
        decision: "allow",
      }),
    ).rejects.toMatchObject({ code: "unknown_request" });
    expect(readFileSync(childAskLogPath, "utf8")).not.toContain('"type":"tool.started"');

    // 确认无等待的后台仍在运行，放行后可正常完成
    const midSubs = await runtime.listSubagents({ parentSessionId: session.id });
    expect(midSubs.find((s) => s.childSessionId === nonWaitingSub.childSessionId)?.state).toBe(
      "running",
    );
    allowNonWaiting.resolve(undefined);
    const nonWaitingLogPath = path.join(sessionsDir, `${nonWaitingSub.childSessionId}.jsonl`);
    await waitFor(() => readFileSync(nonWaitingLogPath, "utf8").includes("non-waiting-ok"));

    await session.close();
  });

  it("project.add 延迟写盘期间并发 interrupt 竞态：迟到写盘完成后不执行操作、不加 session Grant、不复活 pending", async () => {
    const ws = makeTmp("nct-sp-race-");
    const sessionsDir = makeTmp("nct-sp-race-s-");
    const targetFile = path.join(ws, "race.txt");
    writeFileSync(targetFile, "safe");

    const addStarted = deferred();
    const releaseAdd = deferred();
    const savedProjectGrants: Grant[] = [];

    const provider = new FakeProvider({
      handler: (req) => {
        if (isChildRequest(req)) {
          const toolMsg = req.messages.find((m) => m.role === "tool");
          return toolMsg
            ? [
                { type: "tool_call", toolCallId: "cf", name: "finish", input: { result: "done" } },
                { type: "finish", reason: "tool_calls" },
              ]
            : [
                {
                  type: "tool_call",
                  toolCallId: "ce-race",
                  name: "write",
                  input: { path: targetFile, content: "unsafe" },
                },
                { type: "finish", reason: "tool_calls" },
              ];
        }
        return req.messages.at(-1)?.role === "tool"
          ? doneScript()
          : [
              {
                type: "tool_call",
                toolCallId: "t-race",
                name: "task",
                input: { task: "race test" },
              },
              { type: "finish", reason: "tool_calls" },
            ];
      },
    });

    const basePlatform = {
      ...createPlatform(),
      homeDir: () => ws,
      nocturneHome: () => sessionsDir,
      env: () => undefined,
    };
    writeFileSync(
      path.join(sessionsDir, "config.json"),
      JSON.stringify({ modelsDev: false, skills: { sources: { agents: false, claude: false } } }),
    );
    const baseConfig = await loadConfig(basePlatform, {
      nocturneHome: sessionsDir,
      env: () => undefined,
    });
    const wrappedConfig: RuntimeConfig = {
      ...baseConfig,
      async forWorkspace(workspaceRoot) {
        const wsCfg = await baseConfig.forWorkspace(workspaceRoot);
        return {
          ...wsCfg,
          grants: {
            ...wsCfg.grants,
            list: () => savedProjectGrants,
            async add(grant) {
              addStarted.resolve(undefined);
              await releaseAdd.promise;
              savedProjectGrants.push(grant);
            },
          },
        };
      },
    };
    const runtime = await createRuntime({
      cwd: ws,
      sessionsDir,
      config: wrappedConfig,
      providers: [provider],
      interactive: true,
      policy: createRulePolicy({
        workspaceRoot: ws,
        caseSensitive: true,
        preset: "default",
        rules: [{ rule: { kind: "subagent", pattern: "*", action: "allow" }, origin: "user" }],
      }),
    });
    const session = await runtime.createSession({ model: "fake/fake-model" });
    const { view } = attachView(session);

    const submitP = session.submit({ text: "go race" });
    const pending = await waitFor(() =>
      view.pendingSubagentPermissions.length === 1 ? view.pendingSubagentPermissions[0] : false,
    );

    const respondP = session.respondSubagentPermission(pending.childSessionId, pending.requestId, {
      decision: "allow",
      remember: "project",
    });
    await addStarted.promise;

    // 写盘尚未完成时父中断
    session.interrupt();
    await waitFor(() => view.pendingSubagentPermissions.length === 0);

    // 释放延迟写盘
    releaseAdd.resolve(undefined);
    await expect(respondP).rejects.toMatchObject({ code: "unknown_request" });
    await submitP;

    expect(view.pendingSubagentPermissions).toEqual([]);
    expect(await session.listGrants()).toEqual([]);
    expect(readFileSync(targetFile, "utf8")).toBe("safe");
    await session.close();
  });

  it("cancelSubagent 与父 close 均清理 pendingSubagentPermissions 并结算 child", async () => {
    const ws = makeTmp("nct-sp-cc-");
    const outsideDir = makeTmp("nct-sp-cc-out-");
    const sessionsDir = makeTmp("nct-sp-cc-s-");
    const outsideFile = path.join(outsideDir, "x.txt");
    writeFileSync(outsideFile, "x");

    const provider = new FakeProvider({
      handler: (req) => {
        if (isChildRequest(req)) {
          return [
            {
              type: "tool_call",
              toolCallId: "ce-cc",
              name: "read",
              input: { path: outsideFile },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return req.messages.at(-1)?.role === "tool"
          ? doneScript()
          : [
              {
                type: "tool_call",
                toolCallId: "t-cc",
                name: "task",
                input: {
                  task: "bg cancel/close",
                  preset: "explore",
                  background: true,
                  isolation: "none",
                },
              },
              { type: "finish", reason: "tool_calls" },
            ];
      },
    });

    const runtime = await createRuntime({
      cwd: ws,
      sessionsDir,
      providers: [provider],
      interactive: true,
      subagent: { background: true, maxBackground: 3, maxConcurrent: 4 },
      policy: createRulePolicy({
        workspaceRoot: ws,
        caseSensitive: true,
        preset: "default",
        rules: [{ rule: { kind: "subagent", pattern: "*", action: "allow" }, origin: "user" }],
      }),
    });

    // 1) cancelSubagent 清理
    const s1 = await runtime.createSession({ model: "fake/fake-model" });
    const { view: v1 } = attachView(s1);
    await s1.submit({ text: "bg1" });
    const p1 = await waitFor(() =>
      v1.pendingSubagentPermissions.length === 1 ? v1.pendingSubagentPermissions[0] : false,
    );
    await runtime.cancelSubagent({ parentSessionId: s1.id, childSessionId: p1.childSessionId });
    await waitFor(() => v1.pendingSubagentPermissions.length === 0);
    await s1.close();

    // 2) parent.close() 清理
    const s2 = await runtime.createSession({ model: "fake/fake-model" });
    const { view: v2 } = attachView(s2);
    await s2.submit({ text: "bg2" });
    await waitFor(() => v2.pendingSubagentPermissions.length === 1);
    await s2.close();
    expect(v2.pendingSubagentPermissions).toEqual([]);
  });

  it("非交互 / --yes / ACP 不回归", async () => {
    const ws = makeTmp("nct-sp-nr-");
    const sessionsDir = makeTmp("nct-sp-nr-s-");
    writeFileSync(path.join(ws, "a.txt"), "0");

    // 1) ACP 外部代理仍非交互 deny
    const decisions: ExternalAgentPermissionDecision[] = [];
    const ext: ExternalAgentConnector = {
      probe: async () => ({ ok: true, durationMs: 0, configOptions: [] }),
      async run(_config, r) {
        decisions.push(await r.requestPermission([{ kind: "shell", target: "*" }]));
        return {
          status: "ok",
          modelContent: "ext-ok",
          output: {
            agent: r.agent,
            transcriptPath: r.transcriptPath,
            stopReason: "end_turn",
            permissionDecisions: { allowed: 0, denied: 1 },
          },
        };
      },
    };
    const extProvider = new FakeProvider({
      scripts: [
        [
          {
            type: "tool_call",
            toolCallId: "t-ext",
            name: "task",
            input: { task: "ext", agent: "ext-agent" },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        doneScript(),
      ],
    });
    const extPlatform = {
      ...createPlatform(),
      homeDir: () => ws,
      nocturneHome: () => sessionsDir,
      env: () => undefined,
    };
    writeFileSync(
      path.join(sessionsDir, "config.json"),
      JSON.stringify({
        modelsDev: false,
        skills: { sources: { agents: false, claude: false } },
        externalAgents: [
          {
            name: "ext-agent",
            command: "fake",
            args: [],
            description: "ext",
            enabled: true,
          },
        ],
      }),
    );
    const extConfig = await loadConfig(extPlatform, {
      nocturneHome: sessionsDir,
      env: () => undefined,
    });
    const rtExt = await createRuntime({
      cwd: ws,
      sessionsDir,
      config: extConfig,
      providers: [extProvider],
      interactive: true,
      externalAgents: ext,
    });
    const sExt = await rtExt.createSession({ model: "fake/fake-model" });
    const { view: vExt } = attachView(sExt);
    sExt.subscribe((e) => {
      if (e.type === "permission.requested") {
        void sExt.respondPermission(e.payload.requestId, { decision: "allow" });
      }
    });
    await sExt.submit({ text: "ext" });
    expect(decisions).toEqual([{ decision: "deny", source: "non_interactive" }]);
    expect(vExt.pendingSubagentPermissions).toEqual([]);
    await sExt.close();

    // 2) autoApproveAsk (--yes) 不进 pendingSubagentPermissions
    const yesTarget = path.join(ws, "b-yes.txt");
    const yesProvider = new FakeProvider({
      handler: (req) => {
        if (isChildRequest(req)) {
          return req.messages.some((m) => m.role === "tool")
            ? [
                { type: "tool_call", toolCallId: "cf", name: "finish", input: { result: "ok" } },
                { type: "finish", reason: "tool_calls" },
              ]
            : [
                {
                  type: "tool_call",
                  toolCallId: "cw",
                  name: "write",
                  input: { path: yesTarget, content: "1" },
                },
                { type: "finish", reason: "tool_calls" },
              ];
        }
        return req.messages.at(-1)?.role === "tool"
          ? doneScript()
          : [
              { type: "tool_call", toolCallId: "t-yes", name: "task", input: { task: "yes" } },
              { type: "finish", reason: "tool_calls" },
            ];
      },
    });
    const rtYes = await createRuntime({
      cwd: ws,
      sessionsDir,
      providers: [yesProvider],
      interactive: true,
      permissions: { autoApproveAsk: true },
      policy: createRulePolicy({
        workspaceRoot: ws,
        caseSensitive: true,
        preset: "default",
        autoApproveAsk: true,
      }),
    });
    const sYes = await rtYes.createSession({ model: "fake/fake-model" });
    const { events: evYes } = attachView(sYes);
    await sYes.submit({ text: "yes" });
    expect(readFileSync(yesTarget, "utf8")).toBe("1");
    expect(evYes.some((e) => e.type === "subagent.permissions")).toBe(false);
    await sYes.close();

    // 3) interactive: false (如 nctrn -p / schedule / unattended) 不转发，仍按 non_interactive 拒绝
    const niTarget = path.join(ws, "c-ni.txt");
    const niProvider = new FakeProvider({
      handler: (req) => {
        if (isChildRequest(req)) {
          return req.messages.some((m) => m.role === "tool")
            ? [
                {
                  type: "tool_call",
                  toolCallId: "cf",
                  name: "finish",
                  input: { result: "denied" },
                },
                { type: "finish", reason: "tool_calls" },
              ]
            : [
                {
                  type: "tool_call",
                  toolCallId: "cw",
                  name: "write",
                  input: { path: niTarget, content: "1" },
                },
                { type: "finish", reason: "tool_calls" },
              ];
        }
        return req.messages.at(-1)?.role === "tool"
          ? doneScript()
          : [
              { type: "tool_call", toolCallId: "t-ni", name: "task", input: { task: "ni" } },
              { type: "finish", reason: "tool_calls" },
            ];
      },
    });
    const rtNi = await createRuntime({
      cwd: ws,
      sessionsDir,
      providers: [niProvider],
      interactive: false,
      policy: createRulePolicy({
        workspaceRoot: ws,
        caseSensitive: true,
        preset: "default",
        rules: [{ rule: { kind: "subagent", pattern: "*", action: "allow" }, origin: "user" }],
      }),
    });
    const sNi = await rtNi.createSession({ model: "fake/fake-model" });
    const { events: evNi } = attachView(sNi);
    await sNi.submit({ text: "ni" });
    expect(existsSync(niTarget)).toBe(false);
    expect(evNi.some((e) => e.type === "subagent.permissions")).toBe(false);
    await sNi.close();
  });

  it("等待结束后恢复剩余超时计时：若放行后 child 仍挂起，显式 timeoutMs 依然触发超时", async () => {
    const ws = makeTmp("nct-sp-to-after-");
    const sessionsDir = makeTmp("nct-sp-to-after-s-");
    const targetFile = path.join(ws, "slow.txt");
    const hangAfterAllow = deferred();

    const provider = new FakeProvider({
      handler: async (req) => {
        if (isChildRequest(req)) {
          const toolMsg = req.messages.find((m) => m.role === "tool");
          if (toolMsg) {
            await hangAfterAllow.promise;
            return [
              { type: "tool_call", toolCallId: "cf", name: "finish", input: { result: "late" } },
              { type: "finish", reason: "tool_calls" },
            ];
          }
          return [
            {
              type: "tool_call",
              toolCallId: "cw",
              name: "write",
              input: { path: targetFile, content: "ok" },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return req.messages.at(-1)?.role === "tool"
          ? doneScript()
          : [
              {
                type: "tool_call",
                toolCallId: "t-hang",
                name: "task",
                input: { task: "hang after allow", timeoutMs: 80 },
              },
              { type: "finish", reason: "tool_calls" },
            ];
      },
    });

    const runtime = await createRuntime({
      cwd: ws,
      sessionsDir,
      providers: [provider],
      interactive: true,
      subagent: { timeoutMs: 80 },
      policy: createRulePolicy({
        workspaceRoot: ws,
        caseSensitive: true,
        preset: "default",
        rules: [{ rule: { kind: "subagent", pattern: "*", action: "allow" }, origin: "user" }],
      }),
    });
    const session = await runtime.createSession({ model: "fake/fake-model" });
    const { view } = attachView(session);
    const submitP = session.submit({ text: "go" });

    const pending = await waitFor(() =>
      view.pendingSubagentPermissions.length === 1 ? view.pendingSubagentPermissions[0] : false,
    );
    // eslint-disable-next-line no-restricted-syntax -- 反向断言：权限等待期间 150ms 内 80ms task 超时不触发
    await new Promise((r) => setTimeout(r, 150));
    expect(view.pendingSubagentPermissions).toHaveLength(1);

    await session.respondSubagentPermission(pending.childSessionId, pending.requestId, {
      decision: "allow",
    });
    await submitP;
    hangAfterAllow.resolve(undefined);

    const completed = session
      .durableEvents()
      .find((e) => e.type === "tool.completed" && e.payload.name === "task");
    expect(
      completed?.type === "tool.completed" && String(completed.payload.modelContent),
    ).toContain("超过 80ms 未完成");
    await session.close();
  });

  it("project allow 写入项目 Grant 并触发 onGrantsChanged；app allow_always 写入 appPermissions；unattended 会话接管前不转发、接管后可转发", async () => {
    const ws = makeTmp("nct-sp-proj-");
    const sessionsDir = makeTmp("nct-sp-proj-s-");
    const targetFile = path.join(ws, "proj.txt");
    const appCalls: { target: string; action: string }[] = [];

    const basePlatform = {
      ...createPlatform(),
      homeDir: () => ws,
      nocturneHome: () => sessionsDir,
      env: () => undefined,
    };
    writeFileSync(
      path.join(sessionsDir, "config.json"),
      JSON.stringify({ modelsDev: false, skills: { sources: { agents: false, claude: false } } }),
    );
    const baseConfig = await loadConfig(basePlatform, {
      nocturneHome: sessionsDir,
      env: () => undefined,
    });
    const wrappedConfig: RuntimeConfig = {
      ...baseConfig,
      appPermissions: {
        list: () => [],
        async set(target, action) {
          appCalls.push({ target, action: action ?? "undefined" });
        },
        subscribe: () => () => undefined,
      },
    };

    const appTool: ToolDefinition = {
      name: "mcp__app__launch",
      description: "launch app",
      inputSchema: { type: "object", properties: {} },
      traits: { mutates: true, concurrencySafe: false, timeoutMs: 10_000 },
      permissionSubjects: () => [{ kind: "app", target: "MyTestApp", app: { name: "MyTestApp" } }],
      resolveSubject: async (req) => req,
      async execute() {
        return { status: "ok", modelContent: "app-launched" };
      },
    };

    let stage: "project" | "app" | "unattended" = "project";
    const provider = new FakeProvider({
      handler: (req) => {
        if (isChildRequest(req)) {
          const toolMsg = req.messages.find((m) => m.role === "tool");
          if (toolMsg) {
            return [
              { type: "tool_call", toolCallId: "cf", name: "finish", input: { result: "ok" } },
              { type: "finish", reason: "tool_calls" },
            ];
          }
          if (stage === "app") {
            return [
              { type: "tool_call", toolCallId: "ca", name: "mcp__app__launch", input: {} },
              { type: "finish", reason: "tool_calls" },
            ];
          }
          return [
            {
              type: "tool_call",
              toolCallId: "cw",
              name: "write",
              input: { path: targetFile, content: "proj-ok" },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return req.messages.at(-1)?.role === "tool"
          ? doneScript()
          : [
              {
                type: "tool_call",
                toolCallId: "t-p",
                name: "task",
                input: { task: "run stage" },
              },
              { type: "finish", reason: "tool_calls" },
            ];
      },
    });

    const runtime = await createRuntime({
      cwd: ws,
      sessionsDir,
      config: wrappedConfig,
      providers: [provider],
      interactive: true,
      mcpServers: [{ name: "app", command: "fake", origin: "user" }],
      mcp: {
        probe: async () => ({ ok: true, durationMs: 0, tools: [] }),
        open: async () => ({
          startup: async () => undefined,
          reconcile: async () => undefined,
          tools: () => [appTool],
          status: () => [],
          applyPendingTools: () => ({ add: [], remove: [] }),
          close: async () => undefined,
        }),
      },
    });

    const grantPayloads: unknown[] = [];
    runtime.onGrantsChanged((p) => grantPayloads.push(p));

    const s1 = await runtime.createSession({ model: "fake/fake-model" });
    s1.subscribe((e) => {
      if (e.type === "permission.requested") {
        void s1.respondPermission(e.payload.requestId, { decision: "allow", remember: "session" });
      } else if (e.type === "subagent.permissions" && e.payload.pending.length > 0) {
        const req = firstOrThrow(e.payload.pending, "pending");
        void s1.respondSubagentPermission(req.childSessionId, req.requestId, {
          decision: "allow",
          remember: stage === "app" ? "always" : "project",
        });
      }
    });

    // 1) project allow 写入 ws.grants 并发出 onGrantsChanged({ workspace })
    await s1.submit({ text: "project stage" });
    expect(readFileSync(targetFile, "utf8")).toBe("proj-ok");
    expect(grantPayloads).toContainEqual({ workspace: ws });

    // 2) app allow_always 写入 wrappedConfig.appPermissions
    stage = "app";
    await s1.submit({ text: "app stage" });
    expect(appCalls).toEqual([{ target: "MyTestApp", action: "allow" }]);
    await s1.close();

    // 3) schedule/unattended 会话接管前（第 1 条用户消息）不转发，按 non_interactive 拒绝；
    //    接管后（第 2 条用户消息）恢复转发
    stage = "unattended";
    const wsUn = makeTmp("nct-sp-un-");
    const unTarget1 = path.join(wsUn, "un1.txt");
    const unTarget2 = path.join(wsUn, "un2.txt");
    let unAttempt = 0;
    const rtUn = await createRuntime({
      cwd: wsUn,
      sessionsDir,
      config: wrappedConfig,
      providers: [
        new FakeProvider({
          handler: (req) => {
            if (isChildRequest(req)) {
              const toolMsg = req.messages.find((m) => m.role === "tool");
              if (toolMsg) {
                return [
                  { type: "tool_call", toolCallId: "cf", name: "finish", input: { result: "ok" } },
                  { type: "finish", reason: "tool_calls" },
                ];
              }
              return [
                {
                  type: "tool_call",
                  toolCallId: "cw",
                  name: "write",
                  input: { path: unAttempt === 1 ? unTarget1 : unTarget2, content: "ok" },
                },
                { type: "finish", reason: "tool_calls" },
              ];
            }
            if (req.messages.at(-1)?.role === "tool") return doneScript();
            unAttempt += 1;
            return [
              { type: "tool_call", toolCallId: "t-u", name: "task", input: { task: "unattended" } },
              { type: "finish", reason: "tool_calls" },
            ];
          },
        }),
      ],
      interactive: true,
      policy: createRulePolicy({
        workspaceRoot: wsUn,
        caseSensitive: true,
        preset: "default",
        rules: [{ rule: { kind: "subagent", pattern: "*", action: "allow" }, origin: "user" }],
      }),
    });
    const s2 = await rtUn.createSession({
      model: "fake/fake-model",
      schedule: {
        taskId: "sched-1",
        scheduledAt: "2026-11-14T00:00:00.000Z",
        trigger: "schedule",
      },
    });
    let forwardedInUn = 0;
    s2.subscribe((e) => {
      if (e.type === "subagent.permissions" && e.payload.pending.length > 0) {
        forwardedInUn += 1;
        const req = firstOrThrow(e.payload.pending, "pending");
        void s2.respondSubagentPermission(req.childSessionId, req.requestId, { decision: "allow" });
      }
    });
    await s2.submit({ text: "first unattended message" });
    expect(forwardedInUn).toBe(0);
    expect(existsSync(unTarget1)).toBe(false);

    await s2.submit({ text: "second user takeover message" });
    expect(forwardedInUn).toBe(1);
    expect(readFileSync(unTarget2, "utf8")).toBe("ok");
    await s2.close();
  });

  it("父快照回调同步回应或同步 interrupt 时，child 挂起期间父 pendingSubagentPermissions 立即清空", async () => {
    const ws = makeTmp("nct-sp-sync-");
    const sessionsDir = makeTmp("nct-sp-sync-s-");
    const targetFile = path.join(ws, "sync.txt");
    const childHeld = deferred();
    const holdReached = deferred();

    const provider = new FakeProvider({
      handler: async (req) => {
        if (isChildRequest(req)) {
          const toolMsg = req.messages.find((m) => m.role === "tool");
          if (toolMsg) {
            holdReached.resolve(undefined);
            await childHeld.promise;
            return [
              { type: "tool_call", toolCallId: "cf", name: "finish", input: { result: "sync-ok" } },
              { type: "finish", reason: "tool_calls" },
            ];
          }
          return [
            {
              type: "tool_call",
              toolCallId: "cw",
              name: "write",
              input: { path: targetFile, content: "sync-val" },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return req.messages.at(-1)?.role === "tool"
          ? doneScript()
          : [
              {
                type: "tool_call",
                toolCallId: "t-sync",
                name: "task",
                input: { task: "sync test" },
              },
              { type: "finish", reason: "tool_calls" },
            ];
      },
    });

    const runtime = await createRuntime({
      cwd: ws,
      sessionsDir,
      providers: [provider],
      interactive: true,
      policy: createRulePolicy({
        workspaceRoot: ws,
        caseSensitive: true,
        preset: "default",
        rules: [{ rule: { kind: "subagent", pattern: "*", action: "allow" }, origin: "user" }],
      }),
    });

    const session = await runtime.createSession({ model: "fake/fake-model" });
    const { view } = attachView(session);
    // 在 subscribe 回调里同步发起 respondSubagentPermission（gate.respond 在首个 await 前同步 settle）
    session.subscribe((e) => {
      if (e.type === "subagent.permissions" && e.payload.pending.length > 0) {
        const req = firstOrThrow(e.payload.pending, "pending");
        void session.respondSubagentPermission(req.childSessionId, req.requestId, {
          decision: "allow",
        });
      }
    });

    const submitP = session.submit({ text: "sync respond" });
    await holdReached.promise;
    // child 仍被挂起在 finish 前，父视图必须已同步清零，不能残留旧请求
    expect(view.pendingSubagentPermissions).toEqual([]);
    childHeld.resolve(undefined);
    await submitP;
    expect(readFileSync(targetFile, "utf8")).toBe("sync-val");
    await session.close();
  });

  it("executor 真实超时暂停跨越 1080ms 兜底阈值：input.timeoutMs=80 等待 1300ms 后仍未超时且放行完成", async () => {
    const ws = makeTmp("nct-sp-exec-to-");
    const sessionsDir = makeTmp("nct-sp-exec-to-s-");
    const targetFile = path.join(ws, "exec-to.txt");

    const provider = new FakeProvider({
      handler: (req) => {
        if (isChildRequest(req)) {
          const toolMsg = req.messages.find((m) => m.role === "tool");
          if (toolMsg) {
            return [
              { type: "tool_call", toolCallId: "cf", name: "finish", input: { result: "ok" } },
              { type: "finish", reason: "tool_calls" },
            ];
          }
          return [
            {
              type: "tool_call",
              toolCallId: "cw",
              name: "write",
              input: { path: targetFile, content: "after-1300ms" },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return req.messages.at(-1)?.role === "tool"
          ? doneScript()
          : [
              {
                type: "tool_call",
                toolCallId: "t-exec",
                name: "task",
                input: { task: "cross executor grace", timeoutMs: 80 },
              },
              { type: "finish", reason: "tool_calls" },
            ];
      },
    });

    const runtime = await createRuntime({
      cwd: ws,
      sessionsDir,
      providers: [provider],
      interactive: true,
      subagent: { timeoutMs: 5000 },
      policy: createRulePolicy({
        workspaceRoot: ws,
        caseSensitive: true,
        preset: "default",
        rules: [{ rule: { kind: "subagent", pattern: "*", action: "allow" }, origin: "user" }],
      }),
    });

    const session = await runtime.createSession({ model: "fake/fake-model" });
    const { view } = attachView(session);
    const submitP = session.submit({ text: "go" });

    const pending = await waitFor(() =>
      view.pendingSubagentPermissions.length === 1 ? view.pendingSubagentPermissions[0] : false,
    );
    // 超过 task input.timeoutMs (80ms) + EXECUTOR_TIMEOUT_GRACE_MS (1000ms) = 1080ms
    // eslint-disable-next-line no-restricted-syntax -- 反向断言：权限等待期间 1300ms 内 80ms 超时与 1000ms 宽限均不触发
    await new Promise((r) => setTimeout(r, 1300));
    expect(view.pendingSubagentPermissions).toHaveLength(1);

    await session.respondSubagentPermission(pending.childSessionId, pending.requestId, {
      decision: "allow",
    });
    await submitP;
    expect(readFileSync(targetFile, "utf8")).toBe("after-1300ms");
    await session.close();
  }, 10_000);

  it("profile.timeoutMs 与 runtime.subagent.timeoutMs fallback 均排除等待时间且放行后仍生效", async () => {
    const ws = makeTmp("nct-sp-fb-to-");
    const sessionsDir = makeTmp("nct-sp-fb-to-s-");
    const basePlatform = {
      ...createPlatform(),
      homeDir: () => ws,
      nocturneHome: () => sessionsDir,
      env: () => undefined,
    };
    writeFileSync(
      path.join(sessionsDir, "config.json"),
      JSON.stringify({
        modelsDev: false,
        skills: { sources: { agents: false, claude: false } },
        subagents: {
          profiles: {
            short: { description: "短超时", enabled: true, timeoutMs: 80 },
          },
        },
      }),
    );
    const config = await loadConfig(basePlatform, {
      nocturneHome: sessionsDir,
      env: () => undefined,
    });

    // 1) 省略 request.timeoutMs，走 profile.timeoutMs = 80（runtime 给 5000 验证走的是 profile 层）
    const profileFile = path.join(ws, "profile-fb.txt");
    let hangProfileAfterAllow = false;
    const holdProfile = deferred();
    const providerProfile = new FakeProvider({
      handler: async (req) => {
        if (isChildRequest(req)) {
          const toolMsg = req.messages.find((m) => m.role === "tool");
          if (toolMsg) {
            if (hangProfileAfterAllow) await holdProfile.promise;
            return [
              { type: "tool_call", toolCallId: "cf", name: "finish", input: { result: "p-ok" } },
              { type: "finish", reason: "tool_calls" },
            ];
          }
          return [
            {
              type: "tool_call",
              toolCallId: "cw",
              name: "write",
              input: {
                path: hangProfileAfterAllow ? path.join(ws, "p-hang.txt") : profileFile,
                content: "profile-ok",
              },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return req.messages.at(-1)?.role === "tool"
          ? doneScript()
          : [
              {
                type: "tool_call",
                toolCallId: "t-prof",
                name: "task",
                // 不传 request.timeoutMs，强制走 profile.timeoutMs=80
                input: { task: "profile fallback", profile: "short" },
              },
              { type: "finish", reason: "tool_calls" },
            ];
      },
    });
    const rtProfile = await createRuntime({
      cwd: ws,
      sessionsDir,
      config,
      providers: [providerProfile],
      interactive: true,
      subagent: { timeoutMs: 5000 },
      policy: createRulePolicy({
        workspaceRoot: ws,
        caseSensitive: true,
        preset: "default",
        rules: [{ rule: { kind: "subagent", pattern: "*", action: "allow" }, origin: "user" }],
      }),
    });
    const sProf = await rtProfile.createSession({ model: "fake/fake-model" });
    const { view: vProf } = attachView(sProf);
    const p1 = sProf.submit({ text: "profile wait" });
    const pend1 = await waitFor(() =>
      vProf.pendingSubagentPermissions.length === 1 ? vProf.pendingSubagentPermissions[0] : false,
    );
    // eslint-disable-next-line no-restricted-syntax -- 反向断言：权限等待期间 200ms 内 80ms 超时不触发
    await new Promise((r) => setTimeout(r, 200));
    expect(vProf.pendingSubagentPermissions).toHaveLength(1);
    await sProf.respondSubagentPermission(pend1.childSessionId, pend1.requestId, {
      decision: "allow",
    });
    await p1;
    expect(readFileSync(profileFile, "utf8")).toBe("profile-ok");

    // 放行后挂起，证明 profile=80ms 确实仍在生效（未等到 runtime=5000ms）
    hangProfileAfterAllow = true;
    const p2 = sProf.submit({ text: "profile hang" });
    const pend2 = await waitFor(() =>
      vProf.pendingSubagentPermissions.length === 1 ? vProf.pendingSubagentPermissions[0] : false,
    );
    await sProf.respondSubagentPermission(pend2.childSessionId, pend2.requestId, {
      decision: "allow",
    });
    await p2;
    holdProfile.resolve(undefined);
    const profComp = sProf
      .durableEvents()
      .filter((e) => e.type === "tool.completed" && e.payload.name === "task")
      .at(-1);
    expect(profComp?.type === "tool.completed" && String(profComp.payload.modelContent)).toContain(
      "超过 80ms 未完成",
    );
    await sProf.close();

    // 2) 省略 request.timeoutMs 与 profile，走 runtime.subagent.timeoutMs = 80
    const runtimeFile = path.join(ws, "runtime-fb.txt");
    let hangRuntimeAfterAllow = false;
    const holdRuntime = deferred();
    const providerRuntime = new FakeProvider({
      handler: async (req) => {
        if (isChildRequest(req)) {
          const toolMsg = req.messages.find((m) => m.role === "tool");
          if (toolMsg) {
            if (hangRuntimeAfterAllow) await holdRuntime.promise;
            return [
              { type: "tool_call", toolCallId: "cf", name: "finish", input: { result: "r-ok" } },
              { type: "finish", reason: "tool_calls" },
            ];
          }
          return [
            {
              type: "tool_call",
              toolCallId: "cw",
              name: "write",
              input: {
                path: hangRuntimeAfterAllow ? path.join(ws, "r-hang.txt") : runtimeFile,
                content: "runtime-ok",
              },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return req.messages.at(-1)?.role === "tool"
          ? doneScript()
          : [
              {
                type: "tool_call",
                toolCallId: "t-rt",
                name: "task",
                // 不传 request.timeoutMs 与 profile，强制走 runtime.subagent.timeoutMs=80
                input: { task: "runtime fallback" },
              },
              { type: "finish", reason: "tool_calls" },
            ];
      },
    });
    const rtRuntime = await createRuntime({
      cwd: ws,
      sessionsDir,
      providers: [providerRuntime],
      interactive: true,
      subagent: { timeoutMs: 80 },
      policy: createRulePolicy({
        workspaceRoot: ws,
        caseSensitive: true,
        preset: "default",
        rules: [{ rule: { kind: "subagent", pattern: "*", action: "allow" }, origin: "user" }],
      }),
    });
    const sRt = await rtRuntime.createSession({ model: "fake/fake-model" });
    const { view: vRt } = attachView(sRt);
    const r1 = sRt.submit({ text: "runtime wait" });
    const rPend1 = await waitFor(() =>
      vRt.pendingSubagentPermissions.length === 1 ? vRt.pendingSubagentPermissions[0] : false,
    );
    // eslint-disable-next-line no-restricted-syntax -- 反向断言：权限等待期间 200ms 内 80ms 超时不触发
    await new Promise((r) => setTimeout(r, 200));
    expect(vRt.pendingSubagentPermissions).toHaveLength(1);
    await sRt.respondSubagentPermission(rPend1.childSessionId, rPend1.requestId, {
      decision: "allow",
    });
    await r1;
    expect(readFileSync(runtimeFile, "utf8")).toBe("runtime-ok");

    hangRuntimeAfterAllow = true;
    const r2 = sRt.submit({ text: "runtime hang" });
    const rPend2 = await waitFor(() =>
      vRt.pendingSubagentPermissions.length === 1 ? vRt.pendingSubagentPermissions[0] : false,
    );
    await sRt.respondSubagentPermission(rPend2.childSessionId, rPend2.requestId, {
      decision: "allow",
    });
    await r2;
    holdRuntime.resolve(undefined);
    const rtComp = sRt
      .durableEvents()
      .filter((e) => e.type === "tool.completed" && e.payload.name === "task")
      .at(-1);
    expect(rtComp?.type === "tool.completed" && String(rtComp.payload.modelContent)).toContain(
      "超过 80ms 未完成",
    );
    await sRt.close();
  });

  it("task/web_fetch 工具描述、boost 提示词与交互/非交互子提示词准确区分交互转发与非交互拒绝", async () => {
    const ws = makeTmp("nct-sp-desc-");
    const sessionsDir = makeTmp("nct-sp-desc-s-");
    const basePlatform = {
      ...createPlatform(),
      homeDir: () => ws,
      nocturneHome: () => sessionsDir,
      env: () => undefined,
    };
    writeFileSync(
      path.join(sessionsDir, "config.json"),
      JSON.stringify({
        modelsDev: false,
        skills: { sources: { agents: false, claude: false } },
        externalAgents: [
          {
            name: "ext-acp",
            command: "fake",
            args: [],
            description: "ext",
            enabled: true,
          },
        ],
      }),
    );
    const config = await loadConfig(basePlatform, {
      nocturneHome: sessionsDir,
      env: () => undefined,
    });

    const capture = (interactive: boolean) => {
      const seen: { isChild: boolean; systemPrompt: string; taskDesc: string; wfDesc: string }[] =
        [];
      const provider = new FakeProvider({
        handler: (req) => {
          const taskTool = req.tools.find((t) => t.name === "task");
          const wfTool = req.tools.find((t) => t.name === "web_fetch");
          seen.push({
            isChild: isChildRequest(req),
            systemPrompt: req.system.map((b) => b.text).join("\n"),
            taskDesc: taskTool?.description ?? "",
            wfDesc: wfTool?.description ?? "",
          });
          if (isChildRequest(req)) {
            return [
              { type: "tool_call", toolCallId: "cf", name: "finish", input: { result: "ok" } },
              { type: "finish", reason: "tool_calls" },
            ];
          }
          return req.messages.at(-1)?.role === "tool"
            ? doneScript()
            : [
                {
                  type: "tool_call",
                  toolCallId: "t-d",
                  name: "task",
                  input: { task: "check prompt" },
                },
                { type: "finish", reason: "tool_calls" },
              ];
        },
      });
      return { seen, provider, interactive };
    };

    const intCap = capture(true);
    const rtInt = await createRuntime({
      cwd: ws,
      sessionsDir,
      config,
      providers: [intCap.provider],
      interactive: true,
      externalAgents: {
        probe: async () => ({ ok: true, durationMs: 0, configOptions: [] }),
        run: async () => ({ status: "ok", modelContent: "ok" }),
      },
      policy: createRulePolicy({
        workspaceRoot: ws,
        caseSensitive: true,
        preset: "default",
        rules: [{ rule: { kind: "subagent", pattern: "*", action: "allow" }, origin: "user" }],
      }),
    });
    const sInt = await rtInt.createSession({ model: "fake/fake-model" });
    await sInt.submit({ text: "check interactive" });
    await sInt.close();

    const parentEntry = intCap.seen.find((p) => !p.isChild);
    const childInt = intCap.seen.find((p) => p.isChild);
    expect(parentEntry?.taskDesc).toContain("在交互会话下转给用户确认");
    expect(parentEntry?.taskDesc).toContain("在非交互会话（定时任务、-p）下被拒绝");
    expect(parentEntry?.taskDesc).toContain("执行期权限请求经过非交互判定，剩余询问会被拒绝");
    expect(parentEntry?.taskDesc).not.toContain("子会话是非交互的");
    expect(parentEntry?.wfDesc).toContain("在交互会话下转给用户确认");
    expect(parentEntry?.wfDesc).not.toContain("非交互子会话不能确认访问");
    expect(childInt?.systemPrompt).toContain("经父会话转发给用户确认");
    expect(childInt?.systemPrompt).not.toContain("需要确认的操作会被直接拒绝");

    const niCap = capture(false);
    const rtNi = await createRuntime({
      cwd: ws,
      sessionsDir,
      providers: [niCap.provider],
      interactive: false,
      policy: createRulePolicy({
        workspaceRoot: ws,
        caseSensitive: true,
        preset: "default",
        rules: [{ rule: { kind: "subagent", pattern: "*", action: "allow" }, origin: "user" }],
      }),
    });
    const sNi = await rtNi.createSession({ model: "fake/fake-model" });
    await sNi.submit({ text: "check non-interactive" });
    await sNi.close();
    const childNi = niCap.seen.find((p) => p.isChild);
    expect(childNi?.systemPrompt).toContain("需要确认的操作会被直接拒绝");

    const boost = workModeBody("boost", { gitRepository: true, maxBackground: 3 });
    expect(boost).toContain("forward permission requests to the user for confirmation");
    expect(boost).toContain("In non-interactive sessions");
    expect(boost).not.toContain(
      "Subagents are non-interactive and cannot ask the user for approval",
    );
  });
});
