import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config/index.js";
import { loadGrantStore, workspaceKey } from "../src/config/grants.js";
import { createRuntime } from "../src/index.js";
import {
  createPolicyGate,
  createRulePolicy,
  matchGrant,
  matchPatternGrant,
  type GateTurnContext,
  type HookRunner,
  type SecurityReviewer,
} from "../src/permission/index.js";
import { createPlatform, SHELL_RISK_BY_DIALECT, shellDescriptor } from "../src/platform/index.js";
import {
  decodeDurableEvent,
  durableEventSchema,
  isShellSubjectEligibleForPatternGrant,
  matchesShellPatternGrant,
  matchShellPattern,
  replaySessionView,
  suggestShellRulePattern,
  validateShellRulePattern,
  type DurableEvent,
  type Grant,
  type GrantsChangedPayload,
  type PermissionRequestedPayload,
  type PermissionResolvedPayload,
  type PermissionSubject,
  type RuntimeEvent,
  type RuntimeWarningPayload,
} from "../src/protocol/index.js";
import { FakeProvider } from "../src/provider/index.js";

const WS = "C:\\ws\\proj";
const HOME = "C:\\Users\\tester\\.nocturne";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

function createFakeTurn(): {
  turn: GateTurnContext;
  requested: PermissionRequestedPayload[];
  resolved: PermissionResolvedPayload[];
  warnings: RuntimeWarningPayload[];
} {
  const requested: PermissionRequestedPayload[] = [];
  const resolved: PermissionResolvedPayload[] = [];
  const warnings: RuntimeWarningPayload[] = [];
  const turn: GateTurnContext = {
    turnId: "t1",
    events: {
      async emit(type, payload) {
        if (type === "permission.requested") requested.push(payload as PermissionRequestedPayload);
        if (type === "permission.resolved") resolved.push(payload as PermissionResolvedPayload);
      },
      emitEphemeral(type, payload) {
        if (type === "runtime.warning") warnings.push(payload as RuntimeWarningPayload);
      },
    },
  };
  return { turn, requested, resolved, warnings };
}

describe("validateShellRulePattern", () => {
  it("空串、纯空白、超长（>200）返回 mismatch", () => {
    expect(validateShellRulePattern("", "git status")).toEqual({
      ok: false,
      reason: "mismatch",
      message: "不匹配当前命令",
    });
    expect(validateShellRulePattern("   \t  ", "git status")).toEqual({
      ok: false,
      reason: "mismatch",
      message: "不匹配当前命令",
    });
    const longCmd = `git ${"a".repeat(200)}`;
    expect(validateShellRulePattern(`git ${"a".repeat(197)}`, longCmd)).toEqual({
      ok: false,
      reason: "mismatch",
      message: "不匹配当前命令",
    });
    const exact200 = `git ${"a".repeat(196)}`;
    expect(exact200.length).toBe(200);
    expect(validateShellRulePattern(exact200, exact200)).toEqual({
      ok: true,
      pattern: exact200,
    });
  });

  it("包含连接符、管道、分号、重定向、换行、PowerShell 脚本块返回 composite", () => {
    for (const bad of [
      "git status && ls",
      "git status || ls",
      "git status | cat",
      "git status; ls",
      "git status > out.txt",
      "git status < in.txt",
      "git status `id`",
      "git status $(id)",
      "git status\nls",
      "git status\n",
      "git status\r",
    ]) {
      expect(validateShellRulePattern(bad, bad), bad).toEqual({
        ok: false,
        reason: "composite",
        message: "不能包含 &&、|、; 等连接符",
      });
    }
    expect(validateShellRulePattern("git {status}", "git {status}", "powershell")).toEqual({
      ok: false,
      reason: "composite",
      message: "不能包含 &&、|、; 等连接符",
    });
    expect(validateShellRulePattern("git {status}", "git {status}", "posix")).toEqual({
      ok: true,
      pattern: "git {status}",
    });
  });

  it("首词含通配符或与当前命令不同返回 first_word", () => {
    for (const bad of ["git* status", "g?t status", "* status", "npm status"]) {
      expect(validateShellRulePattern(bad, "git status"), bad).toEqual({
        ok: false,
        reason: "first_word",
        message: "开头要是 git",
      });
    }
    expect(validateShellRulePattern("echo *", "echo* hi")).toEqual({
      ok: false,
      reason: "mismatch",
      message: "不匹配当前命令",
    });
  });

  it("不匹配当前命令返回 mismatch；合法模式返回 trim 后的 pattern", () => {
    expect(validateShellRulePattern("git log *", "git status --short")).toEqual({
      ok: false,
      reason: "mismatch",
      message: "不匹配当前命令",
    });
    expect(validateShellRulePattern("  git status *  ", "git status --short")).toEqual({
      ok: true,
      pattern: "git status *",
    });
    expect(validateShellRulePattern("git status --s?ort", "git status --short")).toEqual({
      ok: true,
      pattern: "git status --s?ort",
    });
    expect(validateShellRulePattern("ls", "ls")).toEqual({
      ok: true,
      pattern: "ls",
    });
  });
});

