import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createRuntime, FakeProvider } from "@nocturne/core";

import { runTui } from "../src/index.js";
import { createCursorStream } from "../src/cursor.js";
import { inkFrame, OutputLayer } from "../src/output-layer.js";

const frame = (lines: string[]): string => `${lines.join("\n")}\n`;
const rewritten = (write: string): number[] =>
  [...write.matchAll(/\x1b\[(\d+);1H\x1b\[0m/g)].map((match) => Number(match[1]));

it("从 Ink log-update 的清行前缀提取整帧", () => {
  expect(inkFrame("\x1b[2K\x1b[1A\x1b[2K\x1b[Gfirst\nsecond\n")).toBe("first\nsecond\n");
  expect(inkFrame("\x1b[?25lfirst\nsecond\n")).toBe("first\nsecond\n");
  expect(inkFrame("\x1b[?25h")).toBeUndefined();
});

it("满视口上下平移只覆盖新露出的行；位移过大退回逐行覆盖", () => {
  const layer = new OutputLayer();
  const original = Array.from({ length: 9 }, (_, i) => `row-${i}`);
  layer.render(frame(original), 80, 10, 9, "conversation", undefined);
  const up = layer.render(
    frame([...original.slice(1), "row-9"]),
    80,
    10,
    9,
    "conversation",
    undefined,
  );
  expect(up).toContain("\x1b[1;9r\x1b[1;1H\x1b[1S\x1b[r");
  expect(rewritten(up)).toEqual([9]);
  const down = layer.render(frame(original), 80, 10, 9, "conversation", undefined);
  expect(down).toContain("\x1b[1;9r\x1b[1;1H\x1b[1T\x1b[r");
  expect(rewritten(down)).toEqual([1]);
  const far = layer.render(
    frame(Array.from({ length: 9 }, (_, i) => `row-${i + 4}`)),
    80,
    10,
    9,
    "conversation",
    undefined,
  );
  expect(far).not.toMatch(/\x1b\[\d+[ST]/);
  expect(rewritten(far)).toHaveLength(9);
});

it("单行变更和选区反显只覆盖受影响的行", () => {
  const layer = new OutputLayer();
  const original = Array.from({ length: 9 }, (_, i) => `row-${i}`);
  layer.render(frame(original), 80, 10, 9, "conversation", undefined);
  const one = layer.render(
    frame(original.map((s, i) => (i === 3 ? "changed" : s))),
    80,
    10,
    9,
    "conversation",
    undefined,
  );
  expect(one).not.toMatch(/\x1b\[\d+[ST]/);
  expect(rewritten(one)).toEqual([4]);
  const selected = layer.render(
    frame(original.map((s, i) => (i === 3 ? `\x1b[7m${s}\x1b[27m` : s))),
    80,
    10,
    9,
    "conversation",
    undefined,
  );
  expect(rewritten(selected)).toEqual([4]);
  expect(selected).toContain("\x1b[7mrow-3\x1b[27m");
});

it("尺寸和页面切换逐行重写整帧，不清屏", () => {
  const layer = new OutputLayer();
  const lines = Array.from({ length: 9 }, (_, i) => `row-${i}`);
  layer.render(frame(lines), 80, 10, 9, "conversation", undefined);
  for (const write of [
    layer.render(frame(lines), 100, 10, 9, "conversation", undefined),
    layer.render(frame(lines), 100, 10, 0, "model", undefined),
    layer.render(frame(lines), 100, 10, 0, "record", undefined),
    layer.render(frame(lines), 100, 10, 9, "conversation", undefined),
  ]) {
    expect(rewritten(write)).toHaveLength(9);
    expect(write).not.toContain("\x1b[2J");
  }
});

it("全屏帧只写一次同步事务，IME 各输入位置按绝对坐标补位；帧外顺序不变", () => {
  const io = tty();
  const mouseOn = "\x1b[?1000h";
  const mouseOff = "\x1b[?1000l";
  const out = createCursorStream(io.stdout, {
    fullscreen: true,
    afterEnterAlt: mouseOn,
    beforeExitAlt: mouseOff,
  });
  const id = Symbol();
  out.stream.write("\x1b[?1049h");
  expect(io.writes.at(-1)).toBe("\x1b[?1049h" + mouseOn);
  out.setLayout(3, "conversation");
  for (const [name, x, y] of [
    ["主输入单行", 5, -1],
    ["主输入多行", 8, -3],
    ["模型搜索", 28, -12],
    ["服务商过滤", 10, -18],
  ] as const) {
    out.claims.set(id, { x, y });
    const before = io.writes.length;
    out.stream.write("\x1b[?2026h");
    out.stream.write(frame([name, "second", "third"]));
    out.stream.write("\x1b[?2026l");
    expect(io.writes).toHaveLength(before + 1);
    expect(io.writes.at(-1)).toMatch(
      new RegExp(`\\x1b\\[${30 + y};${x + 1}H\\x1b\\[\\?25h\\x1b\\[\\?2026l$`),
    );
  }
  out.writeOob("\x1b]52;c;YWJj\x07");
  expect(io.writes.at(-1)).toBe("\x1b]52;c;YWJj\x07");
  out.stream.write("\x1b[?1049l");
  expect(io.writes.at(-1)).toBe(mouseOff + "\x1b[?1049l");
  out.stop();
});

const roots: string[] = [];
const temp = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "nct-output-"));
  roots.push(dir);
  return dir;
};
beforeEach(() => vi.stubEnv("NOCTURNE_HOME", temp()));
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tty() {
  const writes: string[] = [];
  const stdout = new EventEmitter() as NodeJS.WriteStream;
  stdout.isTTY = true;
  stdout.columns = 100;
  stdout.rows = 30;
  stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  }) as NodeJS.WriteStream["write"];
  const stderr = new EventEmitter() as NodeJS.WriteStream;
  stderr.write = (() => true) as NodeJS.WriteStream["write"];
  const stdin = new EventEmitter() as NodeJS.ReadStream & { send: (text: string) => void };
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.setEncoding = () => stdin;
  stdin.resume = () => stdin;
  stdin.pause = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  stdin.read = () => null;
  stdin.send = (text) => stdin.emit("data", text);
  return { stdin, stdout, stderr, writes };
}

