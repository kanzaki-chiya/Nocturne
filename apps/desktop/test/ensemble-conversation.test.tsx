// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSessionView,
  formatEnsemblePostForModel,
  replaySessionView,
  type EnsembleMemberView,
  type EnsemblePostView,
  type EnsembleView,
  type ToolEntry,
} from "@nocturne/core/protocol";
import type { RpcSession } from "@nocturne/rpc/client";

import { Conversation, Markdown } from "../src/Conversation";
import { createAttachmentImageSource } from "../src/attachment-images";

afterEach(cleanup);

function fakeSession(id = "s-main"): RpcSession {
  return {
    id,
    readAttachment: vi.fn(),
    resolveFiles: vi.fn(async () => []),
    respondPermission: vi.fn(async () => undefined),
    respondSubagentPermission: vi.fn(async () => undefined),
  } as unknown as RpcSession;
}

function makeToolEntry(seq: number, name: string, input: unknown): ToolEntry {
  return {
    kind: "tool",
    key: `t:${seq}`,
    turnId: "turn-1",
    seq,
    callId: `c-${seq}`,
    name,
    status: "ok",
    input,
    subjects: [],
    permission: undefined,
    resolution: undefined,
    liveOutput: "",
    result: {
      status: "ok",
      durationMs: 5,
      output: {},
      error: undefined,
      truncated: false,
      spillPath: undefined,
      modelContent: "ok",
    },
  };
}

function makeMember(name: string, overrides: Partial<EnsembleMemberView> = {}): EnsembleMemberView {
  return {
    name,
    childSessionId: `child-${name}`,
    charter: { owns: `${name}.ts`, handsOff: "none", doneWhen: "ok" },
    model: { provider: "anthropic", model: "claude-opus-5.5" },
    preset: "general",
    isolated: false,
    status: "waiting",
    pendingPermissions: [],
    ...overrides,
  };
}

function makePost(number: number, overrides: Partial<EnsemblePostView> = {}): EnsemblePostView {
  return {
    seq: number,
    time: "2026-11-12T13:31:00.000Z",
    number,
    from: "maestro",
    fromKind: "maestro",
    text: "测试",
    mentions: [],
    recipients: [],
    ...overrides,
  };
}

