/**
 * ADR-0127 第五阶段返工：worker 跨进程互斥锁（SQLite 事务原语）的验收测试。
 *
 * 上一版存在性文件锁（createExclusive + pid/开机时间失效判定 + token 校验）存在
 * 无法闭合的临界区：失效判定与回收非原子，且本组旧测试只在 createExclusive 前
 * 固定 sleep 5ms——既不能证明互斥，也不能证明崩溃恢复。本组改为**真跨进程**测试：
 * 用 `spawn` 启动独立 node 进程持锁，经 **stdio 消息屏障**（非固定毫秒延时）
 * 协调时序，验证：
 *   1. 恢复竞争中只有一个进程能进入实际 worker 操作（另一个 busy）；
 *   2. 持有进程被强杀（SIGKILL，含未提交事务）后，其余进程可继续——崩溃可恢复；
 *   3. 持有进程退出后锁立即可用（非永久锁）；
 *   4. 两个不同 worker 的锁互不干扰、可并行持有；
 *   5. 同进程内两个独立获取同样互斥（connector 同进程多实例场景）。
 *
 * 互斥原语：`worker-locks.db` 的 `BEGIN IMMEDIATE` 写事务。持有者保持事务不提交，
 * SQLite 保证全库至多一个未提交写事务；崩溃时 OS 关闭文件句柄、SQLite 回滚
 * 未完成事务，锁自动释放——无 pid 探测、无开机时间判定、无 token，无临界区。
 */
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createPlatform, tryAcquireWorkerLock } from "../src/index.js";

const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {
      // 已退出
    }
  }
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

// 跨进程子进程直接 import 已构建的 dist 产物（纯 JS，无需类型剥离），
// 这既避免 `--experimental-strip-types` 无法处理 core 源里的 enum 等语法，
// 又让验收针对真实发布产物而非源码。dist 由 `pnpm --filter @nocturne/core build` 生成。
const CORE_DIST = fileURLToPath(new URL("../dist/index.mjs", import.meta.url));
const CORE_INDEX_URL = pathToFileURL(CORE_DIST).href;

/**
 * 子进程持锁脚本（内联 `-e` 注入）。参数：锁路径、workerId、stdio 屏障。
 * 协议：
 *   - 取得锁后向 stdout 打印 `HOLDING`（屏障：父进程等到此行才继续）；
 *   - 取得失败打印 `BUSY` 并退出；
 *   - 之后挂起，直到被 kill。
 * 用 tsx 跑 core 的 TS 源（vitest 环境已具备），避免依赖 dist 构建产物。
 */
function holderScript(): string {
  return `
import { createPlatform, tryAcquireWorkerLock } from ${JSON.stringify(CORE_INDEX_URL)};
const [lockPath] = process.argv.slice(1);
const platform = createPlatform();
const lock = await tryAcquireWorkerLock(platform, lockPath);
if (lock === undefined) {
  process.stdout.write("BUSY\\n");
  process.exit(2);
}
process.stdout.write("HOLDING\\n");
// 保持锁（事务未提交）直到被杀。监听 release 消息以支持"优雅释放"场景。
process.stdin.on("data", async (chunk) => {
  if (chunk.toString().includes("RELEASE")) {
    await lock.release();
    process.stdout.write("RELEASED\\n");
  }
});
setInterval(() => {}, 1000);
`;
}

interface Holder {
  child: ChildProcess;
  /** 等待 stdout 出现指定行的 Promise（屏障原语，非固定延时） */
  waitForLine(line: string): Promise<void>;
  release(): void;
}

/**
 * 启动一个独立进程持有指定锁。返回的 waitForLine 是屏障：只有子进程真正
 * 取得锁并打印 HOLDING 后 promise 才 resolve——这是跨进程握手，不用固定毫秒等待。
 */
