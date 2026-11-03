import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
const { current } = vi.hoisted(() => ({ current: vi.fn() }));
vi.mock("../src/platform/workspace-branches.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/platform/workspace-branches.js")>()),
  gitCurrentBranch: current,
}));
import { createRuntime, FakeProvider } from "../src/index.js";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("a timed-out or failed Turn-before branch read neither writes an observation nor prevents the model request", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "branch-read-failure-"));
  roots.push(root);
  const provider = new FakeProvider({
    handler: () => [
      { type: "text_delta", text: "ok" },
      { type: "finish", reason: "stop" },
    ],
  });
  const rt = await createRuntime({
    cwd: root,
    sessionsDir: path.join(root, "sessions"),
    providers: [provider],
    subagent: { enabled: false },
  });
  const session = await rt.createSession({ model: "fake/fake-1" });
  current
    .mockResolvedValueOnce(null)
    .mockRejectedValueOnce(Object.assign(new Error("timeout"), { killed: true }));
  expect(await session.submit({ text: "read timed out" })).toBe("done");
  expect(await session.submit({ text: "read failed" })).toBe("done");
  expect(current).toHaveBeenCalledTimes(2);
  expect(
    provider.requests.filter((request) => JSON.stringify(request.messages).includes("read failed"))
      .length,
  ).toBeGreaterThan(0);
  expect(session.state().config.branch).toBeUndefined();
  expect(
    session
      .durableEvents()
      .filter(
        (event) => event.type === "session.config_changed" && event.payload.branch !== undefined,
      ),
  ).toHaveLength(0);
  expect(session.state().history.filter((entry) => entry.kind === "note")).toHaveLength(0);
  await session.close();
});
