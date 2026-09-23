/**
 * 文件系统访问（modules.md：platform 节）。
 * 全部真实 FS I/O 集中在这里；业务模块不得直接使用 node:fs。
 */
import type { Dirent, Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export type FileType = "file" | "directory" | "symlink" | "other";

export interface DirEntry {
  name: string;
  /** 完整路径（目录路径 + name） */
  path: string;
  type: FileType;
}

export interface FileStat {
  /** lstat 语义：符号链接自身报告为 symlink，不解析到目标 */
  type: FileType;
  size: number;
  mtimeMs: number;
}

export interface FileSystem {
  readFile(path: string): Promise<Uint8Array>;
  readTextFile(path: string): Promise<string>;
  /** 覆盖写入（会话日志只用于创建新文件；工具的写入工具在后续阶段加入） */
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  appendFile(path: string, data: string): Promise<void>;
  /** recursive 创建 */
  mkdir(path: string): Promise<void>;
  readdir(path: string): Promise<DirEntry[]>;
  /** 跟随符号链接 */
  stat(path: string): Promise<FileStat>;
  /** 不跟随符号链接 */
  lstat(path: string): Promise<FileStat>;
  realpath(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  unlink(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  /** 把文件数据刷到操作系统（进程崩溃级持久性，sessions.md 第 5 节） */
  fsync(path: string): Promise<void>;
}

/** 取出 Node FS 错误的 code（ENOENT 等），供上层映射为自己的错误码 */
export function fsErrorCode(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e
    ? (e as { code?: string }).code
    : undefined;
}

function direntType(d: Dirent): FileType {
  if (d.isFile()) return "file";
  if (d.isDirectory()) return "directory";
  // Windows junction 在 Dirent 上同样报告为 symbolic link
  if (d.isSymbolicLink()) return "symlink";
  return "other";
}

function statType(s: Stats): FileType {
  if (s.isFile()) return "file";
  if (s.isDirectory()) return "directory";
  if (s.isSymbolicLink()) return "symlink";
  return "other";
}

export function createNodeFileSystem(): FileSystem {
  return {
    readFile: (p) => fs.readFile(p),
    readTextFile: (p) => fs.readFile(p, "utf8"),
    writeFile: (p, data) => fs.writeFile(p, data),
    appendFile: (p, data) => fs.appendFile(p, data, "utf8"),
    mkdir: (p) => fs.mkdir(p, { recursive: true }).then(() => undefined),
    async readdir(p) {
      const dirents = await fs.readdir(p, { withFileTypes: true });
      return dirents.map((d) => ({
        name: d.name,
        path: path.join(p, d.name),
        type: direntType(d),
      }));
    },
    async stat(p) {
      const s = await fs.stat(p);
      return { type: statType(s), size: s.size, mtimeMs: s.mtimeMs };
    },
    async lstat(p) {
      const s = await fs.lstat(p);
      return { type: statType(s), size: s.size, mtimeMs: s.mtimeMs };
    },
    realpath: (p) => fs.realpath(p),
    async exists(p) {
      try {
        await fs.access(p);
        return true;
      } catch {
        return false;
      }
    },
    unlink: (p) => fs.unlink(p),
    rename: (o, n) => fs.rename(o, n),
    async fsync(p) {
      const handle = await fs.open(p, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
  };
}
