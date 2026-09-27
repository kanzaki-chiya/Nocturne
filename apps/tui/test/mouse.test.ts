/**
 * SGR 鼠标序列摘除与 stdin 包装（ADR-0021 第 1 条）：
 * 完整/跨块序列解析、混在按键流中的序列、非鼠标转义放行、
 * 歧义尾巴超时放行、包装后 TTY 接口转发。
 */
import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  createMouseParser,
  MOUSE_DISABLE,
  MOUSE_ENABLE,
  wrapMouseStdin,
  type MouseEvent,
} from "../src/mouse.js";

function parser() {
  const events: MouseEvent[] = [];
  const flushed: string[] = [];
  const p = createMouseParser({
    onEvent: (ev) => events.push(ev),
    onFlushText: (t) => flushed.push(t),
  });
  return { p, events, flushed };
}

describe("SGR 鼠标解析", () => {
  it("完整序列：按下/拖动/松开/滚轮", () => {
    const { p, events } = parser();
    const rest = p.feed("\x1b[<0;10;5M\x1b[<32;11;5M\x1b[<0;11;5m\x1b[<64;1;1M\x1b[<65;1;1M");
    expect(rest).toBe("");
    expect(events).toEqual([
      { type: "press", button: 0, x: 10, y: 5 },
      { type: "drag", button: 0, x: 11, y: 5 },
      { type: "release", button: 0, x: 11, y: 5 },
      { type: "wheel", dir: "up", x: 1, y: 1 },
      { type: "wheel", dir: "down", x: 1, y: 1 },
    ]);
    p.dispose();
  });

  it("序列跨数据块截断：续块拼回，不漏给按键流", () => {
    const { p, events } = parser();
    expect(p.feed("abc\x1b[<0;1")).toBe("abc");
    expect(p.feed("2;4M")).toBe("");
    expect(events).toEqual([{ type: "press", button: 0, x: 12, y: 4 }]);
    // 尾巴再断一次
    expect(p.feed("\x1b[<6")).toBe("");
    expect(p.feed("4;9;9M")).toBe("");
    expect(events[1]).toEqual({ type: "wheel", dir: "up", x: 9, y: 9 });
    p.dispose();
  });

  it("鼠标序列与普通按键混在一个数据块里", () => {
    const { p, events } = parser();
    const rest = p.feed("hi\x1b[<0;3;2Mthere\x1b[<0;3;2m!");
    expect(rest).toBe("hithere!");
    expect(events).toEqual([
      { type: "press", button: 0, x: 3, y: 2 },
      { type: "release", button: 0, x: 3, y: 2 },
    ]);
    p.dispose();
  });

  it("非鼠标转义序列原样放行（方向键、粘贴括号）", () => {
    const { p, events } = parser();
    expect(p.feed("\x1b[A\x1b[200~粘贴\x1b[201~")).toBe("\x1b[A\x1b[200~粘贴\x1b[201~");
    expect(events).toEqual([]);
    // \x1b[< 后紧跟非法字节：不是鼠标序列，不吞
    expect(p.feed("\x1b[<x")).toBe("\x1b[<x");
    p.dispose();
  });

  it("裸 ESC 尾巴到时限放行（Esc 键不被挂死）", async () => {
    const { p, events, flushed } = parser();
    expect(p.feed("\x1b")).toBe("");
    // 前一块的 "\x1b" 与 "\x1b[" 拼接后仍不是鼠标序列：ESC 即刻放行，
    // 仅剩 "\x1b[" 挂起等超时
    expect(p.feed("\x1b[")).toBe("\x1b");
    await new Promise((r) => setTimeout(r, 60));
    expect(flushed).toEqual(["\x1b["]);
    expect(events).toEqual([]);
    p.dispose();
  });

  it("开/关序列的字节与顺序", () => {
    expect(MOUSE_ENABLE).toBe("\x1b[?1000h\x1b[?1002h\x1b[?1006h");
    expect(MOUSE_DISABLE).toBe("\x1b[?1006l\x1b[?1002l\x1b[?1000l");
  });
});

describe("wrapMouseStdin", () => {
  function fakeReal() {
    const real = new EventEmitter() as NodeJS.ReadStream & {
      write?: (d: string) => void;
    };
    real.isTTY = true;
    real.setRawMode = vi.fn(() => real);
    real.setEncoding = vi.fn(() => real);
    real.ref = vi.fn(() => real);
    real.unref = vi.fn(() => real);
    real.read = vi.fn(() => "read0") as unknown as NodeJS.ReadStream["read"];
    return real;
  }

  it("按键透传、鼠标序列只进订阅；TTY 接口转发真实流", () => {
    const real = fakeReal();
    const w = wrapMouseStdin(real);
    const events: MouseEvent[] = [];
    w.mouse.subscribe((ev) => events.push(ev));
    const got: string[] = [];
    w.stdin.on("data", (d) => got.push(String(d)));

    expect(w.stdin.isTTY).toBe(true);
    w.stdin.setRawMode(true);
    expect(real.setRawMode).toHaveBeenCalledWith(true);
    w.stdin.ref();
    w.stdin.unref();
    expect(real.ref).toHaveBeenCalled();
    expect(real.unref).toHaveBeenCalled();
    // read(0) 转发真实流（Windows 控制台读请求兜底）；无参 read 走内层
    expect(w.stdin.read(0)).toBe("read0");

    real.emit("data", "ab\x1b[<64;5;5Mcd");
    expect(got.join("")).toBe("abcd");
    expect(events).toEqual([{ type: "wheel", dir: "up", x: 5, y: 5 }]);
    w.dispose();
  });

  it("dispose 后不再转发", () => {
    const real = fakeReal();
    const w = wrapMouseStdin(real);
    const got: string[] = [];
    w.stdin.on("data", (d) => got.push(String(d)));
    w.dispose();
    real.emit("data", "x");
    expect(got).toEqual([]);
  });
});
