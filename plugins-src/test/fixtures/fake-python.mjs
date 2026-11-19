import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

const logFile = process.env.FAKE_LOG_FILE;
const mode = process.env.FAKE_PYTHON_MODE ?? "normal";
const grandchildPidFile = process.env.FAKE_GRANDCHILD_PID_FILE;

function logEvent(evt) {
  if (!logFile) return;
  appendFileSync(
    logFile,
    `${JSON.stringify({ ts: Date.now(), pid: process.pid, ...evt })}\n`,
    "utf8",
  );
}

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`, "utf8");
}

const args = process.argv.slice(2);
const pipeIdx = args.indexOf("--pipe");
const pipeName = pipeIdx >= 0 ? (args[pipeIdx + 1] ?? "") : "";

logEvent({ actor: "python", event: "start", pipeName, mode });

if (mode === "uno-unavailable") {
  send({
    ready: false,
    code: "libreoffice_uno_unavailable",
    error: "Simulated missing python3-uno",
  });
  process.exit(2);
}

send({ ready: true });

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (rawLine) => {
  const line = rawLine.trim();
  if (!line) return;
  const req = JSON.parse(line);
  const startTs = Date.now();
  logEvent({ actor: "python", event: "op_start", id: req.id, op: req.op, startTs });

  if (req.op === "shutdown") {
    send({ id: req.id, ok: true, result: { shutdown: true } });
    process.exit(0);
  }

  if (mode === "hang" || req.op === "hang_forever") {
    const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (grandchildPidFile && grandchild.pid) {
      writeFileSync(grandchildPidFile, String(grandchild.pid), "utf8");
    }
    logEvent({ actor: "python", event: "hanging", grandchildPid: grandchild.pid });
    return;
  }

  const delayMs = Number(process.env.FAKE_OP_DELAY_MS ?? "0");
  const finish = () => {
    const endTs = Date.now();
    logEvent({ actor: "python", event: "op_end", id: req.id, op: req.op, startTs, endTs });

    if (mode === "no-output") {
      send({ id: req.id, ok: true, result: { outputPath: req.params?.outputPath } });
      return;
    }

    if (req.op === "docx_create" || req.op === "docx_convert" || req.op === "pdf_create") {
      const outPath = req.params?.outputPath;
      if (outPath) {
        mkdirSync(path.dirname(outPath), { recursive: true });
        writeFileSync(outPath, `FAKE:${req.op}`, "utf8");
      }
      send({ id: req.id, ok: true, result: { outputPath: outPath } });
      return;
    }

    send({
      id: req.id,
      ok: true,
      result: {
        op: req.op,
        echo: req.params?.echo ?? req.params?.path ?? null,
        pipeName,
      },
    });
  };

  if (delayMs > 0) {
    setTimeout(finish, delayMs);
  } else {
    finish();
  }
});

rl.once("close", () => {
  logEvent({ actor: "python", event: "exit", pipeName });
  process.exit(0);
});
