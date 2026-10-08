import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { FakeScript } from "@nocturne/core";
import type { RuntimeEvent } from "@nocturne/core/protocol";

import { cleanupTmp, connect, MODEL, textScript, until, type Harness } from "./harness.js";

afterEach(cleanupTmp);

const writeThenDone = (): FakeScript[] => [
  [
    {
      type: "tool_call",
      toolCallId: "w1",
      name: "write",
      input: { path: "out.txt", content: "written-by-agent" },
    },
    { type: "finish", reason: "tool_calls" },
  ],
  textScript("done"),
];

async function open(h: Harness) {
  const { session } = await h.client.runtime.createSession({ model: MODEL });
  const events: RuntimeEvent[] = [];
  await session.subscribe((e) => events.push(e));
  return { session, events };
}

describe("权限请求往返", () => {
  it("permission.requested 事件 → respondPermission(allow) → 工具执行、Turn 完成", async () => {
    const h = await connect({ scripts: writeThenDone() });
    const { session, events } = await open(h);
    const turn = session.submit({ text: "写文件" });
    await until(() => events.some((e) => e.type === "permission.requested"), "权限请求");
    const requested = events.find((e) => e.type === "permission.requested");
    if (requested?.type !== "permission.requested") throw new Error("缺少权限请求");
    expect(existsSync(path.join(h.ws, "out.txt"))).toBe(false);

    await session.respondPermission(requested.payload.requestId, { decision: "allow" });
    expect(await turn).toBe("done");
    expect(readFileSync(path.join(h.ws, "out.txt"), "utf8")).toBe("written-by-agent");
    const resolved = events.find((e) => e.type === "permission.resolved");
    expect(resolved?.type === "permission.resolved" && resolved.payload.source).toBe("user");
    h.client.close();
    await h.served;
  });

  it("deny 并附反馈：工具被拒，反馈回到模型；重复回复 unknown_request", async () => {
    const h = await connect({ scripts: writeThenDone() });
    const { session, events } = await open(h);
    const turn = session.submit({ text: "写文件" });
    await until(() => events.some((e) => e.type === "permission.requested"), "权限请求");
    const requested = events.find((e) => e.type === "permission.requested");
    if (requested?.type !== "permission.requested") throw new Error("缺少权限请求");
    const { requestId } = requested.payload;

    await session.respondPermission(requestId, { decision: "deny", feedback: "别写这里" });
    expect(await turn).toBe("done");
    expect(existsSync(path.join(h.ws, "out.txt"))).toBe(false);
    const completed = events.find((e) => e.type === "tool.completed");
    expect(completed?.type === "tool.completed" && completed.payload.status).toBe("denied");
    await expect(session.respondPermission(requestId, { decision: "allow" })).rejects.toMatchObject(
      { code: "unknown_request" },
    );
    h.client.close();
    await h.served;
  });
});

describe("提问往返（ask_user）", () => {
  const askThenDone = (): FakeScript[] => [
    [
      {
        type: "tool_call",
        toolCallId: "q1",
        name: "ask_user",
        input: {
          questions: [
            {
              question: "用哪个数据库？",
              header: "选型",
              options: [
                { label: "PostgreSQL", description: "关系型" },
                { label: "SQLite", description: "嵌入式" },
              ],
            },
          ],
        },
      },
      { type: "finish", reason: "tool_calls" },
    ],
    textScript("done"),
  ];

  it("question.requested → respondQuestion：不合法的回复 invalid_reply 且请求保持等待，合法回复后 Turn 完成", async () => {
    const h = await connect({ scripts: askThenDone() });
    const { session, events } = await open(h);
    const turn = session.submit({ text: "选库" });
    await until(() => events.some((e) => e.type === "question.requested"), "提问请求");
    const requested = events.find((e) => e.type === "question.requested");
    if (requested?.type !== "question.requested") throw new Error("缺少提问请求");
    const { requestId } = requested.payload;

    await expect(
      session.respondQuestion(requestId, { answers: [{ selected: ["不存在的选项"] }] }),
    ).rejects.toMatchObject({ code: "invalid_reply", rpcCode: -32001 });
    await session.respondQuestion(requestId, { answers: [{ selected: ["PostgreSQL"] }] });
    expect(await turn).toBe("done");
    const completed = events.find((e) => e.type === "tool.completed");
    expect(completed?.type === "tool.completed" && completed.payload.status).toBe("ok");
    await expect(
      session.respondQuestion(requestId, { answers: [{ selected: ["SQLite"] }] }),
    ).rejects.toMatchObject({ code: "unknown_request" });
    h.client.close();
    await h.served;
  });
});

describe("中断", () => {
  it("interrupt 通知中断运行中的 Turn，submit 随后以 aborted 返回；Turn 进行中再 submit 报 session_busy", async () => {
    const h = await connect({ scripts: [[{ type: "wait", ms: 60_000 }], textScript("好了")] });
    const { session, events } = await open(h);
    let phase = "submit";
    const watchdog = setTimeout(() => {
      console.error(
        "[interrupt watchdog]",
        JSON.stringify({
          pid: process.pid,
          phase,
          events: events.map((event) => ({
            type: event.type,
            seq: "seq" in event ? event.seq : null,
          })),
          diagnostics: h.diagnostics,
          provider: {
            requests: h.provider.requests.length,
            roleRequests: h.provider.roleRequests.length,
            ...h.provider.waitState,
          },
          openTurn: h.coreSession(session.id)?.state().openTurn ?? null,
          interruptReceived: h.diagnostics.some(
            (record) => record.kind === "notification" && record.method === "session.interrupt",
          ),
        }),
      );
    }, 20_000);
    try {
      const turn = session.submit({ text: "慢" });
      await until(() => events.some((e) => e.type === "turn.started"), "Turn 开始");
      await expect(session.submit({ text: "再来" })).rejects.toMatchObject({
        code: "session_busy",
        message: "会话正忙（Turn 或压缩进行中）",
      });
      phase = "interrupt";
      session.interrupt();
      phase = "await aborted";
      expect(await turn).toBe("aborted");
      const completed = events.find((e) => e.type === "turn.completed");
      expect(completed?.type === "turn.completed" && completed.payload.reason).toBe("aborted");
      // 中断后会话空闲，可继续提交
      phase = "second submit";
      expect(await session.submit({ text: "好了" })).toBe("done");
      h.client.close();
      phase = "server cleanup";
      await h.served;
    } finally {
      clearTimeout(watchdog);
    }
  });

  it("interrupt 也可以请求形式发送，无运行中的 Turn 时无操作", async () => {
    const h = await connect();
    const { session } = await open(h);
    session.interrupt();
    await expect(
      h.client.call("session.interrupt" as "session.close", { sessionId: session.id }),
    ).resolves.toBeNull();
    h.client.close();
    await h.served;
  });
});
