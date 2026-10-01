import { describe, expect, it } from "vitest";
import type { PermissionSubject } from "../protocol/index.js";
import { createRulePolicy, grantFromSubject, grantKey, matchGrant } from "./index.js";

describe("PermissionSubject.detail 仅作显示", () => {
  const subject: PermissionSubject = {
    kind: "network",
    target: "docs.example",
    detail: "https://docs.example/start",
  };
  const base = { workspaceRoot: "C:/workspace", caseSensitive: true };

  it.each(["default", "read-only", "auto-edit", "guarded"] as const)(
    "%s 预设不读取 detail",
    (preset) => {
      const policy = createRulePolicy({ ...base, preset });
      const result = policy.evaluate([subject]);
      expect(result.decision.action).toBe(preset === "guarded" ? "allow" : "ask");
      expect(policy.evaluate([{ ...subject, detail: "deny everything" }]).decision).toEqual(
        result.decision,
      );
      expect(result.subjects[0]?.detail).toBe(subject.detail);
    },
  );

  it("network 通配符规则只匹配 target，URL 不影响规则", () => {
    const policy = createRulePolicy({
      ...base,
      rules: [{ rule: { kind: "network", pattern: "*.example", action: "allow" }, origin: "user" }],
    });
    expect(policy.evaluate([subject]).decision.action).toBe("allow");
    expect(
      policy.evaluate([{ ...subject, target: "unapproved.invalid", detail: subject.detail }])
        .decision.action,
    ).toBe("ask");
  });

  it("授权键与 Grant 不含 detail，同主机另一页面匹配，其他端口不匹配", () => {
    const grant = grantFromSubject(subject, true, "2026-09-30T00:00:00.000Z");
    expect(grantKey(subject, true)).toBe("docs.example");
    expect(grant).toEqual({
      kind: "network",
      target: "docs.example",
      createdAt: "2026-09-30T00:00:00.000Z",
    });
    expect(matchGrant([grant], { ...subject, detail: "https://docs.example/other" }, true)).toBe(
      grant,
    );
    expect(matchGrant([grant], { ...subject, target: "docs.example:8443" }, true)).toBeUndefined();
  });
});
