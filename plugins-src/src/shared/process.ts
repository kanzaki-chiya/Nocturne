import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import path from "node:path";

/**
 * Spawn an executable or Node script (.mjs/.js/.cjs) or Windows batch (.cmd/.bat).
 * Uses process group isolation on POSIX so the full process tree can be terminated.
 */
export function spawnExecutable(
  executable: string,
  args: readonly string[],
  options: Omit<SpawnOptions, "shell" | "detached" | "windowsHide"> = {},
): ChildProcess {
  const ext = path.extname(executable).toLowerCase();
  const isNodeScript = ext === ".mjs" || ext === ".js" || ext === ".cjs";
  const isWinBatch = process.platform === "win32" && (ext === ".cmd" || ext === ".bat");
  const detached = process.platform !== "win32";

  if (isNodeScript) {
    return spawn(process.execPath, [executable, ...args], {
      ...options,
      detached,
      windowsHide: true,
    });
  }

  if (isWinBatch) {
    return spawn(executable, [...args], {
      ...options,
      shell: true,
      windowsHide: true,
    });
  }

  return spawn(executable, [...args], {
    ...options,
    detached,
    windowsHide: true,
  });
}

/**
 * Terminate a process and all its descendants.
 * Windows: `taskkill /T /F /PID <pid>`.
 * POSIX: signal negative PID (process group), falling back to direct PID.
 */
export async function killProcessTree(pid: number | undefined): Promise<void> {
  if (pid === undefined || pid <= 0) return;

  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/T", "/F", "/PID", String(pid)], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("error", () => {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Process may already be gone.
        }
        resolve();
      });
      killer.once("exit", () => {
        resolve();
      });
    });
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
  }

  // Give POSIX children a brief chance to exit cleanly before SIGKILL.
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already dead.
        }
      }
      resolve();
    }, 150);
    timer.unref();
  });
}
