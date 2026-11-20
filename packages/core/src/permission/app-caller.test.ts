import { describe, expect, it } from "vitest";
import type { AnnotatedRule, PermissionSubject } from "../protocol/index.js";
import { createRulePolicy } from "./index.js";

const WS = "C:\\ws\\proj";

const mcpSubject = (target: string, readOnly?: boolean): PermissionSubject => ({
  kind: "mcp",
  target,
  ...(readOnly !== undefined ? { readOnly } : {}),
});

const mcpRule = (
  pattern: string,
  action: "allow" | "ask" | "deny",
  origin: AnnotatedRule["origin"] = "user",
): AnnotatedRule => ({
  origin,
  rule: { kind: "mcp", pattern, action },
});

describe("ADR-0101 页面来源（caller: app）权限判定", () => {
  const caller = { kind: "app" as const, serverId: "demo" };

  it("只读 + allow 规则 → 放行", () => {
    const policy = createRulePolicy({
      workspaceRoot: WS,
      caseSensitive: false,
      preset: "default",
      rules: [mcpRule("demo/*", "allow")],
    });
    const res = policy.evaluate([mcpSubject("demo/inspect", true)], { caller });
    expect(res.decision.action).toBe("allow");
    expect(res.decision.errorCode).toBeUndefined();
  });

  it("只读 + ask（default 与 read-only 预设）→ 放行且不弹确认", () => {
    for (const preset of ["default", "read-only"] as const) {
      const policy = createRulePolicy({
        workspaceRoot: WS,
        caseSensitive: false,
        preset,
      });
      const res = policy.evaluate([mcpSubject("demo/inspect", true)], { caller });
      expect(res.decision.action).toBe("allow");
      expect(res.decision.errorCode).toBeUndefined();
    }
  });

  it("只读 + deny（用户规则或不可信项目规则）→ 拒绝", () => {
    const byUser = createRulePolicy({
      workspaceRoot: WS,
      caseSensitive: false,
      preset: "bypass",
      rules: [mcpRule("demo/inspect", "deny", "user")],
    });
    const r1 = byUser.evaluate([mcpSubject("demo/inspect", true)], { caller });
    expect(r1.decision.action).toBe("deny");
    expect(r1.decision.errorCode).toBeUndefined();

    const byUntrusted = createRulePolicy({
      workspaceRoot: WS,
      caseSensitive: false,
      preset: "default",
      untrustedRules: [mcpRule("demo/*", "deny", "project")],
    });
    const r2 = byUntrusted.evaluate([mcpSubject("demo/inspect", true)], { caller });
    expect(r2.decision.action).toBe("deny");
    expect(r2.decision.errorCode).toBeUndefined();
  });

  it("非只读 + bypass / guarded 预设 → 拒绝并返回 app_tool_not_allowed", () => {
    for (const preset of ["bypass", "guarded"] as const) {
      const policy = createRulePolicy({
        workspaceRoot: WS,
        caseSensitive: false,
        preset,
      });
      const rFalse = policy.evaluate([mcpSubject("demo/mutate", false)], { caller });
      expect(rFalse.decision.action).toBe("deny");
      expect(rFalse.decision.errorCode).toBe("app_tool_not_allowed");

      const rMissing = policy.evaluate([mcpSubject("demo/mutate")], { caller });
      expect(rMissing.decision.action).toBe("deny");
      expect(rMissing.decision.errorCode).toBe("app_tool_not_allowed");
    }
  });

  it("非只读 + 显式 allow 规则 → 拒绝并返回 app_tool_not_allowed", () => {
    const policy = createRulePolicy({
      workspaceRoot: WS,
      caseSensitive: false,
      preset: "default",
      rules: [mcpRule("demo/*", "allow", "user"), mcpRule("*", "allow", "cli")],
    });
    const res = policy.evaluate([mcpSubject("demo/mutate", false)], { caller });
    expect(res.decision.action).toBe("deny");
    expect(res.decision.errorCode).toBe("app_tool_not_allowed");
  });

  it("跨服务器调用 → 拒绝并返回 app_tool_not_allowed（即使只读且 bypass）", () => {
    const policy = createRulePolicy({
      workspaceRoot: WS,
      caseSensitive: false,
      preset: "bypass",
      rules: [mcpRule("*", "allow", "user")],
    });
    const res = policy.evaluate([mcpSubject("other/inspect", true)], { caller });
    expect(res.decision.action).toBe("deny");
    expect(res.decision.errorCode).toBe("app_tool_not_allowed");
  });

  it("空主体或非 MCP 主体在页面来源下拒绝", () => {
    const policy = createRulePolicy({
      workspaceRoot: WS,
      caseSensitive: false,
      preset: "bypass",
    });
    expect(policy.evaluate([], { caller }).decision).toMatchObject({
      action: "deny",
      errorCode: "app_tool_not_allowed",
    });
    expect(
      policy.evaluate([{ kind: "read", target: "a.txt", resolved: `${WS}\\a.txt` }], { caller })
        .decision,
    ).toMatchObject({
      action: "deny",
      errorCode: "app_tool_not_allowed",
    });
  });
});
