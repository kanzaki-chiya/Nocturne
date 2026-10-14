import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, rename, chmod } from "node:fs/promises";
import { join } from "node:path";

export interface InviteRecord {
  hash: string;
  note?: string;
  createdAt: number;
  expiresAt: number;
  usedAt?: number;
}
export interface HostRecord {
  id: string;
  pub: string;
  note?: string;
  createdAt: number;
  lastSeenAt?: number;
  revokedAt?: number;
}
export interface PushSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}
export interface DeviceRecord extends HostRecord {
  hostId: string;
  name: string;
  push?: PushSubscription;
}
export interface RelayData {
  version: 1;
  invites: InviteRecord[];
  hosts: HostRecord[];
  devices: DeviceRecord[];
}
export const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
export class Store {
  data: RelayData = { version: 1, invites: [], hosts: [], devices: [] };
  private writes = Promise.resolve();
  constructor(readonly dir: string) {}
  async open(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(this.dir, 0o700);
    try {
      const data = JSON.parse(await readFile(join(this.dir, "relay-data.json"), "utf8")) as Omit<
        RelayData,
        "version"
      > & { version: unknown };
      if (
        data.version !== 1 ||
        !Array.isArray(data.invites) ||
        !Array.isArray(data.hosts) ||
        !Array.isArray(data.devices)
      )
        throw new Error("中继数据格式错误");
      this.data = { ...data, version: 1 };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  save(): Promise<void> {
    const snapshot = JSON.stringify(this.data);
    const write = this.writes.then(async () => {
      const temp = join(this.dir, "relay-data.json.tmp");
      await writeFile(temp, snapshot, { mode: 0o600 });
      await rename(temp, join(this.dir, "relay-data.json"));
    });
    this.writes = write;
    return write;
  }
  async invite(origin: string, expiresMs: number, note?: string): Promise<string> {
    const code = randomBytes(18).toString("base64url");
    this.data.invites.push({
      hash: hash(code),
      createdAt: Date.now(),
      expiresAt: Date.now() + expiresMs,
      ...(note === undefined ? {} : { note }),
    });
    await this.save();
    return `nocturne-invite:${new URL(origin).host}/${code}`;
  }
}
