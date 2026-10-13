import { describe, expect, it } from "vitest";
import {
  budgetUserMessages,
  omittedMarker,
  projectNotesFrom,
  USER_MESSAGE_LIMIT,
  USER_MESSAGES_BUDGET,
} from "./review-input.js";

describe("审查输入：用户消息预算", () => {
  it("预算内全部保留，空消息丢弃", () => {
    expect(budgetUserMessages(["a", "", "  ", "b"])).toEqual(["a", "b"]);
  });

  it("单条截断到 2000 字", () => {
    const [only] = budgetUserMessages(["x".repeat(5000)]);
    expect(only).toHaveLength(USER_MESSAGE_LIMIT);
  });

  it("超出总预算：保留第一条和尽量多的最近几条，中间插入省略标记", () => {
    const messages = Array.from({ length: 12 }, (_, i) => `${String(i)}:`.padEnd(1500, "x"));
    const result = budgetUserMessages(messages);
    expect(result[0]).toBe(messages[0]);
    const tailCount = result.length - 2;
    expect(result[1]).toBe(omittedMarker(12 - 1 - tailCount));
    expect(result.at(-1)).toBe(messages.at(-1));
    const kept = result.filter((text) => !text.startsWith("（省略"));
    expect(kept.reduce((sum, text) => sum + text.length, 0)).toBeLessThanOrEqual(
      USER_MESSAGES_BUDGET,
    );
    // 尽量多：再多留一条就会超出预算
    expect(1500 * (tailCount + 1) + 16).toBeLessThanOrEqual(USER_MESSAGES_BUDGET);
    expect(1500 * (tailCount + 2) + 16).toBeGreaterThan(USER_MESSAGES_BUDGET);
    // 最近的在尾部且保持时间顺序
    expect(result.slice(2)).toEqual(messages.slice(messages.length - tailCount));
  });

  it("只有一条超长消息时不插入标记", () => {
    expect(budgetUserMessages(["y".repeat(9000)], 8000, 2000)).toHaveLength(1);
  });

  it("较小的自定义预算也保留第一条", () => {
    const result = budgetUserMessages(["first", "b".repeat(50), "c".repeat(50), "last"], 70, 2000);
    expect(result[0]).toBe("first");
    expect(result).toContain(omittedMarker(2));
    expect(result.at(-1)).toBe("last");
  });
});

describe("审查输入：项目说明", () => {
  it("拼接已加载的指令文件，取前 2000 字", () => {
    const text = projectNotesFrom([
      { source: "a", content: "甲".repeat(1500) },
      { source: "b", content: "乙".repeat(1500) },
    ]);
    expect(text).toHaveLength(2000);
    expect(text?.startsWith("甲")).toBe(true);
    expect(projectNotesFrom([{ source: "a", content: "  " }])).toBeUndefined();
    expect(projectNotesFrom([])).toBeUndefined();
  });
});