describe("Ensemble 对话内渲染", () => {
  it("七种 Ensemble 工具行使用规定标签与单行参数", () => {
    const view = createSessionView();
    view.entries = [
      makeToolEntry(1, "ensemble_init", { title: "API 输入校验" }),
      makeToolEntry(2, "ensemble_add_member", { name: "users", preset: "general" }),
      makeToolEntry(3, "ensemble_post", { text: "请 @users 先建校验模块\n补充说明" }),
      makeToolEntry(4, "ensemble_change_model", { name: "verifier", model: "openai/gpt-6.1-sol" }),
      makeToolEntry(5, "ensemble_remove_member", { name: "schema" }),
      makeToolEntry(6, "ensemble_checkout", { member: "users" }),
      makeToolEntry(7, "ensemble_end", { summary: "全部并回\n次行" }),
    ];

    const { container } = render(
      <Conversation
        session={fakeSession()}
        view={view}
        openUrl={vi.fn()}
        cwd="/repo"
        subscribeEvents={() => () => undefined}
        images={createAttachmentImageSource()}
        busy={false}
      />,
    );

    const names = Array.from(container.querySelectorAll(".tool-name")).map((el) => el.textContent);
    expect(names).toEqual(["合奏", "添加", "发帖", "换模型", "移除", "检出", "结束"]);

    const args = Array.from(container.querySelectorAll(".tool-arg")).map((el) =>
      el.textContent?.trim(),
    );
    expect(args).toEqual([
      "API 输入校验",
      "@users",
      "请 @users 先建校验模块",
      "@verifier gpt-6.1-sol",
      "@schema",
      "@users",
      "全部并回",
    ]);
  });

  it("帖子送达渲染为 .post-in，解包 <ensemble-post>，不显示编辑/重发/分叉或插话标记", () => {
    const view = createSessionView();
    view.entries = [
      {
        kind: "user",
        key: "u:10",
        seq: 10,
        turnId: "turn-2",
        content: [
          {
            type: "text",
            text: formatEnsemblePostForModel({
              number: 14,
              from: "verifier",
              text: "三处测试全部通过，`pnpm test` 112 项通过。",
              checkedOut: { member: "orders", commit: "abcdef1234567890" },
            }),
          },
        ],
        steer: true,
        ensemble: { postNumber: 14, from: "verifier", fromKind: "member" },
      },
    ];

    const { container, rerender } = render(
      <Conversation
        session={fakeSession()}
        view={view}
        openUrl={vi.fn()}
        cwd="/repo"
        subscribeEvents={() => () => undefined}
        images={createAttachmentImageSource()}
        busy={false}
        onResubmit={vi.fn()}
        onFork={vi.fn()}
      />,
    );

    expect(container.querySelector(".u")).toBeNull();
    const postIn = container.querySelector(".post-in");
    expect(postIn).not.toBeNull();
    expect(postIn?.querySelector(".post-in-head")?.textContent).toBe("@verifier → 指挥 · #14");
    expect(postIn?.textContent).toContain("三处测试全部通过");
    expect(postIn?.textContent).not.toContain("<ensemble-post");
    expect(postIn?.textContent).not.toContain("[Worktree]");
    expect(container.querySelector("[aria-label='编辑重发']")).toBeNull();
    expect(container.querySelector("[aria-label='分叉会话']")).toBeNull();

    rerender(
      <Conversation
        session={fakeSession("child-orders")}
        view={view}
        openUrl={vi.fn()}
        cwd="/repo"
        subscribeEvents={() => () => undefined}
        images={createAttachmentImageSource()}
        busy={false}
        ensembleRecipientLabel="@orders"
      />,
    );
    expect(container.querySelector(".post-in-head")?.textContent).toBe("@verifier → @orders · #14");
  });

  it("对话区不再渲染入口行，workMode.name=ensemble 显示合奏图标标签，结束行仍按 endedSeq 定位并可展开未合并分支", () => {
    const view = createSessionView();
    view.entries = [
      {
        kind: "user",
        key: "u:1",
        seq: 1,
        turnId: "turn-1",
        content: [{ type: "text", text: "加校验" }],
        workMode: { name: "ensemble", body: "Ensemble mode" },
      },
      {
        kind: "assistant",
        key: "a:5",
        turnId: "turn-1",
        messageId: "m-5",
        seq: 5,
        time: "2026-11-12T13:31:00.000Z",
        text: "已分配给各成员。",
        reasoning: "",
        toolCalls: [],
        model: { provider: "anthropic", model: "claude-opus-5.5" },
        usage: undefined,
        finishReason: "stop",
      },
      {
        kind: "user",
        key: "u:10",
        seq: 10,
        turnId: "turn-2",
        content: [
          { type: "text", text: '<ensemble-post n="2" from="users">\n好了\n</ensemble-post>' },
        ],
        ensemble: { postNumber: 2, from: "users", fromKind: "member" },
      },
    ];
    const ensemble: EnsembleView = {
      createdSeq: 3,
      title: "API 输入校验",
      status: "active",
      maestro: {
        model: { provider: "anthropic", model: "claude-opus-5.5" },
        status: "waiting",
        awaitingPermission: false,
      },
      members: [
        makeMember("users"),
        makeMember("orders"),
        makeMember("schema", { status: "removed" }),
      ],
      awaitingPermissionMembers: [],
      posts: [makePost(1), makePost(2)],
    };
    view.ensemble = ensemble;

    const { container, rerender } = render(
      <Conversation
        session={fakeSession()}
        view={view}
        openUrl={vi.fn()}
        cwd="/repo"
        subscribeEvents={() => () => undefined}
        images={createAttachmentImageSource()}
        busy={false}
      />,
    );

    expect(container.querySelector(".ensemblerow")).toBeNull();
    expect(container.querySelector(".ensemblerow-count")).toBeNull();
    const modeLabel = screen.getByRole("button", { name: "合奏" });
    expect(modeLabel.querySelector("svg")).toBeTruthy();
    expect(modeLabel.getAttribute("aria-expanded")).toBe("false");

    // 结束后仍不出现入口行，结束行出现在 endedSeq 位置并展开 unmerged
    view.ensemble = {
      ...ensemble,
      status: "ended",
      endedSeq: 12,
      endedReason: "user",
      unmerged: [
        {
          name: "orders",
          childSessionId: "child-orders",
          branch: "nocturne/ensemble-orders",
          base: "abc",
          head: "def",
          worktree: "/tmp/wt",
          files: [],
        },
      ],
    };
    rerender(
      <Conversation
        session={fakeSession()}
        view={{ ...view }}
        openUrl={vi.fn()}
        cwd="/repo"
        subscribeEvents={() => () => undefined}
        images={createAttachmentImageSource()}
        busy={false}
      />,
    );
    expect(container.querySelector(".ensemblerow")).toBeNull();
    const endedRow = container.querySelector(".ensemble-ended-row");
    expect(endedRow).not.toBeNull();
    expect(endedRow?.querySelector(".tool-name")?.textContent).toBe("结束");
    expect(endedRow?.querySelector(".tool-arg")?.textContent).toBe("API 输入校验");

    const toolLine = endedRow?.querySelector(".tool-line");
    if (!toolLine) throw new Error("missing tool-line");
    fireEvent.click(toolLine);
    expect(screen.getByText("@orders")).not.toBeNull();
    expect(screen.getByText("nocturne/ensemble-orders")).not.toBeNull();
  });

  it("Markdown 传入 mentions 时只强调出现在 mentions 里的文本节点，不碰代码块", () => {
    const { container } = render(
      <Markdown
        text="请 @users 配合 `@users` 检查，@other 不高亮，回帖找 @maestro。"
        openUrl={vi.fn()}
        mentions={["users", "maestro"]}
      />,
    );
    const highlighted = Array.from(container.querySelectorAll(".ensemble-at")).map(
      (el) => el.textContent,
    );
    expect(highlighted).toEqual(["@users", "@maestro"]);
    expect(container.querySelector("code .ensemble-at")).toBeNull();
  });

  it("指挥对话不渲染新 Runtime 安静提醒，旧日志 Runtime 提醒帖照旧渲染", () => {
    const view = replaySessionView([
      {
        type: "session.created",
        sessionId: "s-coord",
        seq: 1,
        time: "2026-11-18T00:00:00.000Z",
        payload: {
          formatVersion: 1,
          nocturneVersion: "0.0.0",
          cwd: "/repo",
          workspaceRoot: "/repo",
          model: { provider: "anthropic", model: "claude-opus-5.5" },
          permissionPreset: "default",
        },
      },
      {
        type: "message.user",
        sessionId: "s-coord",
        seq: 2,
        time: "2026-11-18T00:00:01.000Z",
        turnId: "turn-1",
        payload: {
          messageId: "u-1",
          content: [{ type: "text", text: "发起合奏" }],
          workMode: { name: "ensemble", body: "Ensemble mode" },
        },
      },
      {
        type: "message.user",
        sessionId: "s-coord",
        seq: 3,
        time: "2026-11-18T00:00:02.000Z",
        turnId: "turn-2",
        payload: {
          messageId: "u-legacy",
          ensemble: { postNumber: 1, from: "Runtime", fromKind: "runtime" },
          content: [
            {
              type: "text",
              text: '<ensemble-post n="1" from="Runtime">\n@maestro 旧日志提醒\n</ensemble-post>',
            },
          ],
        },
      },
      {
        type: "message.user",
        sessionId: "s-coord",
        seq: 4,
        time: "2026-11-18T00:00:03.000Z",
        turnId: "turn-3",
        payload: {
          messageId: "u-quiet",
          ensembleQuietReminder: true,
          content: [
            {
              type: "text",
              text: "All ensemble members are waiting or paused and there are no pending deliveries.",
            },
          ],
        },
      },
      {
        type: "message.assistant",
        sessionId: "s-coord",
        seq: 5,
        time: "2026-11-18T00:00:04.000Z",
        turnId: "turn-3",
        payload: {
          messageId: "a-3",
          model: { provider: "anthropic", model: "claude-opus-5.5" },
          content: [{ type: "text", text: "继续调度成员" }],
          toolCalls: [],
          finishReason: "stop",
        },
      },
    ]);

    const { container } = render(
      <Conversation
        session={fakeSession()}
        view={view}
        openUrl={vi.fn()}
        cwd="/repo"
        subscribeEvents={() => () => undefined}
        images={createAttachmentImageSource()}
        busy={false}
      />,
    );

    expect(container.textContent).not.toContain("All ensemble members are waiting or paused");
    expect(container.textContent).toContain("继续调度成员");
    expect(container.querySelector(".post-in-head")?.textContent).toBe("Runtime → 指挥 · #1");
    expect(container.textContent).toContain("@maestro 旧日志提醒");
  });

  it("合奏入口行覆盖进行中、有成员待确认、已结束三种状态，且不含「完成」", () => {
    const onOpenEnsemble = vi.fn();
    const initEntry: ToolEntry = {
      ...makeToolEntry(3, "ensemble_init", { title: "r1121j 合奏入口" }),
      completedSeq: 5,
    };
    const baseEnsemble: EnsembleView = {
      createdSeq: 4,
      title: "r1121j 合奏入口",
      status: "active",
      maestro: {
        model: { provider: "anthropic", model: "claude-opus-5.5" },
        status: "working",
        awaitingPermission: false,
      },
      members: [
        makeMember("impl", { status: "working" }),
        makeMember("verify", { status: "waiting" }),
        makeMember("old", { status: "removed" }),
      ],
      awaitingPermissionMembers: [],
      posts: [],
    };
    const view = createSessionView();
    view.entries = [initEntry];
    view.ensemble = baseEnsemble;

    const { container, rerender } = render(
      <Conversation
        session={fakeSession()}
        view={view}
        openUrl={vi.fn()}
        cwd="/repo"
        subscribeEvents={() => () => undefined}
        images={createAttachmentImageSource()}
        busy={false}
        onOpenEnsemble={onOpenEnsemble}
      />,
    );

    const row = container.querySelector("button.ensemble-row");
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain("合奏");
    expect(row?.textContent).toContain("r1121j 合奏入口");
    expect(row?.textContent).not.toContain("完成");
    expect(row?.textContent).not.toContain("已结束");
    // 头像组包含指挥 + 2 名未移除成员（排除 removed），均无 warn
    const avatars = row?.querySelectorAll(".ensemble-row-avatars .ensemble-av");
    expect(avatars?.length).toBe(3);
    expect(row?.querySelectorAll(".ensemble-row-avatars .ensemble-av.warn").length).toBe(0);
    const dot = row?.querySelector(".sp-ensemble-dot");
    expect(dot?.classList.contains("ok")).toBe(true);
    expect(dot?.classList.contains("warn")).toBe(false);
    expect(row?.querySelector(".ensemble-row-chevron")).not.toBeNull();

    // 点击与 Enter 调用 openEnsemble
    if (!row) throw new Error("missing ensemble-row");
    fireEvent.click(row);
    fireEvent.keyDown(row, { key: "Enter" });
    expect(onOpenEnsemble).toHaveBeenCalledTimes(2);

    // 有成员待确认：待确认成员头像加 warn 描边，圆点变 warn
    const askEnsemble: EnsembleView = {
      ...baseEnsemble,
      members: [
        makeMember("impl", { status: "working" }),
        makeMember("verify", {
          status: "working",
          pendingPermissions: [
            {
              requestId: "req-1",
              callId: "c-1",
              reason: "执行命令",
              subjects: [{ kind: "shell", target: "pnpm test" }],
              options: ["allow_once", "deny"],
            },
          ],
        }),
        makeMember("old", { status: "removed" }),
      ],
      awaitingPermissionMembers: ["verify"],
    };
    rerender(
      <Conversation
        session={fakeSession()}
        view={{ ...view, ensemble: askEnsemble }}
        openUrl={vi.fn()}
        cwd="/repo"
        subscribeEvents={() => () => undefined}
        images={createAttachmentImageSource()}
        busy={false}
        onOpenEnsemble={onOpenEnsemble}
      />,
    );

    const askRow = container.querySelector("button.ensemble-row");
    expect(askRow?.querySelectorAll(".ensemble-row-avatars .ensemble-av").length).toBe(3);
    expect(askRow?.querySelectorAll(".ensemble-row-avatars .ensemble-av.warn").length).toBe(1);
    expect(askRow?.querySelector(".sp-ensemble-dot")?.classList.contains("warn")).toBe(true);
    expect(askRow?.textContent).not.toContain("完成");

    // 已结束：右侧只写「已结束」，无头像组与圆点，仍保留箭头且可点/Enter
    const endedEnsemble: EnsembleView = {
      ...baseEnsemble,
      status: "ended",
      endedSeq: 10,
      endedReason: "maestro",
    };
    rerender(
      <Conversation
        session={fakeSession()}
        view={{ ...view, ensemble: endedEnsemble }}
        openUrl={vi.fn()}
        cwd="/repo"
        subscribeEvents={() => () => undefined}
        images={createAttachmentImageSource()}
        busy={false}
        onOpenEnsemble={onOpenEnsemble}
      />,
    );

    const endedRow = container.querySelector("button.ensemble-row");
    expect(endedRow).not.toBeNull();
    expect(endedRow?.querySelector(".ensemble-row-avatars")).toBeNull();
    expect(endedRow?.querySelector(".sp-ensemble-dot")).toBeNull();
    expect(endedRow?.querySelector(".tool-res")?.textContent).toBe("已结束");
    expect(endedRow?.textContent).not.toContain("完成");
    expect(endedRow?.querySelector(".ensemble-row-chevron")).not.toBeNull();
    if (!endedRow) throw new Error("missing ended ensemble-row");
    fireEvent.click(endedRow);
    fireEvent.keyDown(endedRow, { key: "Enter" });
    expect(onOpenEnsemble).toHaveBeenCalledTimes(4);
  });

  it("多次合奏时较早的 ensemble_init 行显示「已结束」且无箭头、不可点", () => {
    const onOpenEnsemble = vi.fn();
    const firstInit: ToolEntry = {
      ...makeToolEntry(3, "ensemble_init", { title: "第一次合奏" }),
      completedSeq: 5,
    };
    const secondInit: ToolEntry = {
      ...makeToolEntry(20, "ensemble_init", { title: "第二次合奏" }),
      completedSeq: 22,
    };
    const view = createSessionView();
    view.entries = [firstInit, secondInit];
    view.ensemble = {
      createdSeq: 21,
      title: "第二次合奏",
      status: "active",
      maestro: {
        model: { provider: "anthropic", model: "claude-opus-5.5" },
        status: "working",
        awaitingPermission: false,
      },
      members: [makeMember("impl", { status: "working" })],
      awaitingPermissionMembers: [],
      posts: [],
    };

    const { container } = render(
      <Conversation
        session={fakeSession()}
        view={view}
        openUrl={vi.fn()}
        cwd="/repo"
        subscribeEvents={() => () => undefined}
        images={createAttachmentImageSource()}
        busy={false}
        onOpenEnsemble={onOpenEnsemble}
      />,
    );

    const rows = Array.from(container.querySelectorAll(".ensemble-row"));
    expect(rows).toHaveLength(2);
    const [earlier, current] = rows;
    expect(earlier?.tagName).toBe("DIV");
    expect(earlier?.textContent).toContain("第一次合奏");
    expect(earlier?.querySelector(".tool-res")?.textContent).toBe("已结束");
    expect(earlier?.querySelector(".ensemble-row-chevron")).toBeNull();
    expect(earlier?.querySelector(".ensemble-row-avatars")).toBeNull();
    if (earlier) fireEvent.click(earlier);
    expect(onOpenEnsemble).not.toHaveBeenCalled();

    expect(current?.tagName).toBe("BUTTON");
    expect(current?.textContent).toContain("第二次合奏");
    expect(current?.querySelector(".ensemble-row-chevron")).not.toBeNull();
    expect(current?.querySelector(".sp-ensemble-dot")?.classList.contains("ok")).toBe(true);
    if (current) fireEvent.click(current);
    expect(onOpenEnsemble).toHaveBeenCalledTimes(1);
  });

  it("失败或运行中的 ensemble_init 仍渲染为通用工具行", () => {
    const runningInit: ToolEntry = {
      ...makeToolEntry(3, "ensemble_init", { title: "初始化中" }),
      status: "running",
      result: undefined,
    };
    const failedInit: ToolEntry = {
      ...makeToolEntry(6, "ensemble_init", { title: "已有合奏" }),
      status: "error",
      result: {
        status: "error",
        durationMs: 2,
        output: undefined,
        error: { code: "invalid_input", message: "already active" },
        truncated: false,
        spillPath: undefined,
        modelContent: "error",
      },
    };
    const view = createSessionView();
    view.entries = [runningInit, failedInit];

    const { container } = render(
      <Conversation
        session={fakeSession()}
        view={view}
        openUrl={vi.fn()}
        cwd="/repo"
        subscribeEvents={() => () => undefined}
        images={createAttachmentImageSource()}
        busy={true}
        onOpenEnsemble={vi.fn()}
      />,
    );

    expect(container.querySelector(".ensemble-row")).toBeNull();
    expect(container.querySelectorAll("details.tool-details")).toHaveLength(2);
  });
});
