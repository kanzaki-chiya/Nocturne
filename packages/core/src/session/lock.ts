/**
 * 会话锁（sessions.md 第 4 节第 1 步、ADR-0009）。
 * 存在性锁文件 `<sessionId>.lock`：`createExclusive` 原子创建，内容为
 * `{ pid, hostname, startedAt, token }`（token 是每把锁的随机值，释放时据此
 * 判定归属）。失效判定（满足其一即失效）：
 *   - 锁的 startedAt 早于本机最近一次开机（bootTimeMs）；
 *   - 锁的主机名与本机相同且 pid 已不存活。
 * 失效则删除后重试一次；仍撞上则拒绝。主机名不同、pid 存活或无法判定时拒绝。
 * 已知限制（pid 复用、非强制性）见 ADR-0009。
 */
import { randomUUID } from "node:crypto";

import { fsErrorCode, type FileSystem, type Platform } from "../platform/index.js";
import { SessionError } from "./errors.js";

export interface SessionLock {
  readonly path: string;
  /** 释放锁；best-effort，锁已被清理时不报错 */
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
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 锁是否失效。无法解析的锁内容按"mtime 早于开机时间"兜底判定——
 * 崩溃可能留下半个 JSON，但新进程的锁文件一定新于开机时间。
 */
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
    // 开机时间判定最先执行：早于开机的锁不可能属于存活的本机进程
    if (startedAt !== undefined && startedAt < boot) return true;
    if (content.hostname === platform.hostname()) {
      const pid = content.pid;
      if (typeof pid === "number" && !platform.processAlive(pid)) return true;
    }
    return false;
  }
  // 内容不可解析：按文件年龄判定
  try {
    const stat = await fs.stat(lockPath);
    return stat.mtimeMs < boot;
  } catch {
    return true; // 锁在判定间隙消失——视为失效，走重试
  }
}

export interface AcquireLockOptions {
  /** --force-unlock：先删锁再走正常流程（sessions.md 第 4 节） */
  force?: boolean | undefined;
}

/** 取得排他锁；撞锁且未失效时抛 SessionError("session_locked") */
export async function acquireSessionLock(
  fs: FileSystem,
  platform: Platform,
  lockPath: string,
  options: AcquireLockOptions = {},
): Promise<SessionLock> {
  if (options.force === true) {
    await fs.unlink(lockPath).catch(() => undefined);
  }
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
          // 只删自己写的锁：force/失效清理后可能已有新持有者。同进程同一毫秒
          // 取的两把锁 pid/hostname/startedAt 全同，归属只能靠随机 token 区分
          try {
            const cur = readLockContent(await fs.readTextFile(lockPath));
            if (cur?.token === mine.token) {
              await fs.unlink(lockPath);
            }
          } catch {
            // 锁已消失或不可读——释放语义已达
          }
        },
      };
    } catch (e) {
      if (fsErrorCode(e) !== "EEXIST") throw e;
      if (attempt === 0 && (await isStaleLock(fs, platform, lockPath))) {
        // 失效锁：删除后重试一次；删除失败（竞态/权限）按占用拒绝
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
  throw new SessionError(
    "session_locked",
    `会话被另一个进程占用（锁文件 ${lockPath}）。若确认持有者已退出，用 --force-unlock 清除残留锁`,
  );
}

/** 只读探测：锁存在且持有者看起来存活（list 用，不取得锁） */
export async function lockLooksHeld(
  fs: FileSystem,
  platform: Platform,
  lockPath: string,
): Promise<boolean> {
  if (!(await fs.exists(lockPath))) return false;
  return !(await isStaleLock(fs, platform, lockPath));
}
