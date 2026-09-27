import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

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
