#!/usr/bin/env node
/**
 * nctrn-<version>.tgz 安装冒烟（本机或 CI）：
 *   1. npm i -g <tgz> --prefix <临时前缀>（装进临时目录，不污染全局）
 *   2. 临时前缀下的 nctrn --version 能跑通
 *   3. nctrn rpc --stdio 完成一次 initialize 握手
 *
 * 用法：node scripts/smoke-nctrn.mjs <tgz 路径>
 */
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { run } from "./lib/proc.mjs";

const RPC_PROTOCOL_VERSION = 1;

/** 临时前缀里 nctrn 可执行文件的位置（npm 在 Windows 下直接放前缀根部） */
function binPath(prefix) {
  return process.platform === "win32" ? join(prefix, "nctrn.cmd") : join(prefix, "bin", "nctrn");
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
      // cmd.exe 包装下的 node 是孙进程，按 pid 单杀只杀掉包装层
      if (win) {
        spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
      } else {
        child.kill("SIGKILL");
      }
      // 等进程真正退出，否则 cwd（临时目录）还被持有
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    }
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
    console.log(`冒烟通过：nctrn ${version}，rpc 握手 nocturne=${result.nocturneVersion}`);
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
