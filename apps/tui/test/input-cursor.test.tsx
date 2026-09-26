import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type * as Ink from "ink";

const positions = vi.hoisted(() => ({ values: [] as ({ x: number; y: number } | undefined)[] }));
vi.mock("ink", async (original) => {
  const ink = await original<typeof Ink>();
  return {
    ...ink,
    useCursor: () => ({
      setCursorPosition: (position: { x: number; y: number } | undefined) => {
        positions.values.push(position);
      },
    }),
  };
});

import { InputCursor } from "../src/components/input-cursor.js";

describe("浮层输入法光标", () => {
  it.each([
    ["模型搜索", "搜索: ", 18, 0, 18 + 6 + 4],
    ["服务商过滤", "过滤: ", 0, 2, 6 + 4],
    ["向导名称/URL/密钥行", "> ", 1, 6, 1 + 2 + 4],
  ])("%s 打开时定位到中文末尾", (_name, prefix, x, y, expectedX) => {
    positions.values.length = 0;
    const { unmount } = render(
      createElement(InputCursor, { active: true, prefix, text: "中文", x, y, width: 60 }),
    );
    expect(positions.values.at(-1)).toEqual({ x: expectedX, y });
    unmount();
  });
});
