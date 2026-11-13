#!/usr/bin/env node
/**
 * nctrn-<version>.tgz 安装冒烟（本机或 CI）：
 *   1. npm i -g <tgz> --prefix <临时前缀>（装进临时目录，不污染全局）
 *   2. 临时前缀下的 nctrn --version 能跑通
 *   3. nctrn rpc --stdio 完成一次 initialize 握手
 *   4. nctrn -p 经本地模拟 OpenAI 兼容服务调用 read 读取长图，验证能找到 WASM 并切段
 *
 * 用法：node scripts/smoke-nctrn.mjs <tgz 路径>
 */
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

import { run } from "./lib/proc.mjs";

const RPC_PROTOCOL_VERSION = 1;

/** 临时前缀里 nctrn 可执行文件的位置（npm 在 Windows 下直接放前缀根部） */
function binPath(prefix) {
  return process.platform === "win32" ? join(prefix, "nctrn.cmd") : join(prefix, "bin", "nctrn");
}

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 4, "ascii");
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function makeSolidPng(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rowBytes = 1 + width * 4;
  const raw = Buffer.alloc(rowBytes * height, 200);
  for (let y = 0; y < height; y++) raw[y * rowBytes] = 0;
  const idat = deflateSync(raw, { level: 1 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** rpc --stdio 握手：发 initialize，等 id=1 的响应，校验 protocolVersion */
async function rpcHandshake(bin, env, cwd) {
  const win = process.platform === "win32";
  const command = win ? `"${bin}" rpc --stdio` : bin;
  const args = win ? [] : ["rpc", "--stdio"];
  const child = spawn(command, args, { shell: win, env, cwd });
  try {
    return await new Promise((resolveHandshake, reject) => {
      let buffer = "";
      const timer = setTimeout(() => reject(new Error("rpc 握手超时（20s）")), 20_000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        clearTimeout(timer);
        try {
          const response = JSON.parse(line);
          const result = response.result;
          if (response.id !== 1 || result?.protocolVersion !== RPC_PROTOCOL_VERSION) {
            reject(new Error(`rpc 握手响应不符预期: ${line}`));
          } else {
            resolveHandshake(result);
          }
        } catch {
          reject(new Error(`rpc 握手首行不是 JSON: ${line}`));
        }
      });
      child.on("error", reject);
      child.on("exit", (code) => reject(new Error(`rpc 进程提前退出（${code}）`)));
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: RPC_PROTOCOL_VERSION,
            clientName: "nctrn-smoke",
            capabilities: { interactive: false },
          },
        })}\n`,
      );
    });
  } finally {
    if (child.exitCode === null && child.pid !== undefined) {
      const exited = once(child, "exit");
      if (win) {
        spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
      } else {
        child.kill("SIGKILL");
      }
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    }
  }
}

function runAsync(bin, args, options) {
  const win = process.platform === "win32";
  const command = win ? `"${bin}" ${args.map((a) => `"${a}"`).join(" ")}` : bin;
  const spawnArgs = win ? [] : args;
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, spawnArgs, {
      shell: win,
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    const timer = setTimeout(() => {
      if (win && child.pid !== undefined) {
        spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
      } else {
        child.kill("SIGKILL");
      }
      rejectRun(new Error(`命令超时：${bin} ${args.join(" ")}\nstderr:\n${stderr}`));
    }, 60_000);
    child.on("error", (err) => {
      clearTimeout(timer);
      rejectRun(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolveRun({ stdout, stderr });
      else rejectRun(new Error(`命令退出码 ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
  });
}

