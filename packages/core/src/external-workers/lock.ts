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
 * 失效则删除后重试一次；仍撞上（或持有者存活）返回 busy——调用方据此给
 * 出可识别的 worker_busy 错误，绝不等待或静默串行。崩溃恢复由此保证：
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
        try {
          await fs.unlink(lockPath);
        } catch {
          break;
        }
        continue;
      }
      break;
    }
  }
  return undefined;
}
