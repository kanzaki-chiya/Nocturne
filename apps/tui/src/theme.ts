/** TUI 语义色（ADR-0029）：深浅色适配终端背景，不涂满整屏。 */
import { createContext, useContext } from "react";

export type ThemeId = "dark" | "light";
export interface ThemePalette {
  id: ThemeId;
  text: string; // 正文、状态栏主要信息
  secondary: string; // Markdown 标题、引用、次要说明
  muted: string; // 按键提示、分隔线、留空列
  accent: string; // 输入、当前项、进度
  accentAlt: string; // 图片占位、Logo 副色
  selected: string; // 被选中控件的文字
  onStatus: string; // 有色通知标记的文字
  selectionBg: string; // 选区和聚焦项底色
  border: string; // 面板、Todo 固定区边框
  success: string;
  warning: string;
  error: string;
  info: string; // 中性信息提示
  diffAddBg: string;
  diffRemoveBg: string;
  codeBg: string;
  overlayBg: string;
  inputBg: string;
  moonHighlight: string;
  moonMain: string;
  moonShadow: string;
}

export const palettes: Record<ThemeId, ThemePalette> = {
  dark: {
    id: "dark",
    text: "#D8DCE3",
    secondary: "#B7C0CC",
    muted: "#88919D",
    accent: "#A6A4E8",
    accentAlt: "#83C4C8",
    selected: "#F4F7F9",
    onStatus: "#17212A",
    selectionBg: "#383555",
    border: "#697986",
    success: "#84C49A",
    warning: "#E5BD77",
    error: "#E58F90",
    info: "#96B6D2",
    diffAddBg: "#173526",
    diffRemoveBg: "#3B2329",
    codeBg: "#1B2730",
    overlayBg: "#18232C",
    inputBg: "#111A21",
    moonHighlight: "#FFF0A6",
    moonMain: "#E9BD5A",
    moonShadow: "#9C692A",
  },
  light: {
    id: "light",
    text: "#252B35",
    secondary: "#454F5C",
    muted: "#656F7B",
    accent: "#6255AA",
    accentAlt: "#24727A",
    selected: "#15232A",
    onStatus: "#FFFFFF",
    selectionBg: "#DFD9F1",
    border: "#8799A5",
    success: "#287044",
    warning: "#865B14",
    error: "#AD3340",
    info: "#305D82",
    diffAddBg: "#DBEEDB",
    diffRemoveBg: "#F6DEDF",
    codeBg: "#E8EEF1",
    overlayBg: "#EDF1F3",
    inputBg: "#DDE5EA",
    moonHighlight: "#8C5A12",
    moonMain: "#AB741C",
    moonShadow: "#6D4B26",
  },
};

export function resolveTheme(value: string | undefined): ThemeId {
  return value === "light" ? "light" : "dark";
}

export const ThemeContext = createContext<ThemePalette>(palettes.dark);
export const useTheme = (): ThemePalette => useContext(ThemeContext);

/**
 * Nocturne 像素 Logo（原创双色像素字，5 行高）。
 * 左半（NOCT）用 accent 色、右半（URNE）用 accentAlt 色；
 * LOGO_SPLIT 是每行字符串中两个颜色的分界列。
 */
export const LOGO_ROWS: readonly string[] = (() => {
  const L: Record<string, readonly string[]> = {
    N: ["█   █", "██  █", "█ █ █", "█  ██", "█   █"],
    O: [" ███ ", "█   █", "█   █", "█   █", " ███ "],
    C: [" ███ ", "█    ", "█    ", "█    ", " ███ "],
    T: ["█████", "  █  ", "  █  ", "  █  ", "  █  "],
    U: ["█   █", "█   █", "█   █", "█   █", " ███ "],
    R: ["████ ", "█   █", "████ ", "█ █  ", "█  ██"],
    E: ["█████", "█    ", "████ ", "█    ", "█████"],
  };
  const word = "NOCTURNE";
  const rows: string[] = [];
  for (let r = 0; r < 5; r++) {
    rows.push(
      Array.from(word)
        .map((ch) => L[ch]?.[r] ?? "     ")
        .join(" "),
    );
  }
  return rows;
})();

/** Logo 双色分界列：前 4 个字母（NOCT）= 4×6 = 24 列 */
export const LOGO_SPLIT = 24;

/** Logo 宽度（8 字母 × 5 + 7 空格 = 47 列） */
export const LOGO_WIDTH = 47;

/**
 * 欢迎区弯月标记（ADR-0020）：9×8 像素，半块字符两像素合一格，占 4 行 9 列。
 * H 高光、Y 月黄、O 阴影，"." 留空。▀ ▄ █ 在 conhost GBK 下实测均为 1 列（tui.md §9）。
 * 服务商页的大号字标仍用 LOGO_ROWS。
 */
export const MOON_PIXELS: readonly string[] = [
  "...HYY...",
  "..HY.....",
  ".HY......",
  "HYY......",
  "HYY......",
  "HYYY.....",
  ".OYYYYYO.",
  "..OOOO...",
];
