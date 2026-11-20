#!/usr/bin/env node
/**
 * 真实进程强杀验收（ADR-0102）：
 * 1. CLI + 忽略 stdin EOF 的假 MCP 服务器（含派生子进程）：强杀 nctrn 后 5 秒内全部消失；
 * 2. CLI + 后台命令（shell background: true 长 sleep）：强杀 nctrn 后 5 秒内消失；
 * 3. 桌面形态后台（nctrn rpc --stdio）+ 假 MCP 服务器：只强杀后台进程后 5 秒内全部消失；
 * 4. 正常退出：看门狗随之退出，不留任何进程。
 *
 * 先运行 pnpm build；也可用 NOCTURNE_ACCEPT_CLI=<path> 指定单文件 nctrn.mjs。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(process.env.NOCTURNE_ACCEPT_CLI ?? path.join(here, "../dist/main.js"));
const KILL_DEADLINE_MS = 5_000;

/** 忽略 stdin EOF 并派生一个长期子进程的假 MCP stdio 服务器。 */
const IGNORING_EOF_MCP_SERVER = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const readline = require("node:readline");

process.stdin.on("error", () => {});
process.stdout.on("error", () => {});

const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
  windowsHide: true,
});

if (process.env.NOCTURNE_TEST_PID_FILE) {
  fs.writeFileSync(process.env.NOCTURNE_TEST_PID_FILE, String(process.pid));
}
if (process.env.NOCTURNE_TEST_CHILD_PID_FILE && child.pid) {
  fs.writeFileSync(process.env.NOCTURNE_TEST_CHILD_PID_FILE, String(child.pid));
}

