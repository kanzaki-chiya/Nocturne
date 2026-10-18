/**
 * 面板终端的复制粘贴按键（desktop.md 5.10）：有选区时 Ctrl+C 复制并清掉选区，没有选区
 * 时 Ctrl+C 交给程序（中断）；Ctrl+Insert 复制，Shift+Insert 粘贴；面板快捷键交给窗口。
 */
import { describe, expect, it } from "vitest";

import { terminalKeyAction, type TerminalKey } from "../src/terminal-keys";

const key = (k: string, mods: Partial<TerminalKey> = {}, code = ""): TerminalKey => ({
  key: k,
  code,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

describe("终端按键", () => {
  it("Ctrl+C：有选区复制并清掉选区，没有选区交给程序", () => {
    expect(terminalKeyAction(key("c", { ctrlKey: true }), true)).toBe("copy");
    expect(terminalKeyAction(key("c", { ctrlKey: true }), false)).toBe("terminal");
    // 大写锁定时 key 是 C
    expect(terminalKeyAction(key("C", { ctrlKey: true }), true)).toBe("copy");
  });

  it("Ctrl+Insert 复制、Shift+Insert 粘贴；Ctrl+Shift+C / V 照旧", () => {
    expect(terminalKeyAction(key("Insert", { ctrlKey: true }), true)).toBe("copy");
    expect(terminalKeyAction(key("Insert", { ctrlKey: true }), false)).toBe("terminal");
    expect(terminalKeyAction(key("Insert", { shiftKey: true }), false)).toBe("paste");
    expect(terminalKeyAction(key("C", { ctrlKey: true, shiftKey: true }), true)).toBe("copy-keep");
    expect(terminalKeyAction(key("V", { ctrlKey: true, shiftKey: true }), false)).toBe("paste");
    expect(terminalKeyAction(key("Insert"), false)).toBe("terminal");
  });

  it("面板快捷键交给窗口；Alt 组合与普通按键交给终端", () => {
    expect(terminalKeyAction(key("b", { ctrlKey: true }), false)).toBe("app");
    expect(terminalKeyAction(key("p", { ctrlKey: true }), true)).toBe("app");
    expect(terminalKeyAction(key("G", { ctrlKey: true, shiftKey: true }), false)).toBe("app");
    expect(terminalKeyAction(key("`", { ctrlKey: true }, "Backquote"), false)).toBe("app");
    expect(terminalKeyAction(key("c", { ctrlKey: true, altKey: true }), true)).toBe("terminal");
    expect(terminalKeyAction(key("a"), true)).toBe("terminal");
    expect(terminalKeyAction(key("v", { ctrlKey: true }), false)).toBe("terminal");
  });
});
