/**
 * 紧凑欢迎区（ADR-0020）：对话区第一项，随滚动离开。
 * 左侧 4 行弯月标记，右侧版本、模型与档位、目录、一行提示。
 * 不做会话 id、最近会话和 MCP 分栏；MCP 失败由调用方另给通知。
 */
import { boxSafe, truncateLine } from "./format.js";
import { MOON_PIXELS, palettes, type ThemePalette } from "./theme.js";
import type { LaidLine, LineSegment } from "./viewport.js";

export interface WelcomeInfo {
  version: string;
  model: string;
  effort: string | undefined;
  cwd: string;
  ascii: boolean;
  width: number;
  theme?: ThemePalette;
}

const GAP = 2;

function clip(text: string, width: number): string {
  return truncateLine(boxSafe(text), Math.max(1, width), "...");
}

/**
 * 像素网格 → 终端行：上下两像素合一格。上下同色用 █，
 * 只有一半用 ▀/▄，两色用 ▀（前景=上、背景=下）。ASCII 模式有像素即 #。
 */
export function moonRows(ascii: boolean, theme: ThemePalette = palettes.dark): LineSegment[][] {
  const moonColors: Record<string, string> = {
    H: theme.moonHighlight,
    Y: theme.moonMain,
    O: theme.moonShadow,
  };
  const width = Math.max(...MOON_PIXELS.map((r) => r.length));
  const out: LineSegment[][] = [];
  for (let y = 0; y < MOON_PIXELS.length; y += 2) {
    const row: LineSegment[] = [];
    for (let x = 0; x < width; x++) {
      const top = moonColors[MOON_PIXELS[y]?.[x] ?? "."];
      const bot = moonColors[MOON_PIXELS[y + 1]?.[x] ?? "."];
      if (top === undefined && bot === undefined) row.push({ text: " " });
      else if (ascii) row.push({ text: "#", color: top ?? bot });
      else if (top !== undefined && bot === undefined) row.push({ text: "▀", color: top });
      else if (top === undefined) row.push({ text: "▄", color: bot });
      else if (top === bot) row.push({ text: "█", color: top });
      else row.push({ text: "▀", color: top, backgroundColor: bot });
    }
    out.push(row);
  }
  return out;
}

export function welcomeLines(info: WelcomeInfo): LaidLine[] {
  const theme = info.theme ?? palettes.dark;
  const sep = info.ascii ? " - " : " • ";
  const modelLine =
    info.effort !== undefined && info.effort !== ""
      ? `${info.model}${sep}${info.effort}`
      : info.model;
  const right = [
    `Nocturne ${info.version}`,
    modelLine,
    info.cwd,
    "/ 帮助  Shift+Tab 档位  Alt+M 权限",
  ];
  const moon = moonRows(info.ascii, theme);
  const markW = moon[0]?.length ?? 0;
  const sideW = info.width - 4 - markW - GAP;
  if (info.width < 40 || sideW < 16) {
    return right.map((text, i) => ({
      key: `welcome:${i}`,
      text: clip(text, info.width - 4),
      color: i === 0 ? theme.accent : undefined,
      bold: i === 0,
      dim: i > 0,
    }));
  }
  return moon.map((mark, i) => {
    const side = clip(right[i] ?? "", sideW);
    const segments: LineSegment[] = [
      ...mark,
      { text: " ".repeat(GAP) },
      i === 0 ? { text: side, color: theme.accent, bold: true } : { text: side, dim: true },
    ];
    const text = segments.map((s) => s.text).join("");
    return { key: `welcome:${i}`, text, segments };
  });
}
