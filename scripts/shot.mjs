#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { unusedFetchSafePort } from "./test/ports.mjs";
import { killPidTree } from "./test/process-cleanup.mjs";
import { stripProxyEnv } from "./verify.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(scriptDir, "..");
const DEV_VITE_PORT = 31420;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 解析宽x高参数（默认 1440x900） */
export function parseSize(raw) {
  const m = /^(\d+)[x×](\d+)$/i.exec(String(raw ?? "").trim());
  if (!m) throw new Error(`无效的 --size 值：${raw}（应为 宽x高，例如 1440x900）`);
  const width = Number.parseInt(m[1], 10);
  const height = Number.parseInt(m[2], 10);
  if (width < 200 || height < 200 || width > 8192 || height > 8192) {
    throw new Error(`--size 超出合理范围：${width}x${height}`);
  }
  return { width, height };
}

/** 规范化路径用于边界比较（Windows 忽略大小写与反斜杠差异） */
function normalizeForCompare(targetPath) {
  let resolved = resolve(targetPath);
  try {
    resolved = realpathSync(resolved);
  } catch {
    // 目录尚未创建时使用词法解析结果
  }
  const stripped = resolved.replace(/[\\/]+$/, "");
  return process.platform === "win32" ? stripped.toLowerCase() : stripped;
}

/**
 * 校验隔离的 NOCTURNE_HOME：禁止等于真实 ~/.nocturne 或位于其内部。
 */
export function assertSafeHomeDir(homeDir, userHome = homedir()) {
  if (!homeDir || !String(homeDir).trim()) {
    throw new Error("必须指定 --home <目录> 作为隔离的 NOCTURNE_HOME");
  }
  const realNocturne = normalizeForCompare(join(userHome, ".nocturne"));
  const candidate = normalizeForCompare(homeDir);
  if (candidate === realNocturne || candidate.startsWith(`${realNocturne}${sep}`)) {
    throw new Error(`禁止将 --home 指向或置于真实 ~/.nocturne 目录内：${resolve(homeDir)}`);
  }
  return resolve(homeDir);
}

/** 解析 PNG IHDR 头获取真实像素宽高 */
export function parsePngDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) {
    throw new Error("截图文件不是有效的 PNG（长度不足）");
  }
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("截图文件不是有效的 PNG（文件头不匹配）");
  }
  if (buffer.subarray(12, 16).toString("ascii") !== "IHDR") {
    throw new Error("截图文件缺少 IHDR 块");
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width <= 0 || height <= 0) {
    throw new Error(`截图尺寸无效：${width}x${height}`);
  }
  return { width, height };
}

/** 计算默认调试版桌面端可执行文件路径 */
export function defaultDebugExePath(repoRoot = defaultRepoRoot, env = process.env) {
  const targetDir = env.CARGO_TARGET_DIR?.trim();
  if (targetDir) {
    return join(targetDir, "debug", "nocturne-desktop.exe");
  }
  return join(repoRoot, "apps", "desktop", "src-tauri", "target", "debug", "nocturne-desktop.exe");
}

/** 解析 pnpm shot CLI 参数 */
export function parseShotArgs(argv = process.argv.slice(2), env = process.env) {
  const opts = {
    help: false,
    home: undefined,
    fixture: undefined,
    port: undefined,
    size: { width: 1440, height: 900 },
    theme: undefined,
    steps: undefined,
    exe: defaultDebugExePath(defaultRepoRoot, env),
    noVite: false,
  };

  const nextVal = (i, flag) => {
    const v = argv[i + 1];
    if (!v || v.startsWith("-")) throw new Error(`${flag} 缺少参数值`);
    return v;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "-h" || arg === "--help") {
      opts.help = true;
      return opts;
    }
    if (arg === "--no-vite") {
      opts.noVite = true;
      continue;
    }

    let flag = arg;
    let value;
    const eq = arg.indexOf("=");
    if (eq > 0 && arg.startsWith("--")) {
      flag = arg.slice(0, eq);
      value = arg.slice(eq + 1);
      if (!value) throw new Error(`${flag} 缺少参数值`);
    }

    switch (flag) {
      case "--home":
        opts.home = value ?? nextVal(i++, flag);
        break;
      case "--fixture":
        opts.fixture = value ?? nextVal(i++, flag);
        break;
      case "--port": {
        const raw = value ?? nextVal(i++, flag);
        if (!/^\d+$/.test(raw)) throw new Error(`无效的 --port：${raw}`);
        const port = Number.parseInt(raw, 10);
        if (port < 1 || port > 65535) throw new Error(`--port 超出范围：${port}`);
        opts.port = port;
        break;
      }
      case "--size":
        opts.size = parseSize(value ?? nextVal(i++, flag));
        break;
      case "--theme": {
        const t = value ?? nextVal(i++, flag);
        if (t !== "light" && t !== "dark") {
          throw new Error(`--theme 只支持 light 或 dark，收到：${t}`);
        }
        opts.theme = t;
        break;
      }
      case "--steps":
        opts.steps = value ?? nextVal(i++, flag);
        break;
      case "--exe":
        opts.exe = value ?? nextVal(i++, flag);
        break;
      default:
        throw new Error(`未知参数：${arg}`);
    }
  }

  return opts;
}