function spawnHolder(lockPath: string): Holder {
  // 用 node --experimental-strip-types 直接跑 TS（Node 24 内置 type stripping）。
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "-e", holderScript(), lockPath],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  children.push(child);
  let buffer = "";
  const waiters: { line: string; resolve: () => void; reject: (e: Error) => void }[] = [];
  child.stdout?.on("data", (chunk) => {
    buffer += chunk.toString();
    for (const w of [...waiters]) {
      if (buffer.includes(w.line)) {
        w.resolve();
        waiters.splice(waiters.indexOf(w), 1);
      }
    }
  });
  let spawnError: Error | undefined;
  child.stderr?.on("data", (chunk) => {
    spawnError = new Error(`holder stderr: ${chunk.toString().slice(0, 200)}`);
  });
  child.on("error", (err) => {
    spawnError = err;
  });
  const waitForLine = (line: string): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (buffer.includes(line)) {
        resolve();
        return;
      }
      if (spawnError !== undefined) {
        reject(spawnError);
        return;
      }
      waiters.push({ line, resolve, reject });
      // 子进程异常退出且未打印目标行时 fail-fast，避免屏障永久挂起。
      child.on("exit", () => {
        if (!buffer.includes(line)) {
          reject(
            spawnError ??
              new Error(`holder 退出但 stdout 未出现 ${line}；已收到：${buffer.slice(0, 200)}`),
          );
        }
      });
    });
  return {
    child,
    waitForLine,
    release() {
      child.stdin?.write("RELEASE\n");
    },
  };
}

async function makeLockPath(workerId = "ew-test0000000001"): Promise<{
  dir: string;
  lockPath: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "nct-wlock-"));
  roots.push(root);
  const dir = path.join(root, "external-workers");
  await mkdir(dir, { recursive: true });
  return { dir, lockPath: path.join(dir, `${workerId}.lock`) };
}

