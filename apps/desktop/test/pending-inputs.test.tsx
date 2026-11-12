/** 待发列表（ADR-0070 §6）：单行展示、立即发送、编辑、取消、暂停与继续 */
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

function setup(snapshot: { items: PendingInputItem[]; paused: boolean }, running = true) {
  const onUpdate = vi.fn(async () => undefined);
  const onCancel = vi.fn(async () => undefined);
  const onResume = vi.fn(async () => undefined);
  const view = render(
    <PendingInputs
      snapshot={snapshot}
      running={running}
      onUpdate={onUpdate}
      onCancel={onCancel}
      onResume={onResume}
    />,
  );
  return { onUpdate, onCancel, onResume, ...view };
}

describe("待发列表", () => {
  it("逐条单行显示内容与附件数，无模式徽标与送达说明；排队条目带「立即发送」「编辑」「取消」，插话与空闲时无「立即发送」", () => {
    const { container, rerender, onUpdate, onCancel, onResume } = setup({
      items: [
        item({ id: "i1", mode: "steer", text: "插话内容" }),
        item({ id: "i2", mode: "queue", text: "排队内容", attachments: 2 }),
      ],
      paused: false,
    });
    expect(container.querySelectorAll(".pi-mode")).toHaveLength(0);
    expect(container.querySelectorAll(".pi-note")).toHaveLength(0);
    expect(screen.getByText("插话内容").getAttribute("title")).toBe("插话内容");
    expect(screen.getByText("排队内容").getAttribute("title")).toBe("排队内容");
    expect(screen.getByText("2 张图")).toBeTruthy();
    const rows = Array.from(container.querySelectorAll(".pi-row"));
    expect(rows).toHaveLength(2);
    // 插话条目没有「立即发送」，只有「编辑」「取消」
    expect(
      Array.from(rows[0]?.querySelectorAll("button") ?? []).map((b) =>
        b.getAttribute("aria-label"),
      ),
    ).toEqual(["编辑", "取消"]);
    // 排队条目有「立即发送」「编辑」「取消」三个按钮，顺序固定
    expect(
      Array.from(rows[1]?.querySelectorAll("button") ?? []).map((b) =>
        b.getAttribute("aria-label"),
      ),
    ).toEqual(["立即发送", "编辑", "取消"]);
    expect(screen.queryByText("已暂停")).toBeNull();
    // 不在运行中时也没有「立即发送」
    rerender(
      <PendingInputs
        snapshot={{
          items: [item({ id: "i2", mode: "queue", text: "排队内容" })],
          paused: false,
        }}
        running={false}
        onUpdate={onUpdate}
        onCancel={onCancel}
        onResume={onResume}
      />,
    );
    expect(screen.queryByRole("button", { name: "立即发送" })).toBeNull();
  });

  it("编辑：保存与取消两个图标按钮；Enter 保存只换文本，Esc 取消，组字中不提交", async () => {
    const { container, onUpdate } = setup({ items: [item()], paused: false });
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    expect(
      Array.from(container.querySelectorAll(".pi-acts button")).map((b) =>
        b.getAttribute("aria-label"),
      ),
    ).toEqual(["保存", "取消"]);
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

  it("「立即发送」把排队条目转为插话，「取消」撤回条目", async () => {
    const { onUpdate, onCancel } = setup({
      items: [item({ id: "i1", mode: "queue" })],
      paused: false,
    });
    fireEvent.click(screen.getByRole("button", { name: "立即发送" }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith("i1", { mode: "steer" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
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
        snapshot={{ items: [item({ mode: "queue" })], paused: false }}
        onUpdate={onUpdate}
        onCancel={async () => undefined}
        onResume={async () => undefined}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "立即发送" }));
    expect((await screen.findByRole("alert")).textContent).toContain("这条待发输入已经发出");
  });

  it("Swarm 留言板排队消息解包标签且不显示人工草稿的立即发送、编辑、取消按钮", () => {
    setup({
      items: [
        item({
          id: "sw1",
          mode: "queue",
          text: '<swarm-post n="7" from="orders">\n`orders.ts` 已加上非空数组校验\n</swarm-post>',
        }),
      ],
      paused: false,
    });
    expect(screen.getByText("`orders.ts` 已加上非空数组校验")).toBeTruthy();
    expect(screen.queryByText(/swarm-post/)).toBeNull();
    expect(screen.queryByRole("button", { name: "立即发送" })).toBeNull();
    expect(screen.queryByRole("button", { name: "编辑" })).toBeNull();
    expect(screen.queryByRole("button", { name: "取消" })).toBeNull();
  });
});