describe("suggestShellRulePattern", () => {
  it("5 个核心示例与补充用例符合预期", () => {
    expect(suggestShellRulePattern("git status --short")).toBe("git status *");
    expect(suggestShellRulePattern("npx vitest run --maxWorkers=2 a.ts")).toBe("npx vitest run *");
    expect(suggestShellRulePattern("pnpm -s typecheck")).toBe("pnpm -s typecheck");
    expect(suggestShellRulePattern("cat foo.txt")).toBe("cat foo.txt");
    expect(suggestShellRulePattern("ls")).toBe("ls");
    expect(suggestShellRulePattern("git status")).toBe("git status");
    expect(suggestShellRulePattern("pnpm test packages/core")).toBe("pnpm test *");
    expect(suggestShellRulePattern("docker compose up -d")).toBe("docker compose up *");
  });

  it("组合命令、空串、前导空白、尾部仅空白、PowerShell 脚本块均原样返回", () => {
    expect(suggestShellRulePattern("git status && ls")).toBe("git status && ls");
    expect(suggestShellRulePattern("")).toBe("");
    expect(suggestShellRulePattern(" git status --short")).toBe(" git status --short");
    expect(suggestShellRulePattern("git status   ")).toBe("git status   ");
    expect(suggestShellRulePattern("Invoke-Build { test }", "powershell")).toBe(
      "Invoke-Build { test }",
    );
  });

  it("保留词间原始分隔符（多空格、tab），生成可匹配当前命令的模式", () => {
    expect(suggestShellRulePattern("git  status --short")).toBe("git  status *");
    expect(validateShellRulePattern("git  status *", "git  status --short").ok).toBe(true);
    expect(suggestShellRulePattern("git\tstatus --short")).toBe("git\tstatus *");
    expect(validateShellRulePattern("git\tstatus *", "git\tstatus --short").ok).toBe(true);
    expect(suggestShellRulePattern("npx  vitest\trun --maxWorkers=2")).toBe("npx  vitest\trun *");
    expect(
      validateShellRulePattern("npx  vitest\trun *", "npx  vitest\trun --maxWorkers=2").ok,
    ).toBe(true);
  });
});

describe("matchShellPattern 耗时有界与字面语义", () => {
  it("正则特殊字符按字面匹配、大小写敏感、通配符跨换行，且含字面 * / ? 的输入正确匹配", () => {
    expect(matchShellPattern("grep -E 'a+b.(c)[0-9]^$\\|'", "grep -E 'a+b.(c)[0-9]^$\\|'")).toBe(
      true,
    );
    expect(matchShellPattern("grep -E 'a+b.(c)[0-9]^$\\|'", "grep -E 'aabx(c)[0-9]^$\\|'")).toBe(
      false,
    );
    expect(matchShellPattern("git status *", "GIT status --short")).toBe(false);
    expect(matchShellPattern("echo *", "echo line1\nline2")).toBe(true);
    expect(matchShellPattern("a?b", "a\nb")).toBe(true);

    // 输入自身包含字面 `*` 或 `?` 时，模式通配符仍作为通配符生效
    expect(matchShellPattern("echo *", "echo *.txt")).toBe(true);
    expect(matchShellPattern("echo *.txt", "echo *.txt")).toBe(true);
    expect(matchShellPattern("echo *.txt", "echo *.md")).toBe(false);
    expect(matchShellPattern("echo *", "echo *")).toBe(true);
    expect(matchShellPattern("ls * *", "ls *.ts *.js")).toBe(true);
    expect(matchShellPattern("a*b", "a*c")).toBe(false);
    expect(matchShellPattern("echo ?a", "echo *a")).toBe(true);
    expect(matchShellPattern("echo ?a", "echo ?a")).toBe(true);
    expect(matchShellPattern("echo ?a", "echo **a")).toBe(false);
    expect(validateShellRulePattern("echo *", "echo *.txt")).toEqual({
      ok: true,
      pattern: "echo *",
    });
  });

  it("多通配符未命中病理输入不会发生指数回溯", () => {
    const pathologicalPattern = `a${"*a".repeat(40)}b`;
    const pathologicalCommand = `${"a".repeat(200)}c`;
    const started = performance.now();
    expect(matchShellPattern(pathologicalPattern, pathologicalCommand)).toBe(false);
    expect(performance.now() - started).toBeLessThan(100);
  });
});

describe("isShellSubjectEligibleForPatternGrant & matchesShellPatternGrant", () => {
  it("普通 shell 命令匹配，非 shell/组合/高风险/不透明 PowerShell 均返回 false", () => {
    expect(
      isShellSubjectEligibleForPatternGrant({ kind: "shell", target: "git status --short" }),
    ).toBe(true);
    expect(
      matchesShellPatternGrant("git status *", { kind: "shell", target: "git status --short" }),
    ).toBe(true);
    expect(
      matchesShellPatternGrant("git log *", { kind: "shell", target: "git status --short" }),
    ).toBe(false);
    expect(matchesShellPatternGrant("a*", { kind: "edit", target: "a.txt" })).toBe(false);
    expect(
      matchesShellPatternGrant("git *", { kind: "shell", target: "git status && echo ok" }),
    ).toBe(false);
    expect(
      matchesShellPatternGrant("git *", {
        kind: "shell",
        target: "git push --force origin main",
      }),
    ).toBe(false);
    expect(
      matchesShellPatternGrant("pwsh *", {
        kind: "shell",
        target: "pwsh -EncodedCommand SQBFAFgA",
        shell: "pwsh",
      }),
    ).toBe(false);
  });
});

