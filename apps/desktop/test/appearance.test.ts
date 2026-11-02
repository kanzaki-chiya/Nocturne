/**
 * 设置 › 外观的字体与字号：字号缩放、字体栈拼接、首屏应用、恢复默认。
 * 期望值按需求手算：Math.round(原值 × 字号 / 14)，原值取 tokens.css（12/13/14/16/22）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyAppearance,
  applyStoredAppearance,
  baseFontStack,
  cssFontName,
  fontGroups,
  fontStack,
  scaledFontSize,
} from "../src/appearance";
import { PREFS_KEY } from "../src/prefs";

const TOKENS = readFileSync(path.resolve(import.meta.dirname, "../src/tokens.css"), "utf8");
const SANS =
  '"Noto Sans SC", "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif';
const MONO = '"JetBrains Mono", "Cascadia Mono", Consolas, "Microsoft YaHei", monospace';

const root = document.documentElement;
/** jsdom 读回的字体栈会吞掉逗号后的空格（浏览器原样保留），比较前统一 */
const stack = (name: string) => root.style.getPropertyValue(name).replace(/,\s*/g, ", ");
const fs = (n: number) => root.style.getPropertyValue(`--fs-${n}`);
const sizes = () =>
  [1, 2, 3, 4, 5].map((n) => getComputedStyle(root).getPropertyValue(`--fs-${n}`).trim());

beforeEach(() => {
  const style = document.createElement("style");
  style.id = "tokens";
  style.textContent = TOKENS;
  document.head.appendChild(style);
});

afterEach(() => {
  document.getElementById("tokens")?.remove();
  root.removeAttribute("style");
  delete root.dataset.theme;
  localStorage.clear();
});

describe("字号缩放", () => {
  it("按 Math.round(原值 × 字号 / 14) 计算", () => {
    expect([12, 13, 14, 16, 22].map((base) => scaledFontSize(base, 20))).toEqual([
      17, 19, 20, 23, 31,
    ]);
    expect([12, 13, 14, 16, 22].map((base) => scaledFontSize(base, 12))).toEqual([
      10, 11, 12, 14, 19,
    ]);
    expect([12, 13, 14, 16, 22].map((base) => scaledFontSize(base, 14))).toEqual([
      12, 13, 14, 16, 22,
    ]);
  });

  it("写到根元素的 --fs-1..5，原值来自样式表", () => {
    expect(sizes()).toEqual(["12px", "13px", "14px", "16px", "22px"]);
    applyAppearance(root, { fontSize: 20 });
    expect(sizes()).toEqual(["17px", "19px", "20px", "23px", "31px"]);
    applyAppearance(root, { fontSize: 12 });
    expect(sizes()).toEqual(["10px", "11px", "12px", "14px", "19px"]);
  });

  it("重复应用不叠加缩放，回到 14 即清掉覆盖（恢复默认）", () => {
    applyAppearance(root, { fontSize: 20 });
    applyAppearance(root, { fontSize: 20 });
    expect(fs(2)).toBe("19px");
    applyAppearance(root, {});
    expect([1, 2, 3, 4, 5].map(fs)).toEqual(["", "", "", "", ""]);
    expect(sizes()).toEqual(["12px", "13px", "14px", "16px", "22px"]);
  });
});

describe("字体栈", () => {
  it("所选字体在前，原栈整体留作回退", () => {
    expect(fontStack("Fira Code", MONO)).toBe(`"Fira Code", ${MONO}`);
    expect(fontStack(undefined, SANS)).toBe(SANS);
    expect(fontStack("  ", SANS)).toBe(SANS);
  });

  it("字体名里的引号与反斜杠转义，控制字符去掉", () => {
    expect(cssFontName('A "B"\\C\nD')).toBe('"A \\"B\\"\\\\CD"');
  });

  it("应用到 --sans / --mono；默认项显示用的原栈不受覆盖影响", () => {
    applyAppearance(root, { uiFont: "Segoe UI", codeFont: "Consolas" });
    expect(stack("--sans")).toBe(`"Segoe UI", ${SANS}`);
    expect(stack("--mono")).toBe(`"Consolas", ${MONO}`);
    expect(baseFontStack(root, "ui").replace(/,\s*/g, ", ")).toBe(SANS);
    expect(baseFontStack(root, "code").replace(/,\s*/g, ", ")).toBe(MONO);
    // 换一个字体：仍然是「新字体, 原栈」，不会把上一个字体留在栈里
    applyAppearance(root, { uiFont: "Inter", codeFont: "Consolas" });
    expect(stack("--sans")).toBe(`"Inter", ${SANS}`);
    applyAppearance(root, {});
    expect(stack("--sans")).toBe("");
  });

  it("代码字体等宽在前，界面字体非等宽在前", () => {
    const fonts = [
      { name: "Arial", mono: false },
      { name: "Consolas", mono: true },
      { name: "Segoe UI", mono: false },
      { name: "Fira Code", mono: true },
    ];
    expect(fontGroups(fonts, "code").map((g) => g.map((f) => f.name))).toEqual([
      ["Consolas", "Fira Code"],
      ["Arial", "Segoe UI"],
    ]);
    expect(fontGroups(fonts, "ui").map((g) => g.map((f) => f.name))).toEqual([
      ["Arial", "Segoe UI"],
      ["Consolas", "Fira Code"],
    ]);
  });
});

describe("首屏应用", () => {
  it("读本机 prefs，在渲染前应用主题、字体与字号", () => {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({ theme: "light", uiFont: "Inter", codeFont: "Fira Code", fontSize: 16 }),
    );
    applyStoredAppearance(root);
    expect(root.dataset.theme).toBe("light");
    expect(stack("--sans")).toBe(`"Inter", ${SANS}`);
    expect(stack("--mono")).toBe(`"Fira Code", ${MONO}`);
    expect(sizes()).toEqual(["14px", "15px", "16px", "18px", "25px"]);
  });

  it("越界或类型不对的字号不应用", () => {
    for (const fontSize of [11, 21, 15.5, "16"]) {
      root.removeAttribute("style");
      localStorage.setItem(PREFS_KEY, JSON.stringify({ fontSize }));
      applyStoredAppearance(root);
      expect(fs(1)).toBe("");
    }
  });

  it("存储读不了时按缺省外观，不抛错", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError");
      },
    });
    try {
      expect(() => {
        applyStoredAppearance(root);
      }).not.toThrow();
      expect(root.getAttribute("style")).toBeNull();
      expect(root.dataset.theme).toBeUndefined();
    } finally {
      if (original) Object.defineProperty(globalThis, "localStorage", original);
    }
  });
});
