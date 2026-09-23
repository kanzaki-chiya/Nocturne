import { describe, expect, it } from "vitest";

import type { PermissionSubject } from "../protocol/index.js";
import { computeWhere, createWorkspaceReadPolicy } from "./index.js";

const WS = "C:\\ws\\proj";

describe("computeWhere", () => {
  it("等于工作区根 → workspace", () => {
    expect(computeWhere("C:\\ws\\proj", WS, false)).toBe("workspace");
  });

  it("工作区内子路径 → workspace（含反斜杠/正斜杠混用）", () => {
    expect(computeWhere("C:\\ws\\proj\\src\\a.ts", WS, false)).toBe("workspace");
    expect(computeWhere("C:/ws/proj/src/a.ts", WS, false)).toBe("workspace");
  });

  it("工作区外 → outside", () => {
    expect(computeWhere("C:\\ws\\other\\a.ts", WS, false)).toBe("outside");
    expect(computeWhere("D:\\x", WS, false)).toBe("outside");
  });

  it("前缀陷阱：C:\\ws\\proj2 不在 C:\\ws\\proj 内", () => {
    expect(computeWhere("C:\\ws\\proj2\\a.ts", WS, false)).toBe("outside");
  });

  it("大小写不敏感时大小写差异仍算内部", () => {
    expect(computeWhere("c:\\WS\\PROJ\\a.ts", WS, false)).toBe("workspace");
  });

  it("大小写敏感时大小写差异算外部", () => {
    expect(computeWhere("c:\\ws\\proj\\a.ts", WS, true)).toBe("outside");
    expect(computeWhere("C:\\ws\\proj\\a.ts", WS, true)).toBe("workspace");
  });

  it("尾部多余分隔符不影响判定", () => {
    expect(computeWhere("C:\\ws\\proj\\", WS, false)).toBe("workspace");
  });
});

describe("createWorkspaceReadPolicy（Phase 1 固定策略）", () => {
  const policy = createWorkspaceReadPolicy({
    workspaceRoot: WS,
    caseSensitive: false,
  });
  const subject = (over: Partial<PermissionSubject>): PermissionSubject => ({
    kind: "read",
    target: "x",
    ...over,
  });

  it("工作区内 read → allow，where 被填充", () => {
    const r = policy.evaluate([subject({ resolved: "C:\\ws\\proj\\a.ts" })]);
    expect(r.decision.action).toBe("allow");
    expect(r.subjects[0]?.where).toBe("workspace");
  });

  it("工作区外 read → deny", () => {
    const r = policy.evaluate([subject({ resolved: "C:\\ws\\evil.txt" })]);
    expect(r.decision.action).toBe("deny");
    expect(r.decision.source).toBe("rule");
    expect(r.subjects[0]?.where).toBe("outside");
  });

  it("非 read 类别一律 deny（Phase 1 无写/执行工具）", () => {
    const r = policy.evaluate([subject({ kind: "edit", resolved: "C:\\ws\\proj\\a.ts" })]);
    expect(r.decision.action).toBe("deny");
  });

  it("resolved 缺失 → deny（无法证明在工作区内）", () => {
    const r = policy.evaluate([subject({})]);
    expect(r.decision.action).toBe("deny");
    expect(r.subjects[0]?.where).toBeUndefined();
  });

  it("多主体：任一 deny → 整体 deny", () => {
    const r = policy.evaluate([
      subject({ resolved: "C:\\ws\\proj\\ok.ts" }),
      subject({ resolved: "C:\\ws\\out.ts" }),
    ]);
    expect(r.decision.action).toBe("deny");
  });

  it("多主体全部允许 → allow", () => {
    const r = policy.evaluate([
      subject({ resolved: "C:\\ws\\proj\\a.ts" }),
      subject({ resolved: "C:\\ws\\proj\\b\\c.ts" }),
    ]);
    expect(r.decision.action).toBe("allow");
  });

  it("deny 决定包含可解释原因", () => {
    const r = policy.evaluate([subject({ resolved: "C:\\ws\\out.ts" })]);
    expect(r.decision.reason).toContain("out.ts");
  });
});
