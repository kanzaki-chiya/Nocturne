// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSessionView,
  formatEnsemblePostForModel,
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

  it("对话区不再渲染入口行，workMode.name=ensemble 显示 /ensemble，结束行仍按 endedSeq 定位并可展开未合并分支", () => {
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
    expect(container.querySelector(".mode-ref")?.textContent).toBe("/ensemble");

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
});