/** 验证安装后的 nctrn -p 能通过 WASM + worker 读取长图并切段发往模型 */
async function smokeImageTilePrint(bin, home, workspace) {
  writeFileSync(join(workspace, "tall.png"), makeSolidPng(100, 3600));
  let callIndex = 0;
  let receivedJpegCount = 0;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (!hasTools) {
        // 后台标题等辅助请求，不占主对话脚本顺序
        res.write(
          `data: ${JSON.stringify({
            id: "c0",
            object: "chat.completion.chunk",
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "smoke-title" },
                finish_reason: null,
              },
            ],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            id: "c0",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      callIndex++;
      if (callIndex === 1) {
        res.write(
          `data: ${JSON.stringify({
            id: "c1",
            object: "chat.completion.chunk",
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "tc1",
                      type: "function",
                      function: { name: "read", arguments: '{"path":"tall.png"}' },
                    },
                  ],
                },
              },
            ],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            id: "c1",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      for (const msg of body.messages ?? []) {
        if (!Array.isArray(msg.content)) continue;
        for (const part of msg.content) {
          if (part?.type === "image_url" && typeof part.image_url?.url === "string") {
            if (part.image_url.url.startsWith("data:image/jpeg;base64,")) receivedJpegCount++;
          }
        }
      }
      if (receivedJpegCount === 0) {
        console.error(
          "DEBUG smoke messages:",
          JSON.stringify(
            (body.messages ?? []).map((m) => ({
              role: m.role,
              content:
                typeof m.content === "string"
                  ? m.content.slice(0, 120)
                  : Array.isArray(m.content)
                    ? m.content.map((p) => ({ type: p.type, url: p.image_url?.url?.slice(0, 40) }))
                    : m.content,
            })),
          ),
        );
      }
      res.write(
        `data: ${JSON.stringify({
          id: "c2",
          object: "chat.completion.chunk",
          choices: [
            { index: 0, delta: { role: "assistant", content: "tiled-ok" }, finish_reason: null },
          ],
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          id: "c2",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const printHome = mkdtempSync(join(tmpdir(), "nctrn-img-home-"));
  try {
    writeFileSync(
      join(printHome, "config.json"),
      JSON.stringify({
        model: "mock/vision",
        providers: [
          {
            id: "mock",
            type: "openai-compatible",
            baseURL: `http://127.0.0.1:${port}/v1`,
            apiKeyEnv: "NOCTURNE_SMOKE_MOCK_KEY",
            models: {
              vision: {
                capabilities: {
                  toolCalls: true,
                  imageInput: true,
                },
              },
            },
          },
        ],
      }),
    );
    const { stdout: out, stderr: errOut } = await runAsync(bin, ["-p", "读取 tall.png", "--yes"], {
      cwd: workspace,
      env: {
        ...process.env,
        NOCTURNE_HOME: printHome,
        NOCTURNE_SMOKE_MOCK_KEY: "smoke-key",
        CI: "1",
      },
    });
    if (!out.includes("tiled-ok") || receivedJpegCount !== 2) {
      throw new Error(
        `nctrn -p 长图切段冒烟失败: output=${JSON.stringify(out)}, receivedJpegCount=${receivedJpegCount}, stderr=${errOut}`,
      );
    }
  } finally {
    await new Promise((r) => server.close(() => r()));
    rmSync(printHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
}

async function main() {
  const tgz = resolve(process.argv[2] ?? "");
  if (!process.argv[2]) {
    console.error("用法: node scripts/smoke-nctrn.mjs <tgz 路径>");
    process.exit(1);
  }
  const prefix = mkdtempSync(join(tmpdir(), "nctrn-prefix-"));
  const home = mkdtempSync(join(tmpdir(), "nctrn-home-"));
  const workspace = mkdtempSync(join(tmpdir(), "nctrn-ws-"));
  try {
    run("npm", ["install", "--global", tgz, "--prefix", prefix]);
    const bin = binPath(prefix);
    const version = run(bin, ["--version"], { capture: true, env: { ...process.env } }).trim();
    if (!/^\d+\.\d+\.\d+/.test(version)) {
      throw new Error(`nctrn --version 输出异常: ${version}`);
    }
    const result = await rpcHandshake(
      bin,
      { ...process.env, NOCTURNE_HOME: home, CI: "1" },
      workspace,
    );
    await smokeImageTilePrint(bin, home, workspace);
    console.log(
      `冒烟通过：nctrn ${version}，rpc 握手 nocturne=${result.nocturneVersion}，WASM 切段 2 段`,
    );
  } finally {
    // Windows 下 rpc 子进程被杀后仍短暂持有 cwd，删除需要重试
    const opts = { recursive: true, force: true, maxRetries: 10, retryDelay: 300 };
    rmSync(prefix, opts);
    rmSync(home, opts);
    rmSync(workspace, opts);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
