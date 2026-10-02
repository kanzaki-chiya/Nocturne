import { describe, expect, it, vi } from "vitest";
import type { Grant, PermissionPresetName, PermissionSubject } from "../protocol/index.js";
import { createPolicyGate, createRulePolicy } from "./index.js";

const lexical = "C:/Users/tester/.grok/auth.json";
const resolved = "D:/account/secret.json";
const base = {
  workspaceRoot: "C:/workspace",
  caseSensitive: false,
  externalCredentialPaths: { lexical: [lexical], resolved: [resolved] },
};
const presets: PermissionPresetName[] = [
  "read-only",
  "default",
  "auto-edit",
  "guarded",
  "smart",
  "bypass",
];

describe("external-file 权限（ADR-0042 §9）", () => {
  it.each(presets)("%s 下显式规则、Grant 与 --yes 均不能绕过 read/edit deny", (preset) => {
    for (const kind of ["read", "edit"] as const) {
      const grants: Grant[] = [{ kind, target: resolved, createdAt: "2026-10-03T00:00:00Z" }];
      const policy = createRulePolicy({
        ...base,
        preset,
        autoApproveAsk: true,
        rules: [{ origin: "cli", rule: { kind, pattern: "**", action: "allow" } }],
        grants: { session: grants, project: grants },
      });
      for (const subject of [
        { kind, target: lexical },
        { kind, target: "C:\\USERS\\tester\\.grok\\sub\\..\\AUTH.JSON" },
        { kind, target: "C:/workspace/link.json", resolved },
        { kind, target: resolved },
      ]) {
        const result = policy.evaluate([subject]);
        expect(result.decision.action).toBe("deny");
        expect(result.decision.source).toBe("rule");
        expect(result.decision.reason).toContain("外部服务商凭据文件");
      }
      expect(
        policy.evaluate([{ kind, target: lexical, resolved }], { skipApprovals: true }).decision
          .action,
      ).toBe("deny");
    }
  });

  it.each(["guarded", "smart", "bypass"] as const)(
    "%s 下词法路径、真实路径与文件名命令至少 ask",
    (preset) => {
      const policy = createRulePolicy({ ...base, preset });
      for (const command of [
        `cat '${lexical}'`,
        `Get-Content '${resolved}'`,
        "cat ~/.grok/auth.json",
        "type .grok\\AUTH.JSON",
        "cd D:/account && cat secret.json",
      ]) {
        const result = policy.evaluate([{ kind: "shell", target: command }]);
        expect(result.decision.action).toBe("ask");
        expect(result.userOnly).toBe(true);
      }
      expect(policy.evaluate([{ kind: "shell", target: "git status" }]).decision.action).toBe(
        "allow",
      );
      expect(
        policy.evaluate([
          { kind: "read", target: "C:/workspace/auth.json", resolved: "C:/workspace/auth.json" },
        ]).decision.action,
      ).toBe("allow");
    },
  );

  it("shell 显式 allow 仍降级，显式 deny 不被 Grant 或 --yes 提升", () => {
    const subject: PermissionSubject = { kind: "shell", target: "cat ~/.grok/auth.json" };
    for (const action of ["allow", "deny"] as const) {
      const policy = createRulePolicy({
        ...base,
        preset: "bypass",
        rules: [{ origin: "user", rule: { kind: "shell", pattern: "*", action } }],
      });
      expect(policy.evaluate([subject]).decision.action).toBe(action === "deny" ? "deny" : "ask");
    }
    const denying = createRulePolicy({
      ...base,
      preset: "bypass",
      autoApproveAsk: true,
      grants: { session: [{ kind: "shell", target: subject.target, createdAt: "2026-10-03" }] },
      rules: [{ origin: "user", rule: { kind: "shell", pattern: "*", action: "deny" } }],
    });
    expect(denying.evaluate([subject]).decision.action).toBe("deny");
  });

  it("遵守文件系统大小写敏感性", () => {
    const policy = createRulePolicy({ ...base, caseSensitive: true, preset: "bypass" });
    expect(policy.evaluate([{ kind: "read", target: lexical }]).decision.action).toBe("deny");
    expect(
      policy.evaluate([
        { kind: "read", target: lexical.toUpperCase(), resolved: lexical.toUpperCase() },
      ]).decision.action,
    ).toBe("allow");
  });

  it("硬拒绝不会进入 Hook、审查器或用户确认；词法枚举也拒绝", async () => {
    const hook = vi.fn();
    const review = vi.fn();
    const gate = createPolicyGate(
      createRulePolicy({ ...base, preset: "smart", autoApproveAsk: true }),
      {
        interactive: true,
        preset: () => "smart",
        hooks: { run: hook },
        reviewer: () => ({ review }),
      },
    );
    const outcome = await gate.check(
      [{ kind: "read", target: "C:/workspace/alias", resolved }],
      "call",
      new AbortController().signal,
      undefined,
      { forceAsk: true },
    );
    expect(outcome.decision.action).toBe("deny");
    expect(hook).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
    expect(gate.checkLexical({ kind: "edit", target: lexical })).toBe("deny");
  });
});
