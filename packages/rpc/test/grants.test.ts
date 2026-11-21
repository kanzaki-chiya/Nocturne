import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { GrantsChangedPayload } from "@nocturne/core/protocol";
import { cleanupTmp, connectManyWithConfig, MODEL, textScript, until } from "./harness.js";

afterEach(() => {
  vi.restoreAllMocks();
  cleanupTmp();
});
const write = [
  {
    type: "tool_call" as const,
    toolCallId: "w",
    name: "write",
    input: { path: "out.txt", content: "ok" },
  },
  { type: "finish" as const, reason: "tool_calls" as const },
];

it("grants 方法往返、信任描述、远程仅可查看和撤销；新增和撤销各广播一次", async () => {
  const h = await connectManyWithConfig({
    scripts: [write, textScript("done"), write, textScript("done")],
  });
  const phone = await h.add();
  const local: GrantsChangedPayload[] = [];
  const remote: GrantsChangedPayload[] = [];
  h.client.onNotification("grants.changed", (p) => local.push(p));
  phone.client.onNotification("grants.changed", (p) => remote.push(p));
  const { session } = await h.client.runtime.createSession({ model: MODEL });
  await session.subscribe((event) => {
    if (event.type === "permission.requested")
      void session.respondPermission(event.payload.requestId, {
        decision: "allow",
        remember: "project",
      });
  });
  await session.submit({ text: "write" });
  await until(() => remote.length === 1);
  expect(local).toHaveLength(1);
  expect(local[0]).toEqual({ workspace: expect.any(String) });
  const workspace = local[0]?.workspace;
  if (!workspace) throw new Error("missing workspace notification");
  const grants = await phone.client.runtime.listGrants({ workspace });
  expect(grants).toHaveLength(1);
  expect(await phone.client.runtime.listGrantWorkspaces()).toContainEqual(
    expect.objectContaining({ workspace, grantCount: 1 }),
  );
  const first = grants[0];
  if (!first) throw new Error("missing project grant");
  await phone.client.runtime.revokeGrant({ workspace, kind: first.kind, target: first.target });
  await until(() => remote.length === 2);
  expect(local).toHaveLength(2);
  expect(await h.client.runtime.listGrants({ workspace })).toEqual([]);
  await session.submit({ text: "again" });
  expect(await h.client.runtime.listGrants({ workspace })).toHaveLength(1);
  await phone.client.runtime.revokeAllGrants({ workspace });
  expect(await h.client.runtime.listGrants({ workspace })).toEqual([]);

  await fs.mkdir(path.join(h.ws, ".nocturne"), { recursive: true });
  await fs.writeFile(
    path.join(h.ws, ".nocturne", "config.json"),
    JSON.stringify({ mcp: { servers: { example: { command: "node", args: ["server.js"] } } } }),
  );
  expect(await h.client.runtime.describeProject({ workspace })).toMatchObject({
    mcpServers: [{ name: "example", command: "node server.js" }],
  });
  await h.client.runtime.setWorkspaceTrusted({ workspace, trusted: true });
  expect(await h.client.runtime.listGrantWorkspaces()).toContainEqual(
    expect.objectContaining({ workspace, trusted: true, hasProjectConfig: true }),
  );
  const runtime = h.runtimes[0];
  if (!runtime) throw new Error("missing runtime");
  const describe = vi.spyOn(runtime, "describeProject");
  const trust = vi.spyOn(runtime, "setWorkspaceTrusted");
  await expect(phone.client.runtime.describeProject({ workspace })).rejects.toMatchObject({
    code: "remote_not_allowed",
  });
  await expect(
    phone.client.runtime.setWorkspaceTrusted({ workspace, trusted: false }),
  ).rejects.toMatchObject({ code: "remote_not_allowed" });
  expect(describe).not.toHaveBeenCalled();
  expect(trust).not.toHaveBeenCalled();
  expect(local).toEqual(remote);
  await h.client.shutdown();
  await Promise.all([h.served, phone.served]);
});

