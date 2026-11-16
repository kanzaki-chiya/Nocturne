import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  applyContentWidth,
  applyStoredAppearance,
  applyThemePreset,
  watchTheme,
} from "../src/appearance";
import { deriveTheme, PRESETS, previewThemeVars, themeVars } from "../src/theme-presets";
import { createPrefsStore, PREFS_KEY } from "../src/prefs";

// 按 WCAG 相对亮度独立核算，不复用主题引擎的对比度函数。
function contrastRatio(first: string, second: string): number {
  const luma = (color: string) => {
    const packed = Number.parseInt(color.slice(1), 16);
    return [16, 8, 0].reduce((sum, shift, index) => {
      const channel = ((packed >> shift) & 255) / 255;
      const linear =
        channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
      return sum + linear * ([0.2126, 0.7152, 0.0722][index] ?? 0);
    }, 0);
  };
  const a = luma(first) + 0.05;
  const b = luma(second) + 0.05;
  return Math.max(a / b, b / a);
}

const root = document.documentElement;
afterEach(() => {
  root.removeAttribute("style");
  root.removeAttribute("data-theme");
  root.removeAttribute("data-content-width");
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("主题预设", () => {
  it("非强调色的代码注释与活动行保持工作台原色，切换模式才变化", () => {
    const sheet = document.createElement("style");
    sheet.textContent = readFileSync(
      path.resolve(import.meta.dirname, "../src/tokens.css"),
      "utf8",
    );
    document.head.append(sheet);
    try {
      for (const mode of ["light", "dark"] as const) {
        root.dataset.theme = mode;
        for (const preset of PRESETS) {
          applyThemePreset(root, preset.id, mode);
          const style = getComputedStyle(root);
          expect(style.getPropertyValue("--cm-comment").trim()).toBe(
            mode === "light" ? "#a6a6ad" : "#55555d",
          );
          expect(style.getPropertyValue("--cm-active-line").replace(/\s/g, "")).toBe(
            `color-mix(insrgb,${mode === "light" ? "#f4f4f5" : "#1a1a1f"}70%,transparent)`,
          );
          expect(style.getPropertyValue("--cm-keyword").trim()).toBe("var(--a-accent)");
        }
      }
    } finally {
      sheet.remove();
    }
  });
  for (const preset of PRESETS)
    for (const mode of ["light", "dark"] as const) {
      it(`${preset.name} ${mode}：次要文字≥7、弱化文字≥4.5、强调色上文字≥4.5`, () => {
        const vars = previewThemeVars(preset.id, mode);
        const color = (key: string) => {
          const value = vars[`--a-${key}`];
          expect(value).toBeDefined();
          return value ?? "";
        };
        expect(contrastRatio(color("secondary"), color("bg"))).toBeGreaterThanOrEqual(7);
        expect(contrastRatio(color("muted"), color("bg"))).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(color("on-accent"), color("accent"))).toBeGreaterThanOrEqual(4.5);
      });
    }
  it("工作台与未知 id 返回空表", () => {
    for (const mode of ["light", "dark"] as const) {
      expect(themeVars("workbench", mode)).toEqual({});
      expect(themeVars("unknown", mode)).toEqual({});
    }
  });
  it("纸面种子与推算值照抄效果图，固定颜色由原 token 提供", () => {
    const vars = deriveTheme(PRESETS[2].light, "light");
    expect(vars["--a-bg"]).toBe("#fbfaf6");
    expect(vars["--a-side"]).toBe("#f3f1ea");
    expect(vars["--a-accent"]).toBe("#9a5b2e");
    expect(vars["--a-on-accent"]).toBe("#ffffff");
    expect(
      Object.keys(vars).some((name) =>
        /success|warning|error|accentAlt|cat[2-5]|overlay|qr-bg/.test(name),
      ),
    ).toBe(false);
  });
  it("切换清掉上一套变量，工作台恢复 tokens.css 原值且保留字体", () => {
    const sheet = document.createElement("style");
    sheet.textContent = readFileSync(
      path.resolve(import.meta.dirname, "../src/tokens.css"),
      "utf8",
    );
    document.head.append(sheet);
    try {
      root.dataset.theme = "light";
      root.style.setProperty("--sans", "Consolas");
      applyThemePreset(root, "paper", "light");
      root.style.setProperty("--a-old", "#123456");
      applyThemePreset(root, "ink", "dark");
      expect(root.style.getPropertyValue("--a-bg")).toBe("#000000");
      expect(root.style.getPropertyValue("--a-old")).toBe("");
      applyThemePreset(root, "workbench", "light");
      expect(Array.from(root.style).filter((name) => name.startsWith("--a-"))).toEqual([]);
      expect(getComputedStyle(root).getPropertyValue("--a-bg").trim()).toBe("#ffffff");
      expect(root.style.getPropertyValue("--sans")).toBe("Consolas");
    } finally {
      sheet.remove();
    }
  });
  it("首屏读取预设缓存，模式与系统变化重新推算并退订", () => {
    const media = { matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    vi.stubGlobal("matchMedia", () => media);
    localStorage.setItem(PREFS_KEY, JSON.stringify({ themePreset: "paper", contentWidth: "wide" }));
    applyStoredAppearance(root);
    expect(root.style.getPropertyValue("--a-bg")).toBe("#fbfaf6");
    expect(root.dataset.contentWidth).toBe("wide");
    const stop = watchTheme(root, "system", "paper");
    const change = media.addEventListener.mock.calls[0]?.[1] as (() => void) | undefined;
    media.matches = false;
    change?.();
    expect(root.style.getPropertyValue("--a-bg")).toBe("#171512");
    stop();
    expect(media.removeEventListener).toHaveBeenCalledWith("change", change);
  });
  it("prefs 持久化内容宽度与预设，非法值回退并可恢复标准", () => {
    const store = createPrefsStore(localStorage);
    store.update({ themePreset: "celadon", contentWidth: "full" });
    expect(createPrefsStore(localStorage).get()).toMatchObject({
      themePreset: "celadon",
      contentWidth: "full",
    });
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({ themePreset: "alien", contentWidth: "alien" }),
    );
    expect(createPrefsStore(localStorage).get()).toMatchObject({ themePreset: "workbench" });
    expect(createPrefsStore(localStorage).get().contentWidth).toBeUndefined();
    applyContentWidth(root, "full");
    expect(root.dataset.contentWidth).toBe("full");
    applyContentWidth(root, "standard");
    expect(root.dataset.contentWidth).toBeUndefined();
  });
});
