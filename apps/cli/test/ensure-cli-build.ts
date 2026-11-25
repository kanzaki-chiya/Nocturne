import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { vi } from "vitest";

export function cliBuildStampPaths(repoRoot: string): { lockPath: string; donePath: string } {
  const key = createHash("sha256")
    .update(path.resolve(repoRoot).toLowerCase())
    .digest("hex")
    .slice(0, 16);
  return {
    lockPath: path.join(tmpdir(), `nctrn-cli-build-${key}.lock`),
    donePath: path.join(tmpdir(), `nctrn-cli-build-${key}.done`),
  };
}

function isEexist(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "EEXIST";
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 协调同一轮 Vitest 中多个并发 e2e 测试文件对 `pnpm build` 的调用：
 * 仅第一个拿到锁的 worker 执行一次 `pnpm build`，其余 worker 等待其完成后复用当轮产物，
 * 避免并行 `tsdown` 互相清空 `dist/` 导致子进程报 `ERR_MODULE_NOT_FOUND`。
 */
export async function ensureCliBuilt(repoRoot: string): Promise<void> {
  const { lockPath, donePath } = cliBuildStampPaths(repoRoot);
  const runId = process.env.NOCTURNE_CLI_BUILD_RUN_ID ?? String(process.ppid);

  const isBuiltForRun = (): boolean => {
    try {
      return existsSync(donePath) && readFileSync(donePath, "utf8").trim() === runId;
    } catch {
      return false;
    }
  };

  if (isBuiltForRun()) return;

  let acquiredLock = false;
  await vi.waitFor(
    () => {
      if (isBuiltForRun()) return;
      try {
        const fd = openSync(lockPath, "wx");
        try {
          writeFileSync(fd, String(process.pid), "utf8");
        } finally {
          closeSync(fd);
        }
        acquiredLock = true;
      } catch (err) {
        if (!isEexist(err)) throw err;
        try {
          const holderPid = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
          if (Number.isInteger(holderPid) && holderPid > 0 && !isPidAlive(holderPid)) {
            unlinkSync(lockPath);
          }
        } catch {
          // 锁文件刚被释放或尚未写完，下一轮重试
        }
        throw new Error("等待同轮其他 worker 完成 pnpm build");
      }
    },
    { timeout: 170_000, interval: 100 },
  );

  if (!acquiredLock) return;

  try {
    if (!isBuiltForRun()) {
      execSync("pnpm build", { cwd: repoRoot, stdio: "pipe" });
      writeFileSync(donePath, runId, "utf8");
    }
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      // 忽略清理异常
    }
  }
}
