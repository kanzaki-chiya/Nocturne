import { describe, expect, it } from "vitest";
import { createClickTracker, type HitBox } from "../src/click.js";
import type { MouseEvent } from "../src/mouse.js";

const boxes: HitBox[] = [
  { id: "A", row: 2, colStart: 3, colEnd: 8 },
  { id: "B", row: 2, colStart: 10, colEnd: 15 },
];
const event = (type: "press" | "release" | "drag", x = 3, button = 0): MouseEvent => ({
  type,
  x,
  y: 2,
  button,
});

describe("通用单击判定", () => {
  it("只在同框松开触发一次", () => {
    const click = createClickTracker();
    expect(click.feed(event("press"), boxes)).toBeUndefined();
    expect(click.feed(event("release", 8), boxes)).toBe("A");
    expect(click.feed(event("release"), boxes)).toBeUndefined();
  });

  it.each([
    [event("press"), event("drag", 20), event("drag"), event("release")],
    [event("press"), event("release", 10)],
    [event("press", 3, 2), event("release", 3, 2)],
    [event("release")],
    [event("press", 1), event("release")],
    [event("press"), event("release", 3, 2)],
  ])("拖回原位、异框、右键、孤立松开或框外按下不触发：%j", (...events) => {
    const click = createClickTracker();
    for (const ev of events) expect(click.feed(ev, boxes)).toBeUndefined();
  });

  it("中文 [ 是 ] 共 6 显示列，左右边界均命中，外侧不命中", () => {
    for (const x of [2, 3, 4, 5, 6, 7, 8, 9]) {
      const click = createClickTracker();
      const chinese = [{ id: "是", row: 2, colStart: 3, colEnd: 8 }];
      click.feed(event("press", x), chinese);
      expect(click.feed(event("release", x), chinese)).toBe(x >= 3 && x <= 8 ? "是" : undefined);
    }
  });

  it("换层清除按下记录", () => {
    const click = createClickTracker();
    click.feed(event("press"), boxes);
    click.reset();
    expect(click.feed(event("release"), boxes)).toBeUndefined();
  });
});
