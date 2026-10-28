/** 待发输入列表（ADR-0070 §6）：标签、选中、暂停提示与溢出 */
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { PendingInputsPanel, pendingPanelRows } from "../src/components/pending-inputs.js";

const item = (id: string, mode: "steer" | "queue", text: string, attachments = 0) => ({
  id,
  mode,
  text,
  attachments,
  createdAt: "2026-10-28T10:00:00Z",
  paused: false,
});

describe("PendingInputsPanel", () => {
  it("逐条显示标签与内容，选中项带箭头，插话与排队都可见", async () => {
    const { lastFrame, unmount } = render(
      <PendingInputsPanel
        items={[item("a", "steer", "改成蓝色", 2), item("b", "queue", "再来一次")]}
        paused={false}
        selected={0}
        width={60}
        height={pendingPanelRows(2, false)}
      />,
    );
    await new Promise((done) => setTimeout(done, 20));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("› 1 插话 改成蓝色  2 张图");
    expect(frame).toContain("2 排队 再来一次");
    expect(frame).toContain("Alt+E 编辑");
    unmount();
  });

  it("暂停时第一行提示继续发送；条目过多折成「还有 N 条」", async () => {
    const items = [
      item("a", "queue", "一"),
      item("b", "queue", "二"),
      item("c", "queue", "三"),
      item("d", "queue", "四"),
    ];
    const { lastFrame, unmount } = render(
      <PendingInputsPanel
        items={items}
        paused
        selected={3}
        width={40}
        height={pendingPanelRows(items.length, true)}
      />,
    );
    await new Promise((done) => setTimeout(done, 20));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("已暂停  Alt+R 继续发送");
    expect(frame).toContain("还有 1 条");
    unmount();
  });
});
