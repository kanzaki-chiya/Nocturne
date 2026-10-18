/**
 * 主界面浮层遮挡面板浏览器（desktop.md 5.10）：浮层伸进来 → 浮层先透明、截图 → 换上
 * 截图、隐藏 webview、放出浮层；浮层都关掉 → 显示 webview、撤掉截图。截图超时不等。
 */
import { afterEach, describe, expect, it } from "vitest";

import { coverStep, intersects, overlaysOver, type CoverState } from "../src/browser-occlusion";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("遮挡状态机", () => {
  it("浮层出现：截图并压住浮层；截到后隐藏 webview、放出浮层；浮层关掉后恢复", () => {
    expect(coverStep("live", "overlay")).toEqual({
      state: "capturing",
      capture: true,
      hold: true,
    });
    expect(coverStep("capturing", "overlay")).toEqual({ state: "capturing", hold: true });
    expect(coverStep("capturing", "captured")).toEqual({
      state: "covered",
      webview: "hide",
      hold: false,
    });
    expect(coverStep("covered", "overlay")).toEqual({ state: "covered" });
    expect(coverStep("covered", "clear")).toEqual({
      state: "live",
      webview: "show",
      clearPlaceholder: true,
    });
  });

  it("截图超时也隐藏 webview；截图期间浮层就关了则直接回到正常，webview 不动", () => {
    expect(coverStep("capturing", "timeout")).toMatchObject({ state: "covered", webview: "hide" });
    const quick = coverStep("capturing", "clear");
    expect(quick).toEqual({ state: "live", hold: false, clearPlaceholder: true });
    expect(quick.webview).toBeUndefined();
  });

  it("迟到的截图和超时不改变状态；没有浮层时什么都不做", () => {
    const quiet: [CoverState, "captured" | "timeout" | "clear"][] = [
      ["live", "captured"],
      ["live", "timeout"],
      ["live", "clear"],
      ["covered", "captured"],
      ["covered", "timeout"],
    ];
    for (const [state, event] of quiet) {
      const step = coverStep(state, event);
      expect(step.state).toBe(state);
      expect(step.webview).toBeUndefined();
      expect(step.capture).toBeUndefined();
    }
  });
});

describe("找伸进浏览器区域的浮层", () => {
  const rect = (left: number, top: number, width: number, height: number) =>
    ({
      left,
      top,
      right: left + width,
      bottom: top + height,
      width,
      height,
      x: left,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;

  it("只算和区域相交、有尺寸的浮层；嵌套只算外层；浏览器面板自己的元素不算", () => {
    document.body.innerHTML = `
      <div id="menu" role="menu"><div id="inner" role="listbox"></div></div>
      <div id="far" role="dialog"></div>
      <div id="empty" class="ctxmenu"></div>
      <div id="pane"><div id="own" role="listbox"></div></div>
      <div id="tip" role="tooltip"></div>`;
    const place: Record<string, DOMRect> = {
      menu: rect(500, 100, 200, 300),
      inner: rect(520, 120, 100, 100),
      far: rect(0, 0, 100, 100),
      empty: rect(600, 200, 0, 0),
      own: rect(600, 200, 100, 100),
      tip: rect(590, 590, 40, 20),
    };
    for (const [id, r] of Object.entries(place)) {
      const node = document.getElementById(id);
      if (node !== null) node.getBoundingClientRect = () => r;
    }
    const slot = { left: 560, top: 80, right: 1000, bottom: 600 };
    const hits = overlaysOver(document, slot, document.getElementById("pane"));
    expect(hits.map((node) => node.id)).toEqual(["menu", "tip"]);
    expect(intersects(slot, { left: 1000, top: 0, right: 1100, bottom: 10 })).toBe(false);
  });
});
