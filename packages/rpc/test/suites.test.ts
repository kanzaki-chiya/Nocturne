import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { FakeProvider, type ModelRequest } from "@nocturne/core";
import { createSessionView, reduceSessionView, type RuntimeEvent } from "@nocturne/core/protocol";
import { REMOTE_METHODS } from "@nocturne/rpc/server";

import {
  cleanupTmp,
  connectMany,
  connectManyWithConfig,
  connectWithConfig,
  MODEL,
  textScript,
  tmpDir,
  until,
  VISION_MODELS,
} from "./harness.js";

afterEach(cleanupTmp);

function systemText(req: ModelRequest): string {
  return (req.system ?? []).map((b) => b.text).join("\n");
}

function requestKind(req: ModelRequest): "coordinator" | "thread" | "normal" {
  const sys = systemText(req);
  if (sys.includes("working as the persistent coordinator of a long-running Suite")) {
    return "coordinator";
  }
  if (sys.includes("working in a persistent thread of a Suite")) return "thread";
  return "normal";
}

function must<T>(value: T | undefined, label = "value"): T {
  if (value === undefined) throw new Error(`Expected ${label} to be defined`);
  return value;
}

describe("组曲（Suite）RPC（ADR-0097）", () => {
  it("suites.* CRUD、openSuite 幂等、listSessions 默认排除指挥与参数校验", async () => {
    const h = await connectMany({ subagent: { background: true } });

    const created = await h.client.runtime.createSuite({
      name: "Core RPC Suite",
      goal: "Verify RPC CRUD",
      workspaces: [h.ws],
      instructions: "Keep output short.",
    });
    expect(created.name).toBe("Core RPC Suite");
    expect(created.goal).toBe("Verify RPC CRUD");
    expect(created.workspaces).toEqual([realpathSync.native(h.ws)]);

    expect((await h.client.runtime.listSuites()).map((s) => s.id)).toEqual([created.id]);

    const updated = await h.client.runtime.updateSuite({
      id: created.id,
      name: "Updated Suite",
      instructions: "New instructions",
    });
    expect(updated.name).toBe("Updated Suite");
    expect(updated.instructions).toBe("New instructions");

    const opened1 = await h.client.runtime.openSuite(created.id);
    expect(opened1.opened.meta.suite).toEqual({ id: created.id, role: "coordinator" });
    // 同连接重复 suites.open 直接返回同一打开会话快照
    const opened2 = await h.client.runtime.openSuite(created.id);
    expect(opened2.opened.sessionId).toBe(opened1.opened.sessionId);

    // 指挥会话不进默认列表，传 includeSuiteCoordinators: true 才可见
    const defaultList = await h.client.runtime.listSessions();
    expect(defaultList.some((s) => s.id === opened1.opened.sessionId)).toBe(false);
    const fullList = await h.client.runtime.listSessions({ includeSuiteCoordinators: true });
    expect(fullList.some((s) => s.id === opened1.opened.sessionId)).toBe(true);

    // 指挥会话不支持分叉
    await expect(h.client.runtime.forkSession(opened1.opened.sessionId)).rejects.toMatchObject({
      code: "invalid_command",
    });

    // 归档后默认 listSuites 不含，includeArchived: true 可见
    await h.client.runtime.archiveSuite(created.id);
    expect(await h.client.runtime.listSuites()).toEqual([]);
    expect((await h.client.runtime.listSuites({ includeArchived: true })).map((s) => s.id)).toEqual(
      [created.id],
    );

    // 参数校验（空 id 进 Core 报 invalid_command；缺参 / 非法类型报 -32602）
    await expect(h.client.runtime.archiveSuite("")).rejects.toMatchObject({
      code: "invalid_command",
    });
    await expect(h.client.call("suites.archive", {} as never)).rejects.toMatchObject({
      code: "invalid_params",
      rpcCode: -32602,
    });
    await expect(
      h.client.session(opened1.opened.sessionId).sendToThread({ thread: "t1", text: "" }),
    ).rejects.toMatchObject({ code: "invalid_command" });
  });

  it("远程白名单开放 suites.*、session.resolveThread 与 session.sendToThread，并校验工作区边界", async () => {
    for (const method of [
      "suites.list",
      "suites.create",
      "suites.update",
      "suites.archive",
      "suites.open",
      "session.resolveThread",
      "session.sendToThread",
    ] as const) {
      expect((REMOTE_METHODS as readonly string[]).includes(method)).toBe(true);
    }

    const h = await connectManyWithConfig({ enableRemote: true });
    const remote = await h.add("remote");

    const suite = await remote.client.runtime.createSuite({
      name: "Remote Suite",
      workspaces: [h.ws],
    });
    expect((await remote.client.runtime.listSuites()).map((s) => s.id)).toEqual([suite.id]);

    // 远程传入不存在或未信任的项目配置目录被拒绝
    const untrustedDir = tmpDir("nct-untrusted-");
    mkdirSync(path.join(untrustedDir, ".nocturne"), { recursive: true });
    writeFileSync(path.join(untrustedDir, ".nocturne", "config.json"), "{}", "utf8");
    await expect(
      remote.client.runtime.createSuite({
        name: "Untrusted Suite",
        workspaces: [untrustedDir],
      }),
    ).rejects.toMatchObject({ code: "workspace_untrusted" });
    await expect(
      remote.client.runtime.createSuite({
        name: "Missing Suite",
        workspaces: [path.join(untrustedDir, "missing")],
      }),
    ).rejects.toMatchObject({ code: "workspace_not_found" });

    // 远程可以打开组曲
    const opened = await remote.client.runtime.openSuite(suite.id);
    expect(opened.opened.sessionId).toBe(suite.coordinatorSessionId);
  });

  it("端到端 RPC：thread_start 自动汇报、sendToThread、resolveThread 与线程权限冒泡确认", async () => {
    let threadTurnCount = 0;
    const provider = new FakeProvider({
      models: VISION_MODELS,
      roleHandler: () => textScript("标题"),
      handler: (req) => {
        const kind = requestKind(req);
        if (kind === "coordinator") {
          const hasReport = req.messages.some(
            (m) => m.role === "user" && JSON.stringify(m.content).includes("<thread-report"),
          );
          if (!hasReport) {
            const hasStarted = req.messages.some(
              (m) => m.role === "tool" && m.name === "thread_start",
            );
            if (!hasStarted) {
              return [
                {
                  type: "tool_call",
                  toolCallId: "ts1",
                  name: "thread_start",
                  input: {
                    title: "Write file with approval",
                    task: "Write rpc-approved.txt",
                  },
                },
                { type: "finish", reason: "tool_calls" },
              ];
            }
            return textScript("dispatched");
          }
          return textScript("coordinator got report");
        }
        if (kind === "thread") {
          threadTurnCount += 1;
          if (
            threadTurnCount === 1 &&
            !req.messages.some((m) => m.role === "tool" && m.name === "write")
          ) {
            return [
              {
                type: "tool_call",
                toolCallId: "w1",
                name: "write",
                input: { path: "rpc-approved.txt", content: "rpc-ok\n" },
              },
              { type: "finish", reason: "tool_calls" },
            ];
          }
          const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
          const lastText = lastUser ? JSON.stringify(lastUser.content) : "";
          if (lastText.includes("Follow-up from user via RPC")) {
            return textScript("handled direct user sendToThread");
          }
          return textScript("wrote rpc-approved.txt");
        }
        return textScript("ok");
      },
    });

    const h = await connectManyWithConfig({ provider, enableRemote: true });
    const remote = await h.add("remote");

    const suite = await h.client.runtime.createSuite({
      name: "E2E RPC Suite",
      workspaces: [h.ws],
    });
    const { opened } = await h.client.runtime.openSuite(suite.id);
    await remote.client.runtime.openSuite(suite.id);
    const coord = h.client.session(opened.sessionId);

    const view = createSessionView();
    const events: RuntimeEvent[] = [];
    const sub = await coord.subscribe((ev) => {
      events.push(ev);
      reduceSessionView(view, ev);
    });

    await coord.submit({ text: "Please start a thread to write rpc-approved.txt" });

    // 等待线程权限冒泡到指挥订阅视图
    await until(() => view.pendingSubagentPermissions.length === 1, "subagent permission");
    expect(view.suite?.needsAttentionThreads).toEqual(["t1"]);
    const pending = must(view.pendingSubagentPermissions[0]);

    // 通过远程连接也可以确认权限并收尾（或本机连接确认）
    await remote.client
      .session(opened.sessionId)
      .respondSubagentPermission(pending.childSessionId, pending.requestId, { decision: "allow" });

    await until(
      () =>
        view.pendingSubagentPermissions.length === 0 &&
        view.suite?.threads[0]?.lastReportLine === "wrote rpc-approved.txt" &&
        view.entries.some(
          (e) => e.kind === "assistant" && e.text.includes("coordinator got report"),
        ),
      "thread report delivered to coordinator",
    );
    expect(readFileSync(path.join(h.ws, "rpc-approved.txt"), "utf8")).toBe("rpc-ok\n");

    // 远程调用 session.sendToThread 直接派活给线程
    await remote.client
      .session(opened.sessionId)
      .sendToThread({ thread: "t1", text: "Follow-up from user via RPC" });

    await until(
      () => view.suite?.threads[0]?.lastReportLine === "handled direct user sendToThread",
      "sendToThread second turn report",
    );

    // 远程调用 session.resolveThread 标记完成与重开
    await remote.client.session(opened.sessionId).resolveThread({ thread: "t1" });
    await until(() => view.suite?.threads[0]?.group === "resolved", "thread resolved");
    await remote.client.session(opened.sessionId).resolveThread({ thread: "t1", reopen: true });
    await until(() => view.suite?.threads[0]?.group === "idle", "thread reopened");

    await sub.unsubscribe();
  });

  it("memory.* RPC 支持 suiteId 与 scope=suite 读写删除与清空", async () => {
    let phase = 0;
    const provider = new FakeProvider({
      models: VISION_MODELS,
      roleHandler: () => textScript("标题"),
      handler: () => {
        phase += 1;
        if (phase === 1) {
          return [
            {
              type: "tool_call",
              toolCallId: "mw-s",
              name: "memory_write",
              input: {
                scope: "suite",
                name: "conventions",
                description: "Suite coding style",
                type: "project",
                content: "Always keep functions pure.",
              },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return textScript("saved suite memory");
      },
    });

    const h = await connectWithConfig({ provider });
    const suite = await h.client.runtime.createSuite({
      name: "Memory RPC Suite",
      workspaces: [h.ws],
    });
    const { opened } = await h.client.runtime.openSuite(suite.id);
    await h.client.session(opened.sessionId).submit({ text: "Remember our suite rule" });

    const desc = await h.client.runtime.describeMemory({
      workspaceRoot: h.ws,
      suiteId: suite.id,
    });
    expect(desc.suite?.enabled).toBe(true);
    expect(desc.suite?.entries.map((e) => e.name)).toEqual(["conventions"]);

    const entry = await h.client.runtime.readMemory({
      scope: "suite",
      key: suite.id,
      name: "conventions",
    });
    expect(entry.content).toBe("Always keep functions pure.");

    await h.client.runtime.deleteMemory({
      scope: "suite",
      key: suite.id,
      name: "conventions",
    });
    const afterDelete = await h.client.runtime.describeMemory({
      workspaceRoot: h.ws,
      suiteId: suite.id,
    });
    expect(afterDelete.suite?.entries).toEqual([]);

    // 验证 clearMemory({ scope: "suite", key }) 也能正常执行
    await h.client.runtime.clearMemory({ scope: "suite", key: suite.id });

    // 普通 createSession 使用 MODEL 不报错
    const normal = await h.client.runtime.createSession({ model: MODEL });
    expect(normal.opened.meta.suite).toBeUndefined();
  });
});
