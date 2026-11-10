import * as fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { generateIdentity } from "@nocturne/remote";
import {
  deleteRegistration,
  loadAgents,
  loadRegistration,
  saveAgents,
  saveRegistration,
  type RemoteRegistration,
  type StoredAgentDevice,
} from "../src/server/remote/storage.js";
import { cleanupTmp, tmpDir } from "./harness.js";
import { AgentHost, type AgentConnectionContext } from "../src/server/agent/host.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

afterEach(async () => {
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  vi.mocked(fs.rename).mockReset().mockImplementation(actual.rename);
  vi.restoreAllMocks();
  cleanupTmp();
});

const agent: StoredAgentDevice = {
  kind: "agent",
  id: "test-agent",
  name: "Test Agent",
  pub: "test-pub",
  fingerprint: "0000:1111:2222:3333",
  scope: "read-only",
  maxPermissionPreset: "default",
  createdAt: 1,
};

async function registration(): Promise<RemoteRegistration> {
  return {
    version: 1,
    origin: "https://relay.example.com",
    hostId: (await generateIdentity({ extractable: false })).id,
    enabled: true,
    devices: [],
  };
}

it("concurrent agent and registration updates preserve both kinds of devices", async () => {
  const home = tmpDir("nocturne-storage-");
  const initial = await registration();
  await saveRegistration(home, initial);
  const phone = await generateIdentity({ extractable: false });
  const next = {
    ...initial,
    enabled: false,
    devices: [
      {
        id: phone.id,
        name: "Phone",
        pub: Buffer.from(phone.publicKey).toString("base64url"),
        createdAt: 2,
      },
    ],
  };
  await Promise.all([saveAgents(home, [agent]), saveRegistration(home, next)]);
  expect(await loadAgents(home)).toEqual([agent]);
  expect((await loadRegistration(home)).registration).toEqual(next);
});

it("concurrent registration deletion preserves newly saved agents", async () => {
  const home = tmpDir("nocturne-storage-");
  await saveRegistration(home, await registration());
  await Promise.all([saveAgents(home, [agent]), deleteRegistration(home)]);
  expect(await loadAgents(home)).toEqual([agent]);
  expect(await loadRegistration(home)).toEqual({});
});

it.skipIf(process.platform !== "win32")("retries transient Windows rename failures", async () => {
  const home = tmpDir("nocturne-storage-");
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  vi.mocked(fs.rename)
    .mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "EPERM" }))
    .mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "EACCES" }))
    .mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "EBUSY" }))
    .mockImplementation(actual.rename);
  await saveAgents(home, [agent]);
  expect(await loadAgents(home)).toEqual([agent]);
  expect(await fs.readdir(home)).toEqual(["remote.json"]);
});

it.skipIf(process.platform !== "win32")(
  "permanent Windows locks fail within a bounded retry budget",
  async () => {
    const home = tmpDir("nocturne-storage-");
    const error = Object.assign(new Error("locked"), { code: "EPERM" });
    vi.mocked(fs.rename).mockRejectedValue(error);
    const started = performance.now();
    await expect(saveAgents(home, [agent])).rejects.toBe(error);
    expect(fs.rename).toHaveBeenCalledTimes(6);
    expect(performance.now() - started).toBeLessThan(1_500);
    expect(await fs.readdir(home)).toEqual([]);
  },
);

it("connection and initialize persistence errors are diagnosed while memory stays usable", async () => {
  const home = tmpDir("nocturne-storage-");
  await saveAgents(home, [agent]);
  const diagnosed = vi.fn();
  const host = new AgentHost({
    home,
    serve: async () => undefined,
    notify: () => undefined,
    onPersistenceError: diagnosed,
  });
  await host.start();
  vi.mocked(fs.rename).mockRejectedValue(
    Object.assign(new Error("private detail"), { code: "EIO" }),
  );
  const ctx: AgentConnectionContext = {
    connectionId: "test",
    agentId: agent.id,
    publicKey: agent.pub,
    fingerprint: agent.fingerprint,
    name: agent.name,
    close: () => undefined,
  };
  try {
    host.registerConnection(ctx);
    host.onInitialize(ctx, { clientName: "Renamed Agent" });
    await vi.waitFor(() => expect(diagnosed).toHaveBeenCalledTimes(2));
    expect(diagnosed.mock.calls).toEqual([["EIO"], ["EIO"]]);
    expect(host.describe().agents[0]).toMatchObject({ name: "Renamed Agent", online: true });
    expect(host.checkMethod(ctx, "runtime.listSessions")).toBeDefined();
    diagnosed.mockImplementation(() => {
      throw new Error("diagnostic sink failed");
    });
    host.onInitialize(ctx, { clientName: "Still connected" });
    await vi.waitFor(() => expect(diagnosed).toHaveBeenCalledTimes(3));
    expect(host.describe().agents[0]?.name).toBe("Still connected");
  } finally {
    await host.stop();
  }
});

it("a failed write cleans its temporary file and does not block later updates", async () => {
  const home = tmpDir("nocturne-storage-");
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  const error = Object.assign(new Error("disk failure"), { code: "EIO" });
  vi.mocked(fs.rename).mockRejectedValueOnce(error).mockImplementation(actual.rename);
  await expect(saveAgents(home, [agent])).rejects.toBe(error);
  expect(await fs.readdir(home)).toEqual([]);
  await saveAgents(home, [agent]);
  expect(await loadAgents(home)).toEqual([agent]);
  expect(JSON.parse(await fs.readFile(join(home, "remote.json"), "utf8"))).toEqual({
    version: 1,
    devices: [agent],
  });
});
