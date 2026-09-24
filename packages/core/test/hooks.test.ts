/**
 * HookRunner 与执行管线集成测试（hooks.md）：
 * 用 `node -e` 内联脚本做 Hook 命令，全程离线。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createDefaultPolicy,
  createWorkspaceReadPolicy,
  grantFromSubject,
} from "../src/permission/index.js";
import { createPlatform, type Platform } from "../src/platform/index.js";
import type { HookEntry, HookPoint, PermissionSubject } from "../src/protocol/index.js";
import {
  createPolicyGate,
  createReadStateStore,
  createToolExecutor,
  createToolRegistry,
  builtinTools,
  type ExecutionScope,
} from "../src/tools/index.js";
import { createHookRunner } from "../src/hooks/index.js";

const platform: Platform = createPlatform();
const tmpRoots: string[] = [];

afterEach(() => {
  for (const r of tmpRoots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "nct-hooks-"));
  tmpRoots.push(dir);
  return dir;
}

/** 读 stdin JSON 后把表达式结果写回 stdout 的 node 脚本 */
function echoScript(expr: string): string[] {
  return [
    "-e",
    `let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const i=JSON.parse(s);process.stdout.write(JSON.stringify((${expr})(i)))})`,
  ];
}

function runner(
  ws: string,
  hooks: Partial<Record<HookPoint, HookEntry[]>>,
  warnings: { code: string; message: string }[] = [],
) {
  return createHookRunner({
    hooks,
    platform,
    sessionId: "s1",
    cwd: ws,
    workspaceRoot: ws,
    warn: (code, message) => warnings.push({ code, message }),
  });
}

