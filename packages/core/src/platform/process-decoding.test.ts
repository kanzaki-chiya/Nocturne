import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createProcessRunner, decodeOutput } from "./process.js";

function decoder(label = "gbk", forced = false) {
  const stream = new PassThrough();
  const chunks: string[] = [];
  const done = (async () => {
    for await (const text of decodeOutput(stream, Promise.resolve({ label, forced })))
      chunks.push(text);
  })();
  return { stream, chunks, done };
}

describe("子进程逐行输出解码", () => {
  it("同一流逐行区分 UTF-8 与 GBK，保留 CRLF", async () => {
    const { stream, chunks, done } = decoder();
    stream.end(
      Buffer.concat([
        Buffer.from("UTF8中文\r\n"),
        Buffer.from([0x47, 0x42, 0x4b, 0xd6, 0xd0, 0xce, 0xc4, 0x0a]),
        Buffer.from("ASCII\n"),
      ]),
    );
    await done;
    expect(chunks).toEqual(["UTF8中文\r\n", "GBK中文\n", "ASCII\n"]);
  });

  it("跨块截断的 UTF-8 字符等待下一块，stdout/stderr 状态独立", async () => {
    const stdout = decoder();
    const stderr = decoder();
    const bytes = Buffer.from("中文\n");
    stdout.stream.write(bytes.subarray(0, 2));
    stderr.stream.end(Buffer.from([0xd6, 0xd0, 0x0a]));
    stdout.stream.end(bytes.subarray(2));
    await Promise.all([stdout.done, stderr.done]);
    expect(stdout.chunks.join("")).toBe("中文\n");
    expect(stderr.chunks.join("")).toBe("中\n");
  });

  it("无换行尾巴空闲 50ms 后上报；大于 8KB 时立即上报并保留 UTF-8 截断后缀", async () => {
    const idle = decoder();
    idle.stream.write("短尾巴");
    await vi.waitFor(() => expect(idle.chunks.join("")).toBe("短尾巴"));
    idle.stream.end();
    await idle.done;

    const long = decoder();
    long.stream.write(Buffer.concat([Buffer.from("x".repeat(8193)), Buffer.from([0xe4, 0xb8])]));
    await vi.waitFor(() => expect(long.chunks.join("")).toBe("x".repeat(8193)));
    long.stream.end(Buffer.from([0xad, 0x0a]));
    await long.done;
    expect(long.chunks.join("")).toBe(`${"x".repeat(8193)}中\n`);
  });

  it("显式编码覆盖不识别 UTF-8；探测到 UTF-8 保持原有逐块语义", async () => {
    const forced = decoder("gbk", true);
    forced.stream.end(Buffer.from("中文\n"));
    await forced.done;
    expect(forced.chunks.join("")).toBe(new TextDecoder("gbk").decode(Buffer.from("中文\n")));

    const utf8 = decoder("utf-8");
    utf8.stream.write(Buffer.from("中文"));
    await vi.waitFor(() => expect(utf8.chunks.join("")).toBe("中文"));
    utf8.stream.end();
    await utf8.done;
  });

  it("流结束时解码剩余字节", async () => {
    const output = decoder();
    output.stream.end(Buffer.from([0xd6, 0xd0]));
    await output.done;
    expect(output.chunks).toEqual(["中"]);
  });

  it.runIf(process.platform === "win32")("真实 cmd 管道中的 Node UTF-8 中文输出", async () => {
    const runner = createProcessRunner();
    const proc = runner.spawnShell(
      'node -e "process.stdout.write(\'UTF8中文\\n\')" 2>&1 | findstr /n "^"',
    );
    let output = "";
    for await (const text of proc.stdout) output += text;
    const exit = await proc.wait();
    expect(exit.code).toBe(0);
    expect(output).toContain("UTF8中文");
  });
});

