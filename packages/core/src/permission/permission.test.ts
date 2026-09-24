import { describe, expect, it } from "vitest";

import type { Grant, PermissionSubject } from "../protocol/index.js";
import {
  computeWhere,
  createDefaultPolicy,
  createRulePolicy,
  createWorkspaceReadPolicy,
} from "./index.js";

const WS = "C:\\ws\\proj";
const HOME = "C:\\Users\\tester\\.nocturne";
const SESSIONS = "C:\\Users\\tester\\.nocturne\\sessions";

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

describe("createDefaultPolicy（Phase 2 default 预设）", () => {
  const subject = (over: Partial<PermissionSubject>): PermissionSubject => ({
    kind: "read",
    target: "x",
    ...over,
  });

  it("工作区内 read → allow", () => {
    const policy = createDefaultPolicy({ workspaceRoot: WS, caseSensitive: false });
    const r = policy.evaluate([subject({ resolved: "C:\\ws\\proj\\a.ts" })]);
    expect(r.decision.action).toBe("allow");
    expect(r.decision.source).toBe("rule");
  });

  it("空主体集 → allow（工具声明不触碰任何资源）", () => {
    const policy = createDefaultPolicy({ workspaceRoot: WS, caseSensitive: false });
    expect(policy.evaluate([]).decision.action).toBe("allow");
  });

  it("工作区外 read → ask", () => {
    const policy = createDefaultPolicy({ workspaceRoot: WS, caseSensitive: false });
    const r = policy.evaluate([subject({ resolved: "C:\\ws\\other\\a.ts" })]);
    expect(r.decision.action).toBe("ask");
    expect(r.decision.source).toBe("rule");
  });

  it("工作区内 edit / shell → ask", () => {
    const policy = createDefaultPolicy({ workspaceRoot: WS, caseSensitive: false });
    expect(
      policy.evaluate([subject({ kind: "edit", resolved: "C:\\ws\\proj\\a.ts" })]).decision.action,
    ).toBe("ask");
    expect(policy.evaluate([subject({ kind: "shell", target: "npm test" })]).decision.action).toBe(
      "ask",
    );
  });

  it("混合主体：含非工作区读 → 整体 ask", () => {
    const policy = createDefaultPolicy({ workspaceRoot: WS, caseSensitive: false });
    const r = policy.evaluate([
      subject({ resolved: "C:\\ws\\proj\\a.ts" }),
      subject({ resolved: "C:\\ws\\out\\b.ts" }),
    ]);
    expect(r.decision.action).toBe("ask");
  });

  it("autoApproveAsk：ask 提升为 allow（source 仍为 rule）", () => {
    const policy = createDefaultPolicy({
      workspaceRoot: WS,
      caseSensitive: false,
      autoApproveAsk: true,
    });
    const r = policy.evaluate([subject({ kind: "edit", resolved: "C:\\ws\\proj\\a.ts" })]);
    expect(r.decision.action).toBe("allow");
    expect(r.decision.source).toBe("rule");
    expect(r.decision.reason).toContain("自动批准");
  });

  it("autoApproveAsk：本就 allow 的工作区读不受影响", () => {
    const policy = createDefaultPolicy({
      workspaceRoot: WS,
      caseSensitive: false,
      autoApproveAsk: true,
    });
    const r = policy.evaluate([subject({ resolved: "C:\\ws\\proj\\a.ts" })]);
    expect(r.decision.action).toBe("allow");
    expect(r.decision.reason).not.toContain("自动批准");
  });
});

