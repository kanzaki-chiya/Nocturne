import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPlatform } from "./platform.js";
import type { PipeProcess } from "./process.js";
import { createProcessCleanup, removeTempDirs } from "../../../../scripts/test/process-cleanup.mjs";

const processes = createProcessCleanup();
const platform = processes.platform(createPlatform());
let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "nctrn-pipe-"));
});
afterEach(async () => {
  await processes.cleanup();
  await removeTempDirs([root]);
});

async function text(proc: PipeProcess): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of proc.stdoutRaw) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

describe("spawnPipe 的协议消费者边界", () => {
  it("wait 仍等 close，exited 独立于后代管道，detachOutput 有界结束读取", async () => {
    const pidFile = path.join(root, "child.pid");
    processes.watchPidFile(pidFile);
    const proc = platform.process.spawnPipe(process.execPath, [
      "-e",
      [
        'const {spawn}=require("node:child_process");',
        'const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"inherit"});',
        `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
        "console.log(child.pid); process.exit(3);",
      ].join(""),
    ]);
    let raw = "";
    const reading = (async () => {
      for await (const chunk of proc.stdoutRaw) raw += chunk.toString("utf8");
    })();
    const exit = await proc.exited();
    expect(exit.code).toBe(3);
    let closed = false;
    void proc.wait().then(() => {
      closed = true;
    });
    await vi.waitFor(() => expect(raw.trim()).toMatch(/^\d+$/), { timeout: 5_000, interval: 10 });
    // Windows 的管道 close 不保证等待继承句柄的后代；POSIX 才有此阻塞场景。
    if (process.platform !== "win32") expect(closed).toBe(false);
    const child = Number(raw.trim());
    try {
      await proc.kill();
      proc.detachOutput();
      await reading;
      if (process.platform !== "win32") {
        await vi.waitFor(() => expect(platform.processAlive(child)).toBe(false), {
          timeout: 2_000,
        });
      }
    } finally {
      // Windows 根已退出后不能用 taskkill /T 再找它的树；测试显式收回这个孤儿。
      try {
        process.kill(child, "SIGKILL");
      } catch {
        /* already stopped */
      }
    }
  });

  it("退出后写 stdin 的异步 EPIPE 不成为未处理错误", async () => {
    const proc = platform.process.spawnPipe(process.execPath, ["-e", "process.exit(0)"]);
    await proc.exited();
    expect(() => {
      proc.stdin.write("late protocol write\n");
      proc.stdin.end();
    }).not.toThrow();
    await proc.wait();
  });

  it.runIf(process.platform === "win32")(
    "PATH/PATHEXT 将 npx 解析为 npx.cmd（同名无扩展名脚本不抢先）；cmd/bat 空格/引号/元字符不变成命令",
    async () => {
      const directory = path.join(root, "shim directory");
      await fs.mkdir(directory);
      await fs.writeFile(
        path.join(directory, "args.mjs"),
        "console.log(JSON.stringify(process.argv.slice(2)));\n",
      );
      const wrapper = `@echo off\r\n"${process.execPath}" "%~dp0args.mjs" %*\r\n`;
      // npm 全局目录里与 npx.cmd 并存的 Git Bash 脚本：不能先于 .cmd 命中。
      await fs.writeFile(path.join(directory, "npx"), '#!/bin/sh\nexec node "$0" "$@"\n');
      await fs.writeFile(path.join(directory, "npx.cmd"), wrapper);
      await fs.writeFile(path.join(directory, "other.bat"), wrapper);
      const values = [
        "ordinary",
        "two words",
        'embedded"quote',
        "trailing\\",
        "a&b|c<d>e",
        "(paren)",
        "^caret",
        "%NOCTURNE_PIPE_TEST%",
        "!literal!",
        "中文",
      ];
      for (const command of ["npx", "npx.cmd", "other", path.join(directory, "npx.cmd")]) {
        const proc = platform.process.spawnPipe(command, values, {
          cwd: root,
          env: {
            PATH: `${directory}${path.delimiter}${process.env.PATH ?? ""}`,
            PATHEXT: ".CMD;.BAT;.EXE",
            NOCTURNE_PIPE_TEST: "do-not-expand",
          },
        });
        const output = await text(proc);
        expect((await proc.wait()).code).toBe(0);
        expect(JSON.parse(output)).toEqual(values);
      }
    },
  );
});

describe.runIf(process.platform === "win32")("Windows spawnPipe 不从 cwd 找裸命令", () => {
  const name = "nocturne-cwd-tool";
  const marker = () => path.join(root, "launched-from-cwd.txt");
  beforeEach(async () => {
    // 工作区里的同名脚本：一旦被执行就留下标记文件。
    await fs.writeFile(
      path.join(root, `${name}.cmd`),
      `@echo off\r\necho cwd\r\necho cwd> "%~dp0launched-from-cwd.txt"\r\n`,
    );
  });

  it("cwd 与 PATH 都有同名 cmd 时执行 PATH 里的那个", async () => {
    const bin = path.join(root, "bin");
    await fs.mkdir(bin);
    await fs.writeFile(path.join(bin, `${name}.cmd`), "@echo off\r\necho path\r\n");
    const proc = platform.process.spawnPipe(name, [], {
      cwd: root,
      env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, PATHEXT: ".CMD;.EXE" },
    });
    expect((await text(proc)).trim()).toBe("path");
    expect((await proc.wait()).code).toBe(0);
    expect(await platform.fs.exists(marker())).toBe(false);
  });

  it("只有 cwd 有同名 cmd 时按找不到命令结算，且不启动它", async () => {
    const proc = platform.process.spawnPipe(name, [], {
      cwd: root,
      env: { PATH: process.env.PATH ?? "", PATHEXT: ".CMD;.EXE" },
    });
    expect(proc.pid).toBe(-1);
    expect(await text(proc)).toBe("");
    expect(await proc.wait()).toMatchObject({ code: null, signal: null });
    expect(await platform.fs.exists(marker())).toBe(false);
  });

  it("显式相对路径仍按 cwd 解析并启动", async () => {
    for (const command of [`.\\${name}.cmd`, `./${name}`]) {
      await fs.rm(marker(), { force: true });
      const proc = platform.process.spawnPipe(command, [], {
        cwd: root,
        env: { PATH: process.env.PATH ?? "", PATHEXT: ".CMD;.EXE" },
      });
      expect((await text(proc)).trim()).toBe("cwd");
      expect((await proc.wait()).code).toBe(0);
      expect(await platform.fs.exists(marker())).toBe(true);
    }
  });
});

describe("spawnPipe minimal 代理变量", () => {
  async function withHostEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>) {
    const saved = new Map<string, string | undefined>();
    for (const key of Object.keys(vars)) saved.set(key, process.env[key]);
    try {
      for (const [key, value] of Object.entries(vars)) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await fn();
    } finally {
      for (const [key, value] of saved) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  async function childEnv(
    names: string[],
    options?: { env?: Record<string, string> },
  ): Promise<Record<string, string | null>> {
    const script = `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(names)}.map((k) => [k, process.env[k] ?? null]))))`;
    const proc = platform.process.spawnPipe(process.execPath, ["-e", script], {
      envMode: "minimal",
      ...options,
    });
    const output = await text(proc);
    expect((await proc.wait()).code).toBe(0);
    return JSON.parse(output) as Record<string, string | null>;
  }

  it("minimal 透传宿主代理变量（含用户名密码），仍隔离 *_KEY", async () => {
    await withHostEnv(
      {
        HTTPS_PROXY: "http://user:pass@proxy.test:8080",
        HTTP_PROXY: "http://proxy.test:8080",
        ALL_PROXY: "socks5://proxy.test:1080",
        NO_PROXY: "localhost,127.0.0.1",
        NOCTURNE_TEST_FAKE_KEY: "secret",
      },
      async () => {
        const env = await childEnv([
          "HTTPS_PROXY",
          "HTTP_PROXY",
          "ALL_PROXY",
          "NO_PROXY",
          "NOCTURNE_TEST_FAKE_KEY",
        ]);
        expect(env.HTTPS_PROXY).toBe("http://user:pass@proxy.test:8080");
        expect(env.HTTP_PROXY).toBe("http://proxy.test:8080");
        expect(env.ALL_PROXY).toBe("socks5://proxy.test:1080");
        expect(env.NO_PROXY).toBe("localhost,127.0.0.1");
        expect(env.NOCTURNE_TEST_FAKE_KEY).toBeNull();
      },
    );
  });

  it("env 显式同名变量覆盖宿主值", async () => {
    await withHostEnv({ HTTPS_PROXY: "http://host.test:8080" }, async () => {
      const env = await childEnv(["HTTPS_PROXY"], {
        env: { HTTPS_PROXY: "http://override.test:9090" },
      });
      expect(env.HTTPS_PROXY).toBe("http://override.test:9090");
    });
  });

  it.runIf(process.platform !== "win32")("POSIX 小写代理变量同样透传", async () => {
    await withHostEnv(
      {
        http_proxy: "http://proxy.test:8080",
        https_proxy: "http://proxy.test:8443",
        all_proxy: "socks5://proxy.test:1080",
        no_proxy: "localhost",
      },
      async () => {
        const env = await childEnv(["http_proxy", "https_proxy", "all_proxy", "no_proxy"]);
        expect(env.http_proxy).toBe("http://proxy.test:8080");
        expect(env.https_proxy).toBe("http://proxy.test:8443");
        expect(env.all_proxy).toBe("socks5://proxy.test:1080");
        expect(env.no_proxy).toBe("localhost");
      },
    );
  });
});

describe("进程树终止", () => {
  // 回归：Windows 的 taskkill 自身启动就要约 2 秒，旧实现 2 秒即把它杀掉，根、子、孙全部遗留。
  it(
    "kill() 返回时根、子、孙进程都已不存在（按进程是否存在判断）",
    { timeout: 30_000 },
    async () => {
      const pidFile = path.join(root, "tree.json");
      processes.watchPidFile(pidFile);
      const grandchild = "setInterval(()=>{},1000)";
      const child = [
        'const {spawn}=require("node:child_process");',
        `const g=spawn(process.execPath,["-e",${JSON.stringify(grandchild)}],{stdio:"ignore"});`,
        "console.log(JSON.stringify({child:process.pid,grandchild:g.pid}));",
        "setInterval(()=>{},1000);",
      ].join("");
      const rootScript = [
        'const {spawn}=require("node:child_process");',
        `const c=spawn(process.execPath,["-e",${JSON.stringify(child)}],{stdio:["ignore","pipe","ignore"]});`,
        'c.stdout.on("data",(d)=>{',
        "const {child,grandchild}=JSON.parse(String(d).trim());",
        `require("node:fs").writeFileSync(${JSON.stringify(pidFile)},JSON.stringify({root:process.pid,child,grandchild}));`,
        "});",
        "setInterval(()=>{},1000);",
      ].join("");
      const proc = platform.process.spawnPipe(process.execPath, ["-e", rootScript]);
      let pids: { root: number; child: number; grandchild: number } | undefined;
      await vi.waitFor(
        async () => {
          pids = JSON.parse(await fs.readFile(pidFile, "utf8")) as typeof pids;
          expect(pids?.grandchild).toBeGreaterThan(0);
        },
        { timeout: 10_000, interval: 20 },
      );
      if (pids === undefined) throw new Error("pid 文件未写出");
      const { root: rootPid, child: childPid, grandchild: grandchildPid } = pids;
      for (const pid of [rootPid, childPid, grandchildPid])
        expect(platform.processAlive(pid)).toBe(true);
      await proc.kill();
      proc.detachOutput();
      // kill() 已等 taskkill 结束；容许操作系统几十毫秒内完成句柄回收，但不靠放宽超时掩盖漏杀
      await vi.waitFor(
        () => {
          for (const pid of [rootPid, childPid, grandchildPid])
            expect(platform.processAlive(pid), `pid ${pid}`).toBe(false);
        },
        { timeout: 1_000, interval: 20 },
      );
    },
  );
});

describe("宿主注入的环境变量不进子进程", () => {
  const script =
    "process.stdout.write(JSON.stringify([process.env.NODE_ENV ?? null, process.env.NOCTURNE_HOST_INJECTED_ENV ?? null, process.env.NOCTURNE_TEST_KEEP ?? null]))";

  async function viaSpawn(env?: Record<string, string>): Promise<unknown> {
    const proc = platform.process.spawn(process.execPath, ["-e", script], env ? { env } : {});
    let out = "";
    for await (const chunk of proc.stdout) out += chunk;
    expect((await proc.wait()).code).toBe(0);
    return JSON.parse(out);
  }
  async function viaPipe(env?: Record<string, string>): Promise<unknown> {
    const proc = platform.process.spawnPipe(process.execPath, ["-e", script], env ? { env } : {});
    expect((await proc.wait()).code).toBe(0);
    return JSON.parse(await text(proc));
  }

  it.each([
    ["spawn", viaSpawn],
    ["spawnPipe", viaPipe],
  ])("%s：登记的 NODE_ENV 与登记变量本身都被剔除，其余原样继承", async (_name, run) => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NOCTURNE_HOST_INJECTED_ENV", "NODE_ENV");
    vi.stubEnv("NOCTURNE_TEST_KEEP", "yes");
    try {
      expect(await run()).toEqual([null, null, "yes"]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    ["spawn", viaSpawn],
    ["spawnPipe", viaPipe],
  ])("%s：用户自己设置的 NODE_ENV（未登记）原样保留", async (_name, run) => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NOCTURNE_HOST_INJECTED_ENV", undefined);
    try {
      expect(await run()).toEqual(["development", null, null]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("登记多个变量（逗号分隔、忽略空白）；调用方显式传入的 env 优先", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NOCTURNE_TEST_KEEP", "injected");
    vi.stubEnv("NOCTURNE_HOST_INJECTED_ENV", " NODE_ENV , NOCTURNE_TEST_KEEP ");
    try {
      expect(await viaSpawn()).toEqual([null, null, null]);
      expect(await viaSpawn({ NODE_ENV: "test" })).toEqual(["test", null, null]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
