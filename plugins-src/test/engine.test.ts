import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createWordPluginServer } from "../src/servers/docx.js";
import { LibreOfficeEngine } from "../src/shared/engine.js";
import { DocPluginError } from "../src/shared/errors.js";
import type { PluginServerSpec } from "../src/shared/mcp.js";

function callTool(
  server: PluginServerSpec,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const handler = server.handlers[name];
  if (!handler) throw new Error(`Unknown tool handler: ${name}`);
  return handler(args);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeSoffice = path.join(here, "fixtures", "fake-soffice.mjs");
const fakePython = path.join(here, "fixtures", "fake-python.mjs");

interface LogEntry {
  ts: number;
  pid: number;
  actor: string;
  event: string;
  profileDir?: string;
  pipeName?: string;
  id?: number;
  op?: string;
  startTs?: number;
  endTs?: number;
  grandchildPid?: number;
}

function readLogs(logFile: string): LogEntry[] {
  if (!existsSync(logFile)) return [];
  const raw = readFileSync(logFile, "utf8").trim();
  if (!raw) return [];
  return raw.split(/\r?\n/).map((line) => JSON.parse(line) as LogEntry);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

let tempDir: string;
let logFile: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), "nocturne-engine-test-"));
  logFile = path.join(tempDir, "events.jsonl");
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeFakeEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NOCTURNE_OFFICE_SOFFICE: fakeSoffice,
    NOCTURNE_OFFICE_PYTHON: fakePython,
    FAKE_LOG_FILE: logFile,
    ...extra,
  };
}

