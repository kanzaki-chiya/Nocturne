import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { identityId } from "@nocturne/remote";

export interface RemoteRegistration {
  version: 1;
  origin: string;
  hostId: string;
  enabled: boolean;
  devices: { id: string; name: string; pub: string; createdAt: number; lastSeenAt?: number }[];
}

export async function loadRegistration(
  home: string,
): Promise<{ registration?: RemoteRegistration; warning?: string }> {
  try {
    const value: unknown = JSON.parse(await readFile(join(home, "remote.json"), "utf8"));
    if (typeof value !== "object" || value === null) throw new Error("invalid");
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
    for (const d of r.devices) {
      if (
        typeof d.id !== "string" ||
        typeof d.name !== "string" ||
        !d.name.trim() ||
        typeof d.pub !== "string" ||
        !Number.isFinite(d.createdAt) ||
        (d.lastSeenAt !== undefined && !Number.isFinite(d.lastSeenAt)) ||
        ids.has(d.id)
      )
        throw new Error("invalid");
      const pub = Buffer.from(d.pub, "base64url");
      if (
        pub.length !== 65 ||
        pub[0] !== 4 ||
        pub.toString("base64url") !== d.pub ||
        (await identityId(pub)) !== d.id
      )
        throw new Error("invalid");
      await crypto.subtle.importKey("raw", pub, { name: "ECDSA", namedCurve: "P-256" }, false, [
        "verify",
      ]);
      ids.add(d.id);
    }
    return { registration: r };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    return { warning: "远程登记文件损坏或无法读取，已按未登记处理；原文件保留" };
  }
}

export async function saveRegistration(
  home: string,
  registration: RemoteRegistration,
): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const path = join(home, "remote.json"),
    temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(registration), { mode: 0o600, flag: "wx" });
    if (process.platform !== "win32") await chmod(temporary, 0o600);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function preserveCorruptRegistration(home: string): Promise<string | undefined> {
  const loaded = await loadRegistration(home);
  if (!loaded.warning) return undefined;
  const name = `remote.json.corrupt-${Date.now()}-${randomUUID()}`;
  await rename(join(home, "remote.json"), join(home, name));
  return `损坏的远程登记文件已备份为 ${name}`;
}

export async function deleteRegistration(home: string): Promise<void> {
  await rm(join(home, "remote.json"), { force: true });
}
