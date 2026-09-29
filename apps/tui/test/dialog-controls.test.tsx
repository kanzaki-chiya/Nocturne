import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import { Toggle } from "../src/components/dialog/toggle.js";
import { focusOrder, moveFocus } from "../src/components/dialog/focus.js";
import { segmentedLines, Segmented } from "../src/components/dialog/segmented.js";
import { inputWindow, TextInput } from "../src/components/dialog/text-input.js";
import { TuiEnvContext } from "../src/env.js";

describe("对话框通用控件", () => {
  it("焦点顺序跳过只读字段；整页只读仅返回", () => {
    expect(
      focusOrder(
        [
          { key: "a", editable: true },
          { key: "b", editable: false },
          { key: "c", editable: true },
        ],
        false,
      ),
    ).toEqual(["a", "c", "cancel", "save"]);
    expect(focusOrder([{ key: "a", editable: true }], true)).toEqual(["return"]);
  });

  it("Tab 循环；↓ 从最后一个字段进入「保存」，其余方向键在边界停住", () => {
    const order = ["a", "b", "cancel", "save"];
    expect(moveFocus(order, "save", "tab")).toBe("a");
    expect(moveFocus(order, "a", "shiftTab")).toBe("save");
    expect(moveFocus(order, "a", "up")).toBe("a");
    expect(moveFocus(order, "b", "down")).toBe("save");
    expect(moveFocus(["return"], "return", "down")).toBe("return");
    expect(moveFocus(order, "save", "up")).toBe("b");
    expect(moveFocus(order, "cancel", "down")).toBe("cancel");
    expect(moveFocus(order, "save", "left")).toBe("cancel");
    expect(moveFocus(order, "cancel", "right")).toBe("save");
  });

  it("toggle 的常规与 ASCII 画法可辨", () => {
    const normal = render(createElement(Toggle, { on: true }));
    expect(normal.lastFrame()).toContain("●━━");
    normal.unmount();
    const ascii = render(
      createElement(
        TuiEnvContext.Provider,
        { value: { ascii: true, animated: false } },
        createElement(Toggle, { on: false }),
      ),
    );
    expect(ascii.lastFrame()).toContain("[OFF]");
    ascii.unmount();
  });

  it("segmented 按显示宽度换行；高度仅一行时显示当前项和总数", () => {
    expect(segmentedLines(["跟随", "Chat Completions", "Messages"], 1, 25).length).toBeGreaterThan(
      1,
    );
    expect(segmentedLines(["跟随", "Chat Completions", "Messages"], 1, 25, 1)).toEqual([
      "< Chat Completions > / 共 3 项",
    ]);
    const ui = render(
      createElement(Segmented, {
        options: ["跟随", "是", "否"],
        selected: 2,
        focused: true,
        width: 30,
      }),
    );
    expect(ui.lastFrame()).toContain("[* 否]");
    expect(ui.lastFrame()).toContain(">");
    ui.unmount();
  });

  it("输入框为空仍显示跟随；长文本水平滚动后光标留在可见区", () => {
    const empty = render(
      createElement(TextInput, { value: "", cursor: 0, focused: true, width: 12 }),
    );
    expect(empty.lastFrame()).toContain("跟随");
    empty.unmount();
    const window = inputWindow("一二三四五六七", 7, 10);
    expect(window.text).not.toContain("一");
    expect(window.column).toBeLessThan(6);
    expect(window.text).toContain("七");
  });
});