function send(msg) {
  try {
    process.stdout.write(JSON.stringify(msg) + "\\n");
  } catch {}
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (msg.id === undefined) return;
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "ignore-eof-mcp", version: "1.0.0" },
      },
    });
  } else if (msg.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        tools: [
          {
            name: "ping",
            description: "test ping",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
    });
  } else if (msg.method === "ping") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  } else {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
  }
});
// 刻意忽略 stdin EOF，靠定时器保持存活，验证必须由外部/看门狗清理。
rl.on("close", () => {});
setInterval(() => {}, 1000);
`.trim();

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}

async function waitFor(check, label, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (check()) return;
    await delay(25);
  }
  const msg = typeof label === "function" ? label() : label;
  throw new Error(`等待超时：${msg}`);
}

function readPidFile(file) {
  if (!existsSync(file)) return undefined;
  const text = readFileSync(file, "utf8").trim();
  if (!/^\d+$/.test(text)) return undefined;
  const pid = Number(text);
  return pid > 0 ? pid : undefined;
}

/** 只强杀单个目标进程（Windows 使用 taskkill /F 不带 /T；POSIX 使用 SIGKILL）。 */
async function hardKillSingle(pid) {
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(pid), "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    await once(killer, "exit");
  } else {
    process.kill(pid, "SIGKILL");
  }
}

/** 仅在异常清理时兜底结束我们自己记录下的 PID。 */
function cleanupPids(pids) {
  for (const pid of pids) {
    if (alive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // 已退出
      }
    }
  }
}

/** 等待一组命名 PID 全部消失，并记录每个 PID 自 startedAt 起的消失耗时（ms）。 */
async function waitAllGone(namedPids, startedAt, deadlineMs = KILL_DEADLINE_MS) {
  const goneAt = {};
  const entries = Object.entries(namedPids);
  const until = startedAt + deadlineMs;
  while (Date.now() < until) {
    let remaining = 0;
    for (const [name, pid] of entries) {
      if (goneAt[name] !== undefined) continue;
      if (!alive(pid)) {
        goneAt[name] = Date.now() - startedAt;
      } else {
        remaining += 1;
      }
    }
    if (remaining === 0) return goneAt;
    await delay(25);
  }
  const survivors = entries
    .filter(([name]) => goneAt[name] === undefined)
    .map(([name, pid]) => `${name}(${pid})`);
  throw new Error(`超过 ${deadlineMs}ms 仍有进程存活：${survivors.join(", ")}`);
}

/** 先证明假服务器确实忽略 stdin EOF，不会自行退出。 */
async function verifyFakeServerIgnoresEof(serverScriptPath, root) {
  const pidFile = path.join(root, "direct-mcp.pid");
  const childPidFile = path.join(root, "direct-child.pid");
  const tracked = [];
  const proc = spawn(process.execPath, [serverScriptPath], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      NOCTURNE_TEST_PID_FILE: pidFile,
      NOCTURNE_TEST_CHILD_PID_FILE: childPidFile,
    },
  });
  try {
    await waitFor(() => readPidFile(pidFile) && readPidFile(childPidFile), "直连假服务器就绪");
    const mcpPid = readPidFile(pidFile);
    const childPid = readPidFile(childPidFile);
    tracked.push(mcpPid, childPid);
    proc.stdin.end();
    await delay(600);
    assert(alive(mcpPid), "假服务器在 stdin EOF 后应继续存活");
    assert(alive(childPid), "假服务器派生的子进程在 stdin EOF 后应继续存活");
    console.log(
      `PRECHECK PASS: 假 MCP 服务器(${mcpPid}) 与其子进程(${childPid}) 确实忽略 stdin EOF`,
    );
  } finally {
    cleanupPids(tracked);
    await waitFor(() => tracked.every((p) => !alive(p)), "清理直连假服务器", 5_000);
  }
}

/** 启动仅返回 1 次后台 shell tool_call、随后返回文本的离线 OpenAI 兼容假服务。 */
async function startFakeOpenAiServer(bgCommand) {
  let turn = 0;
  let requests = 0;
  let lastMessages = "";
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const bodyText = Buffer.concat(chunks).toString("utf8");
      let parsed = {};
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        // 忽略
      }
      lastMessages = JSON.stringify(parsed.messages ?? []).slice(-800);
      requests += 1;
      turn += 1;
      const hasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
      const hasToolResult =
        Array.isArray(parsed.messages) && parsed.messages.some((m) => m.role === "tool");
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "close",
      });
      const writeChunk = (delta, finishReason = null) => {
        res.write(
          `data: ${JSON.stringify({
            id: `chatcmpl-${turn}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: "fake-model",
            choices: [{ index: 0, delta, finish_reason: finishReason }],
          })}\n\n`,
        );
      };
      if (hasTools && !hasToolResult) {
        writeChunk({
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_bg_sleep",
              type: "function",
              function: {
                name: "shell",
                arguments: JSON.stringify({
                  command: bgCommand,
                  background: true,
                  name: "accept-bg-sleep",
                }),
              },
            },
          ],
        });
        writeChunk({}, "tool_calls");
      } else {
        writeChunk({ role: "assistant", content: "BG_COMMAND_STARTED" });
        writeChunk({}, "stop");
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests: () => requests,
    lastMessages: () => lastMessages,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function writeMcpConfig(home, serverScriptPath, pidFile, childPidFile) {
  writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({
      mcp: {
        servers: {
          stubborn: {
            command: process.execPath,
            args: [serverScriptPath],
            env: {
              NOCTURNE_TEST_PID_FILE: pidFile,
              NOCTURNE_TEST_CHILD_PID_FILE: childPidFile,
            },
          },
        },
      },
    }),
  );
}

