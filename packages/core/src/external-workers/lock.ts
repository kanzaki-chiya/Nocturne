/**
 * 外部 worker 跨进程互斥锁（ADR-0127 第五阶段返工，锁原语重写）。
 *
 * 背景：单 connector 实例内的 Promise 链只能在同一进程内串行同一 worker 的
 * 续派；共享同一 NOCTURNE_HOME 的独立宿主/connector 实例（例如两个 CLI 进程、
 * 或宿主重启期间的并发调用）不受其约束，可能同时 session/load 同一外部会话，
 * 造成重复轮次与上下文错序。
 *
 * 原语选择（返工重写动机）：上一版用 `<workerId>.lock` 存在性文件 +
 * createExclusive + pid/开机时间失效判定 + token 归属校验。该方案存在无法消除的
 * 临界区——失效判定（read）与回收（unlink）不是原子序列，判定后读到的 token
 * 可能已是新持有者，unlink 也不与换持互斥；继续加读取次数或延时都不能闭合这个
 * 窗口。因此改为成熟的事务原语：SQLite 的写事务（`BEGIN IMMEDIATE`）。
 *
 * 为什么不用单一数据库文件：SQLite 的写事务是**全库级**写锁，没有行级写锁——
 * 单一 `worker-locks.db` 里即便按 workerId 分行，一个 worker 的未提交写事务也会
 * 阻塞所有其他 worker 的 `BEGIN IMMEDIATE`（实测验证）。这会把"不同 worker
 * 可并行"错误地串行化。因此采用**每 worker 一个独立数据库文件**：
 *   `<NOCTURNE_HOME>/external-workers/<workerId>.lock.db`
 * 文件独立使不同 worker 的写事务互不干扰（天然并行），而同一 worker 的并发
 * 获取竞争同一文件，`BEGIN IMMEDIATE` 在文件层强制互斥。
 *
 * 机制：获取锁 = 打开该 worker 的 `.lock.db`，`BEGIN IMMEDIATE` 写入占位行并
 * **保持事务不提交**。SQLite 保证同一时刻该文件至多一个未提交写事务，因此：
 *   - 互斥由数据库引擎在文件层强制，跨进程、跨宿主实例都生效；
 *   - 持有者存活时，竞争者的 `BEGIN IMMEDIATE` 立即报 `database is locked`
 *     （busy_timeout=0，绝不阻塞 event loop 等待）→ 返回 undefined（busy）；
 *   - 持有进程崩溃（含未提交事务被 kill）时，操作系统关闭其文件句柄，
 *     SQLite 在下次访问时自动回滚该未完成事务，锁随之释放——无需 pid 探测、
 *     无需开机时间判定、无需 token 归属校验，不存在"检查与回收"的临界区；
 *   - release = `ROLLBACK`：锁语义只在事务存续期间，回滚后占位行不落地，
 *     文件保持空表，其他进程随后可立即 `BEGIN IMMEDIATE`。
 *
 * 依赖与平台：`node:sqlite` 是 Node 内置模块（产品要求 Node >=24.16，
 * DatabaseSync 自 23.4 起稳定可用），零新增第三方依赖。SQLite 事务语义在
 * Windows / macOS / Linux 一致，不依赖任何平台特定的文件锁、socket 或
 * unlink 技巧——这是统一的跨平台事务原语。
 */
import { DatabaseSync } from "node:sqlite";
import type { Platform } from "../platform/index.js";

const BUSY_TIMEOUT_MS = 0;

export interface WorkerLock {
  readonly path: string;
  /** 释放锁；幂等，已释放或连接已关闭时不报错。 */
  release(): Promise<void>;
}

/**
 * 锁数据库路径：与 worker 元数据同目录，每 worker 一个 `<workerId>.lock.db`。
 * `lockPath` 参数保留既有调用约定（`<dir>/<workerId>.lock`），本实现把扩展名
 * 换成 `.lock.db` 派生实际数据库路径，不改变按 workerId 寻址的语义。
 */
function deriveDbPath(platform: Platform, lockPath: string): string {
  return lockPath.endsWith(".lock")
    ? `${lockPath.slice(0, -".lock".length)}.lock.db`
    : `${lockPath}.db`;
}

/**
 * 尝试取得指定 worker 的排他锁。持有者存活时返回 undefined（不等待）；
 * 取得成功返回 WorkerLock，调用方必须在 finally 中 release。
 *
 * 同步说明：`node:sqlite` 的 DatabaseSync 是同步 API。本实现把 busy_timeout 设为 0，
 * `BEGIN IMMEDIATE` 在锁被占用时立即抛错而非等待，因此同步调用只覆盖一次微秒级
 * 的本地数据库操作，不会在 event loop 上产生可感知阻塞；busy 路径不等待、由
 * 调用方（connector）映射为可识别的 worker_busy。
 */
export async function tryAcquireWorkerLock(
  platform: Platform,
  lockPath: string,
): Promise<WorkerLock | undefined> {
  // 锁与 worker 记录同目录；connector 已确保目录存在，这里兜底创建（幂等）。
  const normalized = lockPath.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  const dir = slash >= 0 ? lockPath.slice(0, slash) : lockPath;
  await platform.fs.mkdir(dir, { mode: 0o700 }).catch(() => undefined);
  const dbPath = deriveDbPath(platform, lockPath);

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath);
  } catch {
    // 数据库文件无法打开（损坏、权限）时按 busy 处理——宁可不进入 worker 操作，
    // 也不在互斥无法保证时放行并发。
    return undefined;
  }

  try {
    db.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`);
    // 单行占位表：CHECK(id=1) 约束全表至多一行，事务本身即锁，行内容仅诊断用。
    db.exec(
      "CREATE TABLE IF NOT EXISTS worker_lock(id INTEGER PRIMARY KEY CHECK(id=1), holder TEXT)",
    );
    // BEGIN IMMEDIATE 是互斥核心：同一时刻该文件至多一个未提交写事务。
    // 失败（database is locked）即他方持有，抛错进入 catch → busy。
    db.exec("BEGIN IMMEDIATE");
  } catch {
    db.close();
    return undefined;
  }

  // 至此本进程持有该文件唯一写事务。写入占位行后保持事务不提交，直到 release。
  // 行内容仅诊断用途，崩溃后随事务回滚消失，无残留状态需要清理。
  try {
    const insert = db.prepare("INSERT OR REPLACE INTO worker_lock(id, holder) VALUES(1, ?)");
    insert.run(`${platform.hostname()}:${platform.pid()}`);
  } catch {
    // 行写入失败不应保留已建立的事务锁——回滚并按 busy 处理（保守：不放行并发）。
    try {
      db.exec("ROLLBACK");
    } catch {
      // 事务可能已不在——忽略
    }
    db.close();
    return undefined;
  }

  let released = false;
  // 释放是同步的 sqlite 调用（ROLLBACK/close），包装为已解决的 Promise 以符合接口。
  const release = (): Promise<void> => {
    if (released) return Promise.resolve();
    released = true;
    try {
      // 回滚而非提交：锁语义只要求事务存续期间的互斥，无需把占位行持久化。
      // 回滚后表保持为空，无行增长；其他进程随后可立即 BEGIN IMMEDIATE。
      db.exec("ROLLBACK");
    } catch {
      // 无活跃事务（理论上不发生）——释放语义已达
    }
    try {
      db.close();
    } catch {
      // 已关闭——忽略
    }
    return Promise.resolve();
  };

  return { path: dbPath, release };
}
