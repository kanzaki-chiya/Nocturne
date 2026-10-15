#!/usr/bin/env node
/** npm-installed relay artifact smoke test; never prints invitation or VAPID material. */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { run } from "./lib/proc.mjs";

const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const clean = (dir) =>
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });

async function freePort() {
  const server = createServer();
  await new Promise((done, reject) => server.once("error", reject).listen(0, "127.0.0.1", done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function safeEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("NOCTURNE_RELAY_")),
  );
}

async function waitExit(child, timeout) {
  if (child.exitCode !== null || child.signalCode !== null)
    return { code: child.exitCode, signal: child.signalCode };
  return Promise.race([
    new Promise((done) => child.once("exit", (code, signal) => done({ code, signal }))),
    pause(timeout).then(() => null),
  ]);
}

async function killTree(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      timeout: 3000,
    });
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
  await waitExit(child, 5000);
}

export async function smokeRelay(tgz) {
  const artifact = resolve(tgz);
  check(existsSync(artifact), `找不到包 ${artifact}`);
  const prefix = mkdtempSync(join(tmpdir(), "relay-smoke-"));
  let child;
  try {
    run("npm", ["install", "--prefix", prefix, artifact, "--no-audit", "--no-fund"], {
      env: safeEnvironment(),
    });
    console.log("安装: 临时前缀完成");
    const installed = join(prefix, "node_modules", "nocturne-relay");
    const pkg = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
    check(
      pkg.name === "nocturne-relay" && artifact.endsWith(`nocturne-relay-${pkg.version}.tgz`),
      "包名或 tgz 版本不一致",
    );
    const main = join(installed, "dist", "main.mjs");
    const env = safeEnvironment();
    // 经 npm 装出的命令调用（POSIX 是符号链接、Windows 是 .cmd），覆盖用户实际的启动方式
    const bin = join(
      prefix,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "nocturne-relay.cmd" : "nocturne-relay",
    );
    check(existsSync(bin), `npm 未生成命令 ${bin}`);
    const version = run(bin, ["--version"], { capture: true, env }).trim();
    check(version === pkg.version, `--version 与包版本不一致 (${version} / ${pkg.version})`);
    console.log(`版本: ${version}`);

    const dataDir = join(prefix, "relay-data");
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    // Windows doesn't deliver SIGTERM to Node as POSIX does. IPC triggers the CLI's
    // existing SIGTERM handler without adding any production-only shutdown protocol.
    const wrapper = `import { main } from ${JSON.stringify(pathToFileURL(main).href)}; process.on('message', m => { if (m === 'stop') { process.disconnect(); process.emit('SIGTERM'); } }); await main(${JSON.stringify(["serve", "--listen", `127.0.0.1:${port}`, "--public-origin", origin, "--data-dir", dataDir])});`;
    child = spawn(process.execPath, ["--input-type=module", "-e", wrapper], {
      env,
      cwd: prefix,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let logs = "";
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (part) => {
        logs = (logs + part.toString()).slice(-65536);
      });
    let response;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      check(child.exitCode === null && child.signalCode === null, "服务提前退出");
      try {
        response = await fetch(origin, { signal: AbortSignal.timeout(1000) });
        if (response.ok) break;
      } catch {
        /* server not listening yet */
      }
      await pause(100);
    }
    check(response?.ok, "服务启动超时");
    const html = await response.text();
    check(
      /<title>\s*Nocturne\s*<\/title>/i.test(html) && /manifest\.webmanifest/.test(html),
      "首页不是手机网页",
    );
    check(
      response.headers.get("content-security-policy") &&
        response.headers.get("x-content-type-options") === "nosniff" &&
        response.headers.get("cache-control") === "no-cache",
      "首页安全/缓存响应头不正确",
    );
    const infoResponse = await fetch(`${origin}/v1/info`);
    const info = await infoResponse.json();
    check(
      infoResponse.status === 200 &&
        info.protocol === 1 &&
        info.relayVersion === pkg.version &&
        typeof info.vapidPublicKey === "string",
      "中继元数据不正确",
    );
    check(existsSync(join(dataDir, "vapid.json")), "临时数据目录未生成 VAPID 文件");
    const manifest = await fetch(`${origin}/manifest.webmanifest`);
    check(
      manifest.status === 200 &&
        manifest.headers.get("content-type")?.includes("application/manifest+json"),
      "manifest MIME 错误",
    );
    const sw = await fetch(`${origin}/sw.js`);
    check(
      sw.status === 200 && sw.headers.get("content-type")?.includes("text/javascript"),
      "sw MIME 错误",
    );
    const asset = /(?:src|href)=["'](\/assets\/[^"']+\.js)["']/.exec(html)?.[1];
    check(asset, "首页未引用 JS asset");
    const js = await fetch(`${origin}${asset}`);
    check(
      js.status === 200 && js.headers.get("content-type")?.includes("text/javascript"),
      "JS asset 响应错误",
    );
    console.log("HTTP: 手机首页、manifest、SW、JS、元数据及安全头通过");

    const create = run(
      process.execPath,
      [main, "invite", "create", "--note", "smoke", "--data-dir", dataDir],
      { capture: true, env },
    ).trim();
    check(/^nocturne-invite:[^\s]+\/[A-Za-z0-9_-]{24}$/.test(create), "创建邀请失败");
    const list = run(process.execPath, [main, "invite", "list", "--data-dir", dataDir], {
      capture: true,
      env,
    }).trim();
    check(
      list.split(/\r?\n/).length === 1 && /^[a-f0-9]{8}\s+smoke\s+/.test(list),
      "邀请列表不是唯一 smoke 条目",
    );
    // Do not echo admin outputs or log content (which could contain a code).
    check(
      !/invite|code/i.test(logs) && !logs.includes(create.split("/").at(-1)),
      "服务日志包含邀请或 code 信息",
    );
    console.log("管理: 创建及列出唯一 smoke 邀请；日志无邀请码");
    if (process.platform === "win32") child.send("stop");
    else {
      child.disconnect();
      child.kill("SIGTERM");
    }
    const stopped = await waitExit(child, 5000);
    check(stopped?.code === 0 && stopped.signal === null, "SIGTERM/IPC 关闭未在 5 秒内正常退出");
    check(
      existsSync(join(dataDir, "relay-data.json")) && existsSync(join(dataDir, "vapid.json")),
      "关闭后缺少持久化数据文件",
    );
    check(
      !/invite|code/i.test(logs) && !logs.includes(create.split("/").at(-1)),
      "关闭日志包含邀请或 code 信息",
    );
    child = null;
    console.log("关闭: 5 秒内正常退出；中继冒烟通过");
  } finally {
    await killTree(child);
    clean(prefix);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) {
    console.error("用法: node scripts/smoke-relay.mjs <tgz 路径>");
    process.exitCode = 1;
  } else {
    smokeRelay(process.argv[2]).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  }
}
