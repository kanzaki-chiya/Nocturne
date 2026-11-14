/**
 * 子代理权限转发 RPC 路由与远程/本地边界（session.respondSubagentPermission + subagent.permissions）。
 */
import { afterEach, describe, expect, it } from "vitest";

import { FakeProvider, type ModelRequest } from "@nocturne/core";
import {
  allPendingPermissions,
  createSessionView,
  reduceSessionView,
  type RuntimeEvent,
} from "@nocturne/core/protocol";

import { cleanupTmp, connectMany, MODEL, until, VISION_MODELS } from "./harness.js";

afterEach(cleanupTmp);

describe("session.respondSubagentPermission RPC 与远程边界", () => {
  it("远程可经父会话查看并批准/会话授权子请求，但 project/always 被拦截且保留 pending", async () => {
    let childCalls = 0;
    const provider = new FakeProvider({
      models: VISION_MODELS,
      handler: (req: ModelRequest) => {
        const isChild = req.tools.some((t) => t.name === "finish");
        const hasToolResult = req.messages.some((m) => m.role === "tool");
        if (!isChild) {
          if (!hasToolResult) {
            return [
              {
                type: "tool_call",
                toolCallId: "parent-task-1",
                name: "task",
                input: { task: "执行受限写入任务", preset: "general" },
              },
              { type: "finish", reason: "tool_calls" },
            ];
          }
          return [
            { type: "text_delta", text: "子任务已完成" },
            { type: "finish", reason: "stop" },
          ];
        }
        childCalls += 1;
        if (childCalls === 1) {
          return [
            {
              type: "tool_call",
              toolCallId: "child-write-1",
              name: "write",
              input: { path: "out.txt", content: "hello" },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return [
          {
            type: "tool_call",
            toolCallId: "child-finish-1",
            name: "finish",
            input: { result: "child done" },
          },
          { type: "finish", reason: "tool_calls" },
        ];
      },
    });

    const h = await connectMany({ provider });
    const remote = await h.add("remote");

    const { session: localSession } = await h.client.runtime.createSession({
      model: MODEL,
      cwd: h.ws,
    });
    const { session: remoteSession } = await remote.client.runtime.resumeSession(localSession.id);

    const remoteEvents: RuntimeEvent[] = [];
    const remoteView = createSessionView();
    await remoteSession.subscribe((ev) => {
      remoteEvents.push(ev);
      reduceSessionView(remoteView, ev);
    });

    const turn = localSession.submit({ text: "派发子任务" });
    await until(() => remoteView.pendingPermission !== undefined, "远程收到父 task 权限确认");
    const parentPending = remoteView.pendingPermission;
    if (parentPending === undefined) throw new Error("预期父权限待决");
    await remoteSession.respondPermission(parentPending.requestId, {
      decision: "allow",
    });
    await until(() => remoteView.pendingSubagentPermissions.length === 1, "远程收到子权限快照");

    const pendingList = allPendingPermissions(remoteView);
    expect(pendingList).toHaveLength(1);
    const subItem = pendingList[0];
    expect(subItem?.kind).toBe("subagent");
    if (subItem?.kind !== "subagent") throw new Error("预期为 subagent 权限");
    expect(subItem.permission.profile).toBe("general");
    expect(subItem.permission.taskSummary).toContain("执行受限写入任务");

    // 远程连接尝试 remember=project / always：被 RPC 边界拦截，pending 必须保留
    await expect(
      remoteSession.respondSubagentPermission(
        subItem.permission.childSessionId,
        subItem.permission.requestId,
        { decision: "allow", remember: "project" },
      ),
    ).rejects.toMatchObject({ code: "remote_not_allowed" });
    await expect(
      remoteSession.respondSubagentPermission(
        subItem.permission.childSessionId,
        subItem.permission.requestId,
        { decision: "allow", remember: "always" },
      ),
    ).rejects.toMatchObject({ code: "remote_not_allowed" });
    expect(remoteView.pendingSubagentPermissions).toHaveLength(1);

    // 远程使用 session 级授权或单次授权可正常放行子代理继续执行
    await remoteSession.respondSubagentPermission(
      subItem.permission.childSessionId,
      subItem.permission.requestId,
      { decision: "allow", remember: "session" },
    );

    expect(await turn).toBe("done");
    expect(remoteView.pendingSubagentPermissions).toEqual([]);
    // 确认父会话持久化日志中不包含子代理的 permission.requested / callId
    const parentPersisted = remoteEvents.filter((e) => "seq" in e);
    expect(
      parentPersisted.some(
        (e) => e.type === "permission.requested" && e.payload.callId === "child-write-1",
      ),
    ).toBe(false);

    h.client.close();
    remote.client.close();
    await h.served;
    await remote.served;
  });

  it("未打开会话、非法参数、未知子会话或请求均报明确错误且不破坏活动请求", async () => {
    const h = await connectMany({
      scripts: [
        [
          { type: "text_delta", text: "ok" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    const remote = await h.add("remote");

    const { session: s1 } = await h.client.runtime.createSession({ model: MODEL, cwd: h.ws });
    const { session: s2 } = await h.client.runtime.createSession({ model: MODEL, cwd: h.ws });

    // 远程连接未打开 s2
    await expect(
      remote.client.call("session.respondSubagentPermission", {
        sessionId: s2.id,
        childSessionId: "c1",
        requestId: "r1",
        reply: { decision: "allow" },
      }),
    ).rejects.toMatchObject({ code: "unknown_session" });

    // 参数校验
    await expect(
      h.client.call("session.respondSubagentPermission", {
        sessionId: s1.id,
        childSessionId: 123 as never,
        requestId: "r1",
        reply: { decision: "allow" },
      }),
    ).rejects.toMatchObject({ rpcCode: -32602 });

    // 无效 childSessionId / requestId → unknown_request
    await expect(
      s1.respondSubagentPermission("non-existent-child", "r1", { decision: "allow" }),
    ).rejects.toMatchObject({ code: "unknown_request" });

    h.client.close();
    remote.client.close();
    await h.served;
    await remote.served;
  });

  it("本机连接可通过 RPC 经父会话拒绝子代理或保存项目授权，并正确清理快照", async () => {
    let childCalls = 0;
    const provider = new FakeProvider({
      models: VISION_MODELS,
      handler: (req: ModelRequest) => {
        const isChild = req.tools.some((t) => t.name === "finish");
        const hasToolResult = req.messages.some((m) => m.role === "tool");
        if (!isChild) {
          if (!hasToolResult) {
            return [
              {
                type: "tool_call",
                toolCallId: "parent-task-deny",
                name: "task",
                input: { task: "测试拒绝与授权", preset: "general" },
              },
              { type: "finish", reason: "tool_calls" },
            ];
          }
          return [
            { type: "text_delta", text: "done" },
            { type: "finish", reason: "stop" },
          ];
        }
        childCalls += 1;
        if (childCalls === 1) {
          return [
            {
              type: "tool_call",
              toolCallId: "child-write-deny",
              name: "write",
              input: { path: "denied.txt", content: "no" },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return [
          {
            type: "tool_call",
            toolCallId: "child-finish-deny",
            name: "finish",
            input: { result: "stopped after deny" },
          },
          { type: "finish", reason: "tool_calls" },
        ];
      },
    });

    const h = await connectMany({ provider });
    const { session: localSession } = await h.client.runtime.createSession({
      model: MODEL,
      cwd: h.ws,
    });

    const view = createSessionView();
    await localSession.subscribe((ev) => {
      reduceSessionView(view, ev);
    });

    const turn = localSession.submit({ text: "派发子任务" });
    await until(() => view.pendingPermission !== undefined, "本机收到父 task 权限确认");
    const parentPending = view.pendingPermission;
    if (parentPending === undefined) throw new Error("预期父权限待决");
    await localSession.respondPermission(parentPending.requestId, {
      decision: "allow",
    });

    await until(() => view.pendingSubagentPermissions.length === 1, "本机收到子权限快照");
    const item = view.pendingSubagentPermissions[0];
    if (item === undefined) throw new Error("预期子权限待决");
    await localSession.respondSubagentPermission(item.childSessionId, item.requestId, {
      decision: "deny",
      feedback: "改用只读路径",
    });

    expect(await turn).toBe("done");
    expect(view.pendingSubagentPermissions).toEqual([]);
    expect(childCalls).toBe(2);

    h.client.close();
    await h.served;
  });
});