describe("permission.requested 的 ruleSuggestion 触发条件", () => {
  async function requestOnce(
    policy: ReturnType<typeof createRulePolicy>,
    subjects: PermissionSubject[],
    opts?: { interactive?: boolean; forceAsk?: boolean },
  ) {
    const { turn, requested } = createFakeTurn();
    const gate = createPolicyGate(policy, {
      interactive: opts?.interactive ?? true,
      caseSensitive: false,
      grants: { session: [] },
    });
    const controller = new AbortController();
    const pendingPromise = gate.check(
      subjects,
      "call-1",
      controller.signal,
      turn,
      opts?.forceAsk ? { forceAsk: true, askReason: "hook ask" } : undefined,
    );
    if (opts?.interactive === false) {
      await pendingPromise;
      return { requested };
    }
    await vi.waitFor(() => {
      expect(requested).toHaveLength(1);
    });
    const req = requested[0];
    if (req === undefined) throw new Error("missing request");
    await gate.respond?.(req.requestId, { decision: "deny" });
    await pendingPromise;
    return { requested };
  }

  it("正例：单条普通 shell 命令带 ruleSuggestion 且值等于 suggestShellRulePattern", async () => {
    const policy = createRulePolicy({ workspaceRoot: WS, caseSensitive: false, preset: "default" });
    const cmd = "git status --short";
    const { requested } = await requestOnce(policy, [{ kind: "shell", target: cmd }]);
    expect(requested[0]?.ruleSuggestion).toEqual({ pattern: suggestShellRulePattern(cmd) });
    expect(requested[0]?.ruleSuggestion?.pattern).toBe("git status *");
  });

  it("反例 1：非 shell 主体或多主体不带 ruleSuggestion", async () => {
    const policy = createRulePolicy({ workspaceRoot: WS, caseSensitive: false, preset: "default" });
    const editReq = await requestOnce(policy, [
      { kind: "edit", target: `${WS}\\a.ts`, resolved: `${WS}\\a.ts` },
    ]);
    expect(editReq.requested[0]?.ruleSuggestion).toBeUndefined();
    expect("ruleSuggestion" in (editReq.requested[0] ?? {})).toBe(false);

    const multiReq = await requestOnce(policy, [
      { kind: "shell", target: "git status --short" },
      { kind: "edit", target: `${WS}\\a.ts`, resolved: `${WS}\\a.ts` },
    ]);
    expect(multiReq.requested[0]?.ruleSuggestion).toBeUndefined();
  });

  it("反例 2：组合 shell 命令与 PowerShell 脚本块不带 ruleSuggestion", async () => {
    const policy = createRulePolicy({ workspaceRoot: WS, caseSensitive: false, preset: "default" });
    const composite = await requestOnce(policy, [{ kind: "shell", target: "git status && ls" }]);
    expect(composite.requested[0]?.ruleSuggestion).toBeUndefined();

    const psBlock = await requestOnce(policy, [
      { kind: "shell", target: "Invoke-Command { git status }", shell: "pwsh" },
    ]);
    expect(psBlock.requested[0]?.ruleSuggestion).toBeUndefined();
  });

  it("反例 3：无 allow_project 选项（高风险命令、不透明 PowerShell）不带 ruleSuggestion", async () => {
    const policy = createRulePolicy({ workspaceRoot: WS, caseSensitive: false, preset: "default" });
    const risky = await requestOnce(policy, [{ kind: "shell", target: "rm -rf /tmp/x" }]);
    expect(risky.requested[0]?.options).not.toContain("allow_project");
    expect(risky.requested[0]?.ruleSuggestion).toBeUndefined();

    const opaque = await requestOnce(policy, [
      { kind: "shell", target: "pwsh -EncodedCommand SQBFAFgA", shell: "pwsh" },
    ]);
    expect(opaque.requested[0]?.options).not.toContain("allow_project");
    expect(opaque.requested[0]?.ruleSuggestion).toBeUndefined();
  });

  it("反例 4：用户/项目/未信任项目/CLI 显式 ask 规则不带 ruleSuggestion", async () => {
    for (const origin of ["user", "project", "cli"] as const) {
      const policy = createRulePolicy({
        workspaceRoot: WS,
        caseSensitive: false,
        preset: "default",
        rules: [{ origin, rule: { kind: "shell", pattern: "git push *", action: "ask" } }],
      });
      const { requested } = await requestOnce(policy, [
        { kind: "shell", target: "git push origin main" },
      ]);
      expect(requested[0]?.ruleSuggestion, origin).toBeUndefined();
    }

    const untrustedPolicy = createRulePolicy({
      workspaceRoot: WS,
      caseSensitive: false,
      preset: "default",
      untrustedRules: [
        {
          origin: "project-untrusted",
          rule: { kind: "shell", pattern: "git push *", action: "ask" },
        },
      ],
    });
    const untrustedReq = await requestOnce(untrustedPolicy, [
      { kind: "shell", target: "git push origin main" },
    ]);
    expect(untrustedReq.requested[0]?.ruleSuggestion).toBeUndefined();
  });

  it("反例 4b：凭据类命令（userOnly）不带 ruleSuggestion", async () => {
    const policy = createRulePolicy({
      workspaceRoot: WS,
      caseSensitive: false,
      preset: "default",
      protectedPaths: { lexical: [`${HOME}\\credentials.json`] },
    });
    const { requested } = await requestOnce(policy, [
      { kind: "shell", target: "secret-tool lookup service nocturne" },
    ]);
    expect(requested[0]?.ruleSuggestion).toBeUndefined();
  });

  it("反例 5：forceAsk（PreToolUse Hook 强制确认）不带 ruleSuggestion", async () => {
    const policy = createRulePolicy({ workspaceRoot: WS, caseSensitive: false, preset: "default" });
    const { requested } = await requestOnce(
      policy,
      [{ kind: "shell", target: "git status --short" }],
      { forceAsk: true },
    );
    expect(requested[0]?.ruleSuggestion).toBeUndefined();
  });

  it("反例 6：非交互模式不发 permission.requested", async () => {
    const policy = createRulePolicy({ workspaceRoot: WS, caseSensitive: false, preset: "default" });
    const { requested } = await requestOnce(
      policy,
      [{ kind: "shell", target: "git status --short" }],
      { interactive: false },
    );
    expect(requested).toHaveLength(0);
  });
});