/** 检测指定主机与端口是否空闲 */
function isHostPortFree(host, port) {
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.unref();
    server.once("error", (err) => {
      if (err?.code === "EADDRNOTAVAIL" || err?.code === "EAFNOSUPPORT") {
        resolvePromise(true);
      } else {
        resolvePromise(false);
      }
    });
    server.listen({ host, port, exclusive: true }, () => {
      server.close(() => resolvePromise(true));
    });
  });
}

/** 同时检查 IPv4 与 IPv6 回环，确保端口未被已有进程占用 */
export async function isLocalPortFree(port) {
  const [v4, v6] = await Promise.all([
    isHostPortFree("127.0.0.1", port),
    isHostPortFree("::1", port),
  ]);
  return v4 && v6;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轻量 CDP 客户端（基于 Node 内置 WebSocket） */
class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.ws = null;
  }

  async connect(timeoutMs = 15_000) {
    await new Promise((resolvePromise, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`CDP WebSocket 连接超时：${this.wsUrl}`));
      }, timeoutMs);

      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolvePromise();
      });
      ws.addEventListener("error", (event) => {
        clearTimeout(timer);
        reject(new Error(`CDP WebSocket 错误：${event?.message ?? "connection failed"}`));
      });
      ws.addEventListener("message", (event) => {
        const msg = JSON.parse(String(event.data));
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) rej(new Error(`CDP ${msg.error.code}: ${msg.error.message}`));
          else res(msg.result);
        }
      });
      ws.addEventListener("close", () => {
        for (const { reject: rej } of this.pending.values()) {
          rej(new Error("CDP 连接已关闭"));
        }
        this.pending.clear();
      });
    });
  }

  send(method, params = {}, timeoutMs = 30_000) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`CDP 未连接，无法调用 ${method}`));
    }
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolvePromise(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}

/** 构造最小化启动桌面端的命令，返回其真实 PID */
async function launchDesktopMinimized({ exePath, cdpPort, env }) {
  const switchArg = `--edge-webview-switches=--remote-debugging-port=${cdpPort}`;
  if (process.platform === "win32") {
    const psQuote = (s) => `'${String(s).replaceAll("'", "''")}'`;
    const cmd = `$p = Start-Process -FilePath ${psQuote(exePath)} -ArgumentList ${psQuote(switchArg)} -WindowStyle Minimized -PassThru; Write-Output $p.Id`;
    const launcher = spawn("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", cmd], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    launcher.stdout.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    launcher.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
    });
    const code = await new Promise((res, rej) => {
      launcher.once("error", rej);
      launcher.once("exit", res);
    });
    const pid = Number.parseInt(stdout.trim(), 10);
    if (code !== 0 || !Number.isInteger(pid) || pid <= 0) {
      throw new Error(`启动桌面端失败（exit ${code}）：${stderr.trim() || stdout.trim()}`);
    }
    return pid;
  }

  const child = spawn(exePath, [switchArg], {
    env,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  if (!child.pid) throw new Error("启动桌面端失败：未能获取 PID");
  return child.pid;
}

/** 列出某父 PID 的直接子进程 PID（用于确认后台 nctrn rpc 子进程全部停止） */
async function listChildPids(parentPid) {
  if (process.platform !== "win32" || !Number.isInteger(parentPid)) return [];
  const cmd = `Get-CimInstance Win32_Process -Filter "ParentProcessId = ${parentPid}" | Select-Object -ExpandProperty ProcessId`;
  const proc = spawn("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", cmd], {
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  let out = "";
  proc.stdout.on("data", (d) => {
    out += d.toString("utf8");
  });
  await new Promise((r) => {
    proc.once("error", r);
    proc.once("exit", r);
  });
  return out
    .split(/\r?\n/)
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

/** 等待 Vite 开发服务器就绪 */
async function waitForHttpOk(url, timeoutMs, isExited) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isExited()) throw new Error("Vite 开发服务器在就绪前意外退出");
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch {
      /* keep polling */
    }
    await delay(250);
  }
  throw new Error(`等待前端开发服务器超时：${url}`);
}

