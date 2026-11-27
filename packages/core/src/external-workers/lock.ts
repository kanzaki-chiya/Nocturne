/**
 * 外部 worker 跨进程互斥锁（ADR-0127 第五阶段返工）。
 *
 * 背景：单 connector 实例内的 Promise 链只能在同一进程内串行同一 worker 的
 * 续派；共享同一 NOCTURNE_HOME 的独立宿主/connector 实例（例如两个 CLI 进程、
 * 或宿主重启期间的并发调用）不受其约束，可能同时 session/load 同一外部会话，
 * 造成重复轮次与上下文错序。
 *
 * 机制：`<NOCTURNE_HOME>/external-workers/<workerId>.lock` 存在性锁，
 * `createExclusive` 原子创建，内容 `{ pid, hostname, startedAt, token }`。
 * 失效判定与 sessions.md 会话锁一致（ADR-0009）：
 *   - startedAt 早于本机最近一次开机；
 *   - 锁的主机名与本机相同且 pid 已不存活。
 * 失效锁的回收带所有权保证（返工第 3 条）：检查旧锁与删除不是原子序列时，
 * 两个并行竞争者可能同时判定同一失效锁可收——先读取旧锁内容取其 token，
 * 删除前重新读取校验 token 未变才 unlink。迟到的清理不会删掉已被另一竞争者
 * 换持的新锁（token 不同则放弃删除并重新竞争）。崩溃恢复由此保证：
 * 宿主进程崩溃留下的锁在下次续派时按 pid/开机时间判定失效回收，
 * 不会形成永久锁；token 归属校验防止误删他人新持有的锁。
 */
import { randomUUID } from "node:crypto";
import { fsErrorCode, type FileSystem, type Platform } from "../platform/index.js";

export interface WorkerLock {
  readonly path: string;
  /** 释放锁；best-effort，锁已被清理时不报错。只会删除自己（token 匹配）的锁。 */
  release(): Promise<void>;
}

interface LockContent {
  pid?: unknown;
  hostname?: unknown;
  startedAt?: unknown;
  token?: unknown;
}

function readLockContent(text: string): LockContent | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null ? value : undefined;
  } catch {
    return undefined;
  }
}

async function isStaleLock(fs: FileSystem, platform: Platform, lockPath: string): Promise<boolean> {
  const boot = platform.bootTimeMs();
  let content: LockContent | undefined;
  try {
    content = readLockContent(await fs.readTextFile(lockPath));
  } catch {
    content = undefined;
  }
  if (content !== undefined) {
    const startedAt = typeof content.startedAt === "number" ? content.startedAt : undefined;
    if (startedAt !== undefined && startedAt < boot) return true;
    if (content.hostname === platform.hostname()) {
      const pid = content.pid;
      if (typeof pid === "number" && !platform.processAlive(pid)) return true;
    }
    return false;
  }
  try {
    const stat = await fs.stat(lockPath);
    return stat.mtimeMs < boot;
  } catch {
    return true;
  }
}

/**
 * 回收失效锁的所有权守卫（返工第 3 条）：读取旧锁 token 后，删除前重新读取
 * 校验 token 未变才 unlink。token 已变说明另一竞争者已换持新锁——本方的
 * 迟到清理不得删除它，返回 false 让调用方重新竞争而非误删。
 */
async function unlinkStaleLockIfOwner(
  fs: FileSystem,
  lockPath: string,
  expectedToken: unknown,
): Promise<void> {
  // 重新读取当前锁内容：只在 token 与失效判定时一致时才删除。
  // 已变（被换持或已删）则跳过 unlink——不是本方的锁，不碰。
  let current: LockContent | undefined;
  try {
    current = readLockContent(await fs.readTextFile(lockPath));
  } catch {
    return;
  }
  if (current?.token !== expectedToken) return;
  try {
    await fs.unlink(lockPath);
  } catch {
    // 锁已消失——回收语义已达
  }
}

/**
 * 尝试取得指定 worker 的排他锁。持有者存活时返回 undefined（不等待）；
 * 取得成功返回 WorkerLock，调用方必须在 finally 中 release。
 */
export async function tryAcquireWorkerLock(
  platform: Platform,
  lockPath: string,
): Promise<WorkerLock | undefined> {
  const { fs } = platform;
  const mine = {
    pid: platform.pid(),
    hostname: platform.hostname(),
    startedAt: Date.now(),
    token: randomUUID(),
  };
  const body = JSON.stringify(mine);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fs.createExclusive(lockPath, body);
      let released = false;
      return {
        path: lockPath,
        async release() {
          if (released) return;
          released = true;
          try {
            const current = readLockContent(await fs.readTextFile(lockPath));
            if (current?.token === mine.token) {
              await fs.unlink(lockPath);
            }
          } catch {
            // 锁已消失或不可读——释放语义已达
          }
        },
      };
    } catch (error) {
      if (fsErrorCode(error) !== "EEXIST") throw error;
      if (attempt === 0 && (await isStaleLock(fs, platform, lockPath))) {
        // 失效锁回收带所有权守卫：先取旧锁 token，删除前校验未变才 unlink——
        // 并行竞争者同遇失效锁时至多一方真正删除成功，另一方 token 不匹配放弃，
        // 双方随后重新 createExclusive 竞争，原子创建保证至多一方进入 worker 操作。
        let staleToken: unknown;
        try {
          staleToken = readLockContent(await fs.readTextFile(lockPath))?.token;
        } catch {
          staleToken = undefined;
        }
        await unlinkStaleLockIfOwner(fs, lockPath, staleToken);
        continue;
      }
      break;
    }
  }
  return undefined;
}
