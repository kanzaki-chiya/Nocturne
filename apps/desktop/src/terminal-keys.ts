/**
 * 面板终端的按键分流（ADR-0060 第 4 节、ADR-0110 第 4 节、desktop.md 5.10）：
 * - Windows：有选区时 Ctrl+C 复制并清掉选区，没有选区时照常发给程序（中断）；
 *   Ctrl+Insert 复制，Shift+Insert 与 Ctrl+Shift+V 粘贴，Ctrl+Shift+C 复制并保留选区；
 * - macOS：有选区时 Cmd+C 复制并清掉选区，Cmd+V 粘贴；Ctrl 组合始终交给终端；
 * - 面板快捷键按平台主修饰键（Windows Ctrl / macOS Cmd）交给窗口。纯函数，便于测试。
 */
import { hasPrimaryMod, isMacOS } from "./platform";

export interface TerminalKey {
  key: string;
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/**
 * - copy：复制选区并清掉选区；
 * - copy-keep：复制选区，保留选区（Ctrl+Shift+C，沿用前几轮的行为）；
 * - paste：交给浏览器原生粘贴（进 xterm 的 textarea，xterm 自己处理括号粘贴）；
 * - app：窗口的面板快捷键；
 * - terminal：照常交给 xterm。
 */
export type TerminalKeyAction = "copy" | "copy-keep" | "paste" | "app" | "terminal";

/** 终端里也交给窗口处理的应用快捷键（面板开关、新标签、变更、快速打开、终端） */
export function isAppShortcut(event: TerminalKey, mac = isMacOS()): boolean {
  if (!hasPrimaryMod(event, mac) || event.altKey) return false;
  if (event.code === "Backquote" && !event.shiftKey) return true;
  const key = event.key.toLowerCase();
  if (event.shiftKey) return key === "g";
  return key === "b" || key === "t" || key === "p";
}

export function terminalKeyAction(
  event: TerminalKey,
  hasSelection: boolean,
  mac = isMacOS(),
): TerminalKeyAction {
  const key = event.key.toLowerCase();
  if (mac) {
    if (event.altKey || event.ctrlKey) return "terminal";
    if (event.metaKey && !event.shiftKey) {
      if (key === "c" && hasSelection) return "copy";
      if (key === "v") return "paste";
    }
    return isAppShortcut(event, true) ? "app" : "terminal";
  }
  if (event.altKey || event.metaKey) return "terminal";
  if (event.ctrlKey && event.shiftKey) {
    if (key === "c") return "copy-keep";
    if (key === "v") return "paste";
  }
  if (event.ctrlKey && !event.shiftKey) {
    if (key === "c" && hasSelection) return "copy";
    if (event.key === "Insert") return hasSelection ? "copy" : "terminal";
  }
  if (event.shiftKey && !event.ctrlKey && event.key === "Insert") return "paste";
  return isAppShortcut(event, false) ? "app" : "terminal";
}
