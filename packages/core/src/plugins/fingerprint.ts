/**
 * 插件目录整目录 SHA-256 指纹（对齐 Codex `hooks/src/engine/plugin_fingerprint.rs`，
 * 前缀改为 `nocturne-plugin-bundle-v1`）。
 */
import { createHash } from "node:crypto";
import type { FileSystem, PathOps } from "../platform/index.js";

const FINGERPRINT_PREFIX = Buffer.from("nocturne-plugin-bundle-v1\0", "utf8");
const MANIFEST_REL_PATHS = new Set([".codex-plugin/plugin.json", ".claude-plugin/plugin.json"]);
const ICON_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".svg"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasIconExtension(filePath: string): boolean {
  const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  const dot = filePath.lastIndexOf(".");
  if (dot <= slash) return false;
  return ICON_EXTENSIONS.has(filePath.slice(dot).toLowerCase());
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    const entries = keys
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function stripManifestIcons(rawBytes: Uint8Array): Uint8Array {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(rawBytes).toString("utf8"));
    if (!isPlainObject(parsed)) return rawBytes;
    const copy: Record<string, unknown> = { ...parsed };
    if (isPlainObject(copy.interface)) {
      const rest: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(copy.interface)) {
        if (k === "composerIcon" || k === "logo") continue;
        rest[k] = v;
      }
      if (Object.keys(rest).length === 0) {
        delete copy.interface;
      } else {
        copy.interface = rest;
      }
    }
    return Buffer.from(canonicalJson(copy), "utf8");
  } catch {
    return rawBytes;
  }
}

async function collectManifestIconRelPaths(
  fs: FileSystem,
  paths: PathOps,
  rootPath: string,
): Promise<Set<string>> {
  const ignored = new Set<string>();
  const normalizeRel = (rel: string) =>
    paths.caseSensitive ? rel.replaceAll("\\", "/") : rel.replaceAll("\\", "/").toLowerCase();

  for (const manifestRel of MANIFEST_REL_PATHS) {
    const manifestPath = paths.join(rootPath, ...manifestRel.split("/"));
    try {
      const st = await fs.lstat(manifestPath);
      if (st.type !== "file") continue;
      const parsed: unknown = JSON.parse(await fs.readTextFile(manifestPath));
      if (!isPlainObject(parsed) || !isPlainObject(parsed.interface)) continue;
      for (const raw of [parsed.interface.composerIcon, parsed.interface.logo]) {
        if (typeof raw !== "string" || raw.trim() === "" || raw.includes("\0")) continue;
        if (
          paths.isAbsolute(raw) ||
          /^[A-Za-z]:/.test(raw) ||
          raw.startsWith("/") ||
          raw.startsWith("\\")
        ) {
          continue;
        }
        const candidate = paths.resolve(rootPath, raw);
        if (!paths.isWithin(rootPath, candidate) || paths.equals(rootPath, candidate)) continue;
        // 安全边界：仅跳过图片扩展名文件，避免借图标字段豁免可执行脚本
        if (!hasIconExtension(candidate)) continue;
        const rel = paths.relative(rootPath, candidate);
        if (rel !== "" && !rel.startsWith("..")) {
          ignored.add(normalizeRel(rel));
        }
      }
    } catch {
      // 清单缺失或非法时不跳过任何文件
    }
  }
  return ignored;
}

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

  const ignoredIconRels = await collectManifestIconRelPaths(fs, paths, rootPath);
  const normalizeRel = (rel: string) => (paths.caseSensitive ? rel : rel.toLowerCase());

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
        if (ignoredIconRels.has(normalizeRel(rel))) continue;
        const rawContent = await fs.readFile(entryPath);
        const content = MANIFEST_REL_PATHS.has(rel) ? stripManifestIcons(rawContent) : rawContent;
        writeLenBytes(rel);
        hash.update(Buffer.from("file\0", "utf8"));
        writeLenBytes(content);
      }
    }
  }

  await walk(rootPath, "");
  return `sha256:${hash.digest("hex")}`;
}
