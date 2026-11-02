/**
 * 桌面端外观（设置 › 外观）：界面字体、代码字体、字号。只在桌面端入口应用；
 * 手机网页与安卓共用样式文件，但入口（web/main.tsx）不调用这里，设置不生效。
 *
 * 做法：在 <html> 的行内样式上覆盖 token。所选字体放到原字体栈最前面，原栈整体留作回退；
 * --fs-1..5 按 Math.round(原值 × 字号 / 14) 缩放。原值每次都从样式表现读（先清掉覆盖），
 * 所以 design/tokens.json 改了这里自动跟着变。
 */
import { FONT_SIZE_DEFAULT, readPrefs, type Prefs } from "./prefs";

export interface FontFamily {
  name: string;
  /** 外壳（fontdb）判定的等宽字体 */
  mono: boolean;
}

export type AppearancePrefs = Pick<Prefs, "uiFont" | "codeFont" | "fontSize">;

export const FONT_SIZE_VARS = ["--fs-1", "--fs-2", "--fs-3", "--fs-4", "--fs-5"] as const;
const OVERRIDDEN = ["--sans", "--mono", ...FONT_SIZE_VARS] as const;

/** 等比缩放一档字号（px） */
export function scaledFontSize(base: number, size: number): number {
  return Math.round((base * size) / FONT_SIZE_DEFAULT);
}

/** CSS 字符串字面量：字体名里的引号、反斜杠转义，换行等控制字符去掉 */
export function cssFontName(name: string): string {
  return `"${name.replace(/[\u0000-\u001f\u007f]/g, "").replace(/["\\]/g, "\\$&")}"`;
}

/** 所选字体在前，原字体栈整体留作回退；没选就是原栈 */
export function fontStack(name: string | undefined, base: string): string {
  if (name === undefined || name.trim() === "") return base;
  return base.trim() === "" ? cssFontName(name) : `${cssFontName(name)}, ${base}`;
}

/**
 * 把外观设置写到根元素。先清掉旧覆盖再从计算样式读原值；样式表还没就绪（读不到）时
 * 对应项不覆盖，保持原 token。
 */
/** 上次应用时读到的原字体栈（被覆盖后计算样式里就读不到原值了） */
const baseStacks = new Map<string, string>();

/** 没被覆盖的原字体栈：字体下拉里「默认」一项用它显示 */
export function baseFontStack(root: HTMLElement, kind: "ui" | "code"): string {
  const name = kind === "ui" ? "--sans" : "--mono";
  if (root.style.getPropertyValue(name) === "") {
    return getComputedStyle(root).getPropertyValue(name).trim();
  }
  return baseStacks.get(name) ?? "";
}

export function applyAppearance(root: HTMLElement, prefs: AppearancePrefs): void {
  for (const name of OVERRIDDEN) root.style.removeProperty(name);
  const size = prefs.fontSize ?? FONT_SIZE_DEFAULT;
  if (prefs.uiFont === undefined && prefs.codeFont === undefined && size === FONT_SIZE_DEFAULT) {
    return;
  }
  const style = getComputedStyle(root);
  const read = (name: string) => style.getPropertyValue(name).trim();
  const sans = read("--sans");
  const mono = read("--mono");
  const bases = FONT_SIZE_VARS.map((name) => [name, Number.parseFloat(read(name))] as const);
  baseStacks.set("--sans", sans);
  baseStacks.set("--mono", mono);
  if (prefs.uiFont !== undefined && sans !== "") {
    root.style.setProperty("--sans", fontStack(prefs.uiFont, sans));
  }
  if (prefs.codeFont !== undefined && mono !== "") {
    root.style.setProperty("--mono", fontStack(prefs.codeFont, mono));
  }
  if (size !== FONT_SIZE_DEFAULT) {
    for (const [name, base] of bases) {
      if (Number.isFinite(base)) root.style.setProperty(name, `${scaledFontSize(base, size)}px`);
    }
  }
}

export type ThemePref = "system" | "light" | "dark";

/** 主题：跟随系统时删掉属性回到 prefers-color-scheme */
export function applyTheme(root: HTMLElement, theme: ThemePref): void {
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
}

/** 桌面端入口在首次渲染前调用：读本机 prefs，应用主题与字体；存储不可读时按缺省 */
export function applyStoredAppearance(root: HTMLElement): void {
  let storage: Storage | undefined;
  try {
    storage = globalThis.localStorage;
  } catch {
    storage = undefined;
  }
  const prefs = readPrefs(storage);
  applyTheme(root, prefs.theme ?? "system");
  applyAppearance(root, prefs);
}

/**
 * 字体下拉的选项顺序：代码字体等宽在前，界面字体非等宽在前；各组内保持外壳给的顺序。
 * 返回两组，界面在两组之间画分隔线。
 */
export function fontGroups(
  fonts: readonly FontFamily[],
  kind: "ui" | "code",
): [FontFamily[], FontFamily[]] {
  const mono = fonts.filter((font) => font.mono);
  const other = fonts.filter((font) => !font.mono);
  return kind === "code" ? [mono, other] : [other, mono];
}