/** 等待 CDP 暴露桌面主页面目标 */
async function waitForCdpTarget(cdpPort, expectedPrefix, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        const targets = await res.json();
        const match = targets.find(
          (t) =>
            t.type === "page" &&
            typeof t.webSocketDebuggerUrl === "string" &&
            (!expectedPrefix || String(t.url ?? "").startsWith(expectedPrefix)),
        );
        if (match) return match;
      }
    } catch {
      /* keep polling */
    }
    await delay(300);
  }
  throw new Error(`等待 CDP 页面目标超时（端口 ${cdpPort}）`);
}

function createStepHelpers(cdp, { width, height, recordedShots }) {
  const evalInPage = async (exprOrFn, ...args) => {
    const expression =
      typeof exprOrFn === "function"
        ? `(${exprOrFn.toString()})(${args.map((a) => JSON.stringify(a)).join(", ")})`
        : String(exprOrFn);
    const res = await cdp.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      const desc =
        res.exceptionDetails.exception?.description ||
        res.exceptionDetails.text ||
        "页面脚本执行失败";
      throw new Error(`eval 失败：${desc}`);
    }
    return res.result?.value;
  };

  const queryDomReady = async (selector) => {
    if (selector.startsWith("text=")) {
      const needle = selector.slice("text=".length);
      return evalInPage((text) => {
        const isVisible = (el) => {
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return false;
          const style = getComputedStyle(el);
          return style.visibility !== "hidden" && style.display !== "none";
        };
        const all = Array.from(document.querySelectorAll("*")).filter(
          (el) => isVisible(el) && (el.textContent ?? "").includes(text),
        );
        return all.length > 0;
      }, needle);
    }
    return evalInPage((sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }, selector);
  };

  const waitFor = async (target, { timeout = 15_000, interval = 100 } = {}) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const ok =
        typeof target === "function"
          ? Boolean(await target())
          : await queryDomReady(String(target));
      if (ok) return true;
      await delay(interval);
    }
    throw new Error(
      `waitFor 超时（${timeout}ms）：${typeof target === "function" ? "[fn]" : target}`,
    );
  };

  const click = async (selector, { timeout = 15_000 } = {}) => {
    await waitFor(selector, { timeout });
    const clicked = await evalInPage((sel) => {
      const isVisible = (el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = getComputedStyle(el);
        return style.visibility !== "hidden" && style.display !== "none";
      };
      let el = null;
      if (sel.startsWith("text=")) {
        const needle = sel.slice("text=".length);
        const interactive = Array.from(
          document.querySelectorAll(
            'button, a, [role="button"], [role="tab"], [role="menuitem"], [role="option"], [role="listitem"], label, [tabindex]',
          ),
        ).filter(isVisible);
        el =
          interactive.find((n) => (n.textContent ?? "").trim() === needle) ??
          interactive.find((n) => (n.textContent ?? "").includes(needle)) ??
          null;
        if (!el) {
          const leaves = Array.from(document.querySelectorAll("*")).filter(
            (n) =>
              isVisible(n) && n.children.length === 0 && (n.textContent ?? "").includes(needle),
          );
          el = leaves[0] ?? null;
        }
      } else {
        el = document.querySelector(sel);
      }
      if (!el) return false;
      el.scrollIntoView({ block: "center", inline: "center" });
      el.click();
      return true;
    }, selector);
    if (!clicked) throw new Error(`click 未找到目标元素：${selector}`);
  };

  const shot = async (outputPath, options = {}) => {
    if (!outputPath || typeof outputPath !== "string") {
      throw new Error("shot(<绝对路径>) 必须传入有效文件路径");
    }
    const resolvedPath = isAbsolute(outputPath) ? outputPath : resolve(outputPath);
    mkdirSync(dirname(resolvedPath), { recursive: true });

    // 等字体和两帧渲染稳定后再截
    await evalInPage(async () => {
      if (document.fonts?.ready) await document.fonts.ready;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    });

    const params = {
      format: "png",
      captureBeyondViewport: false,
      ...(options.clip ? { clip: options.clip } : {}),
    };
    const { data } = await cdp.send("Page.captureScreenshot", params);
    const buffer = Buffer.from(data, "base64");
    writeFileSync(resolvedPath, buffer);

    if (!existsSync(resolvedPath)) {
      throw new Error(`截图写入后文件不存在：${resolvedPath}`);
    }
    const sizeBytes = statSync(resolvedPath).size;
    const dims = parsePngDimensions(readFileSync(resolvedPath));
    if (!options.clip && (dims.width !== width || dims.height !== height)) {
      throw new Error(
        `截图尺寸不符合视口预期：实际 ${dims.width}x${dims.height}，预期 ${width}x${height}（${resolvedPath}）`,
      );
    }

    const record = { path: resolvedPath, width: dims.width, height: dims.height, bytes: sizeBytes };
    recordedShots.push(record);
    console.log(`SHOT OK ${resolvedPath} (${dims.width}x${dims.height}, ${sizeBytes} bytes)`);
    return record;
  };

  return {
    eval: evalInPage,
    evaluate: evalInPage,
    click,
    waitFor,
    shot,
    cdp,
  };
}

