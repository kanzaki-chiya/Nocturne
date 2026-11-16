/** 外观配色依据与推算契约：ADR-0093；此模块不访问 DOM 或客户端存储。 */
export type ThemeMode = "light" | "dark";
export interface ThemeSeed {
  bg: string;
  side: string;
  text: string;
  accent: string;
}
export type ThemeVars = Record<`--a-${string}`, string>;

export const PRESETS = [
  {
    id: "workbench",
    name: "工作台",
    light: { bg: "#ffffff", side: "#fafafa", text: "#0d0d10", accent: "#5d50b0" },
    dark: { bg: "#0b0b0d", side: "#0f0f12", text: "#ededef", accent: "#a8a5ec" },
  },
  {
    id: "nocturne",
    name: "夜曲",
    light: { bg: "#f7f6fc", side: "#efeef7", text: "#1c1d2c", accent: "#5d50b0" },
    dark: { bg: "#0c0d16", side: "#10111d", text: "#e4e5f0", accent: "#a8a5ec" },
  },
  {
    id: "paper",
    name: "纸面",
    light: { bg: "#fbfaf6", side: "#f3f1ea", text: "#1f1d1a", accent: "#9a5b2e" },
    dark: { bg: "#171512", side: "#1d1a16", text: "#ece6da", accent: "#d9a46c" },
  },
  {
    id: "celadon",
    name: "青瓷",
    light: { bg: "#fbfdfd", side: "#f0f6f6", text: "#102224", accent: "#24727a" },
    dark: { bg: "#0a1213", side: "#0e1819", text: "#e2eeee", accent: "#83c4c8" },
  },
  {
    id: "ink",
    name: "松烟",
    light: { bg: "#ffffff", side: "#f4f4f3", text: "#111111", accent: "#111111" },
    dark: { bg: "#000000", side: "#0a0a0a", text: "#f2f2f2", accent: "#f2f2f2" },
  },
] as const satisfies readonly { id: string; name: string; light: ThemeSeed; dark: ThemeSeed }[];
export type ThemePresetId = (typeof PRESETS)[number]["id"];

export function themePresetId(id: unknown): ThemePresetId {
  return PRESETS.find((preset) => preset.id === id)?.id ?? "workbench";
}

const rgb = (hex: string): number[] =>
  [0, 2, 4].map((index) => Number.parseInt(hex.replace("#", "").slice(index, index + 2), 16));
const hex = (values: number[]): string =>
  "#" +
  values
    .map((v) =>
      Math.max(0, Math.min(255, Math.round(v)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("");
const mix = (a: string, b: string, ratio: number): string => {
  const other = rgb(b);
  return hex(rgb(a).map((value, index) => value + ((other[index] ?? 0) - value) * ratio));
};
const luminance = (color: string): number => {
  const values = rgb(color).map((value) => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (values[0] ?? 0) + 0.7152 * (values[1] ?? 0) + 0.0722 * (values[2] ?? 0);
};
function contrastRatio(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
const tone = (text: string, bg: string, ratio: number, minimum: number): string => {
  let color = mix(text, bg, ratio);
  while (contrastRatio(color, bg) < minimum && ratio > 0) {
    ratio = Math.max(0, ratio - 0.01);
    color = mix(text, bg, ratio);
  }
  return color;
};

/** 工作台卡片使用原色；实际应用工作台时仍返回空表。 */
const WORKBENCH: Record<ThemeMode, ThemeVars> = {
  light: {
    "--a-bg": "#ffffff",
    "--a-side": "#fafafa",
    "--a-text": "#0d0d10",
    "--a-secondary": "#55555c",
    "--a-muted": "#75757d",
    "--a-faint": "#a6a6ad",
    "--a-accent": "#5d50b0",
    "--a-on-accent": "#ffffff",
    "--a-raised": "#f4f4f5",
    "--a-sel-strong": "#e6e6ea",
    "--a-border": "#ececef",
    "--a-border-strong": "#dcdce0",
    "--a-input": "#ffffff",
    "--a-btn": "#0d0d10",
  },
  dark: {
    "--a-bg": "#0b0b0d",
    "--a-side": "#0f0f12",
    "--a-text": "#ededef",
    "--a-secondary": "#a0a0a8",
    "--a-muted": "#7a7a83",
    "--a-faint": "#55555d",
    "--a-accent": "#a8a5ec",
    "--a-on-accent": "#17152b",
    "--a-raised": "#1a1a1f",
    "--a-sel-strong": "#24242b",
    "--a-border": "#1f1f24",
    "--a-border-strong": "#2c2c33",
    "--a-input": "#0f0f12",
    "--a-btn": "#ededef",
  },
};

export function deriveTheme(seed: ThemeSeed, mode: ThemeMode): ThemeVars {
  const { bg, side, text, accent } = seed;
  const light = mode === "light";
  const onAccent =
    contrastRatio("#ffffff", accent) >= 4.5 ? "#ffffff" : mix(accent, "#000000", 0.86);
  return {
    "--a-bg": bg,
    "--a-side": side,
    "--a-text": text,
    "--a-accent": accent,
    "--a-panel": light ? bg : mix(bg, text, 0.04),
    "--a-raised": mix(bg, text, light ? 0.045 : 0.065),
    "--a-input": light ? bg : side,
    "--a-secondary": tone(text, bg, light ? 0.3 : 0.34, 7),
    "--a-muted": tone(text, bg, light ? 0.43 : 0.5, 4.5),
    "--a-faint": mix(text, bg, light ? 0.63 : 0.67),
    "--a-sel": mix(bg, text, light ? 0.065 : 0.066),
    "--a-sel-strong": mix(bg, text, light ? 0.1 : 0.11),
    "--a-border": mix(bg, text, light ? 0.075 : 0.085),
    "--a-border-strong": mix(bg, text, light ? 0.14 : 0.145),
    "--a-accent-hover": light ? mix(accent, "#000000", 0.12) : mix(accent, "#ffffff", 0.22),
    "--a-on-accent": contrastRatio(onAccent, accent) >= 4.5 ? onAccent : tone(text, accent, 1, 4.5),
    "--a-accent-subtle": mix(bg, accent, light ? 0.1 : 0.17),
    "--a-accent-border": mix(bg, accent, light ? 0.35 : 0.4),
    "--a-focus-ring": `rgba(${rgb(accent).join(", ")}, ${light ? 0.28 : 0.32})`,
    "--a-multi-sel": mix(bg, accent, light ? 0.17 : 0.2),
    "--a-multi-sel-strong": mix(bg, accent, light ? 0.27 : 0.32),
    "--a-btn": text,
    "--a-on-btn": bg,
    "--a-switch-off": mix(bg, text, light ? 0.14 : 0.145),
    "--a-switch-knob": light ? "#ffffff" : mix(text, bg, 0.42),
    "--a-code-bg": light ? side : mix(bg, text, 0.025),
    "--a-cat1": accent,
  };
}

/** 固定状态色等继续从 tokens.css 读取，不写入预设覆盖。 */
export function themeVars(id: string, mode: ThemeMode): ThemeVars {
  const preset = PRESETS.find((entry) => entry.id === id);
  return !preset || preset.id === "workbench" ? {} : deriveTheme(preset[mode], mode);
}

export function previewThemeVars(id: ThemePresetId, mode: ThemeMode): ThemeVars {
  return id === "workbench" ? WORKBENCH[mode] : themeVars(id, mode);
}
