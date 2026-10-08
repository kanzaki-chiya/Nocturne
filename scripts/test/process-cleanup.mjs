import { spawn } from "node:child_process";
import { readFile, rm, stat } from "node:fs/promises";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Process creation time in local-clock milliseconds, or undefined when unknown
 * (non-Windows or wmic unavailable). Windows recycles PIDs aggressively, so
 * cleanup uses it to tell a registered fixture apart from an unrelated process
 * that reused the same PID after the fixture exited.
 */
async function createdAt(pid) {
  if (process.platform !== "win32") return undefined;
  const output = await new Promise((resolve) => {
    const child = spawn(
      "wmic",
      ["process", "where", `processid=${pid}`, "get", "creationdate", "/value"],
      { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    );
    let text = "";
    let settled = false;
    let timer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    timer = setTimeout(() => {
      child.kill();
      finish("");
    }, 3000);
    child.stdout.on("data", (chunk) => {
      text += chunk;
    });
    child.once("error", () => finish(""));
    child.once("exit", () => finish(text));
  });
  const match = /CreationDate=(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(String(output));
  if (!match) return undefined;
  return Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`);
}

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
  const registeredAt = new Map();
  const notePid = (pid, seenAt) => {
    if (!Number.isInteger(pid) || pid <= 0) return;
    pids.add(pid);
    const previous = registeredAt.get(pid);
    if (previous === undefined || seenAt < previous) registeredAt.set(pid, seenAt);
  };
  const track = (proc) => {
    const entry = { proc, exited: false };
    const markExited = () => {
      entry.exited = true;
    };
    // PipeProcess exposes exited(); SpawnedProcess only exposes wait().
    // Track both shapes: without an exit signal a long-gone process looks
    // alive to cleanup, whose PID fallback then taskkills whatever process
    // recycled the PID meanwhile (seen under package concurrency).
    if (typeof proc.exited === "function") void proc.exited().then(markExited, markExited);
    else if (typeof proc.wait === "function") {
      try {
        const waited = proc.wait();
        if (waited && typeof waited.then === "function") void waited.then(markExited, markExited);
      } catch {
        /* Keep exited=false and fall back to the PID kill. */
      }
    }
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
        const info = await stat(file);
        const value = JSON.parse(await readFile(file, "utf8"));
        for (const pid of typeof value === "number" ? [value] : Object.values(value)) {
          notePid(pid, info.mtimeMs);
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
      notePid(pid, Date.now());
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
          if (proc.pid !== undefined && !entry.exited) {
            // Give the exit signal a moment; once the process really exited the
            // PID must not be taskkilled again—it may already belong to someone else.
            const deadline = Date.now() + 200;
            while (!entry.exited && Date.now() < deadline) await delay(10);
          }
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
          if (!alive(pid)) continue;
          const seenAt = registeredAt.get(pid);
          if (seenAt !== undefined) {
            const created = await createdAt(pid);
            // A process created after registration cannot be our fixture:
            // the PID was recycled. Leave it alone.
            if (created !== undefined && created > seenAt + 2000) continue;
          }
          await killPidTree(pid);
        } catch (error) {
          errors.push(error);
        }
      }
      pids.clear();
      registeredAt.clear();
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
