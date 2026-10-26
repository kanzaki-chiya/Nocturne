import { afterEach, expect, it, vi } from "vitest";
import { cleanupTmp, connectMany, MODEL, until } from "./harness.js";

afterEach(cleanupTmp);

it("listSessions distinguishes this hub from another Runtime holding the lock", async () => {
  const h = await connectMany();
  const remote = await h.add();
  try {
    const { session } = await h.client.runtime.createSession({ model: MODEL });
    expect(await remote.client.runtime.listSessions()).toContainEqual(
      expect.objectContaining({ id: session.id, locked: true, openHere: true }),
    );
    await session.close();
    expect(await h.client.runtime.listSessions()).toContainEqual(
      expect.objectContaining({ id: session.id, locked: false, openHere: false }),
    );
    const other = await connectMany({ sessionsDir: h.sessionsDir, ws: h.ws });
    try {
      await other.client.runtime.resumeSession(session.id);
      expect(await h.client.runtime.listSessions()).toContainEqual(
        expect.objectContaining({ id: session.id, locked: true, openHere: false }),
      );
    } finally {
      await other.client.shutdown();
      await other.served;
    }
  } finally {
    await h.client.shutdown();
    await Promise.all([h.served, remote.served]);
  }
});

it("listSessions includes a session while hub resume is still opening", async () => {
  const h = await connectMany();
  const remote = await h.add();
  try {
    const { session } = await h.client.runtime.createSession({ model: MODEL });
    await session.close();
    const runtime = h.runtimes[0];
    if (!runtime) throw new Error("missing Runtime");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = runtime.resumeSession;
    const resume = vi.spyOn(runtime, "resumeSession").mockImplementation(async (...args) => {
      await gate;
      return original(...args);
    });
    const opening = h.client.runtime.resumeSession(session.id);
    await until(() => resume.mock.calls.length === 1);
    try {
      expect(await remote.client.runtime.listSessions()).toContainEqual(
        expect.objectContaining({ id: session.id, locked: false, openHere: true }),
      );
    } finally {
      release();
      await opening;
      resume.mockRestore();
    }
  } finally {
    await h.client.shutdown();
    await Promise.all([h.served, remote.served]);
  }
});
