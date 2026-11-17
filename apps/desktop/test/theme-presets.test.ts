import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  applyContentWidth,
  applyStoredAppearance,
  applyThemePreset,
  watchTheme,
} from "../src/appearance";
import {
  deriveTheme,
  expandCustomTheme,
  PRESETS,
  previewThemeVars,
  themePresetId,
  themeVars,
  type CustomTheme,
} from "../src/theme-presets";
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
  it.each([
    ["paper", "light"],
    ["ink", "dark"],
  ] as const)("%s %s：代码注释解析为主题 faint，当前行跟随 raised", (id, mode) => {
    const sheet = document.createElement("style");
    sheet.textContent = readFileSync(
      path.resolve(import.meta.dirname, "../src/tokens.css"),
      "utf8",
    );
    document.head.append(sheet);
    try {
      root.dataset.theme = mode;
      applyThemePreset(root, id, mode);
      const style = getComputedStyle(root);
      const comment = style.getPropertyValue("--cm-comment").trim();
      expect(comment).toBe("var(--a-faint)");
      // jsdom 保留自定义属性引用，按浏览器的 var 语义解析后核对实际主题值。
      const resolved = comment.replace(/var\((--[\w-]+)\)/g, (_match, name: string) =>
        style.getPropertyValue(name).trim(),
      );
      expect(resolved).toBe(style.getPropertyValue("--a-faint").trim());
      expect(resolved).toBe(id === "paper" ? "#a4a39f" : "#505050");
      expect(style.getPropertyValue("--cm-active-line").replace(/\s/g, "")).toBe(
        "color-mix(insrgb,var(--a-raised)70%,transparent)",
      );
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
  it("纸面种子与推算值匹配预设，固定颜色由原 token 提供", () => {
    const vars = deriveTheme(PRESETS[2].light, "light");
    expect(vars["--a-bg"]).toBe("#fbfaf6");
    expect(vars["--a-side"]).toBe("#f5f4f0");
    expect(vars["--a-accent"]).toBe("#9a5b2e");
    expect(vars["--a-on-accent"]).toBe("#ffffff");
    expect(
      Object.keys(vars).some((name) =>
        /success|warning|error|accentAlt|cat[2-5]|overlay|qr-bg/.test(name),
      ),
    ).toBe(false);
  });
  it("浅色夜曲、纸面、青瓷正文对比度≥18，推算表面按新比例生成，松烟强调色独立可辨", () => {
    const mixSrgb = (bg: string, fg: string, ratio: number) =>
      "#" +
      [0, 2, 4]
        .map((offset) => {
          const a = Number.parseInt(bg.slice(1 + offset, 3 + offset), 16);
          const b = Number.parseInt(fg.slice(1 + offset, 3 + offset), 16);
          return Math.max(0, Math.min(255, Math.round(a + (b - a) * ratio)))
            .toString(16)
            .padStart(2, "0");
        })
        .join("");
    for (const id of ["nocturne", "paper", "celadon"] as const) {
      const vars = themeVars(id, "light");
      expect(contrastRatio(vars["--a-text"] ?? "", vars["--a-bg"] ?? "")).toBeGreaterThanOrEqual(
        18,
      );
    }
    for (const preset of PRESETS) {
      if (preset.id === "workbench") continue;
      const vars = themeVars(preset.id, "light");
      const { bg, text } = preset.light;
      expect(vars["--a-raised"]).toBe(mixSrgb(bg, text, 0.048));
      expect(vars["--a-border"]).toBe(mixSrgb(bg, text, 0.08));
      expect(vars["--a-border-strong"]).toBe(mixSrgb(bg, text, 0.15));
    }
    for (const mode of ["light", "dark"] as const) {
      const vars = themeVars("ink", mode);
      const accent = vars["--a-accent"] ?? "";
      const bg = vars["--a-bg"] ?? "";
      const text = vars["--a-text"] ?? "";
      const onAccent = vars["--a-on-accent"] ?? "";
      expect(accent).not.toBe(text);
      expect(contrastRatio(accent, bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(onAccent, accent)).toBeGreaterThanOrEqual(4.5);
    }
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

  it.each([
    [
      { bg: "#fbfaf6", text: "#1f1d1a", accent: "#9a5b2e" },
      {
        light: { bg: "#fbfaf6", side: "#f2f1ed", text: "#1f1d1a", accent: "#9a5b2e" },
        dark: { bg: "#13120b", side: "#1a1912", text: "#f0eee9", accent: "#d99e78" },
      },
    ],
    [
      { bg: "#0a1213", text: "#e2eeee", accent: "#83c4c8" },
      {
        light: { bg: "#f7fcfd", side: "#eef3f4", text: "#182021", accent: "#05666b" },
        dark: { bg: "#0a1213", side: "#10191a", text: "#e2eeee", accent: "#83c4c8" },
      },
    ],
    [
      { bg: "#ffffff", text: "#111111", accent: "#111111" },
      {
        light: { bg: "#ffffff", side: "#f5f5f5", text: "#111111", accent: "#111111" },
        dark: { bg: "#0b0b0b", side: "#121212", text: "#ebebeb", accent: "#ebebeb" },
      },
    ],
    [
      { bg: "#f6f8fa", text: "#16202a", accent: "#2f6db5" },
      {
        light: { bg: "#f6f8fa", side: "#edeff2", text: "#16202a", accent: "#2f6db5" },
        dark: { bg: "#121518", side: "#181c1f", text: "#e0eefc", accent: "#79aef0" },
      },
    ],
    [
      { bg: "#11140f", text: "#e5eadf", accent: "#a3c98a" },
      {
        light: { bg: "#f8faf7", side: "#eff1ee", text: "#20231b", accent: "#3d651b" },
        dark: { bg: "#11140f", side: "#171a15", text: "#e5eadf", accent: "#a3c98a" },
      },
    ],
  ])("expandCustomTheme 严格匹配五组参考种子色 %#", (seed, expected) => {
    expect(expandCustomTheme(seed)).toEqual(expected);
  });

  it("id 解析、themeVars 与 previewThemeVars 支持自定义列表且内置预设优先、未知回退工作台", () => {
    const custom: CustomTheme[] = [
      { id: "c-fog", name: "雾蓝", bg: "#f6f8fa", text: "#16202a", accent: "#2f6db5" },
      { id: "paper", name: "冒名纸面", bg: "#000000", text: "#ffffff", accent: "#ff0000" },
    ];
    expect(themePresetId("paper", custom)).toBe("paper");
    expect(themePresetId("c-fog", custom)).toBe("c-fog");
    expect(themePresetId("c-missing", custom)).toBe("workbench");
    expect(themePresetId("c-fog")).toBe("workbench");

    expect(themeVars("paper", "light", custom)["--a-bg"]).toBe("#fbfaf6");
    expect(themeVars("c-fog", "light", custom)["--a-bg"]).toBe("#f6f8fa");
    expect(themeVars("c-fog", "dark", custom)["--a-bg"]).toBe("#121518");
    expect(previewThemeVars("c-fog", "dark", custom)).toEqual(themeVars("c-fog", "dark", custom));
    expect(previewThemeVars("workbench", "light", custom)["--a-bg"]).toBe("#ffffff");
    expect(themeVars("c-missing", "light", custom)).toEqual({});
    expect(previewThemeVars("c-missing", "light", custom)).toEqual({});
  });

  it("deriveTheme 保持第一期行为，不调整用户原三色低对比度", () => {
    const lowContrast = { bg: "#777777", side: "#707070", text: "#888888", accent: "#999999" };
    const vars = deriveTheme(lowContrast, "light");
    expect(vars["--a-bg"]).toBe("#777777");
    expect(vars["--a-text"]).toBe("#888888");
    expect(vars["--a-accent"]).toBe("#999999");
  });

  it("首屏 applyStoredAppearance 应用缓存的自定义主题三色，损坏或失配时回退工作台", () => {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({
        theme: "dark",
        themePreset: "c-fog",
        customTheme: {
          id: "c-fog",
          name: "雾蓝",
          bg: "#f6f8fa",
          text: "#16202a",
          accent: "#2f6db5",
        },
      }),
    );
    applyStoredAppearance(root);
    expect(root.style.getPropertyValue("--a-bg")).toBe("#121518");
    expect(root.style.getPropertyValue("--a-side")).toBe("#181c1f");

    // 缓存失配或损坏时回退工作台并清掉旧覆盖
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({
        theme: "light",
        themePreset: "c-fog",
        customTheme: { id: "c-fog", bg: "bad", text: "#16202a", accent: "#2f6db5" },
      }),
    );
    applyStoredAppearance(root);
    expect(Array.from(root.style).filter((name) => name.startsWith("--a-"))).toEqual([]);
  });
});