describe("gate.respond 处理 remember: pattern", () => {
  it("合法模式放行并写入项目模式 Grant，permission.resolved.remember 为 pattern", async () => {
    const projectGrants: Grant[] = [];
    const sessionGrants: Grant[] = [];
    const policy = createRulePolicy({
      workspaceRoot: WS,
      caseSensitive: false,
      preset: "default",
      grants: { session: sessionGrants, project: projectGrants },
    });
    const gate = createPolicyGate(policy, {
      interactive: true,
      caseSensitive: false,
      grants: {
        session: sessionGrants,
        project: {
          async add(g) {
            projectGrants.push(g);
          },
        },
      },
    });
    const { turn, requested, resolved } = createFakeTurn();
    const pending = gate.check(
      [{ kind: "shell", target: "git status --short" }],
      "c1",
      new AbortController().signal,
      turn,
    );
    await vi.waitFor(() => {
      expect(requested).toHaveLength(1);
    });
    const req = requested[0];
    if (req === undefined) throw new Error("missing request");
    const ok = await gate.respond?.(req.requestId, {
      decision: "allow",
      remember: "pattern",
      pattern: "  git status *  ",
    });
    expect(ok).toBe(true);
    const out = await pending;
    expect(out.decision.action).toBe("allow");
    expect(out.remember).toBe("pattern");
    expect(projectGrants).toEqual([
      {
        kind: "shell",
        target: "git status *",
        createdAt: expect.any(String),
        match: "pattern",
      },
    ]);
    expect(sessionGrants).toEqual([]);
    expect(resolved[0]?.remember).toBe("pattern");
  });

  it("请求没带 ruleSuggestion 时拒绝 remember: pattern 且不写授权、不清除 pending", async () => {
    const projectGrants: Grant[] = [];
    const sessionGrants: Grant[] = [];
    const policy = createRulePolicy({ workspaceRoot: WS, caseSensitive: false, preset: "default" });
    const gate = createPolicyGate(policy, {
      interactive: true,
      caseSensitive: false,
      grants: {
        session: sessionGrants,
        project: {
          async add(g) {
            projectGrants.push(g);
          },
        },
      },
    });
    const { turn, requested } = createFakeTurn();
    const pending = gate.check(
      [{ kind: "shell", target: "git status && ls" }],
      "c1",
      new AbortController().signal,
      turn,
    );
    await vi.waitFor(() => {
      expect(requested).toHaveLength(1);
    });
    const reqId = requested[0]?.requestId;
    if (reqId === undefined) throw new Error("missing requestId");
    expect(requested[0]?.ruleSuggestion).toBeUndefined();
    expect(
      await gate.respond?.(reqId, {
        decision: "allow",
        remember: "pattern",
        pattern: "git status && ls",
      }),
    ).toBe(false);
    expect(gate.hasPending?.(reqId)).toBe(true);
    expect(projectGrants).toEqual([]);
    expect(sessionGrants).toEqual([]);
    // 仍可改用 allow_once 正常结算
    expect(await gate.respond?.(reqId, { decision: "allow" })).toBe(true);
    expect((await pending).decision.action).toBe("allow");
  });

  it("非法模式（不匹配当前命令、首词通配、首词不符、含连接符、缺少 pattern）返回 false 且不写", async () => {
    const projectGrants: Grant[] = [];
    const sessionGrants: Grant[] = [];
    const policy = createRulePolicy({ workspaceRoot: WS, caseSensitive: false, preset: "default" });
    const gate = createPolicyGate(policy, {
      interactive: true,
      caseSensitive: false,
      grants: {
        session: sessionGrants,
        project: {
          async add(g) {
            projectGrants.push(g);
          },
        },
      },
    });
    const { turn, requested } = createFakeTurn();
    const pending = gate.check(
      [{ kind: "shell", target: "git status --short" }],
      "c1",
      new AbortController().signal,
      turn,
    );
    await vi.waitFor(() => {
      expect(requested).toHaveLength(1);
    });
    const reqId = requested[0]?.requestId;
    if (reqId === undefined) throw new Error("missing requestId");
    for (const bad of [
      undefined,
      "",
      "git log *",
      "git* status *",
      "npm status *",
      "git * && ls",
    ]) {
      expect(
        await gate.respond?.(reqId, {
          decision: "allow",
          remember: "pattern",
          ...(bad !== undefined ? { pattern: bad } : {}),
        }),
        String(bad),
      ).toBe(false);
      expect(gate.hasPending?.(reqId)).toBe(true);
    }
    expect(projectGrants).toEqual([]);
    expect(sessionGrants).toEqual([]);
    expect(
      await gate.respondDetailed?.(reqId, {
        decision: "allow",
        remember: "pattern",
        pattern: "git log *",
      }),
    ).toBe("invalid_reply");
    expect(
      await gate.respondDetailed?.("non-existent-req", {
        decision: "allow",
      }),
    ).toBe("unknown_request");
    expect(
      await gate.respondDetailed?.(reqId, {
        decision: "allow",
        remember: "pattern",
        pattern: "git status *",
      }),
    ).toBe("ok");
    await pending;
    expect(projectGrants).toHaveLength(1);
  });

  it("项目写盘失败降级为会话精确 Grant 并发出 grant_persist_failed 警告", async () => {
    const sessionGrants: Grant[] = [];
    const policy = createRulePolicy({ workspaceRoot: WS, caseSensitive: false, preset: "default" });
    const gate = createPolicyGate(policy, {
      interactive: true,
      caseSensitive: false,
      grants: {
        session: sessionGrants,
        project: {
          async add() {
            throw new Error("disk full");
          },
        },
      },
    });
    const { turn, requested, resolved, warnings } = createFakeTurn();
    const pending = gate.check(
      [{ kind: "shell", target: "git status --short" }],
      "c1",
      new AbortController().signal,
      turn,
    );
    await vi.waitFor(() => {
      expect(requested).toHaveLength(1);
    });
    const req = requested[0];
    if (req === undefined) throw new Error("missing request");
    expect(
      await gate.respond?.(req.requestId, {
        decision: "allow",
        remember: "pattern",
        pattern: "git status *",
      }),
    ).toBe(true);
    const out = await pending;
    expect(out.decision.action).toBe("allow");
    expect(out.remember).toBe("session");
    expect(resolved[0]?.remember).toBe("session");
    expect(sessionGrants).toEqual([
      { kind: "shell", target: "git status --short", createdAt: expect.any(String) },
    ]);
    expect("match" in (sessionGrants[0] ?? {})).toBe(false);
    expect(warnings).toContainEqual(
      expect.objectContaining({
        code: "grant_persist_failed",
      }),
    );
  });
});