export async function runShot(argv = process.argv.slice(2), repoRoot = defaultRepoRoot) {
  const opts = parseShotArgs(argv);
  if (opts.help) {
    console.log(
      "用法: pnpm shot --home <隔离目录> --steps <步骤脚本.mjs> [选项]\n" +
        "  --home <目录>      必填，作为隔离的 NOCTURNE_HOME（禁止为真实 ~/.nocturne 或其子目录）\n" +
        "  --fixture <目录>   可选，启动前将其内容复制到 --home\n" +
        "  --port <端口>      可选，CDP 远程调试端口（默认自动选空闲端口）\n" +
        "  --size <宽x高>     视口尺寸，默认 1440x900\n" +
        "  --theme light|dark 可选，强制设置桌面端主题与 prefers-color-scheme\n" +
        "  --steps <脚本>     必填，ES 模块，默认导出 async ({ eval, click, waitFor, shot }) => {}\n" +
        "  --exe <路径>       调试版桌面 exe，默认取 $CARGO_TARGET_DIR/debug/nocturne-desktop.exe\n" +
        "  --no-vite          不启动内置 Vite（仅在 --exe 已内嵌静态前端时使用）",
    );
    return 0;
  }

  const homeDir = assertSafeHomeDir(opts.home);
  if (!opts.steps) throw new Error("必须指定 --steps <脚本文件>");
  const stepsPath = resolve(opts.steps);
  if (!existsSync(stepsPath)) throw new Error(`--steps 脚本不存在：${stepsPath}`);

  const exePath = resolve(opts.exe);
  if (!existsSync(exePath)) {
    throw new Error(
      `调试版桌面端不存在：${exePath}\n` +
        `请先构建：TAURI_CONFIG='{"bundle":{"resources":null}}' cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml`,
    );
  }

  const backendPath = resolve(
    process.env.NOCTURNE_DESKTOP_BACKEND?.trim() ||
      join(repoRoot, "apps", "cli", "dist", "main.js"),
  );
  if (!existsSync(backendPath)) {
    throw new Error(`后台脚本不存在：${backendPath}（请先运行 pnpm build）`);
  }

  if (opts.fixture) {
    const fixtureDir = resolve(opts.fixture);
    if (!existsSync(fixtureDir) || !statSync(fixtureDir).isDirectory()) {
      throw new Error(`--fixture 目录不存在：${fixtureDir}`);
    }
    mkdirSync(homeDir, { recursive: true });
    cpSync(fixtureDir, homeDir, { recursive: true, force: true });
  } else {
    mkdirSync(homeDir, { recursive: true });
  }

  const webviewDataDir = join(homeDir, "webview2");
  mkdirSync(webviewDataDir, { recursive: true });

  // 校验 CDP 端口空闲或自动分配
  let cdpPort = opts.port;
  if (cdpPort !== undefined) {
    if (!(await isLocalPortFree(cdpPort))) {
      throw new Error(`指定的 CDP 端口 ${cdpPort} 已被占用，请更换空闲端口`);
    }
  } else {
    cdpPort = await unusedFetchSafePort();
  }

  const cleanEnv = stripProxyEnv(process.env);
  delete cleanEnv.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS;

  let viteProc = null;
  let viteExited = false;
  let viteLog = "";
  let appPid = null;
  let cdp = null;
  const recordedShots = [];

  const cleanup = async () => {
    cdp?.close();
    cdp = null;
    if (appPid) {
      const childPids = await listChildPids(appPid).catch(() => []);
      await killPidTree(appPid).catch(() => undefined);
      for (const childPid of childPids) {
        await killPidTree(childPid).catch(() => undefined);
      }
      appPid = null;
    }
    if (viteProc?.pid) {
      await killPidTree(viteProc.pid).catch(() => undefined);
      viteProc = null;
    }
  };

  const onSignal = () => {
    void cleanup().finally(() => process.exit(130));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    if (!opts.noVite) {
      // 调试版桌面端 devUrl 固定为 http://localhost:31420；若被占用绝不复用已有服务
      if (!(await isLocalPortFree(DEV_VITE_PORT))) {
        throw new Error(
          `端口 ${DEV_VITE_PORT} 已被占用（可能正在运行 pnpm dev）。` +
            `为避免误连或干扰已有服务，pnpm shot 拒绝复用；请停止占用该端口的服务后再试。`,
        );
      }

      const viteArgs = [
        "--dir",
        "apps/desktop",
        "exec",
        "vite",
        "--port",
        String(DEV_VITE_PORT),
        "--strictPort",
      ];
      viteProc =
        process.platform === "win32"
          ? spawn("cmd.exe", ["/c", "pnpm", ...viteArgs], {
              cwd: repoRoot,
              env: cleanEnv,
              stdio: ["ignore", "pipe", "pipe"],
              windowsHide: true,
            })
          : spawn("pnpm", viteArgs, {
              cwd: repoRoot,
              env: cleanEnv,
              stdio: ["ignore", "pipe", "pipe"],
            });

      viteProc.stdout.on("data", (d) => {
        viteLog += d.toString("utf8");
      });
      viteProc.stderr.on("data", (d) => {
        viteLog += d.toString("utf8");
      });
      viteProc.once("exit", () => {
        viteExited = true;
      });

      await waitForHttpOk(`http://localhost:${DEV_VITE_PORT}/`, 30_000, () => viteExited);
    }

    const appEnv = {
      ...cleanEnv,
      NOCTURNE_HOME: homeDir,
      WEBVIEW2_USER_DATA_FOLDER: webviewDataDir,
      NOCTURNE_DESKTOP_BACKEND: backendPath,
    };

    appPid = await launchDesktopMinimized({ exePath, cdpPort, env: appEnv });
    const expectedOrigin = opts.noVite
      ? "http://tauri.localhost"
      : `http://localhost:${DEV_VITE_PORT}`;
    const target = await waitForCdpTarget(cdpPort, expectedOrigin, 30_000);

    cdp = new CdpClient(target.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: opts.size.width,
      height: opts.size.height,
      deviceScaleFactor: 1,
      mobile: false,
    });

    const helpers = createStepHelpers(cdp, {
      width: opts.size.width,
      height: opts.size.height,
      recordedShots,
    });

    // 等应用首次挂载 #root
    await helpers.waitFor(
      async () =>
        helpers.eval(() => {
          const root = document.getElementById("root");
          return Boolean(root && root.childElementCount > 0);
        }),
      { timeout: 30_000 },
    );

    // 写入主题与关闭自动更新，必要时重载让 React prefs 状态同步
    if (opts.theme) {
      await cdp.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: opts.theme }],
      });
    }
    const needsReload = await helpers.eval((theme) => {
      const key = "nocturne.desktop.prefs.v1";
      let prefs = {};
      try {
        prefs = JSON.parse(localStorage.getItem(key) || "{}") || {};
      } catch {
        prefs = {};
      }
      const next = { ...prefs, autoUpdate: false };
      if (theme) next.theme = theme;
      const changed = JSON.stringify(prefs) !== JSON.stringify(next);
      localStorage.setItem(key, JSON.stringify(next));
      if (theme) document.documentElement.dataset.theme = theme;
      return changed;
    }, opts.theme ?? null);

    if (needsReload) {
      await cdp.send("Page.reload", { ignoreCache: false });
      await delay(400);
      await helpers.waitFor(
        async () =>
          helpers.eval(() => {
            const root = document.getElementById("root");
            return Boolean(root && root.childElementCount > 0);
          }),
        { timeout: 30_000 },
      );
      if (opts.theme) {
        await cdp.send("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: opts.theme }],
        });
      }
    }

    const mod = await import(pathToFileURL(stepsPath).href);
    if (typeof mod.default !== "function") {
      throw new Error(`--steps 模块必须默认导出一个 async 函数：${stepsPath}`);
    }
    await mod.default(helpers);

    if (recordedShots.length === 0) {
      throw new Error("steps 脚本已执行完毕，但未调用 shot() 生成任何截图");
    }

    return 0;
  } catch (error) {
    if (viteLog.trim() && !opts.noVite) {
      console.error("--- Vite 输出尾部 ---");
      console.error(viteLog.split(/\r?\n/).slice(-15).join("\n"));
    }
    throw error;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await cleanup();
  }
}

const isMain =
  process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);

if (isMain) {
  runShot()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
