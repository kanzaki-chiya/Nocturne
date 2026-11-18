/**
 * 插件目录整目录 SHA-256 指纹（对齐 Codex `hooks/src/engine/plugin_fingerprint.rs`，
 * 前缀改为 `nocturne-plugin-bundle-v1`）。
 */
import { createHash } from "node:crypto";
import type { FileSystem, PathOps } from "../platform/index.js";

const FINGERPRINT_PREFIX = Buffer.from("nocturne-plugin-bundle-v1\0", "utf8");

function shouldSkipEntry(name: string): boolean {
  return (
    name === "__pycache__" ||
    name === ".venv" ||
    name.endsWith(".pyc") ||
    name.endsWith(".egg-info")
  );
}

function encodeLength(len: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(len));
  return buf;
}

export async function computePluginFingerprint(
  fs: FileSystem,
  paths: PathOps,
  rootPath: string,
  rawRootPath?: string,
): Promise<string> {
  const checkPath = rawRootPath ?? rootPath;
  const rootStat = await fs.lstat(checkPath);
  if (rootStat.type !== "directory") {
    throw new Error(`插件根目录不是普通目录（${rootStat.type}）：${checkPath}`);
  }

  const hash = createHash("sha256");
  hash.update(FINGERPRINT_PREFIX);

  const writeLenBytes = (data: Uint8Array | string) => {
    const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    hash.update(encodeLength(buf.length));
    hash.update(buf);
  };

  async function walk(dir: string, relPrefix: string): Promise<void> {
    const entries = await fs.readdir(dir);
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (shouldSkipEntry(entry.name)) continue;
      const rel = relPrefix === "" ? entry.name : `${relPrefix}/${entry.name}`;
      const entryPath = paths.join(dir, entry.name);
      const stat = await fs.lstat(entryPath);
      if (stat.type === "symlink" || stat.type === "other") {
        throw new Error(`插件目录包含不允许的条目（${stat.type}）：${rel}`);
      }
      if (stat.type === "directory") {
        writeLenBytes(rel);
        hash.update(Buffer.from("directory\0", "utf8"));
        await walk(entryPath, rel);
      } else {
        const content = await fs.readFile(entryPath);
        writeLenBytes(rel);
        hash.update(Buffer.from("file\0", "utf8"));
        writeLenBytes(content);
      }
    }
  }

  await walk(rootPath, "");
  return `sha256:${hash.digest("hex")}`;
}
