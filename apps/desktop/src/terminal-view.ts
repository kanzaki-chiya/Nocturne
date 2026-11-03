/**
 * xterm.js 封装（ADR-0060 第 4 节）。只由 TerminalPane 动态 import：不打开终端就不进
 * 首屏包，手机网页版也不会打进 xterm。颜色取 `--a-*` 变量，深浅主题切换时跟着换。
 */
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

import { isAppShortcut, terminalKeyAction } from "./terminal-keys";

export interface MountedTerminal {
  write: (data: string) => void;
  /** 按容器尺寸重排；容器不可见（0 尺寸）时不动 */
  fit: () => void;
  size: () => { cols: number; rows: number };
  focus: () => void;
  selection: () => string;
  clearSelection: () => void;
  /** 程序开了鼠标上报（Claude Code、vim、htop 等）：右键交给程序 */
  mouseTracking: () => boolean;
  paste: (text: string) => void;
  clear: () => void;
  dispose: () => void;
}

export interface TerminalCallbacks {
  /** Opening/closing clips a fixed-size view; fit once after it has settled. */
  canFit?: () => boolean;
  onData: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  /** 复制选区；clear 为 true 时复制后清掉选区 */
  onCopy: (clear: boolean) => void;
}

/** 浅色主题：程序自己给的 256 色 / 真彩色也拉到这个对比度以上（ANSI 黄单独用加深的 token） */
const LIGHT_MIN_CONTRAST = 4.5;

function isLightTheme(): boolean {
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--a-bg").trim();
  return luminance(bg || "#121419") > 0.5;
}

function readTheme(): ITheme {
  const style = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  const bg = v("--a-bg", "#121419");
  const light = luminance(bg) > 0.5;
  const text = v("--a-text", "#d8dce3");
  return {
    background: bg,
    foreground: text,
    cursor: v("--a-accent", "#a6a4e8"),
    cursorAccent: bg,
    selectionBackground: v("--a-sel-strong", "#383555"),
    black: light ? text : v("--a-border-strong", "#3a4150"),
    red: v("--a-error", "#e58f90"),
    green: v("--a-success", "#84c49a"),
    yellow: v("--a-termYellow", "#e5bd77"),
    blue: v("--a-cat5", "#8fa6c9"),
    magenta: v("--a-cat4", "#d99ac9"),
    cyan: v("--a-accentAlt", "#83c4c8"),
    white: light ? v("--a-muted", "#656f7b") : v("--a-secondary", "#b7c0cc"),
    brightBlack: v("--a-faint", "#5a626e"),
    brightRed: v("--a-error", "#e58f90"),
    brightGreen: v("--a-success", "#84c49a"),
    brightYellow: v("--a-termYellowBright", "#e5bd77"),
    brightBlue: v("--a-accent", "#a6a4e8"),
    brightMagenta: v("--a-cat4", "#d99ac9"),
    brightCyan: v("--a-cat2", "#83c4c8"),
    brightWhite: light ? v("--a-secondary", "#454f5c") : text,
    // 和面板其余滚动区一样的细滚动条颜色（styles.css .thin-scroll）
    scrollbarSliderBackground: v("--a-scroll", "rgba(183, 192, 204, 0.22)"),
    scrollbarSliderHoverBackground: v("--a-scrollThumbHover", "rgba(183, 192, 204, 0.38)"),
    scrollbarSliderActiveBackground: v("--a-scrollThumbHover", "rgba(183, 192, 204, 0.38)"),
  };
}