it("会话授权 list/revoke/revokeAll 可经手机调用，变化恰好一次通知", async () => {
  const h = await connectManyWithConfig({
    scripts: [write, textScript("done"), write, textScript("done")],
  });
  const { session } = await h.client.runtime.createSession({ model: MODEL });
  const phone = await h.add();
  const b = phone.client.session(session.id);
  const changes: GrantsChangedPayload[] = [];
  phone.client.onNotification("grants.changed", (p) => changes.push(p));
  await session.subscribe((event) => {
    if (event.type === "permission.requested")
      void session.respondPermission(event.payload.requestId, {
        decision: "allow",
        remember: "session",
      });
  });
  await session.submit({ text: "write" });
  await until(() => changes.length === 1);
  const grants = await b.listGrants();
  expect(grants).toHaveLength(1);
  const first = grants[0];
  if (!first) throw new Error("missing session grant");
  await b.revokeGrant({ kind: first.kind, target: first.target });
  await until(() => changes.length === 2);
  expect(await session.listGrants()).toEqual([]);
  await session.submit({ text: "again" });
  expect(await b.listGrants()).toHaveLength(1);
  await b.revokeAllGrants();
  expect(await session.listGrants()).toEqual([]);
  expect(changes).toEqual(Array.from({ length: 4 }, () => ({ sessionId: session.id })));
  await h.client.shutdown();
  await Promise.all([h.served, phone.served]);
});

it("模式 Grant 经 RPC 写入、按 match 撤销，远程连接拒绝 remember: pattern", async () => {
  const shellCmd = (command: string, id: string) => [
    {
      type: "tool_call" as const,
      toolCallId: id,
      name: "shell",
      input: { command },
    },
    { type: "finish" as const, reason: "tool_calls" as const },
  ];
  const h = await connectManyWithConfig({
    scripts: [
      shellCmd("echo alpha --one", "s1"),
      textScript("done1"),
      shellCmd("echo alpha --two", "s2"),
      textScript("done2"),
      shellCmd("echo alpha --three", "s3"),
      textScript("done3"),
    ],
  });
  const phone = await h.add();
  const changes: GrantsChangedPayload[] = [];
  h.client.onNotification("grants.changed", (p) => changes.push(p));

  const { session } = await h.client.runtime.createSession({ model: MODEL });
  const phoneSession = phone.client.session(session.id);
  const requests: { requestId: string; ruleSuggestion?: { pattern: string } | undefined }[] = [];
  let remoteError: unknown;
  let invalidReplyError: unknown;
  await session.subscribe((event) => {
    if (event.type === "permission.requested") {
      requests.push({
        requestId: event.payload.requestId,
        ruleSuggestion: event.payload.ruleSuggestion,
      });
      if (requests.length === 1) {
        void (async () => {
          try {
            await phoneSession.respondPermission(event.payload.requestId, {
              decision: "allow",
              remember: "pattern",
              pattern: "echo alpha *",
            });
          } catch (e) {
            remoteError = e;
          }
          try {
            await session.respondPermission(event.payload.requestId, {
              decision: "allow",
              remember: "pattern",
              pattern: "echo beta *",
            });
          } catch (e) {
            invalidReplyError = e;
          }
          await session.respondPermission(event.payload.requestId, {
            decision: "allow",
            remember: "pattern",
            pattern: "echo alpha *",
          });
        })();
      } else {
        void session.respondPermission(event.payload.requestId, { decision: "allow" });
      }
    }
  });

  // 1. 首次询问：远程尝试 remember: "pattern" 被拒；本地提交不匹配模式报 invalid_reply 且保持等待；合法模式成功批准
  await session.submit({ text: "first" });
  expect(remoteError).toMatchObject({ code: "remote_not_allowed" });
  expect(invalidReplyError).toMatchObject({ code: "invalid_reply", rpcCode: -32001 });
  expect(requests).toHaveLength(1);
  expect(requests[0]?.ruleSuggestion).toEqual({ pattern: "echo alpha *" });
  await until(() => changes.length === 1);
  const workspace = changes[0]?.workspace;
  if (!workspace) throw new Error("missing workspace notification");

  const grantsAfterAdd = await h.client.runtime.listGrants({ workspace });
  expect(grantsAfterAdd).toEqual([
    expect.objectContaining({
      kind: "shell",
      target: "echo alpha *",
      match: "pattern",
    }),
  ]);

  // 2. 同类命令直接放行，不再次询问
  await session.submit({ text: "second" });
  expect(requests).toHaveLength(1);

  // 3. 按 (kind, target, match: "pattern") 经 RPC 撤销后，再次执行重新询问
  await phone.client.runtime.revokeGrant({
    workspace,
    kind: "shell",
    target: "echo alpha *",
    match: "pattern",
  });
  await until(() => changes.length === 2);
  expect(await h.client.runtime.listGrants({ workspace })).toEqual([]);

  await session.submit({ text: "third" });
  expect(requests).toHaveLength(2);

  await h.client.shutdown();
  await Promise.all([h.served, phone.served]);
});