/** 场景 1：忽略 stdin EOF 的假 MCP 服务器 + 派生子进程，强杀 nctrn 后 5 秒内全部消失。 */
async function scenario1CliMcpKill(root, serverScriptPath) {
  const dir = path.join(root, "s1");
  const home = path.join(dir, "home");
  const workspace = path.join(dir, "workspace");
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  const mcpPidFile = path.join(dir, "mcp.pid");
  const childPidFile = path.join(dir, "child.pid");
  const wdPidFile = path.join(dir, "watchdog.pid");
  writeMcpConfig(home, serverScriptPath, mcpPidFile, childPidFile);

  const tracked = [];
  let output = "";
  const nocturne = spawn(process.execPath, [cli, "--cli"], {
    cwd: workspace,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      NOCTURNE_HOME: home,
      NOCTURNE_API_KEY: "acceptance-placeholder",
      NOCTURNE_BASE_URL: "http://127.0.0.1:9/v1",
      NOCTURNE_MODEL: "fake-model",
      NOCTURNE_WATCHDOG_PID_FILE: wdPidFile,
    },
  });
  tracked.push(nocturne.pid);
  nocturne.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  nocturne.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });

  try {
    await waitFor(
      () =>
        readPidFile(mcpPidFile) &&
        readPidFile(childPidFile) &&
        readPidFile(wdPidFile) &&
        output.includes("nctrn> "),
      `场景 1 就绪（output=${output.slice(-300)}）`,
    );
    const mcpPid = readPidFile(mcpPidFile);
    const childPid = readPidFile(childPidFile);
    const wdPid = readPidFile(wdPidFile);
    tracked.push(mcpPid, childPid, wdPid);
    assert(alive(nocturne.pid) && alive(mcpPid) && alive(childPid) && alive(wdPid));

    const tStart = Date.now();
    await hardKillSingle(nocturne.pid);
    await waitFor(() => !alive(nocturne.pid), "场景 1 nctrn 已死亡", 5_000);
    const tDead = Date.now();
    const goneAt = await waitAllGone(
      { mcp: mcpPid, mcpChild: childPid, watchdog: wdPid },
      tDead,
      KILL_DEADLINE_MS,
    );
    console.log(
      `PASS [场景 1 CLI+MCP强杀]: nctrn=${nocturne.pid}(kill=${tDead - tStart}ms), mcp=${mcpPid}(+${goneAt.mcp}ms), mcpChild=${childPid}(+${goneAt.mcpChild}ms), watchdog=${wdPid}(+${goneAt.watchdog}ms)`,
    );
  } finally {
    cleanupPids(tracked);
    assert(
      tracked.every((p) => !alive(p)),
      "场景 1 结束后不应有残留进程",
    );
  }
}

/** 场景 2：后台命令（shell background: true 长 sleep），强杀 nctrn 后消失。 */
async function scenario2CliBackgroundShellKill(root) {
  const dir = path.join(root, "s2");
  const home = path.join(dir, "home");
  const workspace = path.join(dir, "workspace");
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  const bgPidFile = path.join(dir, "bg.pid");
  const wdPidFile = path.join(dir, "watchdog.pid");
  const bgScriptFile = path.join(workspace, "bg-sleep.cjs");
  writeFileSync(
    bgScriptFile,
    `require("node:fs").writeFileSync(${JSON.stringify(bgPidFile)}, String(process.pid)); setInterval(() => {}, 1000);\n`,
  );
  // 跨 pwsh / bash / cmd / sh 通用的调用形式：node 接工作区内无空格文件名
  const bgCommand = "node bg-sleep.cjs";
  const fakeApi = await startFakeOpenAiServer(bgCommand);

  const tracked = [];
  let output = "";
  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^(?:https?|all|no)_proxy$/i.test(k)),
  );
  const nocturne = spawn(process.execPath, [cli, "--cli", "--yes"], {
    cwd: workspace,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...cleanEnv,
      NOCTURNE_HOME: home,
      NOCTURNE_API_KEY: "acceptance-placeholder",
      NOCTURNE_BASE_URL: fakeApi.baseUrl,
      NOCTURNE_MODEL: "fake-model",
      NOCTURNE_WATCHDOG_PID_FILE: wdPidFile,
    },
  });
  tracked.push(nocturne.pid);
  nocturne.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  nocturne.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });

  try {
    await waitFor(
      () => output.includes("nctrn> "),
      `场景 2 REPL 就绪（output=${output.slice(-300)}）`,
    );
    nocturne.stdin.write("start background sleep\n");
    await waitFor(
      () =>
        readPidFile(bgPidFile) && readPidFile(wdPidFile) && output.includes("BG_COMMAND_STARTED"),
      () =>
        `场景 2 后台命令与看门狗就绪（reqs=${fakeApi.requests()}, bgPid=${readPidFile(bgPidFile)}, wdPid=${readPidFile(wdPidFile)}, lastMessages=${fakeApi.lastMessages()}, output=${output.slice(-300)}）`,
      12_000,
    );
    const bgPid = readPidFile(bgPidFile);
    const wdPid = readPidFile(wdPidFile);
    tracked.push(bgPid, wdPid);
    assert(alive(nocturne.pid) && alive(bgPid) && alive(wdPid));

    const tStart = Date.now();
    await hardKillSingle(nocturne.pid);
    await waitFor(() => !alive(nocturne.pid), "场景 2 nctrn 已死亡", 5_000);
    const tDead = Date.now();
    const goneAt = await waitAllGone({ bgShell: bgPid, watchdog: wdPid }, tDead, KILL_DEADLINE_MS);
    console.log(
      `PASS [场景 2 CLI+后台命令强杀]: nctrn=${nocturne.pid}(kill=${tDead - tStart}ms), bgShell=${bgPid}(+${goneAt.bgShell}ms), watchdog=${wdPid}(+${goneAt.watchdog}ms)`,
    );
  } finally {
    await fakeApi.close();
    cleanupPids(tracked);
    assert(
      tracked.every((p) => !alive(p)),
      "场景 2 结束后不应有残留进程",
    );
  }
}