describe("HookRunner 契约", () => {
  it("PreToolUse deny 短路且携带 reason", async () => {
    const ws = tmp();
    const r = runner(ws, {
      PreToolUse: [
        { command: "node", args: echoScript(`() => ({decision:"deny",reason:"不许"})`) },
      ],
    });
    const out = await r.run("PreToolUse", { tool: "shell", input: {} });
    expect(out).toEqual({ decision: "deny", reason: "不许" });
  });

  it("PreToolUse updatedInput 链式传递给后续条目", async () => {
    const ws = tmp();
    const r = runner(ws, {
      PreToolUse: [
        {
          command: "node",
          args: echoScript(`() => ({updatedInput:{step:1}})`),
        },
        {
          command: "node",
          args: [
            "-e",
            `let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const i=JSON.parse(s);require("fs").writeFileSync(${JSON.stringify(
              path.join(ws, "seen.json"),
            )},JSON.stringify(i.input));process.stdout.write("{}")})`,
          ],
        },
      ],
    });
    const out = await r.run("PreToolUse", { tool: "shell", input: { step: 0 } });
    expect(out?.updatedInput).toEqual({ step: 1 });
    const { readFileSync } = await import("node:fs");
    expect(JSON.parse(readFileSync(path.join(ws, "seen.json"), "utf8"))).toEqual({ step: 1 });
  });

  it("PreToolUse ask 与 updatedInput 可合并返回", async () => {
    const ws = tmp();
    const r = runner(ws, {
      PreToolUse: [
        { command: "node", args: echoScript(`() => ({decision:"ask",reason:"看一眼"})`) },
        { command: "node", args: echoScript(`() => ({updatedInput:{x:2}})`) },
      ],
    });
    const out = await r.run("PreToolUse", { tool: "shell", input: { x: 1 } });
    expect(out).toEqual({ decision: "ask", reason: "看一眼", updatedInput: { x: 2 } });
  });

  it("matcher 不匹配时条目不执行", async () => {
    const ws = tmp();
    const warnings: { code: string; message: string }[] = [];
    const r = runner(ws, {
      PreToolUse: [
        {
          matcher: "shell|mcp_*",
          command: "node",
          args: echoScript(`() => ({decision:"deny"})`),
        },
      ],
    }, warnings);
    expect(await r.run("PreToolUse", { tool: "read", input: {} })).toBeUndefined();
    expect(await r.run("PreToolUse", { tool: "shell", input: {} })).toEqual({
      decision: "deny",
      reason: undefined,
    });
  });

  it("PermissionRequest：首个给出 action 的条目结算", async () => {
    const ws = tmp();
    const r = runner(ws, {
      PermissionRequest: [
        { command: "node", args: echoScript(`() => ({})`) },
        {
          command: "node",
          args: echoScript(`() => ({action:"allow",reason:"CI 放行"})`),
        },
      ],
    });
    const out = await r.run("PermissionRequest", { tool: "shell", input: {} });
    expect(out).toEqual({ action: "allow", reason: "CI 放行" });
  });

  it("PostToolUse：多条目 feedback 追加合并", async () => {
    const ws = tmp();
    const r = runner(ws, {
      PostToolUse: [
        { command: "node", args: echoScript(`() => ({feedback:"第一条"})`) },
        { command: "node", args: echoScript(`() => ({feedback:"第二条"})`) },
      ],
    });
    const out = await r.run("PostToolUse", { tool: "read", input: {} });
    expect(out?.feedback).toBe("第一条\n第二条");
  });

  it("TurnStart block 短路", async () => {
    const ws = tmp();
    const r = runner(ws, {
      TurnStart: [
        { command: "node", args: echoScript(`() => ({block:true,reason:"维护中"})`) },
      ],
    });
    const out = await r.run("TurnStart", { text: "hi" });
    expect(out).toEqual({ block: true, reason: "维护中" });
  });

  it("stdin 注入公共字段与 NOCTURNE_* 环境变量", async () => {
    const ws = tmp();
    const outFile = path.join(ws, "payload.json");
    const r = runner(ws, {
      SessionStart: [
        {
          command: "node",
          args: [
            "-e",
            `let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{require("fs").writeFileSync(${JSON.stringify(
              outFile,
            )},JSON.stringify({i:JSON.parse(s),ev:process.env.NOCTURNE_HOOK_EVENT,sid:process.env.NOCTURNE_SESSION_ID}))})`,
          ],
        },
      ],
    });
    await r.run("SessionStart", { resumed: true });
    const { readFileSync } = await import("node:fs");
    const got = JSON.parse(readFileSync(outFile, "utf8")) as {
      i: Record<string, unknown>;
      ev: string;
      sid: string;
    };
    expect(got.i.point).toBe("SessionStart");
    expect(got.i.sessionId).toBe("s1");
    expect(got.i.resumed).toBe(true);
    expect(got.ev).toBe("SessionStart");
    expect(got.sid).toBe("s1");
  });

  it("非零退出 / 非法 JSON / 命令不存在 → 无效果 + hook_failed 警告", async () => {
    const ws = tmp();
    const warnings: { code: string; message: string }[] = [];
    const r = runner(
      ws,
      {
        PreToolUse: [
          { command: "node", args: ["-e", "process.exit(3)"] },
          { command: "node", args: ["-e", "process.stdout.write('not json')"] },
          { command: "definitely-not-a-command-nct" },
        ],
      },
      warnings,
    );
    const out = await r.run("PreToolUse", { tool: "shell", input: {} });
    expect(out).toBeUndefined();
    expect(warnings).toHaveLength(3);
    expect(warnings.every((w) => w.code === "hook_failed")).toBe(true);
  });

  it("超时：timeoutMs 到点记失败", async () => {
    const ws = tmp();
    const warnings: { code: string; message: string }[] = [];
    const r = runner(
      ws,
      {
        PreToolUse: [
          { command: "node", args: ["-e", "setTimeout(()=>{},30000)"], timeoutMs: 300 },
        ],
      },
      warnings,
    );
    const out = await r.run("PreToolUse", { tool: "shell", input: {} });
    expect(out).toBeUndefined();
    expect(warnings.some((w) => w.message.includes("超时"))).toBe(true);
  });
});

