/** 后台子代理在 TUI 中的显示（ADR-0073 §6）：状态栏计数、结果行、待发条目、/subagents */
import { createElement } from "react";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

import type { Runtime } from "@nocturne/core";
import {
  createSessionView,
  type SubagentSummary,
  type UserEntry,
  type ToolEntry,
} from "@nocturne/core/protocol";

import { PendingInputsPanel, pendingPanelRows } from "../src/components/pending-inputs.js";
import { StatusBar } from "../src/components/status-bar.js";
import { Subagents } from "../src/components/subagents.js";
import { TuiEnvContext } from "../src/env.js";
import { layoutEntry } from "../src/lines.js";
import { runSlash } from "../src/commands.js";

const ENV = { ascii: false, animated: false };
const inEnv = (child: React.ReactNode) =>
  createElement(TuiEnvContext.Provider, { value: ENV }, child);
const pause = (ms = 30) => new Promise((done) => setTimeout(done, ms));

const resultEntry: UserEntry = {
  kind: "user",
  key: "u:9",
  seq: 9,
  messageId: "m9",
  content: [
    {
      type: "text",
      text: '<subagent-result id="c1" call="t1" status="ok">\n调研结论：一切正常\n</subagent-result>',
    },
  ],
  subagent: { childSessionId: "c1", callId: "t1", status: "ok", profile: "quick" },
} as unknown as UserEntry;

