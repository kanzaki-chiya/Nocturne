// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSessionView,
  formatSwarmPostForModel,
  type SwarmMemberView,
  type SwarmPostView,
  type SwarmView,
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

function makeMember(name: string, overrides: Partial<SwarmMemberView> = {}): SwarmMemberView {
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

function makePost(number: number, overrides: Partial<SwarmPostView> = {}): SwarmPostView {
  return {
    seq: number,
    time: "2026-11-12T13:31:00.000Z",
    number,
    from: "coordinator",
    fromKind: "coordinator",
    text: "测试",
    mentions: [],
    recipients: [],
    ...overrides,
  };
}

describe("Swarm 对话内渲染", () => {
  it("七种 Swarm 工具行使用规定标签与单行参数", () => {
    const view = createSessionView();
    view.entries = [
      makeToolEntry(1, "swarm_init", { title: "API 输入校验" }),
      makeToolEntry(2, "swarm_add_member", { name: "users", preset: "general" }),
      makeToolEntry(3, "swarm_post", { text: "请 @users 先建校验模块\n补充说明" }),
      makeToolEntry(4, "swarm_change_model", { name: "verifier", model: "openai/gpt-6.1-sol" }),
      makeToolEntry(5, "swarm_remove_member", { name: "schema" }),
      makeToolEntry(6, "swarm_checkout", { member: "users" }),
      makeToolEntry(7, "swarm_end", { summary: "全部并回\n次行" }),
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
    expect(names).toEqual(["Swarm", "添加", "发帖", "换模型", "移除", "检出", "结束"]);

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

  it("帖子送达渲染为 .post-in，解包 <swarm-post>，不显示编辑/重发/分叉或插话标记", () => {
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
            text: formatSwarmPostForModel({
              number: 14,
              from: "verifier",
              text: "三处测试全部通过，`pnpm test` 112 项通过。",
              checkedOut: { member: "orders", commit: "abcdef1234567890" },
            }),
          },
        ],
        steer: true,
        swarm: { postNumber: 14, from: "verifier", fromKind: "member" },
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
    expect(postIn?.querySelector(".post-in-head")?.textContent).toBe("@verifier → 协调者 · #14");
    expect(postIn?.textContent).toContain("三处测试全部通过");
    expect(postIn?.textContent).not.toContain("<swarm-post");
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
        swarmRecipientLabel="@orders"
      />,
    );
    expect(container.querySelector(".post-in-head")?.textContent).toBe("@verifier → @orders · #14");
  });

  it("入口行定位在建群轮末尾、统计未移除成员与帖子数、状态点随权限与结束变化，结束行按 endedSeq 定位并可展开未合并分支", () => {
    const view = createSessionView();
    view.entries = [
      {
        kind: "user",
        key: "u:1",
        seq: 1,
        turnId: "turn-1",
        content: [{ type: "text", text: "/swarm 加校验" }],
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
        content: [{ type: "text", text: '<swarm-post n="2" from="users">\n好了\n</swarm-post>' }],
        swarm: { postNumber: 2, from: "users", fromKind: "member" },
      },
    ];
    const swarm: SwarmView = {
      createdSeq: 3,
      title: "API 输入校验",
      status: "active",
      coordinator: {
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
    view.swarm = swarm;

    const onOpenSwarm = vi.fn();
    const { container, rerender } = render(
      <Conversation
        session={fakeSession()}
        view={view}
        openUrl={vi.fn()}
        cwd="/repo"
        subscribeEvents={() => () => undefined}
        images={createAttachmentImageSource()}
        busy={false}
        onOpenSwarm={onOpenSwarm}
      />,
    );

    const row = container.querySelector(".swarmrow") as HTMLButtonElement | null;
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain("API 输入校验");
    expect(row?.querySelector(".swarmrow-count")?.textContent).toBe("2 · 2");
    expect(row?.querySelector(".swarm-live.ok")).not.toBeNull();

    // 入口行位于 a:5 之后、post-in(seq=10) 之前
    const transcriptChildren = Array.from(
      container.querySelector(".conversation-transcript")?.children ?? [],
    );
    const rowIdx = transcriptChildren.findIndex((el) => el.classList.contains("swarmrow"));
    const postInIdx = transcriptChildren.findIndex((el) => el.classList.contains("post-in"));
    expect(rowIdx).toBeGreaterThan(0);
    expect(rowIdx).toBeLessThan(postInIdx);

    if (!row) throw new Error("missing swarmrow");
    fireEvent.click(row);
    expect(onOpenSwarm).toHaveBeenCalledTimes(1);

    // 成员等确认时入口行状态点变为 warn
    view.swarm = { ...swarm, awaitingPermissionMembers: ["orders"] };
    rerender(
      <Conversation
        session={fakeSession()}
        view={{ ...view }}
        openUrl={vi.fn()}
        cwd="/repo"
        subscribeEvents={() => () => undefined}
        images={createAttachmentImageSource()}
        busy={false}
        onOpenSwarm={onOpenSwarm}
      />,
    );
    expect(container.querySelector(".swarmrow .swarm-live.warn")).not.toBeNull();

    // 已结束：入口行状态点消失，结束行出现在 endedSeq 位置并展开 unmerged
    view.swarm = {
      ...swarm,
      status: "ended",
      endedSeq: 12,
      endedReason: "user",
      unmerged: [
        {
          name: "orders",
          childSessionId: "child-orders",
          branch: "nocturne/swarm-orders",
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
        onOpenSwarm={onOpenSwarm}
      />,
    );
    expect(container.querySelector(".swarmrow .swarm-live")).toBeNull();
    const endedRow = container.querySelector(".swarm-ended-row");
    expect(endedRow).not.toBeNull();
    expect(endedRow?.querySelector(".tool-name")?.textContent).toBe("结束");
    expect(endedRow?.querySelector(".tool-arg")?.textContent).toBe("API 输入校验");

    const toolLine = endedRow?.querySelector(".tool-line");
    if (!toolLine) throw new Error("missing tool-line");
    fireEvent.click(toolLine);
    expect(screen.getByText("@orders")).not.toBeNull();
    expect(screen.getByText("nocturne/swarm-orders")).not.toBeNull();
  });

  it("Markdown 传入 mentions 时只强调出现在 mentions 里的文本节点，不碰代码块", () => {
    const { container } = render(
      <Markdown
        text="请 @users 配合 `@users` 检查，@other 不高亮，回帖找 @coordinator。"
        openUrl={vi.fn()}
        mentions={["users", "coordinator"]}
      />,
    );
    const highlighted = Array.from(container.querySelectorAll(".swarm-at")).map(
      (el) => el.textContent,
    );
    expect(highlighted).toEqual(["@users", "@coordinator"]);
    expect(container.querySelector("code .swarm-at")).toBeNull();
  });
});
