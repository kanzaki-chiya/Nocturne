/**
 * Platform 门面：Runtime 取得的全部系统能力。
 * 业务判断（如"是否在工作区内"）不属于这里。
 */
import os from "node:os";
import process from "node:process";
import { createNodeFileSystem, type FileSystem } from "./fs.js";
import { createPathOps, type PathOps } from "./paths.js";
import { createProcessRunner, type ProcessRunner } from "./process.js";
import { resolveRealPath } from "./realpath.js";

export interface Platform {
  readonly fs: FileSystem;
  readonly paths: PathOps;
  readonly process: ProcessRunner;
  /** 文件系统路径比较是否大小写敏感（供权限层以数据形式使用） */
  readonly caseSensitivePaths: boolean;
  /** 用户主目录 */
  homeDir(): string;
  /** Nocturne 数据目录：NOCTURNE_HOME 环境变量或 ~/.nocturne */
  nocturneHome(): string;
  /** 读取环境变量（凭据只经此进入，见 workflow.md 第 7 节） */
  env(name: string): string | undefined;
  /** 真实路径解析：含不存在尾巴与 junction/symlink（permissions.md 4.2） */
  resolveReal(path: string): Promise<string>;
  /** 本进程 pid（会话锁持有者标识） */
  pid(): number;
  /** 主机名（会话锁失效判定：跨主机锁不算本机存活进程） */
  hostname(): string;
  /** 指定 pid 的进程看起来存活（同主机判定用；无法判定时按存活处理） */
  processAlive(pid: number): boolean;
  /** 本机最近一次开机的 Unix 毫秒时刻（锁 startedAt 早于它即失效，ADR-0009） */
  bootTimeMs(): number;
}

export function createPlatform(): Platform {
  const fs = createNodeFileSystem();
  // Windows 与 macOS 默认大小写不敏感（permissions.md 4.2）
  const caseSensitive = process.platform !== "win32" && process.platform !== "darwin";
  const paths = createPathOps(caseSensitive);
  return {
    fs,
    paths,
    process: createProcessRunner(),
    caseSensitivePaths: caseSensitive,
    homeDir: () => os.homedir(),
    nocturneHome() {
      const override = process.env.NOCTURNE_HOME;
      if (override !== undefined && override.length > 0) {
        return paths.resolve(override, ".");
      }
      return paths.join(os.homedir(), ".nocturne");
    },
    env: (name) => process.env[name],
    resolveReal: (p) => resolveRealPath(fs, paths, p),
    pid: () => process.pid,
    hostname: () => os.hostname(),
    processAlive(pid) {
      try {
        // signal 0：只探测不发送
        process.kill(pid, 0);
        return true;
      } catch (e) {
        // EPERM = 进程存在但无权限发信号——仍然算存活
        return typeof e === "object" && e !== null && (e as { code?: string }).code === "EPERM";
      }
    },
    bootTimeMs: () => Date.now() - os.uptime() * 1000,
  };
}
