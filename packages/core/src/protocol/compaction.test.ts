import { describe, expect, it } from "vitest";
import { parseCompactionThreshold } from "./compaction.js";

describe("压缩阈值", () => {
  it.each([
    ["90%", "percent", 90],
    ["0.1%", "percent", 0.1],
    ["100%", "percent", 100],
    [200000, "tokens", 200000],
    ["200000", "tokens", 200000],
    ["200k", "tokens", 200000],
    ["1.5m", "tokens", 1500000],
    ["0.001k", "tokens", 1],
    ["2M", "tokens", 2000000],
  ] as const)("解析 %s", (input, unit, value) => {
    expect(parseCompactionThreshold(input)).toEqual({ unit, value });
  });
  it.each([
    0,
    -1,
    1.1,
    Infinity,
    NaN,
    "0%",
    "101%",
    "0",
    "-2",
    "1.1",
    "0.0001k",
    "k",
    "",
    " 90%",
    "20t",
    Number.MAX_SAFE_INTEGER + 1,
  ])("拒绝 %s", (input) => {
    expect(() => parseCompactionThreshold(input)).toThrow("压缩阈值");
  });
});
