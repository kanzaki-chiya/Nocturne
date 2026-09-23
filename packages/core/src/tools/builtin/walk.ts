/**
 * 目录枚举（grep / glob 的内部实现路径，也作为 rg 不可用时的兜底）。
 * 不跟随符号链接 / junction（Dirent.isSymbolicLink 在 Windows 上覆盖 junction），
 * 遵守 .gitignore，始终跳过 .git。
 */
import type { FileSystem, PathOps } from "../../platform/index.js";
import { GitignoreChain } from "./gitignore.js";

export interface WalkedFile {
  /** 绝对路径（root 之下，平台分隔符） */
  path: string;
  /** 相对 root 的路径（"/" 分隔） */
  rel: string;
  size: number;
  mtimeMs: number;
}

const ALWAYS_IGNORED = new Set([".git", ".nocturne"]);

/** 与 rg 默认一致：不枚举隐藏文件（dot 开头） */
const isHidden = (name: string): boolean => name.startsWith(".");

export async function* walkFiles(
  fs: FileSystem,
  paths: PathOps,
  root: string,
  options: { signal?: AbortSignal | undefined; maxDirs?: number } = {},
): AsyncGenerator<WalkedFile> {
  const chain = new GitignoreChain();
  let dirs = 0;
  const maxDirs = options.maxDirs ?? 20_000;

  async function* visit(dirAbs: string, dirRel: string): AsyncGenerator<WalkedFile> {
    if (options.signal?.aborted) return;
    if (++dirs > maxDirs) return;
    const giContent = await fs
      .readTextFile(paths.join(dirAbs, ".gitignore"))
      .catch(() => undefined);
    chain.push(dirRel, giContent);
    let entries;
    try {
      entries = await fs.readdir(dirAbs);
    } catch {
      chain.pop();
      return;
    }
    try {
      for (const e of entries) {
        if (options.signal?.aborted) return;
        if (e.type === "symlink") continue; // 不跟随链接 / junction
        const rel = dirRel === "" ? e.name : `${dirRel}/${e.name}`;
        if (ALWAYS_IGNORED.has(e.name) || isHidden(e.name)) continue;
        if (chain.ignores(rel, e.type === "directory")) continue;
        if (e.type === "directory") {
          yield* visit(e.path, rel);
        } else if (e.type === "file") {
          const stat = await fs.lstat(e.path).catch(() => undefined);
          yield {
            path: e.path,
            rel,
            size: stat?.size ?? 0,
            mtimeMs: stat?.mtimeMs ?? 0,
          };
        }
      }
    } finally {
      chain.pop();
    }
  }

  yield* visit(root, "");
}
