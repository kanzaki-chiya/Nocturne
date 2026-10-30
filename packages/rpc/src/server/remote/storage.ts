import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { PermissionPresetName } from "@nocturne/core";
import { PERMISSION_PRESET_NAMES } from "@nocturne/core";
import {
  exportIdentity,
  generateIdentity,
  identityId,
  importIdentity,
  type Identity,
} from "@nocturne/remote";
import type { AgentScope } from "../../shared/methods.js";

export interface StoredPhoneDevice {
  kind?: "device" | undefined;
  id: string;
  name: string;
  pub: string;
  createdAt: number;
  lastSeenAt?: number;
}

export interface StoredAgentDevice {
  kind: "agent";
  id: string;
  name: string;
  pub: string;
  fingerprint: string;
  scope: AgentScope;
  maxPermissionPreset: PermissionPresetName;
  createdAt: number;
  lastSeenAt?: number | undefined;
}

export type StoredRemoteEntry = StoredPhoneDevice | StoredAgentDevice;

export interface RemoteRegistration {
  version: 1;
  origin: string;
  hostId: string;
  enabled: boolean;
  devices: StoredPhoneDevice[];
}

const VALID_PRESETS = new Set<string>(PERMISSION_PRESET_NAMES);

function isAgentDevice(value: unknown): value is StoredAgentDevice {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    item.kind === "agent" &&
    typeof item.id === "string" &&
    typeof item.name === "string" &&
    Boolean(item.name.trim()) &&
    typeof item.pub === "string" &&
    typeof item.fingerprint === "string" &&
    (item.scope === "read-only" || item.scope === "run") &&
    typeof item.maxPermissionPreset === "string" &&
    VALID_PRESETS.has(item.maxPermissionPreset) &&
    Number.isFinite(item.createdAt) &&
    (item.lastSeenAt === undefined || Number.isFinite(item.lastSeenAt))
  );
}

function isAgentsOnlyFile(value: unknown): value is { version: 1; devices: StoredAgentDevice[] } {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    obj.version === 1 &&
    obj.origin === undefined &&
    obj.hostId === undefined &&
    obj.enabled === undefined &&
    Array.isArray(obj.devices) &&
    obj.devices.every(isAgentDevice)
  );
}

async function writeRemoteJson(home: string, payload: unknown): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const path = join(home, "remote.json"),
    temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(payload), { mode: 0o600, flag: "wx" });
    if (process.platform !== "win32") await chmod(temporary, 0o600);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function loadRegistration(
  home: string,
): Promise<{ registration?: RemoteRegistration; warning?: string }> {
  try {
    const value: unknown = JSON.parse(await readFile(join(home, "remote.json"), "utf8"));
    if (typeof value !== "object" || value === null) throw new Error("invalid");
    if (isAgentsOnlyFile(value)) return {};
    const r = value as RemoteRegistration;
    const url = new URL(r.origin);
    if (
      !("version" in value) ||
      value.version !== 1 ||
      url.origin !== r.origin ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1")) ||
      !/^[A-Za-z0-9_-]{22}$/.test(r.hostId) ||
      typeof r.enabled !== "boolean" ||
      !Array.isArray(r.devices)
    )
      throw new Error("invalid");
    const ids = new Set<string>();
    const phoneDevices: StoredPhoneDevice[] = [];
    for (const d of r.devices as unknown[]) {
      if (isAgentDevice(d)) {
        if (ids.has(d.id)) throw new Error("invalid");
        ids.add(d.id);
        continue;
      }
      const phone = d as Record<string, unknown>;
      if (
        (phone.kind !== undefined && phone.kind !== "device") ||
        typeof phone.id !== "string" ||
        typeof phone.name !== "string" ||
        !phone.name.trim() ||
        typeof phone.pub !== "string" ||
        typeof phone.createdAt !== "number" ||
        !Number.isFinite(phone.createdAt) ||
        (phone.lastSeenAt !== undefined &&
          (typeof phone.lastSeenAt !== "number" || !Number.isFinite(phone.lastSeenAt))) ||
        ids.has(phone.id)
      )
        throw new Error("invalid");
      const pub = Buffer.from(phone.pub, "base64url");
      if (
        pub.length !== 65 ||
        pub[0] !== 4 ||
        pub.toString("base64url") !== phone.pub ||
        (await identityId(pub)) !== phone.id
      )
        throw new Error("invalid");
      await crypto.subtle.importKey("raw", pub, { name: "ECDSA", namedCurve: "P-256" }, false, [
        "verify",
      ]);
      ids.add(phone.id);
      phoneDevices.push(phone as unknown as StoredPhoneDevice);
    }
    return { registration: { ...r, devices: phoneDevices } };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    return { warning: "远程登记文件损坏或无法读取，已按未登记处理；原文件保留" };
  }
}

export async function saveRegistration(
  home: string,
  registration: RemoteRegistration,
): Promise<void> {
  const agents = await loadAgents(home).catch(() => [] as StoredAgentDevice[]);
  await writeRemoteJson(home, {
    ...registration,
    devices: [...registration.devices, ...agents],
  });
}

export async function preserveCorruptRegistration(home: string): Promise<string | undefined> {
  const loaded = await loadRegistration(home);
  if (!loaded.warning) return undefined;
  const name = `remote.json.corrupt-${Date.now()}-${randomUUID()}`;
  await rename(join(home, "remote.json"), join(home, name));
  return `损坏的远程登记文件已备份为 ${name}`;
}

export async function deleteRegistration(home: string): Promise<void> {
  const agents = await loadAgents(home).catch(() => [] as StoredAgentDevice[]);
  if (agents.length > 0) {
    await writeRemoteJson(home, { version: 1, devices: agents });
    return;
  }
  await rm(join(home, "remote.json"), { force: true });
}

export async function loadAgents(home: string): Promise<StoredAgentDevice[]> {
  try {
    const value: unknown = JSON.parse(await readFile(join(home, "remote.json"), "utf8"));
    if (typeof value !== "object" || value === null) return [];
    const devices = (value as { devices?: unknown }).devices;
    if (!Array.isArray(devices)) return [];
    return devices.filter(isAgentDevice);
  } catch {
    return [];
  }
}

export async function saveAgents(home: string, agents: StoredAgentDevice[]): Promise<void> {
  const loaded = await loadRegistration(home);
  if (loaded.registration !== undefined) {
    await writeRemoteJson(home, {
      ...loaded.registration,
      devices: [...loaded.registration.devices, ...agents],
    });
    return;
  }
  if (agents.length === 0) {
    if (!loaded.warning) {
      await rm(join(home, "remote.json"), { force: true });
    }
    return;
  }
  await writeRemoteJson(home, { version: 1, devices: agents });
}

export async function ensureHostIdentity(
  _home: string,
  credentials: {
    get(id: string): Promise<string | undefined>;
    set(id: string, value: string): Promise<void>;
  },
): Promise<{ identity: Identity; warning?: string }> {
  const stored = await credentials.get("remote/host-identity");
  if (stored !== undefined) {
    try {
      return { identity: await importIdentity(stored, { extractable: false }) };
    } catch {
      const identity = await generateIdentity({ extractable: true });
      await credentials.set("remote/host-identity", await exportIdentity(identity));
      return { identity, warning: "电脑身份密钥已损坏并重新生成，请重新登记远程访问" };
    }
  }
  const identity = await generateIdentity({ extractable: true });
  await credentials.set("remote/host-identity", await exportIdentity(identity));
  return { identity };
}