describe("createRulePolicy（Phase 3 规则引擎）", () => {
  const subject = (over: Partial<PermissionSubject>): PermissionSubject => ({
    kind: "read",
    target: "x",
    ...over,
  });
  type ExtraOptions = Omit<
    Parameters<typeof createRulePolicy>[0],
    "workspaceRoot" | "caseSensitive" | "preset" | "presetContext"
  >;
  const policyFor = (
    preset: "read-only" | "default" | "auto-edit" | "full-access",
    extra?: ExtraOptions,
  ) =>
    createRulePolicy({
      workspaceRoot: WS,
      caseSensitive: false,
      preset,
      presetContext: { sessionsDir: SESSIONS, sessionId: "s1", nocturneHome: HOME },
      ...extra,
    });
  const actionOf = (
    preset: "read-only" | "default" | "auto-edit" | "full-access",
    s: PermissionSubject,
    extra?: ExtraOptions,
  ) => policyFor(preset, extra).evaluate([s]).decision.action;

  it("预设矩阵：read-only", () => {
    expect(actionOf("read-only", subject({ resolved: "C:\\ws\\proj\\a.ts" }))).toBe("allow");
    expect(actionOf("read-only", subject({ resolved: "D:\\else\\a.ts" }))).toBe("ask");
    expect(actionOf("read-only", subject({ kind: "edit", resolved: "C:\\ws\\proj\\a.ts" }))).toBe(
      "deny",
    );
    expect(actionOf("read-only", subject({ kind: "shell", target: "ls" }))).toBe("ask");
  });

  it("预设矩阵：auto-edit / full-access", () => {
    expect(actionOf("auto-edit", subject({ kind: "edit", resolved: "C:\\ws\\proj\\a.ts" }))).toBe(
      "allow",
    );
    expect(actionOf("auto-edit", subject({ kind: "edit", resolved: "D:\\else\\a.ts" }))).toBe(
      "ask",
    );
    expect(actionOf("full-access", subject({ kind: "shell", target: "pnpm test" }))).toBe("allow");
    expect(actionOf("full-access", subject({ kind: "edit", resolved: "D:\\else\\a.ts" }))).toBe(
      "ask",
    );
  });

  it("受保护路径：default 中 .git/.nocturne edit → ask", () => {
    const r = policyFor("default").evaluate([
      subject({ kind: "edit", resolved: "C:\\ws\\proj\\.git\\config" }),
    ]);
    expect(r.decision.action).toBe("ask");
    expect(r.decision.matchedRule?.rule?.label).toBe("受保护路径");
    expect(
      actionOf("default", subject({ kind: "edit", resolved: "C:\\ws\\proj\\.nocturne\\x.json" })),
    ).toBe("ask");
  });

  it("read-only 中受保护路径保持 deny（不生成 ask 规则）", () => {
    const r = policyFor("read-only").evaluate([
      subject({ kind: "edit", resolved: "C:\\ws\\proj\\.git\\config" }),
    ]);
    expect(r.decision.action).toBe("deny");
    expect(r.decision.matchedRule?.rule?.label).not.toBe("受保护路径");
  });

  it("授权数据保护：config.json / trust.json / grants/** 的 edit → ask 且带标签", () => {
    for (const p of [`${HOME}\\config.json`, `${HOME}\\trust.json`, `${HOME}\\grants\\abc.json`]) {
      const r = policyFor("full-access").evaluate([subject({ kind: "edit", resolved: p })]);
      expect(r.decision.action).toBe("ask");
      expect(r.decision.matchedRule?.rule?.label).toBe("修改 Nocturne 授权配置");
    }
    // read-only 中仍是 deny
    expect(actionOf("read-only", subject({ kind: "edit", resolved: `${HOME}\\trust.json` }))).toBe(
      "deny",
    );
  });

  it("本会话落盘目录 read → allow；其他会话附件仍 ask", () => {
    expect(
      actionOf("default", subject({ resolved: `${SESSIONS}\\attachments\\s1\\call1.txt` })),
    ).toBe("allow");
    const r = policyFor("default").evaluate([
      subject({ resolved: `${SESSIONS}\\attachments\\s2\\call1.txt` }),
    ]);
    expect(r.decision.action).toBe("ask");
    expect(r.decision.matchedRule?.rule?.label).not.toBe("本会话落盘目录");
  });

  it("full-access 高风险 shell 保持 ask", () => {
    const r = policyFor("full-access").evaluate([
      subject({ kind: "shell", target: "sudo rm -rf /" }),
    ]);
    expect(r.decision.action).toBe("ask");
    expect(r.decision.matchedRule?.rule?.label).toBe("高风险命令");
  });

  it("分层规则后写优先：用户规则覆盖预设", () => {
    const policy = policyFor("default", {
      rules: [
        {
          rule: { kind: "edit", pattern: "src/**", action: "allow" },
          origin: "user",
        },
      ],
    });
    const r = policy.evaluate([subject({ kind: "edit", resolved: "C:\\ws\\proj\\src\\a.ts" })]);
    expect(r.decision.action).toBe("allow");
    expect(r.decision.matchedRule?.origin).toBe("user");
  });

  it("不可信项目规则只收紧：deny 生效，allow 不放宽", () => {
    const policy = policyFor("default", {
      untrustedRules: [
        // 试图收紧：edit src/** deny
        { rule: { kind: "edit", pattern: "src/**", action: "deny" }, origin: "project-untrusted" },
        // 试图放宽（构造中不应出现 allow，但防御性验证）：shell * allow
        { rule: { kind: "shell", pattern: "*", action: "allow" }, origin: "project-untrusted" },
      ],
    });
    expect(
      policy.evaluate([subject({ kind: "edit", resolved: "C:\\ws\\proj\\src\\a.ts" })]).decision
        .action,
    ).toBe("deny");
    // 不可信 allow 不会把 ask 提升为 allow
    expect(policy.evaluate([subject({ kind: "shell", target: "ls" })]).decision.action).toBe("ask");
  });

  it("组合命令：模式匹配的 allow 降级为 ask", () => {
    const r = policyFor("full-access").evaluate([
      subject({ kind: "shell", target: "ls && rm -rf x" }),
    ]);
    expect(r.decision.action).toBe("ask");
    expect(r.decision.reason).toContain("降级");
  });

  it("Grant 精确匹配：shell 全串一致才生效，且只提升 ask", () => {
    const session: Grant[] = [
      { kind: "shell", target: "git status", createdAt: "2026-01-01T00:00:00Z" },
    ];
    const policy = policyFor("default", { grants: { session } });
    // 精确命中 → allow
    const hit = policy.evaluate([subject({ kind: "shell", target: "git status" })]);
    expect(hit.decision.action).toBe("allow");
    expect(hit.decision.source).toBe("grant");
    // 前缀/超集不匹配 → 仍 ask
    expect(
      policy.evaluate([subject({ kind: "shell", target: "git status --all" })]).decision.action,
    ).toBe("ask");
    // deny 不被 Grant 提升：read-only 下 edit 仍 deny
    const ro = policyFor("read-only", {
      grants: {
        session: [
          {
            kind: "edit",
            target: "c:/ws/proj/a.ts",
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
      },
    });
    expect(
      ro.evaluate([subject({ kind: "edit", resolved: "C:\\ws\\proj\\a.ts" })]).decision.action,
    ).toBe("deny");
  });

  it("autoApproveAsk 不覆盖 deny", () => {
    const policy = policyFor("read-only", { autoApproveAsk: true });
    expect(
      policy.evaluate([subject({ kind: "edit", resolved: "C:\\ws\\proj\\a.ts" })]).decision.action,
    ).toBe("deny");
    expect(policy.evaluate([subject({ kind: "shell", target: "ls" })]).decision.action).toBe(
      "allow",
    );
  });

  it("命中解释：reason 含命中描述与 label", () => {
    const r = policyFor("default").evaluate([
      subject({ kind: "edit", resolved: "C:\\ws\\proj\\.git\\config" }),
    ]);
    expect(r.decision.reason).toContain("受保护路径");
    expect(r.decision.matchedRule?.description).toContain("预设");
  });

  it("命中解释：非路径类主体原样展示 target，不称无法解析路径", () => {
    const shell = policyFor("default").evaluate([subject({ kind: "shell", target: "echo hi" })]);
    expect(shell.decision.reason).toContain("shell echo hi（命中：预设 default");
    expect(shell.decision.reason).not.toContain("无法解析路径");

    // 路径类主体没解析出 resolved 时仍如实说明
    const read = policyFor("default").evaluate([subject({ kind: "read", target: "C:\\gone\\x" })]);
    expect(read.decision.reason).toContain("无法解析路径");
  });
});

describe("provider-setup 权限规则（provider-setup.md 第 8 节）", () => {
  const subject = (over: Partial<PermissionSubject>): PermissionSubject => ({
    kind: "read",
    target: "x",
    ...over,
  });
  const CRED_INDEX = `${HOME}\\credentials.json`;
  const protectedPaths = {
    lexical: [CRED_INDEX],
    resolved: [`C:\\Users\\tester\\.nocturne\\credentials.json`],
  };

  it("providers.json 加入授权数据组：edit → ask 且带标签", () => {
    const policy = createRulePolicy({
      workspaceRoot: WS,
      caseSensitive: false,
      preset: "full-access",
      presetContext: { nocturneHome: HOME },
    });
    const r = policy.evaluate([subject({ kind: "edit", resolved: `${HOME}\\providers.json` })]);
    expect(r.decision.action).toBe("ask");
    expect(r.decision.matchedRule?.rule?.label).toBe("修改 Nocturne 授权配置");
  });

  it("凭据索引内置硬拒绝：任何规则/Grant/--yes/full-access 都不能放开", () => {
    const grants: Grant[] = [
      { kind: "read", target: CRED_INDEX, createdAt: "2026-01-01T00:00:00Z" },
    ];
    for (const preset of ["read-only", "default", "auto-edit", "full-access"] as const) {
      for (const extra of [
        { protectedPaths },
        // Grant 精确匹配也不能放开
        { protectedPaths, grants: { session: grants } },
        // --yes 也不能放开
        { protectedPaths, autoApproveAsk: true },
        // 用户层显式 allow 也不能放开
        {
          protectedPaths,
          rules: [{ rule: { pattern: "**", action: "allow" as const }, origin: "user" as const }],
        },
      ]) {
        const policy = createRulePolicy({
          workspaceRoot: WS,
          caseSensitive: false,
          preset,
          ...extra,
        });
        for (const kind of ["read", "edit"] as const) {
          const r = policy.evaluate([subject({ kind, target: CRED_INDEX, resolved: CRED_INDEX })]);
          expect(r.decision.action).toBe("deny");
          expect(r.decision.reason).toContain("硬拒绝");
        }
      }
    }
  });

  it("硬拒绝同时匹配词法路径与真实路径（junction 不能绕过）", () => {
    const policy = createRulePolicy({
      workspaceRoot: WS,
      caseSensitive: false,
      preset: "full-access",
      protectedPaths,
    });
    // 词法不同、真实路径命中
    const viaJunction = policy.evaluate([
      subject({
        kind: "read",
        target: "D:\\junction\\credentials.json",
        resolved: CRED_INDEX,
      }),
    ]);
    expect(viaJunction.decision.action).toBe("deny");
    // 原子写临时文件同样拒绝
    const tmp = policy.evaluate([subject({ kind: "edit", target: `${CRED_INDEX}.tmp-1234` })]);
    expect(tmp.decision.action).toBe("deny");
  });

  it("凭据后端命令至少 ask：shell allow 命中读取命令时降级", () => {
    const policy = createRulePolicy({
      workspaceRoot: WS,
      caseSensitive: false,
      preset: "full-access",
    });
    for (const cmd of [
      "security find-generic-password -s nocturne -a corp -w",
      "secret-tool lookup service nocturne provider corp",
      'powershell -NoProfile -Command "[System.Security.Cryptography.ProtectedData]::Unprotect()"',
    ]) {
      const r = policy.evaluate([subject({ kind: "shell", target: cmd })]);
      expect(r.decision.action).toBe("ask");
      expect(r.decision.reason).toContain("凭据");
    }
    // 普通命令不受影响
    expect(
      policy.evaluate([subject({ kind: "shell", target: "git status" })]).decision.action,
    ).toBe("allow");
  });
});
