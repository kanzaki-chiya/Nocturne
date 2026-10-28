/** 待发列表（ADR-0070 §6）：标签、编辑、切换、撤回、暂停与继续 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PendingInputs } from "../src/PendingInputs";
import type { PendingInputItem } from "@nocturne/core/protocol";

afterEach(cleanup);

const item = (overrides: Partial<PendingInputItem> = {}): PendingInputItem => ({
  id: "i1",
  mode: "steer",
  text: "改成蓝色主题",
  attachments: 0,
  createdAt: "2026-10-28T10:00:00.000Z",
  paused: false,
  ...overrides,
});

function setup(snapshot: { items: PendingInputItem[]; paused: boolean }) {
  const onUpdate = vi.fn(async () => undefined);
  const onCancel = vi.fn(async () => undefined);
  const onResume = vi.fn(async () => undefined);
  const view = render(
    <PendingInputs
      snapshot={snapshot}
      onUpdate={onUpdate}
      onCancel={onCancel}
      onResume={onResume}
    />,
  );
  return { onUpdate, onCancel, onResume, ...view };
}

describe("待发列表", () => {
  it("逐条显示标签、内容、附件数与插话说明", () => {
    const { container } = setup({
      items: [
        item({ id: "i1", mode: "steer", text: "插话内容" }),
        item({ id: "i2", mode: "queue", text: "排队内容", attachments: 2 }),
      ],
      paused: false,
    });
    const labels = Array.from(container.querySelectorAll(".pi-mode")).map((n) => n.textContent);
    expect(labels).toEqual(["插话", "排队"]);
    expect(screen.getByText("插话内容")).toBeTruthy();
    expect(screen.getByText("排队内容")).toBeTruthy();
    expect(screen.getByText("2 张图")).toBeTruthy();
    // 只有插话条目带送达说明
    expect(screen.getAllByText("将在当前步骤结束后送达")).toHaveLength(1);
    expect(screen.queryByText("已暂停")).toBeNull();
  });

  it("编辑：Enter 保存只换文本，Esc 取消，组字中不提交", async () => {
    const { onUpdate } = setup({ items: [item()], paused: false });
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    const field = screen.getByLabelText<HTMLInputElement>("编辑待发消息");
    fireEvent.change(field, { target: { value: "改成绿色" } });
    fireEvent.keyDown(field, { key: "Enter", isComposing: true });
    expect(onUpdate).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onUpdate).toHaveBeenCalledWith("i1", { text: "改成绿色" });
    await waitFor(() => expect(screen.queryByLabelText("编辑待发消息")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    const again = screen.getByLabelText<HTMLInputElement>("编辑待发消息");
    fireEvent.change(again, { target: { value: "不要了" } });
    fireEvent.keyDown(again, { key: "Escape" });
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText("编辑待发消息")).toBeNull();
  });

  it("切换插话/排队与撤回", async () => {
    const { onUpdate, onCancel } = setup({
      items: [item({ id: "i1", mode: "steer" })],
      paused: false,
    });
    fireEvent.click(screen.getByRole("button", { name: "改排队" }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith("i1", { mode: "queue" }));
    fireEvent.click(screen.getByRole("button", { name: "撤回这条待发消息" }));
    await waitFor(() => expect(onCancel).toHaveBeenCalledWith("i1"));
  });

  it("暂停时顶部显示「已暂停」与「继续发送」", async () => {
    const { onResume } = setup({
      items: [item({ paused: true, mode: "queue" })],
      paused: true,
    });
    expect(screen.getByText("已暂停")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "继续发送" }));
    await waitFor(() => expect(onResume).toHaveBeenCalledTimes(1));
  });

  it("已发出（input_consumed）时把原因显示出来", async () => {
    const onUpdate = vi.fn(async () => {
      throw new Error("这条待发输入已经发出");
    });
    render(
      <PendingInputs
        snapshot={{ items: [item()], paused: false }}
        onUpdate={onUpdate}
        onCancel={async () => undefined}
        onResume={async () => undefined}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "改排队" }));
    expect((await screen.findByRole("alert")).textContent).toContain("这条待发输入已经发出");
  });
});
