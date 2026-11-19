import { type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { findPython, findSoffice } from "./discovery.js";
import { DocPluginError, type DocErrorCode, isDocPluginError } from "./errors.js";
import { assertNonEmptyFileProduced, toFileUrl } from "./paths.js";
import { killProcessTree, spawnExecutable } from "./process.js";

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_CALL_TIMEOUT_MS = 120 * 1000;
const DEFAULT_CONNECT_TIMEOUT_MS = 30 * 1000;

export interface LibreOfficeEngineOptions {
  idleTimeoutMs?: number | undefined;
  callTimeoutMs?: number | undefined;
  connectTimeoutMs?: number | undefined;
  pythonScriptPath?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

interface WorkerState {
  soffice: ChildProcess;
  python: ChildProcess;
  rl: ReadlineInterface;
  profileDir: string;
  pipeName: string;
  stderrBuf: string;
  closed: boolean;
  pendingLineResolvers: ((line: string | null) => void)[];
  bufferedLines: string[];
}

interface ReadyMessage {
  ready?: boolean;
  code?: string;
  error?: string;
}

interface ResponseMessage {
  id?: number;
  ok?: boolean;
  result?: unknown;
  code?: string;
  error?: string;
}

export interface CliConvertOptions {
  inputPath: string;
  convertTo: string;
  outputPath?: string | undefined;
  /** When set (e.g. multi-sheet CSV), moves all files matching ext into outDir. */
  multiOutputDir?: string | undefined;
  multiOutputExt?: string | undefined;
  overwrite?: boolean | undefined;
  stripUtf8Bom?: boolean | undefined;
}

function parsePositiveIntEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function resolveDefaultPythonScript(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sibling = path.join(here, "engine.py");
  if (existsSync(sibling)) return sibling;
  const devPath = path.resolve(here, "../../python/engine.py");
  if (existsSync(devPath)) return devPath;
  return sibling;
}

function asDocErrorCode(raw: string | undefined): DocErrorCode {
  switch (raw) {
    case "libreoffice_not_found":
    case "libreoffice_uno_unavailable":
    case "invalid_argument":
    case "file_not_found":
    case "file_exists":
    case "output_missing":
    case "timeout":
    case "engine_error":
      return raw;
    default:
      return "engine_error";
  }
}

function moveFileSafe(src: string, dest: string): void {
  mkdirSync(path.dirname(dest), { recursive: true });
  try {
    renameSync(src, dest);
  } catch {
    copyFileSync(src, dest);
    rmSync(src, { force: true });
  }
}

export class LibreOfficeEngine {
  private readonly idleTimeoutMs: number;
  private readonly callTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly pythonScriptPath: string;
  private readonly env: NodeJS.ProcessEnv;

  private worker: WorkerState | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private queue: Promise<void> = Promise.resolve();
  private activeCount = 0;
  private reqSeq = 0;
  private launchSeq = 0;
  private closing = false;
  private readonly trackedTempDirs = new Set<string>();
  private readonly exitHandler: () => void;

  constructor(options: LibreOfficeEngineOptions = {}) {
    this.env = options.env ?? process.env;
    this.idleTimeoutMs =
      options.idleTimeoutMs ??
      parsePositiveIntEnv(this.env.NOCTURNE_OFFICE_IDLE_MS, DEFAULT_IDLE_TIMEOUT_MS);
    this.callTimeoutMs =
      options.callTimeoutMs ??
      parsePositiveIntEnv(this.env.NOCTURNE_OFFICE_TIMEOUT_MS, DEFAULT_CALL_TIMEOUT_MS);
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.pythonScriptPath = options.pythonScriptPath ?? resolveDefaultPythonScript();

    this.exitHandler = () => {
      for (const dir of this.trackedTempDirs) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup on process exit.
        }
      }
      this.trackedTempDirs.clear();
    };
    process.once("exit", this.exitHandler);
  }

  /** Serializes all operations within this engine instance. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    this.clearIdleTimer();
    this.activeCount += 1;
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run.finally(() => {
      this.activeCount -= 1;
      if (this.activeCount === 0 && !this.closing && this.worker !== undefined) {
        this.armIdleTimer();
      }
    });
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.activeCount === 0 && this.worker !== undefined) {
        void this.stopWorker();
      }
    }, this.idleTimeoutMs);
    this.idleTimer.unref();
  }

  private createTempDir(prefix: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), prefix));
    this.trackedTempDirs.add(dir);
    return dir;
  }

  private removeTempDir(dir: string): void {
    this.trackedTempDirs.delete(dir);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors on locked Windows handles; exit handler retries if still tracked.
    }
  }

  private readNextLine(worker: WorkerState, timeoutMs: number): Promise<string | null> {
    if (worker.bufferedLines.length > 0) {
      const next = worker.bufferedLines.shift();
      return Promise.resolve(next ?? null);
    }
    if (worker.closed) {
      return Promise.resolve(null);
    }
    return new Promise<string | null>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const idx = worker.pendingLineResolvers.indexOf(onLine);
        if (idx >= 0) worker.pendingLineResolvers.splice(idx, 1);
        reject(
          new DocPluginError(
            "timeout",
            `LibreOffice operation timed out after ${Math.round(timeoutMs / 1000)}s.`,
          ),
        );
      }, timeoutMs);

      const onLine = (line: string | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(line);
      };
      worker.pendingLineResolvers.push(onLine);
    });
  }

  private async startWorker(): Promise<WorkerState> {
    if (this.worker !== undefined && !this.worker.closed) {
      return this.worker;
    }

    const sofficePath = findSoffice(this.env);
    const pythonPath = findPython(sofficePath, this.env);
    const profileDir = this.createTempDir("nocturne-lo-profile-");
    const pipeName = `nocturne_${process.pid}_${++this.launchSeq}_${randomBytes(4).toString("hex")}`;

    const soffice = spawnExecutable(
      sofficePath,
      [
        "--headless",
        "--invisible",
        "--nologo",
        "--nodefault",
        "--norestore",
        "--nofirststartwizard",
        `-env:UserInstallation=${toFileUrl(profileDir)}`,
        `--accept=pipe,name=${pipeName};urp;`,
      ],
      {
        env: this.env,
        stdio: ["ignore", "ignore", "pipe"],
      },
    );

    const connectSec = Math.max(
      1,
      Math.ceil(Math.min(this.connectTimeoutMs, this.callTimeoutMs) / 1000),
    );
    const python = spawnExecutable(
      pythonPath,
      [this.pythonScriptPath, "--pipe", pipeName, "--connect-timeout", String(connectSec)],
      {
        env: {
          ...this.env,
          PYTHONUTF8: "1",
          PYTHONIOENCODING: "utf-8",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    if (!python.stdin || !python.stdout) {
      await Promise.all([killProcessTree(python.pid), killProcessTree(soffice.pid)]);
      this.removeTempDir(profileDir);
      throw new DocPluginError("engine_error", "Failed to open stdio pipes to Python UNO helper.");
    }

    const rl = createInterface({ input: python.stdout, crlfDelay: Infinity });
    const state: WorkerState = {
      soffice,
      python,
      rl,
      profileDir,
      pipeName,
      stderrBuf: "",
      closed: false,
      pendingLineResolvers: [],
      bufferedLines: [],
    };

    const pushLine = (line: string | null): void => {
      const resolver = state.pendingLineResolvers.shift();
      if (resolver) {
        resolver(line);
      } else if (line !== null) {
        state.bufferedLines.push(line);
      }
    };

    rl.on("line", (line) => {
      pushLine(line);
    });

    const markClosed = (): void => {
      if (state.closed) return;
      state.closed = true;
      while (state.pendingLineResolvers.length > 0) {
        const resolver = state.pendingLineResolvers.shift();
        resolver?.(null);
      }
    };

    rl.once("close", markClosed);
    python.once("exit", markClosed);
    python.once("error", markClosed);
    soffice.once("error", () => undefined);

    python.stderr?.on("data", (chunk: Buffer) => {
      state.stderrBuf = (state.stderrBuf + chunk.toString("utf8")).slice(-4000);
    });
    soffice.stderr?.on("data", (chunk: Buffer) => {
      state.stderrBuf = (state.stderrBuf + chunk.toString("utf8")).slice(-4000);
    });

    this.worker = state;

    try {
      const handshakeTimeout = Math.min(this.connectTimeoutMs, this.callTimeoutMs);
      const rawLine = await this.readNextLine(state, handshakeTimeout);
      if (rawLine === null) {
        const exitCode = python.exitCode;
        const details = state.stderrBuf.trim();
        await this.stopWorker();
        if (exitCode === 2) {
          throw new DocPluginError(
            "libreoffice_uno_unavailable",
            details ||
              "LibreOffice Python UNO binding is unavailable (Linux: install python3-uno).",
          );
        }
        throw new DocPluginError(
          "engine_error",
          `LibreOffice UNO helper exited before ready (code=${exitCode ?? "unknown"})${details ? `: ${details}` : ""}`,
        );
      }

      let readyMsg: ReadyMessage;
      try {
        readyMsg = JSON.parse(rawLine) as ReadyMessage;
      } catch {
        await this.stopWorker();
        throw new DocPluginError("engine_error", `Invalid handshake from UNO helper: ${rawLine}`);
      }

      if (readyMsg.ready !== true) {
        await this.stopWorker();
        throw new DocPluginError(
          asDocErrorCode(readyMsg.code),
          readyMsg.error ?? "LibreOffice UNO helper failed to initialize.",
        );
      }

      return state;
    } catch (error) {
      if (this.worker === state) {
        await this.stopWorker();
      }
      throw error;
    }
  }

  private async stopWorker(): Promise<void> {
    this.clearIdleTimer();
    const state = this.worker;
    if (state === undefined) return;
    this.worker = undefined;
    state.closed = true;

    try {
      state.rl.close();
    } catch {
      // Ignore.
    }
    try {
      state.python.stdin?.end();
    } catch {
      // Ignore.
    }

    await Promise.all([killProcessTree(state.python.pid), killProcessTree(state.soffice.pid)]);
    this.removeTempDir(state.profileDir);
  }

  /**
   * Call a UNO operation on the persistent worker.
   * If `expectedOutputPath` is given, verifies the file exists and is non-empty after the call.
   */
  async callUno<T>(
    op: string,
    params: Record<string, unknown>,
    options?: { expectedOutputPath?: string | undefined },
  ): Promise<T> {
    return this.enqueue(async () => {
      const worker = await this.startWorker();
      const id = ++this.reqSeq;
      const payload = `${JSON.stringify({ id, op, params })}\n`;

      try {
        await new Promise<void>((resolve, reject) => {
          worker.python.stdin?.write(payload, "utf8", (err) => {
            if (err) reject(err);
            else resolve();
          });
        });

        const rawLine = await this.readNextLine(worker, this.callTimeoutMs);
        if (rawLine === null) {
          const details = worker.stderrBuf.trim();
          await this.stopWorker();
          throw new DocPluginError(
            "engine_error",
            `LibreOffice UNO helper terminated unexpectedly${details ? `: ${details}` : ""}`,
          );
        }

        let resp: ResponseMessage;
        try {
          resp = JSON.parse(rawLine) as ResponseMessage;
        } catch {
          await this.stopWorker();
          throw new DocPluginError("engine_error", `Invalid JSON from UNO helper: ${rawLine}`);
        }

        if (resp.ok !== true) {
          throw new DocPluginError(
            asDocErrorCode(resp.code),
            resp.error ?? `UNO operation "${op}" failed.`,
          );
        }

        if (options?.expectedOutputPath !== undefined) {
          assertNonEmptyFileProduced(options.expectedOutputPath);
        }

        return resp.result as T;
      } catch (error) {
        if (isDocPluginError(error) && error.code === "timeout") {
          await this.stopWorker();
        }
        throw error;
      }
    });
  }

  /**
   * Run a one-shot `soffice --headless --convert-to` conversion using an isolated temp profile.
   * Used as a fallback when Python UNO is unavailable.
   */
  async convertViaCli(opts: CliConvertOptions): Promise<{ outputPaths: string[] }> {
    return this.enqueue(async () => {
      const sofficePath = findSoffice(this.env);
      const profileDir = this.createTempDir("nocturne-lo-cli-profile-");
      const tmpOutDir = this.createTempDir("nocturne-lo-cli-out-");

      try {
        const child = spawnExecutable(
          sofficePath,
          [
            "--headless",
            "--invisible",
            "--nologo",
            "--nodefault",
            "--norestore",
            "--nofirststartwizard",
            `-env:UserInstallation=${toFileUrl(profileDir)}`,
            "--convert-to",
            opts.convertTo,
            "--outdir",
            tmpOutDir,
            opts.inputPath,
          ],
          {
            env: this.env,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );

        let stderr = "";
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr = (stderr + chunk.toString("utf8")).slice(-4000);
        });

        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            void killProcessTree(child.pid).finally(() => {
              reject(
                new DocPluginError(
                  "timeout",
                  `LibreOffice CLI conversion timed out after ${Math.round(this.callTimeoutMs / 1000)}s.`,
                ),
              );
            });
          }, this.callTimeoutMs);

          child.once("error", (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(new DocPluginError("engine_error", `Failed to spawn soffice: ${err.message}`));
          });

          child.once("exit", (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (code !== 0) {
              reject(
                new DocPluginError(
                  "engine_error",
                  `LibreOffice CLI conversion exited with code ${code ?? "unknown"}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
                ),
              );
              return;
            }
            resolve();
          });
        });

        const produced = readdirSync(tmpOutDir)
          .filter((name) => {
            if (opts.multiOutputExt) {
              return name.toLowerCase().endsWith(opts.multiOutputExt.toLowerCase());
            }
            return true;
          })
          .sort();

        if (produced.length === 0) {
          throw new DocPluginError(
            "output_missing",
            "LibreOffice CLI exited cleanly but produced no output file.",
          );
        }

        if (opts.multiOutputDir) {
          mkdirSync(opts.multiOutputDir, { recursive: true });
          if (opts.overwrite !== true) {
            for (const name of produced) {
              const dest = path.join(opts.multiOutputDir, name);
              if (existsSync(dest)) {
                throw new DocPluginError(
                  "file_exists",
                  `Target file already exists: ${dest}. Pass overwrite: true to replace it.`,
                );
              }
            }
          }
          const finalPaths: string[] = [];
          for (const name of produced) {
            const src = path.join(tmpOutDir, name);
            const dest = path.join(opts.multiOutputDir, name);
            moveFileSafe(src, dest);
            assertNonEmptyFileProduced(dest);
            finalPaths.push(dest);
          }
          return { outputPaths: finalPaths };
        }

        const firstFile = produced[0];
        if (!firstFile || !opts.outputPath) {
          throw new DocPluginError("output_missing", "No converted output file found.");
        }
        const srcPath = path.join(tmpOutDir, firstFile);
        if (!existsSync(srcPath) || statSync(srcPath).size === 0) {
          throw new DocPluginError("output_missing", "Converted output file is empty.");
        }
        if (opts.stripUtf8Bom) {
          const raw = readFileSync(srcPath);
          if (raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
            writeFileSync(srcPath, raw.subarray(3));
          }
        }
        moveFileSafe(srcPath, opts.outputPath);
        assertNonEmptyFileProduced(opts.outputPath);
        return { outputPaths: [opts.outputPath] };
      } finally {
        this.removeTempDir(tmpOutDir);
        this.removeTempDir(profileDir);
      }
    });
  }

  /**
   * Try UNO first; if UNO is unavailable, fall back to headless CLI conversion.
   */
  async callUnoOrCliFallback<T>(
    unoFn: () => Promise<T>,
    cliFallbackFn: () => Promise<T>,
  ): Promise<T> {
    try {
      return await unoFn();
    } catch (error) {
      if (isDocPluginError(error) && error.code === "libreoffice_uno_unavailable") {
        return await cliFallbackFn();
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    process.off("exit", this.exitHandler);
    await this.stopWorker();
    for (const dir of [...this.trackedTempDirs]) {
      this.removeTempDir(dir);
    }
  }
}
