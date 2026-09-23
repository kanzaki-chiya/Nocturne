import { describe, expect, it } from "vitest";

import type { RuntimeEvent } from "@nocturne/core/protocol";

import { renderDiff, renderEvent, renderPermissionPrompt } from "../src/render.js";

const durable = <T extends RuntimeEvent["type"]>(
  type: T,
  payload: Extract<RuntimeEvent, { type: T }>["payload"],
): RuntimeEvent => ({ type, sessionId: "s", seq: 1, time: "", payload }) as RuntimeEvent;

const ephemeral = <T extends RuntimeEvent["type"]>(
  type: T,
  payload: Extract<RuntimeEvent, { type: T }>["payload"],
): RuntimeEvent =>
  ({ type, sessionId: "s", runId: "r", eseq: 1, afterSeq: 0, time: "", payload }) as RuntimeEvent;

describe("事件渲染（cli.md 第 5 节）", () => {
  it("非交互模式：text delta → stdout，其余 → stderr", () => {
    const text = renderEvent(
      ephemeral("message.assistant.delta", { messageId: "m", kind: "text", delta: "hi" }),
      "print",
    );
    expect(text).toEqual([{ channel: "stdout", text: "hi" }]);

    const tool = renderEvent(
      durable("tool.started", {
        callId: "c",
        name: "read",
        input: { path: "a.ts" },
        subjects: [],
        permission: { action: "allow", source: "rule" },
      }),
      "print",
    );
    expect(tool[0]?.channel).toBe("stderr");
    expect(tool[0]?.text).toContain("read(");
    expect(tool[0]?.text).toContain("a.ts");
  });

  it("交互模式：状态行走 stdout", () => {
    const tool = renderEvent(
      durable("tool.started", {
        callId: "c",
        name: "shell",
        input: {},
        subjects: [],
        permission: { action: "allow", source: "user" },
      }),
      "interactive",
    );
    expect(tool[0]?.channel).toBe("stdout");
  });

  it("tool.completed：ok 与 denied 形态", () => {
    const ok = renderEvent(
      durable("tool.completed", {
        callId: "c",
        name: "read",
        status: "ok",
        modelContent: "",
        durationMs: 12,
      }),
      "interactive",
    );
    expect(ok[0]?.text).toContain("ok");

    const denied = renderEvent(
      durable("tool.completed", {
        callId: "c",
        name: "write",
        status: "denied",
        modelContent: "",
        error: { code: "permission_denied", message: "被拒绝" },
      }),
      "interactive",
    );
    expect(denied[0]?.text).toContain("denied");
    expect(denied[0]?.text).toContain("permission_denied");
  });

  it("tool.completed 携带 output.diff 时渲染 diff", () => {
    const ev = renderEvent(
      durable("tool.completed", {
        callId: "c",
        name: "edit",
        status: "ok",
        modelContent: "",
        output: { path: "a.ts", diff: "--- a.ts\n+++ a.ts\n@@ -1 +1 @@\n-old\n+new" },
      }),
      "interactive",
    );
    expect(ev.some((r) => r.text.includes("-old") && r.text.includes("+new"))).toBe(true);
  });

  it("permission.resolved / context.compacted / provider.retry / runtime.error", () => {
    const r = renderEvent(
      durable("permission.resolved", {
        callId: "c",
        action: "allow",
        source: "user",
      }),
      "interactive",
    );
    expect(r[0]?.text).toContain("allow");

    const c = renderEvent(
      durable("context.compacted", { kind: "summary", throughSeq: 42 }),
      "interactive",
    );
    expect(c[0]?.text).toContain("summary");
    expect(c[0]?.text).toContain("42");

    const retry = renderEvent(
      ephemeral("provider.retry", {
        attempt: 1,
        maxAttempts: 3,
        delayMs: 500,
        error: { kind: "rate_limit", message: "x" },
      }),
      "interactive",
    );
    expect(retry[0]?.text).toContain("rate_limit");
    expect(retry[0]?.text).toContain("1/3");

    const err = renderEvent(ephemeral("runtime.error", { code: "boom", message: "坏了" }), "print");
    expect(err[0]?.channel).toBe("stderr");
  });

  it("turn.completed：done 时交互模式附用量行；非 done 附原因", () => {
    const done = renderEvent(
      durable("turn.completed", {
        reason: "done",
        steps: 2,
        usage: { inputTokens: 100, outputTokens: 20 },
      }),
      "interactive",
    );
    expect(done.some((r) => r.text.includes("100"))).toBe(true);

    const failed = renderEvent(
      durable("turn.completed", {
        reason: "error",
        steps: 1,
        usage: { inputTokens: 0, outputTokens: 0 },
        error: { code: "provider_error", message: "挂了" },
      }),
      "print",
    );
    expect(failed[0]?.text).toContain("error");
    expect(failed[0]?.channel).toBe("stderr");
  });

  it("tool.input.delta 与 runtime.status(idle) 不渲染", () => {
    expect(
      renderEvent(
        ephemeral("tool.input.delta", { callId: "c", name: "x", delta: "{}" }),
        "interactive",
      ),
    ).toEqual([]);
    expect(renderEvent(ephemeral("runtime.status", { status: "idle" }), "interactive")).toEqual([]);
  });

  it("renderDiff：增删行着色标记存在（NO_COLOR 降级不报错）", () => {
    const out = renderDiff("--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y");
    expect(out).toContain("-x");
    expect(out).toContain("+y");
  });

  it("权限提示块：列出主体与 a/d 选项", () => {
    const text = renderPermissionPrompt(
      [{ kind: "write", target: "src/a.ts", resolved: "Z:\\w\\src\\a.ts" }],
      "default 预设：需确认",
    );
    expect(text).toContain("write: src/a.ts");
    expect(text).toContain("→ Z:\\w\\src\\a.ts");
    expect(text).toContain("允许一次");
    expect(text).toContain("拒绝");
  });
});
