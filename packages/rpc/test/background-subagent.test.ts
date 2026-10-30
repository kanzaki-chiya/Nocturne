/**
 * 后台子代理的 RPC 映射（ADR-0073 §6、rpc.md）：subagent.cancel、远程白名单、
 * subagent.list 的 background 字段。
 */
import { afterEach, describe, expect, it } from "vitest";

import { FakeProvider, type FakeScript } from "@nocturne/core";
import type { RuntimeEvent } from "@nocturne/core/protocol";
import { REMOTE_METHODS } from "@nocturne/rpc/server";

import { RUNTIME_METHODS } from "../src/server/coverage.js";
import { cleanupTmp, connectMany, MODEL, until } from "./harness.js";

afterEach(cleanupTmp);

/** 父会话首个请求启动一个后台 explore 子代理；子会话等很久才 finish */
function provider(): FakeProvider {
  let dispatched = false;
  return new FakeProvider({
    handler: (request): FakeScript => {
      if (request.tools.some((tool) => tool.name === "finish"))
        return [
          { type: "wait", ms: 10_000 },
          { type: "tool_call", toolCallId: "f", name: "finish", input: { result: "x" } },
          { type: "finish", reason: "tool_calls" },
        ];
      if (dispatched)
        return [
          { type: "text_delta", text: "ok" },
          { type: "finish", reason: "stop" },
        ];
      dispatched = true;
      return [
        {
          type: "tool_call",
          toolCallId: "t",
          name: "task",
          input: { task: "look around", background: true, preset: "explore" },
        },
        { type: "finish", reason: "tool_calls" },
      ];
    },
  });
}

describe("subagent.cancel", () => {
  it("覆盖表与远程白名单：cancel 开放，观察类方法仍只限本机", () => {
    expect(RUNTIME_METHODS.cancelSubagent).toBe("subagent.cancel");
    expect(REMOTE_METHODS as readonly string[]).toContain("subagent.cancel");
    for (const method of ["subagent.list", "subagent.subscribe", "subagent.readAttachment"])
      expect(REMOTE_METHODS as readonly string[]).not.toContain(method);
  });

  it("list 带 background；远程取消后交付 cancelled；再取消报 invalid_command", async () => {
    const h = await connectMany({ provider: provider(), subagent: { background: true } });
    const { session: local } = await h.client.runtime.createSession({ model: MODEL, cwd: h.ws });
    expect(await local.submit({ text: "go" })).toBe("done");
    const [summary] = await h.client.runtime.listSubagents({ parentSessionId: local.id });
    expect(summary).toMatchObject({ background: true, state: "running" });
    if (summary === undefined) throw new Error("缺少后台子代理");

    const remote = await h.add();
    const { session } = await remote.client.runtime.resumeSession(local.id);
    const events: RuntimeEvent[] = [];
    await session.subscribe((event) => events.push(event));
    const params = { parentSessionId: local.id, childSessionId: summary.childSessionId };
    await remote.client.runtime.cancelSubagent(params);
    await until(
      () =>
        events.some(
          (event) =>
            event.type === "message.user" && event.payload.subagent?.status === "cancelled",
        ),
      "收到 cancelled 结果",
    );
    await expect(remote.client.runtime.cancelSubagent(params)).rejects.toMatchObject({
      code: "invalid_command",
    });
  });
});