describe("模式 Grant 求值与排除条件", () => {
  const patternGrant = (pattern: string): Grant => ({
    kind: "shell",
    target: pattern,
    createdAt: "2026-11-21T00:00:00Z",
    match: "pattern",
  });

  it("模式 Grant 放行同类命令并填充 RuleHit.grant.match/pattern；精确 Grant 优先且不带 match", () => {
    const exact: Grant = {
      kind: "shell",
      target: "git status --short",
      createdAt: "2026-11-20T00:00:00Z",
    };
    const pattern = patternGrant("git status *");
    expect(matchGrant([pattern], { kind: "shell", target: "git status *" }, false)).toBeUndefined();
    expect(matchPatternGrant([pattern], { kind: "shell", target: "git status --short" })).toEqual(
      pattern,
    );

    const policy = createRulePolicy({
      workspaceRoot: WS,
      caseSensitive: false,
      preset: "default",
      grants: { project: [exact, pattern] },
    });

    const hitExact = policy.evaluate([{ kind: "shell", target: "git status --short" }]);
    expect(hitExact.decision.action).toBe("allow");
    expect(hitExact.decision.source).toBe("grant");
    expect(hitExact.decision.matchedRule?.grant).toEqual({
      scope: "project",
      createdAt: exact.createdAt,
    });
    expect("match" in (hitExact.decision.matchedRule?.grant ?? {})).toBe(false);

    const hitPattern = policy.evaluate([{ kind: "shell", target: "git status -sb" }]);
    expect(hitPattern.decision.action).toBe("allow");
    expect(hitPattern.decision.source).toBe("grant");
    expect(hitPattern.decision.matchedRule).toEqual({
      origin: "grant",
      grant: {
        scope: "project",
        createdAt: pattern.createdAt,
        match: "pattern",
        pattern: "git status *",
      },
      description: "Grant（本项目）：shell git status *",
    });
  });

  it("组合命令、高风险段、不透明 PowerShell、凭据类命令不被模式 Grant 放行", () => {
    const policy = createRulePolicy({
      workspaceRoot: WS,
      caseSensitive: false,
      preset: "default",
      protectedPaths: { lexical: [`${HOME}\\credentials.json`] },
      grants: {
        project: [
          patternGrant("git *"),
          patternGrant("pwsh *"),
          patternGrant("Remove-Item *"),
          patternGrant("cat *"),
          patternGrant("secret-tool *"),
        ],
      },
    });

    // 组合命令
    expect(
      policy.evaluate([{ kind: "shell", target: "git status && rm -rf /tmp/x" }]).decision.action,
    ).toBe("ask");

    // 高风险段（POSIX & PowerShell）
    expect(
      policy.evaluate([{ kind: "shell", target: "git push --force origin main" }]).decision.action,
    ).toBe("ask");
    expect(
      policy.evaluate([{ kind: "shell", target: "git reset --hard HEAD" }]).decision.action,
    ).toBe("ask");
    expect(
      policy.evaluate([
        {
          kind: "shell",
          target: "Remove-Item -r -f C:\\temp\\x",
          shell: "pwsh",
          shellRisk: shellDescriptor("pwsh", "pwsh.exe", "win32").risk,
          shellRiskByDialect: SHELL_RISK_BY_DIALECT,
        },
      ]).decision.action,
    ).toBe("ask");

    // 不透明 PowerShell
    expect(
      policy.evaluate([{ kind: "shell", target: "pwsh -EncodedCommand SQBFAFgA", shell: "pwsh" }])
        .decision.action,
    ).toBe("ask");

    // 凭据类命令
    expect(
      policy.evaluate([{ kind: "shell", target: `cat ${HOME}\\credentials.json` }]).decision.action,
    ).toBe("ask");
    expect(
      policy.evaluate([{ kind: "shell", target: "secret-tool lookup service nocturne" }]).decision
        .action,
    ).toBe("ask");
  });

  it("用户/未信任项目显式 ask 规则仍返回 ask；用户 deny 规则仍返回 deny", () => {
    const policy = createRulePolicy({
      workspaceRoot: WS,
      caseSensitive: false,
      preset: "default",
      rules: [
        { origin: "user", rule: { kind: "shell", pattern: "git push *", action: "ask" } },
        { origin: "user", rule: { kind: "shell", pattern: "git tag *", action: "deny" } },
      ],
      untrustedRules: [
        {
          origin: "project-untrusted",
          rule: { kind: "shell", pattern: "git rebase *", action: "ask" },
        },
      ],
      grants: { project: [patternGrant("git *")] },
    });

    expect(policy.evaluate([{ kind: "shell", target: "git status --short" }]).decision.action).toBe(
      "allow",
    );
    expect(
      policy.evaluate([{ kind: "shell", target: "git push origin main" }]).decision.action,
    ).toBe("ask");
    expect(policy.evaluate([{ kind: "shell", target: "git rebase main" }]).decision.action).toBe(
      "ask",
    );
    expect(policy.evaluate([{ kind: "shell", target: "git tag v1.0.0" }]).decision.action).toBe(
      "deny",
    );
  });

  it("--yes、smart 审查与 Hook 先后不变", async () => {
    // --yes 仍把未命中的 ask 提升为 allow，不覆盖 deny
    const yesPolicy = createRulePolicy({
      workspaceRoot: WS,
      caseSensitive: false,
      preset: "default",
      autoApproveAsk: true,
      rules: [{ origin: "user", rule: { kind: "shell", pattern: "git tag *", action: "deny" } }],
      grants: { project: [patternGrant("git status *")] },
    });
    expect(
      yesPolicy.evaluate([{ kind: "shell", target: "git status --short" }]).decision.source,
    ).toBe("grant");
    expect(
      yesPolicy.evaluate([{ kind: "shell", target: "git push origin main" }]).decision.action,
    ).toBe("allow");
    expect(yesPolicy.evaluate([{ kind: "shell", target: "git tag v1" }]).decision.action).toBe(
      "deny",
    );

    // smart 预设下：命中模式 Grant 直接放行不调审查器；被排除（如显式 ask）不放行
    const reviewSpy = vi.fn(async () => ({ verdict: "allow" as const, reason: "ok" }));
    const reviewer: SecurityReviewer = { review: reviewSpy };
    const smartPolicy = createRulePolicy({
      workspaceRoot: WS,
      caseSensitive: false,
      preset: "smart",
      grants: { project: [patternGrant("git push *")] },
    });
    const smartGate = createPolicyGate(smartPolicy, {
      interactive: false,
      preset: () => "smart",
      reviewer: () => reviewer,
      caseSensitive: false,
    });
    const { turn } = createFakeTurn();
    const resAllow = await smartGate.check(
      [{ kind: "shell", target: "git push origin feature" }],
      "c1",
      new AbortController().signal,
      turn,
    );
    expect(resAllow.decision.action).toBe("allow");
    expect(resAllow.decision.source).toBe("grant");
    expect(reviewSpy).not.toHaveBeenCalled();

    // Hook forceAsk 绕过模式 Grant；PermissionRequest Hook 仍在 ask 阶段运行
    const hookRun = vi.fn(async () => ({ action: "allow" as const, reason: "hook ok" }));
    const hooks: HookRunner = { run: hookRun };
    const hookGate = createPolicyGate(smartPolicy, {
      interactive: false,
      hooks,
      caseSensitive: false,
    });
    const resForce = await hookGate.check(
      [{ kind: "shell", target: "git push origin feature" }],
      "c2",
      new AbortController().signal,
      turn,
      { forceAsk: true, askReason: "pre-tool hook" },
    );
    expect(hookRun).toHaveBeenCalledTimes(1);
    expect(resForce.decision.action).toBe("allow");
    expect(resForce.decision.source).toBe("hook");
  });
});

