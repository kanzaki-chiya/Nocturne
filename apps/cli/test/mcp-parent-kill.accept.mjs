#!/usr/bin/env node
/** 真实 nctrn 进程验收：响应 stdin EOF 的 MCP 服务器在主进程被强杀后自行退出。先运行 pnpm build。 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, "../dist/main.js");
const fakeServer = path.resolve(here, "../../../packages/mcp/test/fake-server.mjs");
const root = mkdtempSync(path.join(tmpdir(), "nct-mcp-kill-"));
const home = path.join(root, "home");
const workspace = path.join(root, "workspace");
mkdirSync(home);
mkdirSync(workspace);

async function waitFor(check, label, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (check()) return;
    await delay(50);
  }
  throw new Error(`等待超时：${label}`);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

let direct;
let nocturne;
let mcpPid;
try {
  assert(existsSync(cli), "先运行 pnpm build");

  // 先单独证明测试服务器本身遵守 stdin EOF 约定。
  const directPidFile = path.join(root, "direct.pid");
  direct = spawn(process.execPath, [fakeServer], {
    stdio: ["pipe", "ignore", "pipe"],
    env: { ...process.env, NOCTURNE_TEST_PID_FILE: directPidFile },
  });
  await waitFor(() => existsSync(directPidFile), "假服务器启动");
  direct.stdin.end();
  const [directCode] = await once(direct, "exit");
  assert.equal(directCode, 0, "假服务器应在 stdin EOF 后正常退出");

  const pidFile = path.join(root, "mcp.pid");
  writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({
      mcp: {
        servers: {
          fake: {
            command: process.execPath,
            args: [fakeServer],
            env: { NOCTURNE_TEST_PID_FILE: pidFile },
          },
        },
      },
    }),
  );
  let output = "";
  nocturne = spawn(process.execPath, [cli], {
    cwd: workspace,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      NOCTURNE_HOME: home,
      NOCTURNE_API_KEY: "acceptance-placeholder",
      NOCTURNE_BASE_URL: "http://127.0.0.1:9/v1",
      NOCTURNE_MODEL: "fake-model",
    },
  });
  nocturne.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  nocturne.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });
  await waitFor(() => existsSync(pidFile) && output.includes("nctrn> "), "nctrn 与 MCP 就绪");
  mcpPid = Number(readFileSync(pidFile, "utf8"));
  assert(alive(mcpPid), "MCP 服务器应仍在运行");
  assert(nocturne.kill("SIGKILL"), "无法强杀 nctrn");
  await once(nocturne, "exit");
  await waitFor(() => !alive(mcpPid), "MCP 服务器随 stdin EOF 自行退出");
  console.log("PASS: MCP 服务器在 stdin EOF 后退出；强杀 nctrn 后没有残留");
} finally {
  if (direct?.exitCode === null) direct.kill("SIGKILL");
  if (nocturne?.exitCode === null && nocturne.signalCode === null) nocturne.kill("SIGKILL");
  if (mcpPid !== undefined && alive(mcpPid)) process.kill(mcpPid, "SIGKILL");
  rmSync(root, { recursive: true, force: true });
}
