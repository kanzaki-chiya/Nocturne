/** 外观配色依据与推算契约：ADR-0093；此模块不访问 DOM 或客户端存储。 */
export type ThemeMode = "light" | "dark";
export interface ThemeSeed {
  bg: string;
  side: string;
  text: string;
  accent: string;
}
export interface CustomThemeSeed {
  bg: string;
  text: string;
  accent: string;
}
export type CustomTheme = CustomThemeSeed & {
  id: string;
  name: string;
};
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

export function themePresetId(id: unknown, customThemes?: readonly CustomTheme[]): string {
  const preset = PRESETS.find((entry) => entry.id === id);
  if (preset) return preset.id;
  if (typeof id === "string" && customThemes?.some((entry) => entry.id === id)) return id;
  return "workbench";
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR.test(value);
}

export function parseCustomTheme(
  value: unknown,
  options?: { allowEmptyName?: boolean },
): CustomTheme | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (id === "") return undefined;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (options?.allowEmptyName !== true && name === "") return undefined;
  if (!isHexColor(record.bg) || !isHexColor(record.text) || !isHexColor(record.accent)) {
    return undefined;
  }
  return {
    id,
    name,
    bg: record.bg.toLowerCase(),
    text: record.text.toLowerCase(),
    accent: record.accent.toLowerCase(),
  };
}

export function parseCustomThemesJson(raw: unknown): CustomTheme[] {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    if (raw.trim() === "") return [];
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  const themes: CustomTheme[] = [];
  const seen = new Set<string>();
  for (const entry of parsed) {
    const theme = parseCustomTheme(entry);
    if (!theme || seen.has(theme.id)) continue;
    seen.add(theme.id);
    themes.push(theme);
  }
  return themes;
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

const srgbToLinear = (channel: number): number => {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
};
const linearToSrgb = (value: number): number =>
  255 * (value <= 0.0031308 ? 12.92 * value : 1.055 * Math.pow(value, 1 / 2.4) - 0.055);

function toOk(color: string): [number, number, number] {
  const [r = 0, g = 0, b = 0] = rgb(color).map(srgbToLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), Math.atan2(B, A)];
}

function okRaw(L: number, C: number, H: number): [number, number, number] {
  const A = C * Math.cos(H);
  const B = C * Math.sin(H);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function fromOk(L: number, C: number, H: number): string {
  let c = C;
  for (let i = 0; i < 40; i++) {
    const v = okRaw(L, c, H);
    if (v.every((x) => x >= -1e-4 && x <= 1 + 1e-4)) return hex(v.map(linearToSrgb));
    c *= 0.92;
  }
  return hex(okRaw(L, 0, H).map(linearToSrgb));
}

function atContrast(C: number, H: number, bg: string, target: number, lighter: boolean): string {
  let lo = lighter ? toOk(bg)[0] : 0;
  let hi = lighter ? 1 : toOk(bg)[0];
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    const c = contrastRatio(fromOk(mid, C, H), bg);
    if (lighter) {
      if (c >= target) hi = mid;
      else lo = mid;
    } else {
      if (c >= target) lo = mid;
      else hi = mid;
    }
  }
  return fromOk(lighter ? hi : lo, C, H);
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

function flipSeed(seed: CustomThemeSeed): CustomThemeSeed {
  const [Lb, Cb, Hb] = toOk(seed.bg);
  const toLight = Lb <= 0.5;
  const bg = toLight
    ? fromOk(clamp(1 - (Lb - 0.15) / 2, 0.94, 1), Cb * 0.4, Hb)
    : fromOk(clamp(0.15 + (1 - Lb) * 2, 0.13, 0.24), Math.min(Cb * 2.5, 0.025), Hb);
  const [, Ct, Ht] = toOk(seed.text);
  const [La, Ca, Ha] = toOk(seed.accent);
  const tc = contrastRatio(seed.text, seed.bg);
  const ac = contrastRatio(seed.accent, seed.bg);
  const text = atContrast(
    Ct,
    Ht,
    bg,
    toLight ? clamp(tc, 15, 17.5) : clamp(tc, 14, 16.5),
    !toLight,
  );
  const mono = Math.abs(La - toOk(seed.text)[0]) < 0.03 && Ca < 0.03;
  const accent = mono
    ? text
    : atContrast(
        toLight ? Ca / 0.85 : Ca * 0.85,
        Ha,
        bg,
        toLight ? clamp(ac - 3, 4.5, 6.5) : clamp(ac + 3, 7.5, 10),
        !toLight,
      );
  return { bg, text, accent };
}

const withSide = (seed: CustomThemeSeed, light: boolean): ThemeSeed => ({
  bg: seed.bg,
  side: mix(seed.bg, seed.text, light ? 0.04 : 0.03),
  text: seed.text,
  accent: seed.accent,
});

/** 依据单面三色种子在 OKLCH 空间推算深浅双面四色（自定义主题第二期）。 */
export function expandCustomTheme(seed: CustomThemeSeed): { light: ThemeSeed; dark: ThemeSeed } {
  const light = toOk(seed.bg)[0] > 0.5;
  const other = flipSeed(seed);
  return light
    ? { light: withSide(seed, true), dark: withSide(other, false) }
    : { light: withSide(other, true), dark: withSide(seed, false) };
}

/** 固定状态色等继续从 tokens.css 读取，不写入预设覆盖。 */
export function themeVars(
  id: string,
  mode: ThemeMode,
  customThemes?: readonly CustomTheme[],
): ThemeVars {
  const preset = PRESETS.find((entry) => entry.id === id);
  if (preset) {
    return preset.id === "workbench" ? {} : deriveTheme(preset[mode], mode);
  }
  const custom = customThemes?.find((entry) => entry.id === id);
  return custom ? deriveTheme(expandCustomTheme(custom)[mode], mode) : {};
}

export function previewThemeVars(
  id: string,
  mode: ThemeMode,
  customThemes?: readonly CustomTheme[],
): ThemeVars {
  return id === "workbench" ? WORKBENCH[mode] : themeVars(id, mode, customThemes);
}