describe("detachOutput 与流销毁收尾", () => {
  const tmpDirs: string[] = [];
  const orphanPids: number[] = [];

  afterEach(async () => {
    // 先杀孤儿再等其消失（Windows 上进程持有的 cwd 句柄会锁临时目录）；
    // 除登记 PID 外扫描本组临时目录中的 orphan.pid，覆盖 waitFor/断言
    // 在登记前失败的路径，不留后台进程
    const pids = new Set(orphanPids.splice(0));
    for (const dir of tmpDirs) {
      const pidFile = path.join(dir, "orphan.pid");
      if (!existsSync(pidFile)) continue;
      const pid = Number(readFileSync(pidFile, "utf8"));
      if (Number.isInteger(pid) && pid > 0) pids.add(pid);
    }
    for (const pid of pids) {
      if (process.platform === "win32") {
        await new Promise<void>((resolve) => {
          const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          });
          killer.once("exit", () => resolve());
          killer.once("error", () => resolve());
        });
      } else {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // 已退出
        }
      }
      for (let i = 0; i < 50; i++) {
        try {
          process.kill(pid, 0);
        } catch {
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    for (const dir of tmpDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });

  it("流销毁（detach）后已捕获的 UTF-8/GBK 行与截断尾巴按原规则冲刷并结束", async () => {
    const d = decoder(); // gbk 非强制：整段先按 fatal UTF-8 探测
    d.stream.write(Buffer.from("UTF8中文\n"));
    d.stream.write(Buffer.from([0xd6, 0xd0, 0x0a])); // GBK「中\n」
    d.stream.write(Buffer.from([0xe4, 0xb8])); // UTF-8「中」的截断尾巴
    d.stream.destroy(); // destroy 只发 close，不发 end/error
    await d.done;
    expect(d.chunks.length).toBe(3);
    expect(d.chunks[0]).toBe("UTF8中文\n");
    expect(d.chunks[1]).toBe("中\n");
    // 截断尾巴在收尾时经回退编码解码（与正常 end 路径相同）
    expect(d.chunks[2]).toBe(new TextDecoder("gbk").decode(Buffer.from([0xe4, 0xb8])));
  });

  it("UTF-8 流式路径下流销毁同样收尾：尾巴经 TextDecoder 冲刷", async () => {
    const d = decoder("utf-8");
    d.stream.write(Buffer.from("OK\n"));
    d.stream.write(Buffer.from([0xe4, 0xb8]));
    d.stream.destroy();
    await d.done;
    // 截断的多字节尾巴经 TextDecoder 收尾冲刷为替换字符
    expect(d.chunks[0]).toBe("OK\n");
    expect(d.chunks[1]).toBe(new TextDecoder("utf-8").decode(Buffer.from([0xe4, 0xb8])));
    expect(d.chunks.length).toBe(2);
  });

  it("spawnShell 在 shell 本体 exit 时结算；detachOutput 幂等收尾被占用的管道", async () => {
    // parent 派生 detached 孙进程（继承输出管道、长期存活）后退出：
    // shell 进程退出但管道仍被孙进程持有
    const dir = mkdtempSync(path.join(tmpdir(), "nct-detach-"));
    tmpDirs.push(dir);
    writeFileSync(path.join(dir, "orphan.js"), "setInterval(()=>{},1000);\n");
    writeFileSync(
      path.join(dir, "parent.js"),
      `const {spawn}=require("node:child_process");
const fs=require("node:fs");
const c=spawn(process.execPath,["orphan.js"],{cwd:__dirname,detached:true,stdio:["ignore","inherit","inherit"],windowsHide:true});
c.unref();
fs.writeFileSync(${JSON.stringify(path.join(dir, "orphan.pid"))},String(c.pid));
process.stdout.write("READY\\n");`,
    );
    const runner = createProcessRunner();
    const proc = runner.spawnShell(`${JSON.stringify(process.execPath)} parent.js`, { cwd: dir });
    let text = "";
    const done = (async () => {
      for await (const chunk of proc.stdout) text += chunk;
    })();
    try {
      const pidFile = path.join(dir, "orphan.pid");
      await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), {
        timeout: 10_000,
        interval: 50,
      });
      orphanPids.push(Number(readFileSync(pidFile, "utf8")));
      // 管道仍被孙进程占用，但 wait 已在 shell exit 时结算
      const exit = await Promise.race([
        proc.wait(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
      ]);
      expect(exit?.code).toBe(0);
      expect(text).toContain("READY\n");
      proc.detachOutput();
      proc.detachOutput(); // 幂等：重复调用不抛错
      await done;
      expect(text).toBe("READY\n");
    } finally {
      await proc.kill().catch(() => undefined);
    }
  });
});
