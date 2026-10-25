import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRUNE_LIMIT,
  parseCompactionPruneLimit,
  parseCompactionThreshold,
} from "./compaction.js";

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

describe("修剪绝对上限（ADR-0066）", () => {
  it("默认 200,000，接受 0 与正整数，拒绝非法值", () => {
    expect(DEFAULT_PRUNE_LIMIT).toBe(200_000);
    expect(parseCompactionPruneLimit(0)).toBe(0);
    expect(parseCompactionPruneLimit(200_000)).toBe(200_000);
    expect(parseCompactionPruneLimit(1)).toBe(1);
    for (const bad of [
      -1,
      1.5,
      NaN,
      Infinity,
      "200000",
      "80%",
      null,
      undefined,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() => parseCompactionPruneLimit(bad)).toThrow("修剪上限");
    }
  });
});
