import { afterEach, expect, it } from "vitest";
import { cleanupTmp, connectMany, MODEL, textScript, until } from "./harness.js";

afterEach(cleanupTmp);

it("archive/unarchive map to Core, notify lists, and remain local-only", async () => {
  const h = await connectMany();
  const remote = await h.add();
  try {
    let notifications = 0;
    remote.client.onNotification("runtime.sessionsChanged", () => notifications++);
    const { session } = await h.client.runtime.createSession({ model: MODEL });
    await until(() => notifications > 0, "creation notification");
    notifications = 0;
    expect(await h.client.call("runtime.archiveSession", { sessionId: session.id })).toBeNull();
    expect(await h.client.runtime.listSessions()).toEqual([]);
    expect(await h.client.runtime.listSessions({ includeArchived: true })).toContainEqual(
      expect.objectContaining({ id: session.id, archivedAt: expect.any(String) }),
    );
    expect(await remote.client.runtime.listSessions({ includeArchived: true })).toEqual([]);
    for (const method of ["runtime.archiveSession", "runtime.unarchiveSession"] as const) {
      await expect(remote.client.call(method, { sessionId: session.id })).rejects.toMatchObject({
        code: "remote_not_allowed",
      });
    }
    await until(() => notifications > 0, "archive notification");
    notifications = 0;
    expect(await h.client.call("runtime.unarchiveSession", { sessionId: session.id })).toBeNull();
    await until(() => notifications > 0, "restore notification");
    expect(await h.client.runtime.listSessions()).toContainEqual(
      expect.objectContaining({ id: session.id }),
    );
  } finally {
    await h.client.shutdown();
    await Promise.all([h.served, remote.served]);
  }
});

it("submit restores an archived session and broadcasts a fresh sessionsChanged", async () => {
  const h = await connectMany({ scripts: [textScript("one"), textScript("two")] });
  const remote = await h.add();
  try {
    const { session } = await h.client.runtime.createSession({ model: MODEL });
    await session.submit({ text: "first" });
    await h.client.runtime.archiveSession(session.id);
    let notifications = 0;
    remote.client.onNotification("runtime.sessionsChanged", () => notifications++);
    await until(() => notifications > 0, "archive notification");
    notifications = 0;
    await session.submit({ text: "second" });
    await until(() => notifications > 0, "automatic restore notification");
    expect(await remote.client.runtime.listSessions()).toContainEqual(
      expect.objectContaining({ id: session.id }),
    );
  } finally {
    await h.client.shutdown();
    await Promise.all([h.served, remote.served]);
  }
});

it("archive parameter validation does not reach Core", async () => {
  const h = await connectMany();
  try {
    for (const method of ["runtime.archiveSession", "runtime.unarchiveSession"] as const) {
      await expect(h.client.call(method, { sessionId: 4 } as never)).rejects.toMatchObject({
        rpcCode: -32602,
      });
    }
  } finally {
    await h.client.shutdown();
    await h.served;
  }
});
