/**
 * 欢迎区（ADR-0020/0039）：空会话全屏显示大字标；紧凑形态随对话滚动。
 * 左侧 4 行弯月标记，右侧版本、模型与档位、目录、一行提示。
 * 不做会话 id、最近会话和 MCP 分栏；MCP 失败由调用方另给通知。
 */
import stringWidth from "string-width";
import { boxSafe, stripControls, truncateLine, truncateLineHead } from "./format.js";
import { pixelLogoLines } from "./components/pixel-logo.js";
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

/** 空会话专用显示行；不放进小欢迎区的导出/Static 路径。 */
export function emptyWelcomeLines(info: WelcomeInfo, height: number, otherRows = 0): LaidLine[] {
  if (height < 4) return welcomeLines(info, true).slice(0, height);
  const theme = info.theme ?? palettes.dark;
  const logo = info.width >= 51 && height >= 12;
  const sep = info.ascii ? " - " : " • ";
  const version = `v${info.version.replace(/^v/, "")}`;
  const detail = `${version}${sep}${info.model}${info.effort ? `${sep}思考:${info.effort}` : ""}`;
  const texts = [
    logo ? detail : `Nocturne ${version}`,
    ...(logo ? [] : [info.effort ? `${info.model}${sep}思考:${info.effort}` : info.model]),
    truncateLineHead(boxSafe(stripControls(info.cwd)), info.width, "..."),
    ...(logo || height >= 5 ? [""] : []),
    "/ 帮助  Shift+Tab 档位  Alt+M 权限",
  ];
  const lines: LaidLine[] = [
    ...(logo ? [...pixelLogoLines(info.ascii, theme), { key: "welcome:gap", text: "" }] : []),
    ...texts.map((text, i) => ({
      key: `empty-welcome:${i}`,
      text: truncateLine(boxSafe(stripControls(text)), info.width, ""),
      color: i === 0 ? theme.accent : theme.muted,
    })),
  ];
  const top = Math.max(0, Math.floor(((height - lines.length - otherRows) * 2) / 5));
  return [
    ...Array.from({ length: top }, (_, i) => ({ key: `welcome:space:${i}`, text: "" })),
    ...lines.map((line) => {
      const padding = " ".repeat(
        Math.max(0, Math.floor((info.width - stringWidth(line.text)) / 2)),
      );
      return {
        ...line,
        text: padding + line.text,
        segments: [
          { text: padding },
          ...(line.segments ?? [{ text: line.text, color: line.color }]),
        ],
      };
    }),
  ];
}

function clip(text: string, width: number): string {
  return truncateLine(boxSafe(text), Math.max(1, width), "...");
}

function parseHexRgb(hex: string): readonly [number, number, number] {
  const clean = hex.startsWith("#") ? hex.slice(1) : hex;
  const n = Number.parseInt(clean, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function lerpHex(from: string, to: string, t: number): string {
  const [r1, g1, b1] = parseHexRgb(from);
  const [r2, g2, b2] = parseHexRgb(to);
  const ch = (a: number, b: number) =>
    Math.round(a + (b - a) * t)
      .toString(16)
      .padStart(2, "0")
      .toUpperCase();
  return `#${ch(r1, r2)}${ch(g1, g2)}${ch(b1, b2)}`;
}

/** 计算弯月像素 (x, y) 的斜向 sRGB 渐变色（theme.accent -> theme.accentAlt）。 */
function moonPixelColor(
  x: number,
  y: number,
  width: number,
  height: number,
  theme: ThemePalette,
): string {
  const raw = ((x + 0.5) / width) * 0.47 + ((y + 0.5) / height) * 0.53;
  const t = Math.min(1, Math.max(0, (raw - 0.1) / 0.8));
  return lerpHex(theme.accent, theme.accentAlt, t);
}

/**
 * 像素网格 → 终端行：上下两像素合一格。上下同色用 █，
 * 只有一半用 ▀/▄，两色用 ▀（前景=上、背景=下）。ASCII 模式有像素即 #。
 */
export function moonRows(ascii: boolean, theme: ThemePalette = palettes.dark): LineSegment[][] {
  const height = MOON_PIXELS.length;
  const width = Math.max(...MOON_PIXELS.map((r) => r.length));
  const colorAt = (x: number, y: number): string | undefined =>
    MOON_PIXELS[y]?.[x] === "#" ? moonPixelColor(x, y, width, height, theme) : undefined;
  const out: LineSegment[][] = [];
  for (let y = 0; y < height; y += 2) {
    const row: LineSegment[] = [];
    for (let x = 0; x < width; x++) {
      const top = colorAt(x, y);
      const bot = colorAt(x, y + 1);
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

export function welcomeLines(info: WelcomeInfo, textOnly = false): LaidLine[] {
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
  if (textOnly || info.width < 40 || sideW < 16) {
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