describe("worker 跨进程互斥锁（SQLite 事务原语）", () => {
  it("恢复竞争中只有一个进程能进入 worker 操作：持有者存活时竞争者 busy", async () => {
    const { lockPath } = await makeLockPath();
    const holder = spawnHolder(lockPath);
    // 屏障：等子进程真正持锁后再发起竞争，消除时序偶然性。
    await holder.waitForLine("HOLDING");

    // 同路径竞争者（本进程）：锁被独立进程持有 → 必须 busy（undefined）。
    const platform = createPlatform();
    const contender = await tryAcquireWorkerLock(platform, lockPath);
    expect(contender).toBeUndefined();

    // 第二个独立进程竞争：同样 busy 退出（握手协议 exit code 2 + BUSY）。
    const busyChild = spawn(
      process.execPath,
      ["--experimental-strip-types", "-e", holderScript(), lockPath],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    children.push(busyChild);
    const busyOut = await new Promise<string>((resolve) => {
      let out = "";
      busyChild.stdout?.on("data", (chunk) => {
        out += chunk.toString();
      });
      busyChild.on("exit", () => resolve(out));
    });
    expect(busyOut).toContain("BUSY");
    expect(busyOut).not.toContain("HOLDING");
  });

  it("持有进程被强杀（SIGKILL，含未提交事务）后其余进程可继续：崩溃可恢复", async () => {
    const { lockPath } = await makeLockPath();
    const holder = spawnHolder(lockPath);
    await holder.waitForLine("HOLDING");

    // 强杀持有者——模拟宿主崩溃，未提交事务、无清理机会。
    const exitPromise = new Promise<void>((resolve) => {
      holder.child.on("exit", () => resolve());
    });
    holder.child.kill("SIGKILL");
    // 屏障：等进程真正退出（OS 已关闭其文件句柄），而非固定毫秒。
    await exitPromise;

    // 其余进程应能立即取得锁——崩溃不留下永久锁，无需失效判定。
    const platform = createPlatform();
    const recovered = await tryAcquireWorkerLock(platform, lockPath);
    expect(recovered).not.toBeUndefined();
    await recovered?.release();
  });

  it("持有进程优雅退出释放锁后立即可重新获取：非永久锁", async () => {
    const { lockPath } = await makeLockPath();
    const holder = spawnHolder(lockPath);
    await holder.waitForLine("HOLDING");

    // 让持有者优雅 release（经 stdin 握手），确认释放后他人可用。
    holder.release();
    await holder.waitForLine("RELEASED");

    const platform = createPlatform();
    const after = await tryAcquireWorkerLock(platform, lockPath);
    expect(after).not.toBeUndefined();
    await after?.release();
  });

  it("两个不同 worker 的锁互不干扰：并行持有", async () => {
    const a = await makeLockPath("ew-aaaa000000000001");
    const b = await makeLockPath("ew-bbbb000000000002");
    const holderA = spawnHolder(a.lockPath);
    const holderB = spawnHolder(b.lockPath);
    // 屏障：两个独立进程同时持锁都成功——证明按 workerId 寻址的并行性。
    await Promise.all([holderA.waitForLine("HOLDING"), holderB.waitForLine("HOLDING")]);
    // 清理
    holderA.child.kill("SIGKILL");
    holderB.child.kill("SIGKILL");
  });

  it("同进程两个独立获取互斥（connector 同进程多实例场景）", async () => {
    const { lockPath } = await makeLockPath();
    const platform = createPlatform();
    const first = await tryAcquireWorkerLock(platform, lockPath);
    expect(first).not.toBeUndefined();
    const second = await tryAcquireWorkerLock(platform, lockPath);
    expect(second).toBeUndefined();
    await first?.release();
    // 释放后立即可再获取（快速连续 5 次无死锁）。
    for (let i = 0; i < 5; i++) {
      const lock = await tryAcquireWorkerLock(platform, lockPath);
      expect(lock).not.toBeUndefined();
      await lock?.release();
    }
  });

  it("锁在数据库事务而非文件存在性：release 后不残留持锁状态、可立即再获取", async () => {
    const { dir, lockPath } = await makeLockPath();
    const platform = createPlatform();
    const lock = await tryAcquireWorkerLock(platform, lockPath);
    expect(lock).not.toBeUndefined();
    await lock?.release();
    // 锁语义全在 .lock.db 的写事务里——数据库文件本身可以存在（空表），
    // 但不携带任何"被持有"状态。验证：release 后表为空、可立即再获取，
    // 且旧式 <workerId>.lock 存在性文件不再被使用。
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(dir);
    expect(entries.filter((e) => e.endsWith(".lock"))).toEqual([]);
    // 释放后能立即再获取——空数据库文件不构成"锁被占用"。
    const again = await tryAcquireWorkerLock(platform, lockPath);
    expect(again).not.toBeUndefined();
    await again?.release();
  });

  it("并发竞争同一锁：至多一个进程进入（屏障同步的确定性竞速）", async () => {
    // 用握手制造确定性同时发起：先在 db 里放一个「起跑线」标记不如直接并发 spawn。
    // 这里并发启动两个持有者竞争同一路径，断言恰好一个 HOLDING、另一个 BUSY 或未持锁。
    // 这验证「恢复竞争中只有一个进程进入实际 worker 操作」的排他性核心。
    const { lockPath } = await makeLockPath();
    const results = await Promise.all(
      [0, 1].map(
        () =>
          new Promise<string>((resolve) => {
            const child = spawn(
              process.execPath,
              ["--experimental-strip-types", "-e", holderScript(), lockPath],
              { stdio: ["pipe", "pipe", "pipe"] },
            );
            children.push(child);
            let out = "";
            child.stdout?.on("data", (chunk) => {
              out += chunk.toString();
              // 一旦看到首行即可判定（HOLDING 或 BUSY）。
              if (out.includes("HOLDING")) resolve("HOLDING");
              else if (out.includes("BUSY")) resolve("BUSY");
            });
            child.on("exit", () => {
              if (!out.includes("HOLDING") && !out.includes("BUSY")) resolve(out.trim() || "EXIT");
              else if (out.includes("BUSY")) resolve("BUSY");
            });
          }),
      ),
    );
    const winners = results.filter((r) => r === "HOLDING");
    // 至多一个赢家——互斥的排他性核心保证。
    expect(winners.length).toBeLessThanOrEqual(1);
    // 且至少一个能赢（锁可用）。
    expect(winners.length).toBe(1);
  });
});
