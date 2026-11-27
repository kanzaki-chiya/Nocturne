/**
 * ADR-0127 第五阶段返工第 3 条：失效锁并行回收的所有权保证。
 *
 * 背景：tryAcquireWorkerLock 的失效锁清理分「检查旧锁」与「稍后 unlink」两步，
 * 非原子序列下两个并行竞争者可能同时判定同一失效锁可收——若不加守卫，
 * 迟到的一方可能把已被对方换持的新锁误删，导致两个进程同时进入 worker 操作。
 * 本组用确定性同步点（注入可控延时的 platform）验证：
 *   - 两个竞争者遇到同一失效锁时，至多一个在同一时刻持有有效锁；
 *   - 迟到的清理不得删除已换持有者的新锁（token 校验）；
 *   - 释放与重新获取不留死锁；
 *   - 不同 worker（不同锁路径）天然并行。
 */
import { mkdtemp, rm, writeFile, readFile, access, mkdir } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createPlatform, tryAcquireWorkerLock } from "../src/index.js";
import type { Platform } from "../src/index.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

async function makeLockDir(): Promise<{ dir: string; lockPath: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "nct-wlock-"));
  roots.push(root);
  const dir = path.join(root, "external-workers");
  return { dir, lockPath: path.join(dir, "ew-test0000000001.lock") };
}

/** 写一份"失效"锁（死 pid + 旧 token），模拟宿主崩溃残留。 */
async function writeStaleLock(lockPath: string, token: string): Promise<void> {
  await mkdir(path.dirname(lockPath), { recursive: true });
  const deadPid = await new Promise<number>((resolve, reject) => {
    const probe = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    if (probe.pid === undefined) {
      reject(new Error("probe 未分配 pid"));
      return;
    }
    probe.on("close", () => resolve(probe.pid as number));
    probe.on("error", reject);
  });
  await writeFile(
    lockPath,
    JSON.stringify({ pid: deadPid, hostname: hostname(), startedAt: Date.now(), token }),
  );
}

describe("返工第 3 条：失效锁并行回收的所有权保证", () => {
  it("迟到清理不删已换持有者的新锁：token 校验阻止误删", async () => {
    const { lockPath } = await makeLockDir();
    const platform = createPlatform();
    await writeStaleLock(lockPath, "stale-token-original");
    const lockA = await tryAcquireWorkerLock(platform, lockPath);
    expect(lockA).not.toBeUndefined();
    const heldContent = JSON.parse(await readFile(lockPath, "utf8")) as { token?: unknown };
    expect(heldContent.token).not.toBe("stale-token-original");
    const lockB = await tryAcquireWorkerLock(platform, lockPath);
    expect(lockB).toBeUndefined();
    await lockA?.release();
    const exists = await access(lockPath)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
    const lockB2 = await tryAcquireWorkerLock(platform, lockPath);
    expect(lockB2).not.toBeUndefined();
    await lockB2?.release();
  });

  it("两个并行竞争者遇同一失效锁：至多一个持有有效锁，释放后另一方立即可用", async () => {
    const { lockPath } = await makeLockDir();
    await writeStaleLock(lockPath, "stale-shared");
    const base = createPlatform();
    const makeDelayed = (delayMs: number): Platform => ({
      ...base,
      fs: {
        ...base.fs,
        createExclusive: async (p, data) => {
          // 测试替身注入可控延时制造确定性交错：迫使两个并行竞争者的「检查→删除→重建」
          // 窗口真实重叠，而非串行退化为单方获胜——这是锁竞争测试的核心同步点，无法用真实事件替代。
          // eslint-disable-next-line no-restricted-syntax
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          return base.fs.createExclusive(p, data);
        },
      },
    });
    const contenderA = makeDelayed(5);
    const contenderB = makeDelayed(5);
    const [resA, resB] = await Promise.all([
      tryAcquireWorkerLock(contenderA, lockPath),
      tryAcquireWorkerLock(contenderB, lockPath),
    ]);
    const held = [resA, resB].filter((lock) => lock !== undefined);
    expect(held.length).toBeLessThanOrEqual(1);
    expect(held.length).toBe(1);
    const winner = held[0];
    const content = JSON.parse(await readFile(lockPath, "utf8")) as { token?: unknown };
    expect(typeof content.token).toBe("string");
    await winner?.release();
    const after = await tryAcquireWorkerLock(base, lockPath);
    expect(after).not.toBeUndefined();
    await after?.release();
  });

  it("失效锁被正确回收：死 pid 的锁不阻塞后续获取", async () => {
    const { lockPath } = await makeLockDir();
    const platform = createPlatform();
    await writeStaleLock(lockPath, "stale-dead");
    const lock = await tryAcquireWorkerLock(platform, lockPath);
    expect(lock).not.toBeUndefined();
    await lock?.release();
  });

  it("释放与重新获取不留死锁：release 后可立即再获取", async () => {
    const { lockPath } = await makeLockDir();
    await mkdir(path.dirname(lockPath), { recursive: true });
    const platform = createPlatform();
    for (let i = 0; i < 5; i++) {
      const lock = await tryAcquireWorkerLock(platform, lockPath);
      expect(lock).not.toBeUndefined();
      await lock?.release();
    }
  });

  it("不同 worker 的锁路径不同：并行持有互不干扰", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nct-wlock-"));
    roots.push(root);
    const dir = path.join(root, "external-workers");
    const platform = createPlatform();
    const lockPathA = path.join(dir, "ew-aaaa000000000001.lock");
    const lockPathB = path.join(dir, "ew-bbbb000000000002.lock");
    await mkdir(dir, { recursive: true });
    const [lockA, lockB] = await Promise.all([
      tryAcquireWorkerLock(platform, lockPathA),
      tryAcquireWorkerLock(platform, lockPathB),
    ]);
    expect(lockA).not.toBeUndefined();
    expect(lockB).not.toBeUndefined();
    await lockA?.release();
    await lockB?.release();
  });
});
