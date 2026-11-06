import { describe, expect, it, vi } from "vitest";
import { createPolicyGate, createRulePolicy, PERMISSION_PRESET_NAMES } from "./index.js";
import type { GateTurnContext } from "./types.js";
import type { AnnotatedRule, Grant, PermissionSubject } from "../protocol/index.js";

const ctx = { workspaceRoot: "C:/ws", caseSensitive: false, nocturneHome: "C:/home" };
const app = (target = "excel.exe"): PermissionSubject => ({ kind: "app", target });
const rule = (
  pattern: string,
  action: "allow" | "ask" | "deny",
  origin: AnnotatedRule["origin"] = "user",
): AnnotatedRule => ({ origin, rule: { kind: "app", pattern, action } });

function setup(
  save = vi.fn(async (_subjects: PermissionSubject[]) => undefined),
  grants: Grant[] = [],
) {
  const events: { type: string; payload: unknown }[] = [];
  const policy = createRulePolicy({
    ...ctx,
    preset: "bypass",
    rules: [],
    grants: { session: grants },
  });
  const gate = createPolicyGate(policy, {
    interactive: true,
    caseSensitive: false,
    grants: { session: grants },
    saveAppPermissions: save,
  });
  const turn: GateTurnContext = {
    turnId: "turn",
    events: {
      emit: async (type, payload) => {
        events.push({ type, payload });
      },
      emitEphemeral: vi.fn((type, payload) => {
        events.push({ type, payload });
      }),
    },
  };
  const check = (subjects = [app()]) =>
    gate.check(subjects, `call-${events.length}`, new AbortController().signal, turn);
  const request = async () => {
    await vi.waitFor(() =>
      expect(events.some((e) => e.type === "permission.requested")).toBe(true),
    );
    return events.filter((e) => e.type === "permission.requested").at(-1)?.payload as {
      requestId: string;
      options: string[];
    };
  };
  if (gate.respond === undefined || gate.cancelAll === undefined) throw new Error("缺少交互闸门");
  return { gate, events, check, request, save, respond: gate.respond, cancelAll: gate.cancelAll };
}

describe("ADR-0082 app 权限", () => {
  it("未解析 PID 不能由通配 allow 或会话 Grant 放行", () => {
    const policy = createRulePolicy({
      ...ctx,
      rules: [rule("*", "allow")],
      grants: { session: [{ kind: "app", target: "PID 99", createdAt: "now" }] },
    });
    expect(
      policy.evaluate([{ kind: "app", target: "PID 99", appUnresolved: true }]).decision.action,
    ).toBe("ask");
  });
  it.each(PERMISSION_PRESET_NAMES)("%s 下 app 默认 ask，不能自动批准", (preset) => {
    const policy = createRulePolicy({ ...ctx, preset, autoApproveAsk: true });
    expect(policy.evaluate([app()])).toMatchObject({ decision: { action: "ask" }, userOnly: true });
  });
  it("app 通配和精确用户规则生效，项目 allow 不能放宽", () => {
    const policy = createRulePolicy({
      ...ctx,
      rules: [rule("*", "deny"), rule("excel.exe", "allow"), rule("*", "allow", "project")],
    });
    expect(policy.evaluate([app()]).decision.action).toBe("allow");
    expect(policy.evaluate([app("notepad.exe")]).decision.action).toBe("deny");
    expect(
      createRulePolicy({ ...ctx, rules: [rule("*", "allow", "project")] }).evaluate([app()])
        .decision.action,
    ).toBe("ask");
  });
  it("项目 deny 收紧用户 allow；泛类别规则不能默许 app", () => {
    expect(
      createRulePolicy({
        ...ctx,
        rules: [rule("*", "allow"), rule("excel.exe", "deny", "project")],
      }).evaluate([app()]).decision.action,
    ).toBe("deny");
    expect(
      createRulePolicy({
        ...ctx,
        rules: [{ origin: "user", rule: { kind: "*", pattern: "*", action: "allow" } }],
      }).evaluate([app()]).decision.action,
    ).toBe("ask");
  });
  it("app 不接受项目 Grant", () => {
    expect(
      createRulePolicy({
        ...ctx,
        grants: { project: [{ kind: "app", target: "excel.exe", createdAt: "now" }] },
      }).evaluate([app()]).decision.action,
    ).toBe("ask");
  });
  it("全是 app 时只有三项；会话允许仅覆盖相同软件", async () => {
    const s = setup();
    const first = s.check();
    const request = await s.request();
    expect(request.options).toEqual(["allow_session", "allow_always", "deny"]);
    await s.respond(request.requestId, { decision: "allow", remember: "session" });
    expect((await first).decision.action).toBe("allow");
    expect((await s.check()).decision.source).toBe("grant");
    const second = s.check([app("notepad.exe")]);
    await vi.waitFor(() =>
      expect(s.events.filter((e) => e.type === "permission.requested")).toHaveLength(2),
    );
    s.cancelAll();
    await second;
  });
  it("混合主体没有 allow_always，伪造回复被拒绝", async () => {
    const s = setup();
    const pending = s.check([app(), { kind: "mcp", target: "server/tool" }]);
    const request = await s.request();
    expect(request.options).not.toContain("allow_always");
    expect(await s.respond(request.requestId, { decision: "allow", remember: "always" })).toBe(
      false,
    );
    s.cancelAll();
    await pending;
  });
  it("始终允许由权限层写用户规则", async () => {
    const s = setup();
    const pending = s.check();
    const request = await s.request();
    expect(await s.respond(request.requestId, { decision: "allow", remember: "always" })).toBe(
      true,
    );
    expect((await pending).remember).toBe("always");
    expect(s.save).toHaveBeenCalledWith([app()]);
  });
  it("写入失败降级会话 Grant 并发警告", async () => {
    const s = setup(
      vi.fn(async () => {
        throw new Error("disk full");
      }),
    );
    const pending = s.check();
    const request = await s.request();
    await s.respond(request.requestId, { decision: "allow", remember: "always" });
    expect((await pending).remember).toBe("session");
    expect(s.events).toContainEqual(
      expect.objectContaining({
        type: "runtime.warning",
        payload: expect.objectContaining({ code: "app_permission_save_failed" }),
      }),
    );
    expect((await s.check()).decision.source).toBe("grant");
  });
});