it("120 行流式思考保持固定窗口，每帧至多改 6 行且不清屏", async () => {
  const scripts = [
    [
      ...Array.from({ length: 120 }, (_, i) => [
        { type: "reasoning_delta" as const, text: `推理第${String(i).padStart(3, "0")}行\n` },
        { type: "wait" as const, ms: 15 },
      ]).flat(),
      { type: "text_delta" as const, text: "完成" },
      { type: "finish" as const, reason: "stop" as const },
    ],
  ];
  const runtime = await createRuntime({
    cwd: temp(),
    sessionsDir: temp(),
    providers: [new FakeProvider({ scripts })],
  });
  const session = await runtime.createSession({ model: "fake/fake-model" });
  const io = tty();
  const done = runTui({ session }, runtime, {
    stdin: io.stdin,
    stdout: io.stdout,
    stderr: io.stderr,
    patchConsole: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  await session.submit({ text: "测试流式" });
  const frames: string[] = [];
  let frame = "";
  let collecting = false;
  for (const write of io.writes) {
    if (write === "\x1b[?2026h") {
      collecting = true;
      frame = write;
    } else if (collecting) {
      frame += write;
      if (frame.includes("\x1b[?2026l")) {
        frames.push(frame);
        collecting = false;
      }
    } else if (write.startsWith("\x1b[?2026h") && write.endsWith("\x1b[?2026l")) {
      frames.push(write);
    }
  }
  // 回复正文/Turn 完结会重排页面，只统计长思考稳定流式阶段。
  const steady = frames.filter(
    (f) => /推理第(?:0[4-9]\d|1[01]\d)行/.test(f) && !f.includes("完成"),
  );
  const rows = steady.map((f) => (f.match(/\x1b\[1G|\x1b\[\d+;1H/g) ?? []).length);
  const bytes = steady.map((f) => Buffer.byteLength(f));
  if (process.env.NOCTURNE_RENDER_METRICS === "1") {
    console.log("output metrics", {
      frames: steady.length,
      meanRows: rows.reduce((a, b) => a + b, 0) / rows.length,
      meanBytes: bytes.reduce((a, b) => a + b, 0) / bytes.length,
      maxRows: Math.max(...rows),
    });
  }
  try {
    expect(steady.length).toBeGreaterThan(10);
    expect(Math.max(...rows)).toBeLessThanOrEqual(6);
    expect(steady.join("")).not.toMatch(/\x1b\[\d+[ST]/);
    expect(io.writes.join("")).not.toContain("\x1b[2J");
  } finally {
    io.stdin.send("\x04");
    await done;
    await session.close();
  }
}, 15000);