/** 场景 3：桌面形态后台（nctrn rpc --stdio），打开会话启动假 MCP，只强杀后台进程。 */
async function scenario3DesktopRpcBackendKill(root, serverScriptPath) {
  const dir = path.join(root, "s3");
  const home = path.join(dir, "home");
  const workspace = path.join(dir, "workspace");
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  const mcpPidFile = path.join(dir, "mcp.pid");
  const childPidFile = path.join(dir, "child.pid");
  const wdPidFile = path.join(dir, "watchdog.pid");
  writeMcpConfig(home, serverScriptPath, mcpPidFile, childPidFile);

  const tracked = [];
  let stderr = "";
  const rpc = spawn(process.execPath, [cli, "rpc", "--stdio"], {
    cwd: workspace,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      NOCTURNE_HOME: home,
      NOCTURNE_API_KEY: "acceptance-placeholder",
      NOCTURNE_BASE_URL: "http://127.0.0.1:9/v1",
      NOCTURNE_MODEL: "fake-model",
      NOCTURNE_WATCHDOG_PID_FILE: wdPidFile,
    },
  });
  tracked.push(rpc.pid);

  const responses = new Map();
  let stdoutBuf = "";
  rpc.stdout.setEncoding("utf8");
  rpc.stdout.on("data", (chunk) => {
    stdoutBuf += chunk;
    let idx = stdoutBuf.indexOf("\n");
    while (idx >= 0) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (line) {
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined) {
            const waiter = responses.get(msg.id);
            if (waiter) {
              responses.delete(msg.id);
              waiter(msg);
            }
          }
        } catch {
          // 忽略非 JSON 行
        }
      }
      idx = stdoutBuf.indexOf("\n");
    }
  });
  rpc.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  let nextId = 1;
  const request = (method, params) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        responses.delete(id);
        reject(new Error(`RPC ${method} 超时（stderr=${stderr.slice(-400)}）`));
      }, 15_000);
      responses.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) reject(new Error(`RPC ${method} 失败：${JSON.stringify(msg.error)}`));
        else resolve(msg.result);
      });
      rpc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  };

  try {
    await request("initialize", {
      protocolVersion: 1,
      clientName: "desktop-accept",
      capabilities: { interactive: true },
    });
    const models = await request("runtime.listModels", { workspaceRoot: workspace });
    assert(Array.isArray(models) && models.length > 0, "RPC runtime.listModels 应返回至少一个模型");
    const firstModel = models[0].ref;
    const opened = await request("runtime.createSession", {
      cwd: workspace,
      workspaceRoot: workspace,
      model: firstModel,
    });
    assert(opened?.sessionId, "RPC createSession 应返回 sessionId");

    await waitFor(
      () => readPidFile(mcpPidFile) && readPidFile(childPidFile) && readPidFile(wdPidFile),
      `场景 3 MCP 与看门狗就绪（stderr=${stderr.slice(-400)}）`,
    );
    const mcpPid = readPidFile(mcpPidFile);
    const childPid = readPidFile(childPidFile);
    const wdPid = readPidFile(wdPidFile);
    tracked.push(mcpPid, childPid, wdPid);
    assert(alive(rpc.pid) && alive(mcpPid) && alive(childPid) && alive(wdPid));

    const tStart = Date.now();
    await hardKillSingle(rpc.pid);
    await waitFor(() => !alive(rpc.pid), "场景 3 rpcBackend 已死亡", 5_000);
    const tDead = Date.now();
    const goneAt = await waitAllGone(
      { mcp: mcpPid, mcpChild: childPid, watchdog: wdPid },
      tDead,
      KILL_DEADLINE_MS,
    );
    console.log(
      `PASS [场景 3 桌面RPC后台强杀]: rpcBackend=${rpc.pid}(kill=${tDead - tStart}ms), mcp=${mcpPid}(+${goneAt.mcp}ms), mcpChild=${childPid}(+${goneAt.mcpChild}ms), watchdog=${wdPid}(+${goneAt.watchdog}ms)`,
    );
  } finally {
    cleanupPids(tracked);
    assert(
      tracked.every((p) => !alive(p)),
      "场景 3 结束后不应有残留进程",
    );
  }
}

