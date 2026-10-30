/** 后台子代理在桌面端（ADR-0073 §6）：概览标记与取消、结果卡片、待发条目 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSessionView,
  pendingBackgroundSubagents,
  type SubagentSummary,
  type ToolEntry,
  type UserEntry,
} from "@nocturne/core/protocol";
import type { RpcSession } from "@nocturne/rpc/client";

import { createAttachmentImageSource } from "../src/attachment-images";
import { Conversation } from "../src/Conversation";
import { SessionOverview } from "../src/PanelChrome";
import { PendingInputs } from "../src/PendingInputs";

afterEach(cleanup);

const summary = (overrides: Partial<SubagentSummary> = {}): SubagentSummary =>
  ({
    childSessionId: "child-1",
    parentSessionId: "parent-1",
    callId: "call-1",
    profile: "explore",
    background: true,
    state: "running",
    taskSummary: "查找调用方",
    startedAt: new Date(Date.now() - 3000).toISOString(),
    ...overrides,
  }) as SubagentSummary;

const resultEntry = {
  kind: "user",
  key: "u-9",
  seq: 9,
  messageId: "m9",
  content: [
    {
      type: "text",
      text: '<subagent-result id="child-1" call="call-1" status="ok">\n调研结论：一切正常\n</subagent-result>',
    },
  ],
  subagent: {
    childSessionId: "child-1",
    callId: "call-1",
    status: "ok",
    profile: "quick",
    durationMs: 65_000,
  },
} as unknown as UserEntry;

describe("概览", () => {
  it("后台子代理带「后台」标记与取消按钮；同步子代理没有；点名字仍打开观察", () => {
    const onOpen = vi.fn();
    const onCancel = vi.fn();
    render(
      <SessionOverview
        project="proj"
        workspace="Z:\proj"
        totals={{ added: 0, removed: 0, files: 0 }}
        docked
        rightOffset={0}
        onOpenChanges={vi.fn()}
        subagents={{
          running: [
            summary(),
            summary({ childSessionId: "child-2", background: false, taskSummary: "同步任务" }),
          ],
          external: [],
          onOpen,
          onCancel,
        }}
      />,
    );
    expect(screen.getAllByText("后台")).toHaveLength(1);
    const cancels = screen.getAllByRole("button", { name: /取消后台子代理/ });
    expect(cancels).toHaveLength(1);
    fireEvent.click(cancels[0] as HTMLElement);
    expect(onCancel).toHaveBeenCalledWith(expect.objectContaining({ childSessionId: "child-1" }));
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /查找调用方/ }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ childSessionId: "child-1" }));
  });
});

describe("结果卡片", () => {
  it("折叠显示档位、状态、耗时，不显示外壳；「在面板中查看」打开子会话", () => {
    const view = createSessionView();
    view.entries = [resultEntry];
    const open = vi.fn();
    const { container } = render(
      <Conversation
        view={view}
        session={{ id: "parent-1" } as unknown as RpcSession}
        openUrl={vi.fn()}
        cwd="Z:/project"
        subscribeEvents={() => () => undefined}
        images={createAttachmentImageSource()}
        busy={false}
        onResubmit={vi.fn(async () => undefined)}
        subagentLinks={{ link: () => ({ state: "none" }) as never, open }}
      />,
    );
    const card = container.querySelector("details.subagent-result");
    expect(card).not.toBeNull();
    expect(card?.querySelector("summary")?.textContent).toBe(
      "子代理结果quick · 完成 · 1 分 5 秒在面板中查看",
    );
    expect(card?.querySelector("summary .subagent-view")).not.toBeNull();
    expect(container.textContent).not.toContain("subagent-result");
    expect(container.querySelector(".u-bubble")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "在面板中查看" }));
    expect(open).toHaveBeenCalledWith("child-1");
  });

  it("手机端从视图推导未送达的后台子代理；结果写入后消失", () => {
    const started = {
      kind: "tool",
      key: "t-1",
      seq: 3,
      turnId: "turn-1",
      callId: "call-1",
      name: "task",
      status: "ok",
      input: { task: "查找调用方", background: true, preset: "explore" },
      subjects: [],
      permission: undefined,
      resolution: undefined,
      liveOutput: "",
      result: {
        status: "ok",
        modelContent: "Background subagent started",
        output: { childSessionId: "child-1", background: true },
        error: undefined,
        truncated: false,
        spillPath: undefined,
        durationMs: 5,
      },
    } as ToolEntry;
    const view = createSessionView();
    view.entries = [started];
    const props = {
      view,
      session: { id: "parent-1" } as unknown as RpcSession,
      openUrl: vi.fn(),
      cwd: "Z:/project",
      subscribeEvents: () => () => undefined,
      images: createAttachmentImageSource(),
      busy: false,
      onResubmit: vi.fn(async () => undefined),
    };
    const ui = render(<Conversation {...props} />);
    expect(ui.container.querySelector(".tool-res")?.textContent).toBe("后台运行中");
    ui.rerender(<Conversation {...props} view={{ ...view, entries: [started, resultEntry] }} />);
    expect(ui.container.querySelector(".tool-res")?.textContent).toBe("完成");
    for (const [status, label] of [
      ["error", "失败"],
      ["timeout", "超时"],
      ["cancelled", "已取消"],
      ["interrupted", "已中断"],
    ] as const) {
      ui.rerender(
        <Conversation
          {...props}
          view={{
            ...view,
            entries: [
              started,
              { ...resultEntry, subagent: { childSessionId: "child-1", callId: "call-1", status } },
            ],
          }}
        />,
      );
      expect(ui.container.querySelector(".tool-res")?.textContent).toBe(label);
    }
    expect(pendingBackgroundSubagents([started])).toEqual([
      { callId: "call-1", childSessionId: "child-1", profile: "explore", task: "查找调用方" },
    ]);
    expect(pendingBackgroundSubagents([started, resultEntry])).toEqual([]);
  });
});

describe("待发区", () => {
  it("子代理结果条目可撤回、不可编辑或切换", async () => {
    const onCancel = vi.fn(async () => undefined);
    const { container } = render(
      <PendingInputs
        snapshot={{
          items: [
            {
              id: "s1",
              mode: "subagent",
              text: "<subagent-result>…",
              attachments: 0,
              createdAt: "2026-10-30T10:00:00.000Z",
              paused: false,
            },
          ],
          paused: false,
        }}
        onUpdate={vi.fn(async () => undefined)}
        onCancel={onCancel}
        onResume={vi.fn(async () => undefined)}
      />,
    );
    expect(container.querySelector(".pi-mode")?.textContent).toBe("子代理结果");
    expect(screen.getByText("等待送达")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "编辑" })).toBeNull();
    expect(screen.queryByRole("button", { name: /改排队|改插话/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "撤回这条待发消息" }));
    await waitFor(() => expect(onCancel).toHaveBeenCalledWith("s1"));
  });
});
