import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  exportIdentity,
  fingerprint,
  generateIdentity,
  importIdentity,
  type Identity,
} from "@nocturne/remote";
import { resolveNocturneHome } from "./pipe.js";

export interface BridgeIdentityResult {
  identity: Identity;
  fingerprint: string;
  filePath: string;
  label?: string | undefined;
}

function sanitizeSlotLabel(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || !/^[A-Za-z0-9._-]+$/.test(trimmed) || trimmed === "." || trimmed === "..") {
    throw new Error(`无效的桥名称标签：${raw}（只允许字母、数字、点、下划线和连字符）`);
  }
  return trimmed;
}

function formatFingerprint(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes).toString("hex").slice(0, 16);
  return hex.match(/.{1,4}/g)?.join(":") ?? hex;
}

/**
 * 加载或首次生成 MCP 桥身份密钥对（ADR-0074 §3）：
 * - 默认保存在 `<nocturneHome>/mcp-bridge/identity.json`（权限仅当前用户可读 `0600`）；
 * - 传入 `--name <label>` 时保存在 `<nocturneHome>/mcp-bridge/<label>.json`。
 */
export async function loadOrCreateBridgeIdentity(options?: {
  home?: string | undefined;
  name?: string | undefined;
}): Promise<BridgeIdentityResult> {
  const home = resolveNocturneHome(options?.home);
  const label = options?.name !== undefined ? sanitizeSlotLabel(options.name) : undefined;
  const dir = path.join(home, "mcp-bridge");
  const fileName = label !== undefined && label !== "identity" ? `${label}.json` : "identity.json";
  const filePath = path.join(dir, fileName);

  try {
    const raw = await readFile(filePath, "utf8");
    const identity = await importIdentity(raw, { extractable: false });
    const fp = formatFingerprint(await fingerprint(identity.publicKey));
    return {
      identity,
      fingerprint: fp,
      filePath,
      ...(label !== undefined ? { label } : {}),
    };
  } catch {
    /* 不存在或已损坏：重新生成并原子写入 */
  }

  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    await chmod(dir, 0o700).catch(() => undefined);
  }
  const generated = await generateIdentity({ extractable: true });
  const exported = await exportIdentity(generated);
  const tempPath = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tempPath, `${exported}\n`, { mode: 0o600 });
    if (process.platform !== "win32") {
      await chmod(tempPath, 0o600);
    }
    await rename(tempPath, filePath);
    if (process.platform !== "win32") {
      await chmod(filePath, 0o600).catch(() => undefined);
    }
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }

  const identity = await importIdentity(exported, { extractable: false });
  const fp = formatFingerprint(await fingerprint(identity.publicKey));
  return {
    identity,
    fingerprint: fp,
    filePath,
    ...(label !== undefined ? { label } : {}),
  };
}