/** 场景 4：正常退出后，看门狗随之退出，不留进程。 */
async function scenario4NormalExit(root, serverScriptPath) {
  const dir = path.join(root, "s4");
  const home = path.join(dir, "home");
  const workspace = path.join(dir, "workspace");
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  const mcpPidFile = path.join(dir, "mcp.pid");
  const childPidFile = path.join(dir, "child.pid");
  const wdPidFile = path.join(dir, "watchdog.pid");
  writeMcpConfig(home, serverScriptPath, mcpPidFile, childPidFile);

  const tracked = [];
  let output = "";
  const nocturne = spawn(process.execPath, [cli, "--cli"], {
    cwd: workspace,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      NOCTURNE_HOME: home,
      NOCTURNE_API_KEY: "acceptance-placeholder",
      NOCTURNE_BASE_URL: "http://127.0.0.1:9/v1",
      NOCTURNE_MODEL: "fake-model",
      NOCTURNE_WATCHDOG_PID_FILE: wdPidFile,
    },
  });
  tracked.push(nocturne.pid);
  nocturne.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  nocturne.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });

  try {
    await waitFor(
      () =>
        readPidFile(mcpPidFile) &&
        readPidFile(childPidFile) &&
        readPidFile(wdPidFile) &&
        output.includes("nctrn> "),
      `场景 4 就绪（output=${output.slice(-300)}）`,
    );
    const mcpPid = readPidFile(mcpPidFile);
    const childPid = readPidFile(childPidFile);
    const wdPid = readPidFile(wdPidFile);
    tracked.push(mcpPid, childPid, wdPid);
    assert(alive(nocturne.pid) && alive(mcpPid) && alive(childPid) && alive(wdPid));

    const t0 = Date.now();
    const exitPromise = once(nocturne, "exit");
    nocturne.stdin.write("/exit\n");
    nocturne.stdin.end();
    const [exitCode] = await exitPromise;
    assert.equal(exitCode, 0, `正常退出码应为 0，实际 ${exitCode}`);

    const goneAt = await waitAllGone(
      { nctrn: nocturne.pid, mcp: mcpPid, mcpChild: childPid, watchdog: wdPid },
      t0,
      10_000,
    );
    console.log(
      `PASS [场景 4 正常退出]: exitCode=${exitCode}, nctrn=${nocturne.pid}(${goneAt.nctrn}ms), mcp=${mcpPid}(${goneAt.mcp}ms), mcpChild=${childPid}(${goneAt.mcpChild}ms), watchdog=${wdPid}(${goneAt.watchdog}ms)`,
    );
  } finally {
    cleanupPids(tracked);
    assert(
      tracked.every((p) => !alive(p)),
      "场景 4 结束后不应有残留进程",
    );
  }
}

assert(existsSync(cli), `找不到被测入口 ${cli}；先运行 pnpm build`);
const root = mkdtempSync(path.join(tmpdir(), "nct-orphan-accept-"));
const serverScriptPath = path.join(root, "ignore-eof-mcp.cjs");
writeFileSync(serverScriptPath, IGNORING_EOF_MCP_SERVER);

try {
  console.log(`CLI entry: ${cli}`);
  await verifyFakeServerIgnoresEof(serverScriptPath, root);
  await scenario1CliMcpKill(root, serverScriptPath);
  await scenario2CliBackgroundShellKill(root);
  await scenario3DesktopRpcBackendKill(root, serverScriptPath);
  await scenario4NormalExit(root, serverScriptPath);
  console.log("ALL 4 ACCEPTANCE SCENARIOS PASSED");
} finally {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // 清理临时目录失败不掩盖主错误
  }
}
