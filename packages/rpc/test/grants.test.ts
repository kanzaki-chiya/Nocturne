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
  const workspace = local[0]!.workspace!;
  const grants = await phone.client.runtime.listGrants({ workspace });
  expect(grants).toHaveLength(1);
  expect(await phone.client.runtime.listGrantWorkspaces()).toContainEqual(
    expect.objectContaining({ workspace, grantCount: 1 }),
  );
  await phone.client.runtime.revokeGrant({
    workspace,
    kind: grants[0]!.kind,
    target: grants[0]!.target,
  });
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
  const describe = vi.spyOn(h.runtimes[0]!, "describeProject");
  const trust = vi.spyOn(h.runtimes[0]!, "setWorkspaceTrusted");
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
  await b.revokeGrant({ kind: grants[0]!.kind, target: grants[0]!.target });
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
