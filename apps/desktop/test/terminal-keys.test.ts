/**
 * 面板终端的复制粘贴按键（desktop.md 5.10）：有选区时 Ctrl+C 复制并清掉选区，没有选区
 * 时 Ctrl+C 交给程序（中断）；Ctrl+Insert 复制，Shift+Insert 粘贴；面板快捷键交给窗口。
 */
import { afterEach, describe, expect, it } from "vitest";

import { setPlatformForTest } from "../src/platform";
import { isAppShortcut, terminalKeyAction, type TerminalKey } from "../src/terminal-keys";

afterEach(() => {
  setPlatformForTest(null);
});

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
    expect(terminalKeyAction(key("~", { ctrlKey: true, shiftKey: true }, "Backquote"), false)).toBe(
      "app",
    );
    expect(terminalKeyAction(key("k", { ctrlKey: true }), false)).toBe("terminal");
    expect(terminalKeyAction(key("c", { ctrlKey: true, altKey: true }), true)).toBe("terminal");
    expect(terminalKeyAction(key("a"), true)).toBe("terminal");
    expect(terminalKeyAction(key("v", { ctrlKey: true }), false)).toBe("terminal");
  });

  it("macOS 终端：Cmd+C 选区复制、Cmd+V 粘贴、Ctrl 组合始终送终端", () => {
    setPlatformForTest("macos");
    expect(terminalKeyAction(key("c", { metaKey: true }), true)).toBe("copy");
    expect(terminalKeyAction(key("c", { metaKey: true }), false)).toBe("terminal");
    expect(terminalKeyAction(key("v", { metaKey: true }), false)).toBe("paste");
    // Ctrl+C / Ctrl+Shift+C / Ctrl+Shift+V / Ctrl+B 在 macOS 一律交给终端
    expect(terminalKeyAction(key("c", { ctrlKey: true }), true)).toBe("terminal");
    expect(terminalKeyAction(key("c", { ctrlKey: true }), false)).toBe("terminal");
    expect(terminalKeyAction(key("C", { ctrlKey: true, shiftKey: true }), true)).toBe("terminal");
    expect(terminalKeyAction(key("V", { ctrlKey: true, shiftKey: true }), false)).toBe("terminal");
    expect(terminalKeyAction(key("b", { ctrlKey: true }), false)).toBe("terminal");
    expect(terminalKeyAction(key("Insert", { ctrlKey: true }), true)).toBe("terminal");
    expect(terminalKeyAction(key("Insert", { shiftKey: true }), false)).toBe("terminal");
  });

  it("macOS 终端面板快捷键改用 Cmd，不占用 Ctrl", () => {
    setPlatformForTest("macos");
    expect(isAppShortcut(key("b", { metaKey: true }))).toBe(true);
    expect(isAppShortcut(key("t", { metaKey: true }))).toBe(true);
    expect(isAppShortcut(key("p", { metaKey: true }))).toBe(true);
    expect(isAppShortcut(key("G", { metaKey: true, shiftKey: true }))).toBe(true);
    expect(isAppShortcut(key("`", { metaKey: true }, "Backquote"))).toBe(true);
    expect(terminalKeyAction(key("p", { metaKey: true }), true)).toBe("app");
    expect(isAppShortcut(key("b", { ctrlKey: true }))).toBe(false);
    expect(isAppShortcut(key("p", { ctrlKey: true }))).toBe(false);
    expect(isAppShortcut(key("`", { ctrlKey: true }, "Backquote"))).toBe(false);
  });
});