describe("执行管线集成", () => {
  async function harness(ws: string, hooks?: ReturnType<typeof createHookRunner>) {
    const workspaceRoot = await platform.resolveReal(ws);
    const policy = createWorkspaceReadPolicy({
      workspaceRoot,
      caseSensitive: platform.caseSensitivePaths,
    });
    const events: { type: string; payload: Record<string, unknown> }[] = [];
    const scope: ExecutionScope = {
      cwd: ws,
      workspaceRoot,
      paths: platform.paths,
      sessionId: "s1",
      turnId: "turn-1",
      signal: new AbortController().signal,
      platform,
      gate: createPolicyGate(policy),
      readState: createReadStateStore(platform.paths),
      hooks,
      events: {
        emit: (type, payload) => {
          events.push({ type, payload: payload as unknown as Record<string, unknown> });
          return Promise.resolve();
        },
        emitEphemeral: (type, payload) => {
          events.push({ type, payload: payload as unknown as Record<string, unknown> });
        },
      },
    };
    const registry = createToolRegistry();
    for (const t of builtinTools()) registry.register(t);
    return { scope, events, executor: createToolExecutor(registry) };
  }

  it("PreToolUse deny → denied + permission.resolved(source:hook)", async () => {
    const ws = tmp();
    const warnings: { code: string; message: string }[] = [];
    const h = await harness(
      ws,
      runner(ws, {
        PreToolUse: [{ command: "node", args: echoScript(`() => ({decision:"deny"})`) }],
      }, warnings),
    );
    const r = await h.executor.execute(
      { callId: "c1", name: "shell", input: { command: "echo hi" } },
      h.scope,
    );
    expect(r.status).toBe("denied");
    const resolved = h.events.find((e) => e.type === "permission.resolved");
    expect(resolved?.payload.source).toBe("hook");
  });

  it("PreToolUse updatedInput → 重新校验并按新输入执行", async () => {
    const ws = tmp();
    await platform.fs.writeFile(path.join(ws, "real.txt"), "真实内容");
    const h = await harness(
      ws,
      runner(ws, {
        PreToolUse: [
          { command: "node", args: echoScript(`() => ({updatedInput:{path:"real.txt"}})`) },
        ],
      }),
    );
    const r = await h.executor.execute(
      { callId: "c1", name: "read", input: { path: "missing.txt" } },
      h.scope,
    );
    expect(r.status).toBe("ok");
    expect(r.result.modelContent).toContain("真实内容");
  });

  it("PreToolUse updatedInput 不合法 → invalid_input", async () => {
    const ws = tmp();
    const h = await harness(
      ws,
      runner(ws, {
        PreToolUse: [
          { command: "node", args: echoScript(`() => ({updatedInput:{path:42}})`) },
        ],
      }),
    );
    const r = await h.executor.execute(
      { callId: "c1", name: "read", input: { path: "a.txt" } },
      h.scope,
    );
    expect(r.status).toBe("error");
    expect(r.result.status === "error" && r.result.error.code).toBe("invalid_input");
  });

  it("PreToolUse ask 不被 Grant 与 autoApproveAsk 绕过", async () => {
    const ws = tmp();
    const workspaceRoot = await platform.resolveReal(ws);
    // default 预设下 shell 为 ask；叠加精确匹配的 Grant 与 autoApproveAsk（--yes）
    // 两者在 forceAsk 下都必须被跳过——否则 Hook 收紧形同虚设（permissions.md 5.5）
    const policy = createDefaultPolicy({
      workspaceRoot,
      caseSensitive: platform.caseSensitivePaths,
      autoApproveAsk: true,
    });
    const subject: PermissionSubject = { kind: "shell", target: "echo hi" };
    const grants = [grantFromSubject(subject, platform.caseSensitivePaths, "now")];
    const events: { type: string; payload: Record<string, unknown> }[] = [];
    const gate = createPolicyGate(policy, {
      interactive: true,
      caseSensitive: platform.caseSensitivePaths,
      grants: { session: grants },
    });
    const checkPromise = gate.check(
      [subject],
      "c1",
      new AbortController().signal,
      {
        turnId: "turn-1",
        events: {
          emit: (type, payload) => {
            events.push({ type, payload: payload as unknown as Record<string, unknown> });
            return Promise.resolve();
          },
          emitEphemeral: () => undefined,
        },
      },
      { forceAsk: true, askReason: "Hook 要求", tool: "shell", input: { command: "echo hi" } },
    );
    // forceAsk 下必须挂起为 permission.requested，而不是被 Grant 自动放行
    await new Promise((r) => setTimeout(r, 50));
    const requested = events.find((e) => e.type === "permission.requested");
    expect(requested).toBeDefined();
    const requestId = (requested?.payload as { requestId: string }).requestId;
    const ok = await gate.respond?.(requestId, { decision: "allow" });
    expect(ok).toBe(true);
    const outcome = await checkPromise;
    expect(outcome.decision.action).toBe("allow");
  });

  it("PermissionRequest Hook 的 allow 直接结算 ask", async () => {
    const ws = tmp();
    const warnings: { code: string; message: string }[] = [];
    const hookRunner = runner(
      ws,
      {
        PermissionRequest: [
          { command: "node", args: echoScript(`() => ({action:"allow"})`) },
        ],
      },
      warnings,
    );
    // shell 在 default 预设下是 ask；注入 PermissionRequest Hook 后应直接 allow
    const workspaceRoot = await platform.resolveReal(ws);
    const policy = createDefaultPolicy({
      workspaceRoot,
      caseSensitive: platform.caseSensitivePaths,
    });
    const events: { type: string; payload: Record<string, unknown> }[] = [];
    const gate = createPolicyGate(policy, {
      interactive: true,
      caseSensitive: platform.caseSensitivePaths,
      hooks: hookRunner,
    });
    const outcome = await gate.check(
      [{ kind: "shell", target: "echo hi" }],
      "c1",
      new AbortController().signal,
      {
        turnId: "turn-1",
        events: {
          emit: (type, payload) => {
            events.push({ type, payload: payload as unknown as Record<string, unknown> });
            return Promise.resolve();
          },
          emitEphemeral: () => undefined,
        },
      },
      { tool: "shell", input: { command: "echo hi" } },
    );
    expect(outcome.decision.action).toBe("allow");
    expect(outcome.decision.source).toBe("hook");
    // Hook 结算也发 permission.resolved（持久记录）
    const resolved = events.find((e) => e.type === "permission.resolved");
    expect(resolved?.payload.source).toBe("hook");
    expect(events.find((e) => e.type === "permission.requested")).toBeUndefined();
  });

  it("PostToolUse feedback 追加进 modelContent", async () => {
    const ws = tmp();
    await platform.fs.writeFile(path.join(ws, "a.txt"), "正文");
    const h = await harness(
      ws,
      runner(ws, {
        PostToolUse: [
          { command: "node", args: echoScript(`() => ({feedback:"追加"})`) },
        ],
      }),
    );
    const r = await h.executor.execute(
      { callId: "c1", name: "read", input: { path: "a.txt" } },
      h.scope,
    );
    expect(r.status).toBe("ok");
    expect(r.result.modelContent).toContain("[hook] 追加");
  });

  it("未配置 Hooks 时管线行为与之前一致（无 hook 相关事件）", async () => {
    const ws = tmp();
    await platform.fs.writeFile(path.join(ws, "a.txt"), "正文");
    const h = await harness(ws);
    const r = await h.executor.execute(
      { callId: "c1", name: "read", input: { path: "a.txt" } },
      h.scope,
    );
    expect(r.status).toBe("ok");
    expect(h.events.map((e) => e.type)).toEqual(["tool.started", "tool.completed"]);
  });
});
