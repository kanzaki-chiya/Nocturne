/**
 * 选区（selection.ts）：坐标换算（中文宽字符）、选区规范化、
 * 复制文本（折行续行拼回/行尾空白/真换行保留）、主题选区分段。
 */
import { describe, expect, it } from "vitest";

import { palettes } from "../src/theme.js";

import {
  colFromDisplay,
  selCopyText,
  selIsEmpty,
  selNormalized,
  selRangeOnLine,
  selSegments,
} from "../src/selection.js";
import type { LaidLine } from "../src/viewport.js";

const L = (text: string, extra?: Partial<LaidLine>): LaidLine => ({
  key: text,
  text,
  ...extra,
});

describe("列换算", () => {
  it("ASCII 列与字符一一对应；越界收到行尾", () => {
    expect(colFromDisplay("hello", 0)).toBe(0);
    expect(colFromDisplay("hello", 3)).toBe(3);
    expect(colFromDisplay("hello", 99)).toBe(5);
  });

  it("中文占两列：落在右半格按整个字符收到字符之后", () => {
    // 「中」占显示列 0-1，「文」占 2-3
    expect(colFromDisplay("中文ab", 0)).toBe(0);
    expect(colFromDisplay("中文ab", 1)).toBe(1); // 中 的右半格 → 字符后
    expect(colFromDisplay("中文ab", 2)).toBe(1);
    expect(colFromDisplay("中文ab", 3)).toBe(2);
    expect(colFromDisplay("中文ab", 4)).toBe(2);
    expect(colFromDisplay("中文ab", 5)).toBe(3);
  });
});

describe("选区规范化", () => {
  it("反向拖动交换端点；同点为空选区", () => {
    const sel = { anchor: { abs: 5, col: 9 }, head: { abs: 2, col: 1 } };
    expect(selNormalized(sel)).toEqual({
      from: { abs: 2, col: 1 },
      to: { abs: 5, col: 9 },
    });
    expect(selIsEmpty(sel)).toBe(false);
    expect(selIsEmpty({ anchor: { abs: 1, col: 2 }, head: { abs: 1, col: 2 } })).toBe(true);
  });

  it("行范围：首行从 anchor 到尾、中间行整行、末行到头", () => {
    const sel = { anchor: { abs: 1, col: 2 }, head: { abs: 3, col: 4 } };
    expect(selRangeOnLine(sel, 0)).toBeUndefined();
    expect(selRangeOnLine(sel, 1)).toEqual({ start: 2, end: Number.MAX_SAFE_INTEGER });
    expect(selRangeOnLine(sel, 2)).toEqual({ start: 0, end: Number.MAX_SAFE_INTEGER });
    expect(selRangeOnLine(sel, 3)).toEqual({ start: 0, end: 4 });
    expect(selRangeOnLine(sel, 4)).toBeUndefined();
  });
});

describe("复制文本", () => {
  it("多行选区拼接，行尾空白去掉，真换行保留", () => {
    const lines = [L("第一行   "), L("第二行"), L("第三行  "), L("第四行")];
    const sel = { anchor: { abs: 0, col: 1 }, head: { abs: 2, col: 3 } };
    expect(selCopyText(lines, sel)).toBe("一行\n第二行\n第三行");
  });

  it("自动折行续行拼回原逻辑行；续行断点不加换行", () => {
    const lines = [
      L("一段很长的话被折"),
      L("成了两行", { continued: true }),
      L("下一行是真的换行"),
    ];
    const sel = { anchor: { abs: 0, col: 0 }, head: { abs: 2, col: 8 } };
    expect(selCopyText(lines, sel)).toBe("一段很长的话被折成了两行\n下一行是真的换行");
  });

  it("反向拖动复制结果一致；空选区为空串", () => {
    const lines = [L("abc"), L("def")];
    const fwd = { anchor: { abs: 0, col: 1 }, head: { abs: 1, col: 2 } };
    const bwd = { anchor: { abs: 1, col: 2 }, head: { abs: 0, col: 1 } };
    expect(selCopyText(lines, fwd)).toBe("bc\nde");
    expect(selCopyText(lines, bwd)).toBe("bc\nde");
    expect(selCopyText(lines, { anchor: { abs: 0, col: 0 }, head: { abs: 0, col: 0 } })).toBe("");
  });
});

describe("高亮分段", () => {
  it("选区部分使用主题前景与底色，保留原分段样式", () => {
    const line = L("aXbYc", {
      segments: [{ text: "aX", color: "red" }, { text: "bY", dim: true }, { text: "c" }],
    });
    const segs = selSegments(line, { start: 1, end: 4 });
    expect(segs).toEqual([
      { text: "a", color: "red" },
      { text: "X", color: palettes.dark.selected, backgroundColor: palettes.dark.selectionBg },
      {
        text: "bY",
        dim: true,
        color: palettes.dark.selected,
        backgroundColor: palettes.dark.selectionBg,
      },
      { text: "c" },
    ]);
  });

  it("无分段的行整行拆；越界范围整行高亮", () => {
    const segs = selSegments(L("abc"), { start: 0, end: Number.MAX_SAFE_INTEGER });
    expect(segs).toEqual([
      { text: "abc", color: palettes.dark.selected, backgroundColor: palettes.dark.selectionBg },
    ]);
  });
});
