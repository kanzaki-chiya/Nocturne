import { describe, expect, it } from "vitest";

import type { RuntimeEvent } from "@nocturne/core/protocol";

import {
  createEventWriter,
  renderDiff,
  renderEvent,
  renderPermissionPrompt,
  type Channel,
} from "../src/render.js";

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
  it("todo_write 在交互与打印模式逐次输出完整清单，失败不打印快照", () => {
    const payload = {
      callId: "todo",
      name: "todo_write",
      status: "ok" as const,
      modelContent: "updated",
      output: {
        items: [
          { text: "甲", status: "completed" },
          { text: "乙", status: "in_progress" },
        ],
      },
    };
    const interactive = renderEvent(durable("tool.completed", payload), "interactive");
    expect(interactive.map((part) => part.text).join("\n")).toContain("已完成 1/2");
    expect(interactive.map((part) => part.text).join("\n")).toContain("[>] 乙");
    const printed = renderEvent(durable("tool.completed", payload), "print");
    expect(printed.every((part) => part.channel === "stderr")).toBe(true);
    expect(
      renderEvent(durable("tool.completed", { ...payload, output: { items: [] } }), "interactive")
        .map((part) => part.text)
        .join("\n"),
    ).toContain("已完成 0/0");
    expect(
      renderEvent(durable("tool.completed", { ...payload, status: "error" }), "interactive")
        .map((part) => part.text)
        .join("\n"),
    ).not.toContain("已完成");
  });

  it("非交互模式：text delta → stdout，其余 → stderr", () => {
    const text = renderEvent(
      ephemeral("message.assistant.delta", { messageId: "m", kind: "text", delta: "hi" }),
      "print",
    );
    expect(text).toEqual([{ channel: "stdout", text: "hi", stream: true }]);

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

  it("带行号 diff 完整输出、准确计数，旧头部不臆造行号", () => {
    const diff = "@@ -2,2 +2,3 @@\n same\n-old\n+new\n+extra";
    const rendered = renderDiff(diff);
    expect(rendered).toContain("   2    2  same");
    expect(rendered).toContain("   3      -old");
    expect(rendered).toContain("        3 +new");
    expect(rendered).toContain("        4 +extra");
    const ev = renderEvent(
      durable("tool.completed", {
        callId: "c",
        name: "edit",
        status: "ok",
        modelContent: "已修改 a.ts",
        output: { path: "a.ts", diff },
      }),
      "print",
    );
    expect(ev.every((r) => r.channel === "stderr")).toBe(true);
    expect(ev.map((r) => r.text).join("\n")).toContain("新增 2 行，删除 1 行");
    expect(renderDiff("@@ a.ts @@\n-old\n+new")).toContain("         -old");
    expect(renderDiff("+created")).toContain("         +created");
    expect(renderDiff("@@ -1,1 +1,1 @@\n--- source\n+++ source")).toContain("   1      --- source");
    expect(renderDiff("@@ -1,1 +1,1 @@\n--- source\n+++ source")).toContain("        1 +++ source");
  });

  it("结构化输出省略时显示真实省略提示", () => {
    const ev = renderEvent(
      durable("tool.completed", {
        callId: "c",
        name: "write",
        status: "ok",
        modelContent: "已创建 a.ts\n[结构化 output 超过大小上限，已省略]",
      }),
      "interactive",
    );
    expect(ev.map((r) => r.text).join("\n")).toContain("结构化 output 超过大小上限，已省略");
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

describe("写出器：整行与流式片段的换行（cli.md 第 5 节）", () => {
  const capture = () => {
    const chunks: { channel: Channel; text: string }[] = [];
    const writer = createEventWriter((channel, text) => {
      chunks.push({ channel, text });
    });
    const joined = (channel: Channel) =>
      chunks
        .filter((c) => c.channel === channel)
        .map((c) => c.text)
        .join("");
    return { writer, joined };
  };

  it("交互模式：模型文本后的状态行另起一行，状态行之间各占一行", () => {
    const { writer, joined } = capture();
    const events: RuntimeEvent[] = [
      ephemeral("message.assistant.delta", { messageId: "m", kind: "text", delta: "先看看" }),
      durable("tool.completed", {
        callId: "c",
        name: "shell",
        status: "ok",
        modelContent: "",
        durationMs: 3,
      }),
      ephemeral("message.assistant.delta", { messageId: "m", kind: "text", delta: "好了" }),
      durable("turn.completed", {
        reason: "done",
        steps: 2,
        usage: { inputTokens: 1, outputTokens: 2 },
      }),
    ];
    for (const ev of events) writer.write(renderEvent(ev, "interactive"));
    const lines = joined("stdout").split("\n");
    expect(lines[0]).toBe("先看看");
    expect(lines[1]).toContain("ok");
    expect(lines[2]).toBe("好了");
    expect(lines[3]).toContain("tokens: in 1 / out 2");
    expect(joined("stdout").endsWith("\n")).toBe(true);
  });

  it("非交互模式：stdout 保持纯模型文本，状态行在 stderr 各占一行", () => {
    const { writer, joined } = capture();
    writer.write(
      renderEvent(
        ephemeral("message.assistant.delta", { messageId: "m", kind: "text", delta: "答案" }),
        "print",
      ),
    );
    writer.write(renderEvent(ephemeral("runtime.error", { code: "a", message: "x" }), "print"));
    writer.write(renderEvent(ephemeral("runtime.error", { code: "b", message: "y" }), "print"));
    expect(joined("stdout")).toBe("答案");
    expect(joined("stderr")).toBe("! a: x\n! b: y\n");
  });

  it("shell 进度：片段断在行中间时不重复缩进、不插入多余换行", () => {
    const { writer, joined } = capture();
    const progress = (chunk: string) =>
      renderEvent(
        ephemeral("tool.progress", { callId: "c", stream: "stdout", chunk }),
        "interactive",
      );
    writer.write(progress("line one\nline t"));
    writer.write(progress("wo\n\nlast"));
    writer.line("stdout", "└ ok");
    expect(joined("stdout")).toBe("  line one\n  line two\n\n  last\n└ ok\n");
  });

  it("子代理进度：info 每次调用独立成行，不粘连", () => {
    const { writer, joined } = capture();
    for (const chunk of ["子会话第 1 轮开始", "read → ok"]) {
      writer.write(
        renderEvent(ephemeral("tool.progress", { callId: "c", stream: "info", chunk }), "print"),
      );
    }
    expect(joined("stdout")).toBe("");
    expect(joined("stderr")).toBe("  子会话第 1 轮开始\n  read → ok\n");
  });

  it("line / endLine：已在行首时不补空行", () => {
    const { writer, joined } = capture();
    writer.line("stdout", "a");
    writer.endLine("stdout");
    writer.line("stdout", "b");
    expect(joined("stdout")).toBe("a\nb\n");
  });
});

describe("智能权限审查行", () => {
  for (const [verdict, label] of [
    ["allow", "放行"],
    ["block", "拦截"],
    ["unsure", "拿不准"],
  ] as const) {
    it(`${label} 理由及审查用量在交互和打印输出单列显示`, () => {
      const event = durable("permission.reviewed", {
        callId: "c",
        backend: "model",
        verdict,
        reason: "用户授权范围\n检查完毕",
        durationMs: 30,
        cached: false,
        usage: { inputTokens: 12, outputTokens: 3 },
      });
      for (const mode of ["interactive", "print"] as const) {
        expect(renderEvent(event, mode)).toEqual([
          {
            channel: mode === "print" ? "stderr" : "stdout",
            text: `审查：${label} — 用户授权范围 检查完毕（审查用量：12 输入 / 3 输出）`,
          },
        ]);
      }
    });
  }
  it("审查器结算不重复输出权限行，用户结算照常输出", () => {
    for (const mode of ["interactive", "print"] as const) {
      expect(
        renderEvent(
          durable("permission.resolved", { callId: "c", action: "allow", source: "reviewer" }),
          mode,
        ),
      ).toEqual([]);
      expect(
        renderEvent(
          durable("permission.resolved", { callId: "c", action: "allow", source: "user" }),
          mode,
        ).map((line) => line.text),
      ).toEqual(["└ 权限：allow（user）"]);
    }
  });
  it("拿不准的理由和一次性选项进入确认提示", () => {
    const text = renderPermissionPrompt(
      [{ kind: "edit", target: "/outside/a" }],
      "审查：拿不准 — 未明确授权",
      ["allow_once", "deny", "deny_stop"],
    );
    expect(text).toContain("审查：拿不准 — 未明确授权");
    expect(text).not.toContain("本会话内允许");
    expect(text).not.toContain("始终允许");
  });
});
