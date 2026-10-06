import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPlatform } from "./platform.js";
import type { PipeProcess } from "./process.js";

const platform = createPlatform();
const processes: PipeProcess[] = [];
let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "nctrn-pipe-"));
});
afterEach(async () => {
  for (const proc of processes.splice(0)) {
    await proc.kill();
    proc.detachOutput();
  }
  await fs.rm(root, { recursive: true, force: true });
});

async function text(proc: PipeProcess): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of proc.stdoutRaw) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

describe("spawnPipe 的协议消费者边界", () => {
  it("wait 仍等 close，exited 独立于后代管道，detachOutput 有界结束读取", async () => {
    const proc = platform.process.spawnPipe(process.execPath, [
      "-e",
      [
        'const {spawn}=require("node:child_process");',
        'const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"inherit"});',
        "console.log(child.pid); process.exit(3);",
      ].join(""),
    ]);
    processes.push(proc);
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
    processes.push(proc);
    await proc.exited();
    expect(() => {
      proc.stdin.write("late protocol write\n");
      proc.stdin.end();
    }).not.toThrow();
    await proc.wait();
  });

  it.runIf(process.platform === "win32")(
    "PATH/PATHEXT 将 npx 解析为 npx.cmd；cmd/bat 空格/引号/元字符不变成命令",
    async () => {
      const directory = path.join(root, "shim directory");
      await fs.mkdir(directory);
      await fs.writeFile(
        path.join(directory, "args.mjs"),
        "console.log(JSON.stringify(process.argv.slice(2)));\n",
      );
      const wrapper = `@echo off\r\n"${process.execPath}" "%~dp0args.mjs" %*\r\n`;
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
        processes.push(proc);
        const output = await text(proc);
        expect((await proc.wait()).code).toBe(0);
        expect(JSON.parse(output)).toEqual(values);
      }
    },
  );
});
