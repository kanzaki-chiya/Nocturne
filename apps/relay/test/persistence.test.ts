import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  generateIdentity,
  registerHost,
  connectHostRelay,
  connectDeviceRelay,
} from "@nocturne/remote";
import { RelayServer } from "../src/server.js";
import { fetchSafeListen } from "../../../scripts/test/ports.mjs";

it("重启后电脑与设备仍能认证，吊销墓碑持久化且 unregister 不删除", async () => {
  const dir = await mkdtemp(join(tmpdir(), "relay-persist-"));
  let relay = new RelayServer(
    { dataDir: dir, listen: await fetchSafeListen(), publicOrigin: "http://127.0.0.1:1" },
    () => {
      /* 测试日志静默。 */
    },
  );
  const hostIdentity = await generateIdentity({ extractable: true }),
    phone = await generateIdentity({ extractable: false });
  try {
    let port = await relay.start();
    let origin = `http://127.0.0.1:${port}`;
    relay.config.publicOrigin = origin;
    const invite = await relay.store.invite(origin, 10000);
    await registerHost({ origin, identity: hostIdentity, code: invite.split("/").at(-1) ?? "" });
    let host = await connectHostRelay({ origin, identity: hostIdentity, hostId: hostIdentity.id });
    await host.allowDevice({ ...phone, name: "手机" });
    await relay.close();
    relay = new RelayServer(
      { dataDir: dir, listen: await fetchSafeListen(), publicOrigin: "http://127.0.0.1:1" },
      () => {
        /* 测试日志静默。 */
      },
    );
    port = await relay.start();
    origin = `http://127.0.0.1:${port}`;
    relay.config.publicOrigin = origin;
    host = await connectHostRelay({ origin, identity: hostIdentity, hostId: hostIdentity.id });
    const device = await connectDeviceRelay({ origin, identity: phone, hostId: hostIdentity.id });
    expect(device.online).toBe(true);
    await relay.revoke("device", phone.id);
    await host.unregister();
    expect(relay.store.data.devices.some((d) => d.id === phone.id && d.revokedAt)).toBe(true);
    await relay.close();
    relay = new RelayServer(
      { dataDir: dir, listen: await fetchSafeListen(), publicOrigin: "http://127.0.0.1:1" },
      () => {
        /* 测试日志静默。 */
      },
    );
    port = await relay.start();
    origin = `http://127.0.0.1:${port}`;
    relay.config.publicOrigin = origin;
    const nextInvite = await relay.store.invite(origin, 10000);
    await registerHost({
      origin,
      identity: hostIdentity,
      code: nextInvite.split("/").at(-1) ?? "",
    });
    host = await connectHostRelay({ origin, identity: hostIdentity, hostId: hostIdentity.id });
    await expect(host.allowDevice({ ...phone, name: "手机" })).rejects.toMatchObject({
      code: "revoked",
    });
    await relay.revoke("host", hostIdentity.id);
    expect(await readFile(join(dir, "relay-data.json"), "utf8")).toContain('"revokedAt"');
  } finally {
    await relay.close();
    await rm(dir, { recursive: true, force: true });
  }
});
