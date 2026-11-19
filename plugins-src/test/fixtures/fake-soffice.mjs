import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const logFile = process.env.FAKE_LOG_FILE;
const mode = process.env.FAKE_SOFFICE_MODE ?? "normal";

function logEvent(evt) {
  if (!logFile) return;
  appendFileSync(
    logFile,
    `${JSON.stringify({ ts: Date.now(), pid: process.pid, ...evt })}\n`,
    "utf8",
  );
}

const args = process.argv.slice(2);
const userInstArg = args.find((a) => a.startsWith("-env:UserInstallation="));
let profileDir = "";
if (userInstArg) {
  const urlStr = userInstArg.slice("-env:UserInstallation=".length);
  try {
    profileDir = fileURLToPath(urlStr);
  } catch {
    profileDir = urlStr;
  }
}

const convertIdx = args.indexOf("--convert-to");
const outdirIdx = args.indexOf("--outdir");

if (convertIdx >= 0 && outdirIdx >= 0) {
  const convertTo = args[convertIdx + 1] ?? "";
  const outDir = args[outdirIdx + 1] ?? "";
  const inputPath = args[args.length - 1] ?? "";
  logEvent({ actor: "soffice-cli", event: "start", profileDir, convertTo, inputPath });

  if (mode === "no-output") {
    logEvent({ actor: "soffice-cli", event: "exit-no-output" });
    process.exit(0);
  }
  if (mode === "hang") {
    setInterval(() => undefined, 60_000);
  } else {
    mkdirSync(outDir, { recursive: true });
    const stem = path.basename(inputPath, path.extname(inputPath));
    const ext = convertTo.split(":")[0] || "pdf";
    const outPath = path.join(outDir, `${stem}.${ext}`);
    writeFileSync(outPath, `CLI-CONVERTED:${ext}:${stem}\n`, "utf8");
    logEvent({ actor: "soffice-cli", event: "converted", outPath });
    process.exit(0);
  }
} else {
  const acceptArg = args.find((a) => a.startsWith("--accept=")) ?? "";
  logEvent({ actor: "soffice", event: "start", profileDir, acceptArg });
  const keepAlive = setInterval(() => undefined, 60_000);
  const cleanup = () => {
    clearInterval(keepAlive);
    logEvent({ actor: "soffice", event: "exit", profileDir });
    process.exit(0);
  };
  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);
}
