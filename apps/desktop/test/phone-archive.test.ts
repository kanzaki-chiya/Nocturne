import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createRuntime, FakeProvider } from "@nocturne/core";
import { createMemoryTransportPair, createRpcClient } from "@nocturne/rpc/client";
import { createRpcServer } from "@nocturne/rpc/server";
import { PhoneSessions } from "../src/web/sessions";

it("手机网页与安卓共享列表排除归档，恢复后通过列表通知重新出现", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "nct-phone-archive-"));
  const runtime = await createRuntime({
    cwd: home,
    sessionsDir: path.join(home, "sessions"),
    providers: [new FakeProvider({ scripts: [] })],
  });
  const server = createRpcServer({
    nocturneVersion: "test",
    createRuntime: () => Promise.resolve({ runtime }),
  });
  const [localServer, localTransport] = createMemoryTransportPair();
  const [phoneServer, phoneTransport] = createMemoryTransportPair();
  const localDone = server.serve(localServer);
  const phoneDone = server.serve(phoneServer, { origin: "remote" });
  const local = createRpcClient(localTransport, { clientName: "desktop-test" });
  const phone = createRpcClient(phoneTransport, { clientName: "phone-test" });
  const sessions = new PhoneSessions(() => undefined);
  try {
    await local.initialize();
    await phone.initialize();
    const { session } = await local.runtime.createSession({ model: "fake/fake-model" });
    await local.runtime.archiveSession(session.id);
    await sessions.connected(phone);
    expect(sessions.list.map((s) => s.id)).not.toContain(session.id);
    expect(await phone.runtime.listSessions({ includeArchived: true })).toEqual([]);
    await local.runtime.unarchiveSession(session.id);
    await expect.poll(() => sessions.list.map((s) => s.id)).toContain(session.id);
  } finally {
    sessions.disconnected();
    await local.shutdown();
    await Promise.all([localDone, phoneDone]);
    await rm(home, { recursive: true, force: true });
  }
});
