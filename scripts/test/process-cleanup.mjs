import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export async function killPidTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || !alive(pid)) return;
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      const timer = setTimeout(() => {
        killer.kill();
        resolve();
      }, 2000);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      killer.once("exit", done);
      killer.once("error", done);
    });
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* Already stopped. */
      }
    }
  }
  // taskkill can itself stall under load. Do not leave the registered root alive.
  if (alive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* Already stopped. */
    }
  }
  for (let i = 0; i < 50 && alive(pid); i++) await delay(20);
  if (alive(pid)) throw new Error(`Fixture process ${pid} survived cleanup`);
}

/** Register at spawn time, including processes hidden behind tools/hooks/connectors. */
export function createProcessCleanup() {
  const processes = new Set();
  const pids = new Set();
  const files = new Set();
  const track = (proc) => {
    const entry = { proc, exited: false };
    if (proc.exited)
      void proc.exited().then(
        () => {
          entry.exited = true;
        },
        () => {
          entry.exited = true;
        },
      );
    processes.add(entry);
    return proc;
  };
  const wrap = (runner) =>
    new Proxy(runner, {
      get(target, key) {
        if (["spawn", "spawnShell", "spawnPipe"].includes(key))
          return (...args) => track(target[key](...args));
        return Reflect.get(target, key);
      },
    });
  const readPids = async () => {
    for (const file of files) {
      try {
        const value = JSON.parse(await readFile(file, "utf8"));
        for (const pid of typeof value === "number" ? [value] : Object.values(value)) {
          if (Number.isInteger(pid) && pid > 0) pids.add(pid);
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  };
  return {
    track,
    trackChild: (child) => {
      track({
        async kill() {
          if (child.pid !== undefined && child.exitCode === null && child.signalCode === null)
            await killPidTree(child.pid);
        },
        detachOutput() {
          child.stdin?.destroy();
          child.stdout?.destroy();
          child.stderr?.destroy();
        },
      });
      return child;
    },
    trackPid: (pid) => {
      pids.add(pid);
    },
    watchPidFile: (file) => {
      files.add(file);
    },
    wrap,
    platform: (platform) => ({ ...platform, process: wrap(platform.process) }),
    async cleanup() {
      const errors = [];
      try {
        await readPids();
      } catch (error) {
        errors.push(error);
      }
      // Stop roots before re-reading PID files: they can no longer create new leaves.
      for (const entry of processes) {
        const proc = entry.proc;
        try {
          await proc.kill();
          if (proc.pid !== undefined && !entry.exited) await killPidTree(proc.pid);
        } catch (error) {
          errors.push(error);
        } finally {
          proc.detachOutput?.();
        }
      }
      processes.clear();
      try {
        await readPids();
      } catch (error) {
        errors.push(error);
      }
      for (const pid of pids) {
        try {
          await killPidTree(pid);
        } catch (error) {
          errors.push(error);
        }
      }
      pids.clear();
      files.clear();
      if (errors.length) throw new AggregateError(errors, "Fixture process cleanup failed");
    },
  };
}

export async function removeTempDirs(directories) {
  for (const directory of directories) {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