describe("TUI 后台子代理", () => {
  it("启动行运行中与最终结果状态一致", () => {
    const entry = {
      kind: "tool",
      key: "t1",
      callId: "t1",
      name: "task",
      status: "ok",
      input: { preset: "explore", background: true },
      liveOutput: "",
      result: { output: { background: true }, modelContent: "started" },
    } as unknown as ToolEntry;
    expect(
      layoutEntry(entry, 100, false)
        .map((line) => line.text)
        .join("\n"),
    ).toContain("后台运行中");
    const lines = layoutEntry(entry, 100, false, undefined, undefined, false, false, undefined, {
      entries: [entry, resultEntry],
    });
    expect(lines.map((line) => line.text).join("\n")).toContain("完成");
    expect(lines.map((line) => line.text).join("\n")).not.toContain("后台运行中");
  });
  it("状态栏：运行中的后台数大于 0 才显示", () => {
    const view = createSessionView();
    view.config.model = { provider: "fake", model: "m" };
    const frame = (backgroundCount: number) => {
      const { lastFrame, unmount } = render(
        inEnv(
          createElement(StatusBar, { view, width: 100, context: { used: 0 }, backgroundCount }),
        ),
      );
      const text = lastFrame() ?? "";
      unmount();
      return text;
    };
    expect(frame(0)).not.toContain("后台");
    expect(frame(2)).toContain("后台 2");
  });

  it("结果消息一行显示档位与状态，不显示外壳；展开后看正文", () => {
    const collapsed = layoutEntry(resultEntry, 80, false).map((line) => line.text);
    expect(collapsed).toEqual([expect.stringContaining("子代理结果 • quick • 完成")]);
    expect(collapsed.join("\n")).not.toContain("subagent-result");
    const open = layoutEntry(resultEntry, 80, false, new Map(), 0, false, false, undefined, {
      reasoningExpanded: new Map([["subagent:u:9", true]]),
    })
      .map((line) => line.text)
      .join("\n");
    expect(open).toContain("调研结论：一切正常");
    expect(open).not.toContain("<subagent-result");
  });

  it("待发区条目：子代理结果 · 等待送达", async () => {
    const { lastFrame, unmount } = render(
      <PendingInputsPanel
        items={[
          {
            id: "p1",
            mode: "subagent",
            text: "<subagent-result>…",
            attachments: 0,
            createdAt: "2026-10-30T10:00:00Z",
            paused: false,
          },
        ]}
        paused={false}
        selected={0}
        width={60}
        height={pendingPanelRows(1, false)}
      />,
    );
    await pause(20);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("子代理结果 · 等待送达");
    expect(frame).toContain("Alt+X 撤回");
    expect(frame).not.toContain("Alt+E");
    expect(frame).not.toContain("subagent-result");
    unmount();
  });

  it("/subagents 列出运行中的后台子代理，确认后取消", async () => {
    expect(await runSlash("/subagents", {} as never)).toEqual({
      kind: "overlay",
      name: "subagents",
    });
    const summary = {
      childSessionId: "c1",
      parentSessionId: "p",
      callId: "t1",
      profile: "explore",
      background: true,
      state: "running",
      taskSummary: "查找调用方",
      startedAt: new Date(Date.now() - 5000).toISOString(),
    } as SubagentSummary;
    const cancelSubagent = vi.fn(() => Promise.resolve());
    const runtime = {
      listSubagents: () =>
        Promise.resolve([summary, { ...summary, childSessionId: "c2", background: false }]),
      cancelSubagent,
      listSubagentWorktrees: () => Promise.resolve([]),
    } as unknown as Runtime;
    const onClose = vi.fn();
    const ui = render(
      inEnv(<Subagents runtime={runtime} sessionId="p" width={80} onClose={onClose} />),
    );
    await vi.waitFor(() => expect(ui.lastFrame()).toContain("explore • 5s • 查找调用方"));
    expect((ui.lastFrame() ?? "").match(/查找调用方/g)).toHaveLength(1);
    // Ink 在首帧之后才订阅输入：按键前稍等，结果用 waitFor 判断而不是固定等待
    await pause(100);
    ui.stdin.write("\r");
    await vi.waitFor(() => expect(ui.lastFrame()).toContain("取消 explore？"));
    ui.stdin.write("\u001B[B");
    await pause(30);
    ui.stdin.write("\r");
    await vi.waitFor(() =>
      expect(cancelSubagent).toHaveBeenCalledWith({ parentSessionId: "p", childSessionId: "c1" }),
    );
    expect(onClose).toHaveBeenCalled();
    ui.unmount();
  });

  it("ADR-0075：结果行带改动摘要，展开列文件与增删行数；并回行显示文件数与冲突", () => {
    const entry = {
      ...resultEntry,
      subagent: {
        ...resultEntry.subagent,
        changes: {
          branch: "nocturne/c1",
          base: "a",
          head: "b",
          snapshot: false,
          worktree: "w",
          files: [{ path: "src/a.ts", status: "modified", additions: 3, deletions: 1 }],
        },
      },
    } as unknown as UserEntry;
    expect(layoutEntry(entry, 100, false)[0]?.text).toContain("改动 1 个文件 • nocturne/c1");
    const open = layoutEntry(entry, 100, false, new Map(), 0, false, false, undefined, {
      reasoningExpanded: new Map([["subagent:u:9", true]]),
    })
      .map((line) => line.text)
      .join("\n");
    expect(open).toContain("src/a.ts +3 −1");
    const apply = (conflicts: string[]) =>
      layoutEntry(
        {
          kind: "tool",
          key: "t2",
          callId: "t2",
          name: "apply_subagent_changes",
          status: "ok",
          input: { id: "c1" },
          liveOutput: "",
          result: { output: { files: [{}, {}], conflicts }, modelContent: "" },
        } as unknown as ToolEntry,
        100,
        false,
      )
        .map((line) => line.text)
        .join("\n");
    // TUI 把中点渲染为 •
    expect(apply([])).toContain("并回子代理改动 • 2 个文件");
    expect(apply(["src/a.ts"])).toContain("有冲突 • 1 个文件");
  });

  it("ADR-0075：/subagents 标出隔离的运行项，单列保留的副本与分支，确认后删除", async () => {
    const summary = {
      childSessionId: "c1",
      parentSessionId: "p",
      callId: "t1",
      profile: "general",
      background: true,
      state: "running",
      taskSummary: "改登录",
      startedAt: new Date().toISOString(),
    } as SubagentSummary;
    const deleteSubagentWorktree = vi.fn(() => Promise.resolve());
    const runtime = {
      listSubagents: () => Promise.resolve([summary]),
      listSubagentWorktrees: () =>
        Promise.resolve([
          { childSessionId: "c1", branch: "nocturne/c1" },
          {
            childSessionId: "c9",
            branch: "nocturne/c9",
            changes: { files: [{ path: "a" }, { path: "b" }] },
          },
        ]),
      deleteSubagentWorktree,
    } as unknown as Runtime;
    const onClose = vi.fn();
    const ui = render(
      inEnv(<Subagents runtime={runtime} sessionId="p" width={80} onClose={onClose} />),
    );
    await vi.waitFor(() => expect(ui.lastFrame()).toContain("nocturne/c9 • 改动 2 个文件"));
    expect(ui.lastFrame()).toContain("general • 隔离");
    expect(ui.lastFrame()).not.toContain("nocturne/c1");
    await pause(100);
    ui.stdin.write("\u001B[B");
    await pause(30);
    ui.stdin.write("\r");
    await vi.waitFor(() => expect(ui.lastFrame()).toContain("其中的改动会丢失"));
    await pause(100);
    ui.stdin.write("\u001B[B");
    await pause(30);
    ui.stdin.write("\r");
    await vi.waitFor(() =>
      expect(deleteSubagentWorktree, ui.lastFrame()).toHaveBeenCalledWith({
        parentSessionId: "p",
        childSessionId: "c9",
      }),
    );
    ui.unmount();
  });
});
