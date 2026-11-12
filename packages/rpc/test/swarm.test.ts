/**
 * Swarm RPC 方法与成员子会话交互测试（ADR-0089 §8、§10）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { FakeProvider } from "@nocturne/core";
import { reduceSessionView, replaySessionView, type RuntimeEvent } from "@nocturne/core/protocol";

import { cleanupTmp, connect, MODEL, textScript, VISION_MODELS } from "./harness.js";

afterEach(cleanupTmp);

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected value to be defined");
  return value;
}

describe("Swarm RPC 方法与成员子会话通道", { timeout: 20_000 }, () => {
  it("支持 postToSwarm、removeSwarmMember、endSwarm，以及经 RPC 直接向成员会话 submit 与 respondPermission", async () => {
    let coordInitDone = false;
    const provider = new FakeProvider({
      models: VISION_MODELS,
      roleHandler: () => textScript("Title"),
      handler: (req) => {
        const sys = req.system.map((s) => s.text).join("\n");
        const memberMatch = /persistent swarm member `@([a-z0-9-]+)`/.exec(sys);
        if (memberMatch?.[1] === "writer") {
          if (!req.messages.some((m) => m.role === "tool")) {
            return [
              {
                type: "tool_call",
                toolCallId: "w1",
                name: "write",
                input: { path: "rpc-out.txt", content: "rpc-approved\n" },
              },
              { type: "finish", reason: "tool_calls" },
            ];
          }
          return textScript("writer done");
        }
        if (memberMatch?.[1] === "helper") {
          return textScript("helper ack");
        }
        if (!coordInitDone) {
          coordInitDone = true;
          return [
            {
              type: "tool_call",
              toolCallId: "i1",
              name: "swarm_init",
              input: { title: "RPC Swarm" },
            },
            {
              type: "tool_call",
              toolCallId: "a1",
              name: "swarm_add_member",
              input: {
                name: "writer",
                charter: { owns: "rpc-out.txt", handsOff: "other", doneWhen: "written" },
              },
            },
            {
              type: "tool_call",
              toolCallId: "a2",
              name: "swarm_add_member",
              input: {
                name: "helper",
                charter: { owns: "notes", handsOff: "rpc-out.txt", doneWhen: "noted" },
              },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return textScript("coordinator ack");
      },
    });

    const h = await connect({
      provider,
      interactive: true,
      subagent: { background: true },
    });

    const { session: coord } = await h.client.runtime.createSession({
      model: MODEL,
      permissionPreset: "default",
    });

    const view = replaySessionView([]);
    await coord.subscribe((ev: RuntimeEvent) => {
      reduceSessionView(view, ev);
    });

    // 参数校验
    await expect(
      h.client.call("session.postToSwarm", { sessionId: coord.id, text: 123 as never }),
    ).rejects.toMatchObject({ rpcCode: -32602 });
    await expect(
      h.client.call("session.removeSwarmMember", { sessionId: coord.id, name: 456 as never }),
    ).rejects.toMatchObject({ rpcCode: -32602 });
    await expect(coord.postToSwarm({ text: "before init" })).rejects.toMatchObject({
      code: "invalid_command",
    });

    // 启动 Swarm
    await coord.submit({ text: "start via rpc", workMode: "swarm" });
    await vi.waitFor(() => {
      expect(view.swarm?.status).toBe("active");
      expect(view.swarm?.members).toHaveLength(2);
    });

    // 用户经 RPC 发帖 @writer -> 触发 default 预设下的权限确认冒泡
    const posted = await coord.postToSwarm({ text: "@writer please write rpc-out.txt" });
    expect(posted.recipients).toEqual(["writer"]);

    await vi.waitFor(() => {
      expect(view.swarm?.awaitingPermissionMembers).toEqual(["writer"]);
    });

    const writerMember = must(must(view.swarm).members.find((m) => m.name === "writer"));
    const reqId = must(writerMember.pendingPermissions[0]).requestId;

    // 客户端经 RPC 打开成员子会话并调用 respondPermission 放行
    const { session: writerRpc } = await h.client.runtime.resumeSession(
      writerMember.childSessionId,
    );
    await writerRpc.respondPermission(reqId, { decision: "allow" });

    await vi.waitFor(() => {
      expect(view.swarm?.awaitingPermissionMembers).toEqual([]);
      expect(view.swarm?.members.find((m) => m.name === "writer")?.status).toBe("waiting");
    });
    expect(readFileSync(path.join(h.ws, "rpc-out.txt"), "utf8")).toBe("rpc-approved\n");
    await writerRpc.close();

    // 客户端经 RPC 直接向 helper 成员子会话调用 submit：不上协调者留言板
    const helperMember = must(must(view.swarm).members.find((m) => m.name === "helper"));
    const postsBefore = must(view.swarm).posts.length;
    const { session: helperRpc } = await h.client.runtime.resumeSession(
      helperMember.childSessionId,
    );
    await helperRpc.submit({ text: "direct rpc message to helper" });
    expect(must(view.swarm).posts.length).toBe(postsBefore);
    await helperRpc.close();

    // 移除成员与结束 Swarm
    await coord.removeSwarmMember("helper");
    await vi.waitFor(() => {
      expect(view.swarm?.members.find((m) => m.name === "helper")?.status).toBe("removed");
    });

    const endRes = await coord.endSwarm();
    expect(endRes.unmerged).toEqual([]);
    await vi.waitFor(() => {
      expect(view.swarm?.status).toBe("ended");
    });

    await coord.close();
    h.client.close();
    await h.served;
  });
});
