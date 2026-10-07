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
  /**
   * 只读文件开头至多 maxBytes 字节（ADR-0051：会话列表只取日志头部）。
   * 文件更短则返回全部；截断可能落在多字节字符或一行的中间，由调用方按业务规则处理。
   */
  readFileSlice(path: string, maxBytes: number): Promise<Uint8Array>;
  /** 覆盖写入；mode 仅 POSIX 生效且只在新建文件时应用（如凭据索引 0600） */
  writeFile(path: string, data: string | Uint8Array, options?: { mode?: number }): Promise<void>;
  /** 排他创建（文件已存在时报 EEXIST）：会话锁等存在性锁的实现原语 */
  createExclusive(path: string, data: string | Uint8Array): Promise<void>;
  /** 追加写入；mode 与 writeFile 同语义——仅 POSIX 生效且只在新建文件时应用 */
  appendFile(path: string, data: string, options?: { mode?: number }): Promise<void>;
  /** 截断到指定字节长度（恢复时切除损坏尾部，sessions.md 第 4 节） */
  truncate(path: string, length: number): Promise<void>;
  /** recursive 创建；mode 仅 POSIX 生效且只作用于本次新建的目录（如 NOCTURNE_HOME 0700） */
  mkdir(path: string, options?: { mode?: number }): Promise<void>;
  /** 排他创建随机后缀目录，供外部进程探测使用。 */
  mkdtemp(prefix: string): Promise<string>;
  /** 删除临时目录及其内容；不跟随目录中的符号链接。 */
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
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
    async readFileSlice(p, maxBytes) {
      const handle = await fs.open(p, "r");
      try {
        const buffer = Buffer.alloc(maxBytes);
        const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
        return new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead);
      } finally {
        await handle.close();
      }
    },
    writeFile: (p, data, options) => fs.writeFile(p, data, { mode: options?.mode }),
    createExclusive: (p, data) => fs.writeFile(p, data, { flag: "wx" }),
    appendFile: (p, data, options) =>
      fs.appendFile(p, data, { encoding: "utf8", mode: options?.mode }),
    truncate: (p, len) => fs.truncate(p, len),
    mkdir: (p, options) =>
      fs.mkdir(p, { recursive: true, mode: options?.mode }).then(() => undefined),
    mkdtemp: (prefix) => fs.mkdtemp(prefix),
    rm: (p, options) => fs.rm(p, options),
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