/** #rrggbb 的相对亮度（0–1）；解析不了按深色 */
function luminance(color: string): number {
  const hex = /^#([0-9a-f]{6})$/i.exec(color)?.[1];
  if (hex === undefined) return 0;
  const n = Number.parseInt(hex, 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

/**
 * 终端字体跟随设置 › 外观：字号取计算后的 --fs-2，字体取计算后的 --mono（含所选代码字体）。
 * 没有单独的终端字号设置。
 */
export function readTerminalFont(): { fontFamily: string; fontSize: number } {
  const style = getComputedStyle(document.documentElement);
  const size = Number.parseFloat(style.getPropertyValue("--fs-2"));
  return {
    fontFamily: style.getPropertyValue("--mono").trim() || "Consolas, monospace",
    fontSize: Number.isFinite(size) && size > 0 ? size : 13,
  };
}

export function mountTerminal(parent: HTMLElement, callbacks: TerminalCallbacks): MountedTerminal {
  const font = readTerminalFont();
  const term = new Terminal({
    scrollback: 5000,
    fontFamily: font.fontFamily,
    fontSize: font.fontSize,
    lineHeight: 1.15,
    cursorBlink: true,
    // Unicode 11 宽度表在实验性 unicode API 上，不开 proposed API 读不到
    allowProposedApi: true,
    theme: readTheme(),
    minimumContrastRatio: isLightTheme() ? LIGHT_MIN_CONTRAST : 1,
    // 竖滚动条宽度跟随概览标尺宽度：与面板其余滚动区一样 10px
    overviewRuler: { width: 10 },
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  // xterm 6.0.0 自带 Unicode 6 宽度表，emoji 会被算成 1 列。配套的是同标签里的
  // @xterm/addon-unicode11 0.9.0（与 addon-fit 0.11.0 一起发布）。
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  term.open(parent);
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== "keydown") return !isAppShortcut(event);
    switch (terminalKeyAction(event, term.hasSelection())) {
      case "copy":
      case "copy-keep":
        event.preventDefault();
        callbacks.onCopy(!(event.ctrlKey && event.shiftKey));
        return false;
      case "paste":
        // 不拦默认行为：浏览器原生粘贴事件进 xterm 的 textarea，xterm 自己处理（含括号粘贴），
        // 也不会像 navigator.clipboard.readText 那样触发 WebView2 的剪贴板权限框
        return false;
      case "app":
        // 返回 false：xterm 不处理，事件照常冒泡到窗口的快捷键
        return false;
      case "terminal":
        return true;
    }
  });
  const data = term.onData(callbacks.onData);
  const resize = term.onResize(({ cols, rows }) => {
    callbacks.onResize(cols, rows);
  });
  const fit = () => {
    if (callbacks.canFit?.() === false) return;
    if (parent.clientWidth === 0 || parent.clientHeight === 0) return;
    try {
      fitAddon.fit();
    } catch {
      // 渲染器还没就绪时 fit 会抛错，下一次尺寸变化再来
    }
  };
  const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(fit);
  observer?.observe(parent);
  // 主题：设置页改 data-theme，或跟随系统时系统切换
  const retheme = () => {
    term.options.theme = readTheme();
    term.options.minimumContrastRatio = isLightTheme() ? LIGHT_MIN_CONTRAST : 1;
  };
  // 字体与字号：设置页改根元素行内样式上的 --mono / --fs-*；变了就换字体并按新字格重算行列
  // （fit 触发 onResize，pty 跟着改尺寸）
  const refont = () => {
    const next = readTerminalFont();
    if (next.fontFamily === term.options.fontFamily && next.fontSize === term.options.fontSize) {
      return;
    }
    term.options.fontFamily = next.fontFamily;
    term.options.fontSize = next.fontSize;
    fit();
  };
  const themeObserver = new MutationObserver((records) => {
    if (records.some((record) => record.attributeName === "data-theme")) retheme();
    if (records.some((record) => record.attributeName === "style")) refont();
  });
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "style"],
  });
  const media = window.matchMedia("(prefers-color-scheme: light)");
  media.addEventListener("change", retheme);
  fit();
  return {
    write: (text) => {
      term.write(text);
    },
    fit,
    size: () => ({ cols: term.cols, rows: term.rows }),
    focus: () => {
      term.focus();
    },
    selection: () => term.getSelection(),
    clearSelection: () => {
      term.clearSelection();
    },
    mouseTracking: () => term.modes.mouseTrackingMode !== "none",
    paste: (text) => {
      term.paste(text);
    },
    clear: () => {
      term.reset();
    },
    dispose: () => {
      observer?.disconnect();
      themeObserver.disconnect();
      media.removeEventListener("change", retheme);
      data.dispose();
      resize.dispose();
      term.dispose();
    },
  };
}