describe("协议兼容、视图回放与 Grant 存储", () => {
  it("旧 permission.requested 无 ruleSuggestion 正常解码回放；新字段正常透传；PermissionOption 无新增值", () => {
    const legacyRequested = JSON.stringify({
      type: "permission.requested",
      sessionId: "s1",
      seq: 1,
      time: "2026-11-21T00:00:00Z",
      turnId: "t1",
      payload: {
        requestId: "r1",
        callId: "c1",
        subjects: [{ kind: "shell", target: "git status" }],
        reason: "ask",
        options: ["allow_once", "allow_session", "allow_project", "deny", "deny_stop"],
      },
    });
    const decodedLegacy = decodeDurableEvent(legacyRequested);
    const legacyView = replaySessionView([decodedLegacy]);
    expect(legacyView.pendingPermission?.ruleSuggestion).toBeUndefined();

    // PermissionOption 不允许新增枚举值
    expect(() =>
      durableEventSchema.parse({
        type: "permission.requested",
        sessionId: "s1",
        seq: 1,
        time: "2026-11-21T00:00:00Z",
        payload: {
          requestId: "r1",
          callId: "c1",
          subjects: [{ kind: "shell", target: "git status" }],
          reason: "ask",
          options: ["allow_pattern"],
        },
      }),
    ).toThrow();

    // 新事件带 ruleSuggestion、remember: "pattern" 与 grant.match/pattern 正常解码与回放
    const events: DurableEvent[] = [
      decodeDurableEvent(
        JSON.stringify({
          type: "permission.requested",
          sessionId: "s1",
          seq: 1,
          time: "2026-11-21T00:00:00Z",
          turnId: "t1",
          payload: {
            requestId: "r1",
            callId: "c1",
            subjects: [{ kind: "shell", target: "git status --short" }],
            reason: "ask",
            options: ["allow_once", "allow_session", "allow_project", "deny", "deny_stop"],
            ruleSuggestion: { pattern: "git status *" },
          },
        }),
      ),
      decodeDurableEvent(
        JSON.stringify({
          type: "permission.resolved",
          sessionId: "s1",
          seq: 2,
          time: "2026-11-21T00:00:01Z",
          turnId: "t1",
          payload: {
            requestId: "r1",
            callId: "c1",
            action: "allow",
            source: "user",
            remember: "pattern",
          },
        }),
      ),
      decodeDurableEvent(
        JSON.stringify({
          type: "tool.started",
          sessionId: "s1",
          seq: 3,
          time: "2026-11-21T00:00:02Z",
          turnId: "t1",
          payload: {
            callId: "c2",
            name: "shell",
            input: { command: "git status -sb" },
            subjects: [{ kind: "shell", target: "git status -sb" }],
            permission: {
              action: "allow",
              source: "grant",
              rule: "Grant（本项目）：shell git status *",
              grant: {
                scope: "project",
                createdAt: "2026-11-21T00:00:01Z",
                match: "pattern",
                pattern: "git status *",
              },
            },
          },
        }),
      ),
    ];

    const viewBeforeResolve = replaySessionView(events.slice(0, 1));
    expect(viewBeforeResolve.pendingPermission?.ruleSuggestion).toEqual({
      pattern: "git status *",
    });

    const fullView = replaySessionView(events);
    const permNotice = fullView.entries.find(
      (e) => e.kind === "notice" && e.subtype === "permission",
    );
    expect(permNotice?.kind === "notice" ? permNotice.message : undefined).toContain(
      "，已写入项目授权",
    );
    const tool2 = fullView.entries.find((e) => e.kind === "tool" && e.callId === "c2");
    expect(tool2?.kind === "tool" ? tool2.permission?.grant : undefined).toEqual({
      scope: "project",
      createdAt: "2026-11-21T00:00:01Z",
      match: "pattern",
      pattern: "git status *",
    });
  });

  it("config/grants.ts：带 match 读写、三元键去重与撤销、坏条目跳过告警、旧无 match 文件照常读", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nct-pattern-grants-"));
    roots.push(root);
    const workspace = path.join(root, "workspace");
    const grantsDir = path.join(root, "grants");
    await fs.mkdir(workspace);
    await fs.mkdir(grantsDir);
    const platform = createPlatform();
    const realWs = await platform.resolveReal(workspace);
    const file = path.join(grantsDir, `${workspaceKey(platform.paths.canonicalize(realWs))}.json`);

    // 写入含合法精确 Grant、合法模式 Grant 和 2 条非法条目的文件
    await fs.writeFile(
      file,
      JSON.stringify({
        version: 1,
        workspaceRoot: realWs,
        grants: [
          { kind: "shell", target: "git status", createdAt: "2026-11-20T00:00:00Z" },
          {
            kind: "shell",
            target: "git status",
            createdAt: "2026-11-21T00:00:00Z",
            match: "pattern",
          },
          { kind: "read", target: "/a", createdAt: "2026-11-21T00:00:00Z", match: "pattern" },
          { kind: "shell", target: "ls", createdAt: "2026-11-21T00:00:00Z", match: "other" },
        ],
      }),
    );

    const loaded = await loadGrantStore(platform, grantsDir, realWs);
    expect(loaded.warning).toContain("2 条无效条目已跳过");
    const list = loaded.store.list();
    expect(list).toEqual([
      { kind: "shell", target: "git status", createdAt: "2026-11-20T00:00:00Z" },
      {
        kind: "shell",
        target: "git status",
        createdAt: "2026-11-21T00:00:00Z",
        match: "pattern",
      },
    ]);
    // 精确 Grant 不保留值为 undefined 的 match 键
    expect("match" in (list[0] ?? {})).toBe(false);

    // 重复添加同一模式 Grant 会去重
    await loaded.store.add({
      kind: "shell",
      target: "git status",
      createdAt: "2026-11-22T00:00:00Z",
      match: "pattern",
    });
    expect(loaded.store.list()).toHaveLength(2);

    // 只撤销模式 Grant，保留同名精确 Grant
    await loaded.store.remove("shell", "git status", "pattern");
    expect(loaded.store.list()).toEqual([
      { kind: "shell", target: "git status", createdAt: "2026-11-20T00:00:00Z" },
    ]);

    // 重新写入模式 Grant 并重新加载验证落盘
    await loaded.store.add({
      kind: "shell",
      target: "git status *",
      createdAt: "2026-11-22T00:00:00Z",
      match: "pattern",
    });
    const reloaded = await loadGrantStore(platform, grantsDir, realWs);
    expect(reloaded.warning).toBeUndefined();
    expect(reloaded.store.list()).toEqual([
      { kind: "shell", target: "git status", createdAt: "2026-11-20T00:00:00Z" },
      {
        kind: "shell",
        target: "git status *",
        createdAt: "2026-11-22T00:00:00Z",
        match: "pattern",
      },
    ]);
  });

  it("子代理转发透传 ruleSuggestion，回复 remember: pattern 触发项目 grantsChanged", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nct-sub-pattern-"));
    roots.push(root);
    const workspace = path.join(root, "workspace");
    const home = path.join(root, "home");
    await fs.mkdir(workspace);
    await fs.mkdir(home);
    await fs.writeFile(
      path.join(home, "config.json"),
      JSON.stringify({ modelsDev: false, skills: { sources: { agents: false, claude: false } } }),
    );
    const platform = {
      ...createPlatform(),
      homeDir: () => root,
      nocturneHome: () => home,
      env: () => undefined,
    };
    const config = await loadConfig(platform, { nocturneHome: home, env: () => undefined });

    let parentStep = 0;
    let childStep = 0;
    const provider = new FakeProvider({
      handler: async (req) => {
        if (req.tools.some((t) => t.name === "finish")) {
          childStep++;
          if (childStep === 1) {
            return [
              {
                type: "tool_call",
                toolCallId: "sh1",
                name: "shell",
                input: { command: "echo hello --verbose" },
              },
              { type: "finish", reason: "tool_calls" },
            ];
          }
          return [
            { type: "tool_call", toolCallId: "fin", name: "finish", input: { result: "done" } },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        parentStep++;
        if (parentStep === 1) {
          return [
            {
              type: "tool_call",
              toolCallId: "task1",
              name: "task",
              input: { task: "run echo", preset: "general" },
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

    const runtime = await createRuntime({
      config,
      cwd: workspace,
      interactive: true,
      providers: [provider],
    });
    const changes: GrantsChangedPayload[] = [];
    runtime.onGrantsChanged((p) => changes.push(p));

    const session = await runtime.createSession({ model: "fake/fake-1" });
    let seenSuggestion: { pattern: string } | undefined;
    let invalidSubagentErr: unknown;
    session.subscribe((event: RuntimeEvent) => {
      if (event.type === "permission.requested") {
        void session.respondPermission(event.payload.requestId, { decision: "allow" });
      } else if (event.type === "subagent.permissions" && event.payload.pending.length > 0) {
        const req = event.payload.pending[0];
        if (req === undefined) return;
        seenSuggestion = req.ruleSuggestion;
        void session
          .respondSubagentPermission(req.childSessionId, req.requestId, {
            decision: "allow",
            remember: "pattern",
            pattern: "git status *",
          })
          .catch((e) => {
            invalidSubagentErr = e;
          })
          .finally(() => {
            void session.respondSubagentPermission(req.childSessionId, req.requestId, {
              decision: "allow",
              remember: "pattern",
              pattern: req.ruleSuggestion?.pattern ?? "echo hello *",
            });
          });
      }
    });

    try {
      await session.submit({ text: "run subagent" });
      expect(seenSuggestion).toEqual({ pattern: "echo hello *" });
      expect(invalidSubagentErr).toMatchObject({ code: "invalid_reply" });
      expect(changes).toContainEqual({ workspace: await platform.resolveReal(workspace) });
      const projectGrants = await runtime.listGrants({ workspace });
      expect(projectGrants).toContainEqual(
        expect.objectContaining({
          kind: "shell",
          target: "echo hello *",
          match: "pattern",
        }),
      );
    } finally {
      await session.close();
    }
  });
});