describe("LibreOfficeEngine with mock soffice and Python test doubles", () => {
  it("does not spawn child processes before the first call", async () => {
    const engine = new LibreOfficeEngine({ env: makeFakeEnv() });
    try {
      expect(readLogs(logFile)).toHaveLength(0);
    } finally {
      await engine.close();
    }
  });

  it("spawns soffice and Python only once across multiple calls and reuses the same profile directory", async () => {
    const engine = new LibreOfficeEngine({ env: makeFakeEnv() });
    try {
      const r1 = await engine.callUno<{ op: string }>("ping", { echo: "one" });
      const r2 = await engine.callUno<{ op: string }>("ping", { echo: "two" });
      expect(r1.op).toBe("ping");
      expect(r2.op).toBe("ping");

      const logs = readLogs(logFile);
      const sofficeStarts = logs.filter((l) => l.actor === "soffice" && l.event === "start");
      const pythonStarts = logs.filter((l) => l.actor === "python" && l.event === "start");
      expect(sofficeStarts).toHaveLength(1);
      expect(pythonStarts).toHaveLength(1);
      const profileDir = sofficeStarts[0]?.profileDir ?? "";
      expect(profileDir.length).toBeGreaterThan(0);
      expect(existsSync(profileDir)).toBe(true);
    } finally {
      await engine.close();
    }
  });

  it("stops workers after idle timeout and restarts on the next call", async () => {
    const engine = new LibreOfficeEngine({
      env: makeFakeEnv(),
      idleTimeoutMs: 250,
    });
    try {
      await engine.callUno("ping", { echo: "first" });
      const firstLogs = readLogs(logFile);
      const firstSoffice = firstLogs.find((l) => l.actor === "soffice" && l.event === "start");
      const firstPython = firstLogs.find((l) => l.actor === "python" && l.event === "start");
      if (!firstSoffice || !firstPython) {
        throw new Error("Expected initial soffice and python start events");
      }

      // Wait for idle timeout to stop both processes
      await vi.waitFor(
        () => {
          expect(isPidAlive(firstSoffice.pid)).toBe(false);
          expect(isPidAlive(firstPython.pid)).toBe(false);
        },
        { timeout: 5000, interval: 40 },
      );

      // Next call restarts a fresh worker pair
      await engine.callUno("ping", { echo: "second" });
      const allLogs = readLogs(logFile);
      const sofficeStarts = allLogs.filter((l) => l.actor === "soffice" && l.event === "start");
      const pythonStarts = allLogs.filter((l) => l.actor === "python" && l.event === "start");
      expect(sofficeStarts).toHaveLength(2);
      expect(pythonStarts).toHaveLength(2);
      expect(sofficeStarts[1]?.pid).not.toBe(sofficeStarts[0]?.pid);
    } finally {
      await engine.close();
    }
  });

  it("serializes two concurrent calls so their execution intervals do not overlap", async () => {
    const engine = new LibreOfficeEngine({
      env: makeFakeEnv({ FAKE_OP_DELAY_MS: "120" }),
    });
    try {
      await Promise.all([
        engine.callUno("ping", { echo: "a" }),
        engine.callUno("ping", { echo: "b" }),
      ]);

      const opEnds = readLogs(logFile).filter((l) => l.actor === "python" && l.event === "op_end");
      expect(opEnds).toHaveLength(2);
      const [first, second] = opEnds;
      expect(first?.startTs).toBeTypeOf("number");
      expect(first?.endTs).toBeTypeOf("number");
      expect(second?.startTs).toBeTypeOf("number");
      expect(second?.startTs ?? -1).toBeGreaterThanOrEqual(first?.endTs ?? Infinity);
    } finally {
      await engine.close();
    }
  });

  it("returns output_missing when child exits 0 without producing the expected output file", async () => {
    // 1. UNO path returning ok without writing outputPath
    const unoEngine = new LibreOfficeEngine({
      env: makeFakeEnv({ FAKE_PYTHON_MODE: "no-output" }),
    });
    const missingUnoOut = path.join(tempDir, "missing-uno.docx");
    try {
      await expect(
        unoEngine.callUno(
          "docx_create",
          { outputPath: missingUnoOut },
          { expectedOutputPath: missingUnoOut },
        ),
      ).rejects.toSatisfy(
        (err: unknown) => err instanceof DocPluginError && err.code === "output_missing",
      );
    } finally {
      await unoEngine.close();
    }

    // 2. CLI convert path exiting 0 without writing any output file
    const cliEngine = new LibreOfficeEngine({
      env: makeFakeEnv({ FAKE_SOFFICE_MODE: "no-output" }),
    });
    const dummyInput = path.join(tempDir, "in.docx");
    writeFileSync(dummyInput, "dummy", "utf8");
    try {
      await expect(
        cliEngine.convertViaCli({
          inputPath: dummyInput,
          convertTo: "pdf",
          outputPath: path.join(tempDir, "missing-cli.pdf"),
        }),
      ).rejects.toSatisfy(
        (err: unknown) => err instanceof DocPluginError && err.code === "output_missing",
      );
    } finally {
      await cliEngine.close();
    }
  });

  it("terminates the entire process tree on single-call timeout", async () => {
    const grandchildPidFile = path.join(tempDir, "grandchild.pid");
    const engine = new LibreOfficeEngine({
      env: makeFakeEnv({
        FAKE_PYTHON_MODE: "hang",
        FAKE_GRANDCHILD_PID_FILE: grandchildPidFile,
      }),
      callTimeoutMs: 450,
    });
    try {
      await expect(engine.callUno("hang_forever", {})).rejects.toSatisfy(
        (err: unknown) => err instanceof DocPluginError && err.code === "timeout",
      );

      const logs = readLogs(logFile);
      const sofficeStart = logs.find((l) => l.actor === "soffice" && l.event === "start");
      const pythonStart = logs.find((l) => l.actor === "python" && l.event === "start");
      const grandchildPid = existsSync(grandchildPidFile)
        ? Number(readFileSync(grandchildPidFile, "utf8").trim())
        : undefined;

      await vi.waitFor(
        () => {
          if (sofficeStart) expect(isPidAlive(sofficeStart.pid)).toBe(false);
          if (pythonStart) expect(isPidAlive(pythonStart.pid)).toBe(false);
          if (grandchildPid) expect(isPidAlive(grandchildPid)).toBe(false);
        },
        { timeout: 5000, interval: 40 },
      );
    } finally {
      await engine.close();
    }
  });

  it("rejects writing when target exists without overwrite: true and succeeds with overwrite: true", async () => {
    const server = createWordPluginServer({ env: makeFakeEnv() });
    const targetPath = path.join(tempDir, "existing.docx");
    writeFileSync(targetPath, "original", "utf8");

    try {
      await expect(
        callTool(server, "create", { outputPath: targetPath, content: "# Hello" }),
      ).rejects.toSatisfy(
        (err: unknown) => err instanceof DocPluginError && err.code === "file_exists",
      );

      const okRes = await callTool(server, "create", {
        outputPath: targetPath,
        content: "# Updated",
        overwrite: true,
      });
      expect(okRes.isError).toBeUndefined();
      expect(readFileSync(targetPath, "utf8")).toContain("FAKE:docx_create");
    } finally {
      await server.close();
    }
  });

  it("returns libreoffice_not_found and libreoffice_uno_unavailable, while CLI fallback still works without UNO", async () => {
    // 1. libreoffice_not_found
    const missingSofficeEngine = new LibreOfficeEngine({
      env: makeFakeEnv({ NOCTURNE_OFFICE_SOFFICE: path.join(tempDir, "no-such-soffice.exe") }),
    });
    try {
      await expect(missingSofficeEngine.callUno("ping", {})).rejects.toSatisfy(
        (err: unknown) => err instanceof DocPluginError && err.code === "libreoffice_not_found",
      );
    } finally {
      await missingSofficeEngine.close();
    }

    // 2. libreoffice_uno_unavailable on UNO tool, while convert succeeds via CLI fallback
    const wordServer = createWordPluginServer({
      env: makeFakeEnv({ FAKE_PYTHON_MODE: "uno-unavailable" }),
    });
    const srcDoc = path.join(tempDir, "sample.docx");
    const outPdf = path.join(tempDir, "sample.pdf");
    writeFileSync(srcDoc, "dummy docx", "utf8");

    try {
      await expect(callTool(wordServer, "read", { path: srcDoc })).rejects.toSatisfy(
        (err: unknown) =>
          err instanceof DocPluginError && err.code === "libreoffice_uno_unavailable",
      );

      const convertRes = await callTool(wordServer, "convert", {
        path: srcDoc,
        outputPath: outPdf,
        format: "pdf",
      });
      expect(convertRes.isError).toBeUndefined();
      expect(existsSync(outPdf)).toBe(true);
      expect(readFileSync(outPdf, "utf8")).toContain("CLI-CONVERTED:pdf");
    } finally {
      await wordServer.close();
    }
  });

  it("removes the temporary UserInstallation profile directory when the server closes", async () => {
    const engine = new LibreOfficeEngine({ env: makeFakeEnv() });
    await engine.callUno("ping", { echo: "cleanup" });
    const startEvt = readLogs(logFile).find((l) => l.actor === "soffice" && l.event === "start");
    const profileDir = startEvt?.profileDir ?? "";
    expect(profileDir.length).toBeGreaterThan(0);
    expect(existsSync(profileDir)).toBe(true);

    await engine.close();
    expect(existsSync(profileDir)).toBe(false);
  });

  it("round-trips Chinese UTF-8 strings cleanly across the Node-helper stdio channel", async () => {
    const engine = new LibreOfficeEngine({ env: makeFakeEnv() });
    const chinesePayload = "季度总结报告：研发进度与测试验收（2026年11月）— 中文无乱码 ✓";
    try {
      const res = await engine.callUno<{ echo: string }>("ping", { echo: chinesePayload });
      expect(res.echo).toBe(chinesePayload);
    } finally {
      await engine.close();
    }
  });
});
