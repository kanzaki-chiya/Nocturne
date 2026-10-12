/**
 * SGR 鼠标序列摘除与 stdin 包装（ADR-0021 第 1 条）：
 * 完整/跨块序列解析、混在按键流中的序列、非鼠标转义放行、
 * 歧义尾巴超时放行、包装后 TTY 接口转发。
 */
import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  createMouseParser,
  FOCUS_DISABLE,
  FOCUS_ENABLE,
  MOUSE_DISABLE,
  MOUSE_ENABLE,
  wrapMouseStdin,
  type MouseEvent,
} from "../src/mouse.js";

function parser() {
  const events: MouseEvent[] = [];
  const flushed: string[] = [];
  const focus: boolean[] = [];
  const p = createMouseParser({
    onEvent: (ev) => events.push(ev),
    onFocus: (value) => focus.push(value),
    onFlushText: (t) => flushed.push(t),
  });
  return { p, events, flushed, focus };
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
    await new Promise((r) => setTimeout(r, 300));
    expect(flushed).toEqual(["\x1b["]);
    expect(events).toEqual([]);
    p.dispose();
  });

  it("开/关序列的字节与顺序", () => {
    expect(MOUSE_ENABLE).toBe("\x1b[?1000h\x1b[?1002h\x1b[?1006h");
    expect(MOUSE_DISABLE).toBe("\x1b[?1006l\x1b[?1002l\x1b[?1000l");
    expect(FOCUS_ENABLE).toBe("\x1b[?1004h");
    expect(FOCUS_DISABLE).toBe("\x1b[?1004l");
  });
});

describe("焦点回送解析（CSI I / CSI O）", () => {
  it("完整序列只记焦点态，不进按键流；与按键混排照常摘除", () => {
    const { p, focus } = parser();
    expect(p.feed("\x1b[I\x1b[O")).toBe("");
    expect(focus).toEqual([true, false]);
    expect(p.feed("a\x1b[Ib\x1b[Oc")).toBe("abc");
    expect(focus).toEqual([true, false, true, false]);
    p.dispose();
  });

  it("跨数据块截断：ESC / ESC[ / 序列头依次拼回", () => {
    const { p, focus } = parser();
    expect(p.feed("\x1b")).toBe("");
    expect(p.feed("[")).toBe("");
    expect(p.feed("I")).toBe("");
    expect(focus).toEqual([true]);
    expect(p.feed("\x1b[")).toBe("");
    expect(p.feed("O")).toBe("");
    expect(focus).toEqual([true, false]);
    p.dispose();
  });

  it("与 Esc、Alt+键混排：歧义尾巴到时限原样放行，不算焦点回送", () => {
    vi.useFakeTimers();
    const { p, focus, flushed } = parser();
    try {
      // Alt+M = ESC m：非 CSI 即刻交给 Ink，不与焦点回送混淆
      expect(p.feed("m")).toBe("m");
      expect(flushed).toEqual([]);
      // Esc 键（单独 ESC）之后再按 [：同样超时放行
      expect(p.feed("[")).toBe("");
      vi.advanceTimersByTime(300);
      expect(flushed).toEqual(["["]);
      expect(focus).toEqual([]);
    } finally {
      p.dispose();
      vi.useRealTimers();
    }
  });

  it("与鼠标序列相邻：鼠标照常解析、焦点照常摘除", () => {
    const { p, events, focus } = parser();
    const out = p.feed("[<0;10;20M[Ix[<64;5;5M[O");
    expect(out).toBe("x");
    expect(events).toHaveLength(2);
    expect(focus).toEqual([true, false]);
    p.dispose();
  });
  it("CSI 前缀延迟续块不按裸 Esc 的短超时放行", () => {
    vi.useFakeTimers();
    const { p, focus, flushed } = parser();
    try {
      expect(p.feed("\x1b[")).toBe("");
      vi.advanceTimersByTime(100);
      expect(flushed).toEqual([]);
      expect(p.feed("O")).toBe("");
      expect(focus).toEqual([false]);
      expect(p.feed("\x1b")).toBe("");
      vi.advanceTimersByTime(30);
      expect(flushed).toEqual(["\x1b"]);
    } finally {
      p.dispose();
      vi.useRealTimers();
    }
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

  it("焦点回送只更新焦点态：初始 false（从未回送按没在看）", () => {
    const real = fakeReal();
    const w = wrapMouseStdin(real);
    const got: string[] = [];
    w.stdin.on("data", (d) => got.push(String(d)));
    expect(w.focus.focused()).toBe(false);
    real.emit("data", "\x1b[Ox\x1b[I");
    expect(got.join("")).toBe("x");
    expect(w.focus.focused()).toBe(true);
    real.emit("data", "\x1b[O");
    expect(w.focus.focused()).toBe(false);
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
