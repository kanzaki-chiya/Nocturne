import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  createSessionView,
  type AssistantEntry,
  type TurnChanges,
  type RewindTarget,
} from "@nocturne/core/protocol";
import type { RpcSession } from "@nocturne/rpc/client";
import { Conversation, type ConversationProps } from "../src/Conversation";
import { createAttachmentImageSource } from "../src/attachment-images";

afterEach(cleanup);
const reply = (seq: number, turn: string): AssistantEntry => ({
  kind: "assistant",
  key: `a${seq}`,
  seq,
  turnId: turn,
  messageId: `a${seq}`,
  time: "2026-10-08T02:00:00Z",
  text: `回答 ${seq}`,
  reasoning: "",
  toolCalls: [],
  model: { provider: "test", model: "test" },
  usage: undefined,
  finishReason: "stop",
});
function fixture() {
  const view = createSessionView();
  view.entries = [
    { kind: "user", key: "u2", seq: 2, turnId: "t1", content: [{ type: "text", text: "first" }] },
    reply(3, "t1"),
    { kind: "user", key: "u8", seq: 8, turnId: "t2", content: [{ type: "text", text: "second" }] },
    reply(9, "t2"),
  ];
  const first: TurnChanges = {
    seq: 2,
    files: [
      {
        path: "Z:/project/old.ts",
        status: "modified",
        added: 1,
        removed: 1,
        restorable: true,
        external: false,
      },
    ],
    untrackedCalls: 0,
  };
  const latest: TurnChanges = {
    seq: 8,
    files: [
      {
        path: "Z:/project/src/a.ts",
        status: "modified",
        added: 3,
        removed: 2,
        restorable: true,
        external: true,
      },
      {
        path: "Z:/project/new.ts",
        status: "added",
        added: 2,
        removed: 0,
        restorable: true,
        external: false,
        approximate: true,
      },
      {
        path: "Z:/project/untracked",
        status: "modified",
        unavailable: "目录",
        restorable: false,
        external: false,
      },
    ],
    untrackedCalls: 1,
  };
  const target: RewindTarget = {
    seq: 8,
    firstLine: "second",
    text: "second",
    time: "",
    hasImages: false,
    files: [
      { path: latest.files[0]?.path ?? "", action: "restore", external: true },
      { path: latest.files[1]?.path ?? "", action: "delete", external: false },
      { path: latest.files[2]?.path ?? "", action: "untracked", reason: "目录", external: false },
    ],
    untrackedCalls: 1,
  };
  const diff = vi
    .fn<RpcSession["turnChangeDiff"]>()
    .mockResolvedValue({ diff: "@@ -1,1 +1,1 @@\n-old\n+new" });
  const rewind = vi.fn<RpcSession["rewind"]>().mockResolvedValue([
    { path: "Z:/project/src/a.ts", result: "restored" },
    { path: "Z:/project/new.ts", result: "deleted" },
  ]);
  const targets = vi.fn<RpcSession["rewindTargets"]>().mockResolvedValue([target]);
  const session = {
    id: "changes",
    rewindTargets: targets,
    turnChangeDiff: diff,
    rewind,
    resolveFiles: vi.fn().mockResolvedValue([]),
  } as unknown as RpcSession;
  const cache = new Map<string, ReturnType<RpcSession["turnChangeDiff"]>>();
  const props: ConversationProps = {
    session,
    view,
    cwd: "Z:/project",
    busy: false,
    openUrl: vi.fn(),
    subscribeEvents: () => () => undefined,
    images: createAttachmentImageSource(),
    onResubmit: vi.fn(),
    turnChanges: new Map([
      [2, first],
      [8, latest],
    ]),
    loadChangeDiff: (seq, path) => {
      const key = JSON.stringify([seq, path]);
      let result = cache.get(key);
      if (!result) {
        result = session.turnChangeDiff(seq, path);
        cache.set(key, result);
      }
      return result;
    },
    onRewindFiles: async (seq) => {
      const files = await session.rewind(seq, "files");
      latest.reverted = { seq: 20, files };
      rendered.rerender(<Conversation {...props} />);
    },
  };
  const rendered = render(<Conversation {...props} />);
  return { props, latest, first, targets, diff, rewind, rendered };
}

it("卡片位置与标题合计；整卡不再折叠，刷新不收起文件行", () => {
  const h = fixture();
  const latest = screen.getByRole("region", { name: "本轮文件更改 8" });
  expect(latest.textContent).toContain("已编辑 3 个文件");
  expect(latest.textContent).toContain("约 +5−2");
  expect(within(latest).queryByRole("button", { name: /已编辑 3 个文件/ })).toBeNull();
  expect(latest.nextElementSibling?.getAttribute("aria-label")).toBe("回复操作");
  expect(latest.previousElementSibling?.textContent).toContain("回答 9");
  expect(within(latest).queryByRole("button", { name: /再显示/ })).toBeNull();
  const file = within(latest).getByRole("button", { name: "文件差异 src/a.ts" });
  fireEvent.click(file);
  h.rendered.rerender(<Conversation {...h.props} turnChanges={new Map(h.props.turnChanges)} />);
  expect(file.getAttribute("aria-expanded")).toBe("true");
});

it("同用户轮含多个 Turn 时卡片和回复操作只跟最后非空文字", () => {
  const h = fixture();
  h.props.view.entries.push(reply(10, "retry"));
  h.rendered.rerender(<Conversation {...h.props} />);
  const card = screen.getByRole("region", { name: "本轮文件更改 8" });
  expect(card.previousElementSibling?.textContent).toContain("回答 10");
  expect(screen.getAllByRole("group", { name: "回复操作" })).toHaveLength(2);
});

it("仅最后有效轮可撤销，忙时置灰；生成中和无改动轮不显示", () => {
  const h = fixture();
  expect(screen.getAllByRole("button", { name: "↶ 撤销" })).toHaveLength(1);
  h.rendered.rerender(<Conversation {...h.props} busy />);
  const undo = screen.getByRole("button", { name: "↶ 撤销" }) as HTMLButtonElement;
  expect(undo.disabled).toBe(true);
  expect(undo.title).toBe("请先等待或按 Esc 中断");
  h.props.view.currentTurn = { turnId: "t2", turnIndex: 2 };
  h.rendered.rerender(<Conversation {...h.props} />);
  expect(screen.queryByRole("region", { name: "本轮文件更改 8" })).toBeNull();
  h.props.view.currentTurn = undefined;
  h.rendered.rerender(<Conversation {...h.props} turnChanges={new Map()} />);
  expect(screen.queryByText(/已编辑/)).toBeNull();
});

it("确认列还原、删除、无法还原与外部警告；取消默认聚焦，Esc 取消", async () => {
  const h = fixture();
  fireEvent.click(screen.getByRole("button", { name: "↶ 撤销" }));
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "取消" }));
  await screen.findByText("无法还原（目录）");
  expect(screen.getByText("还原")).toBeDefined();
  expect(screen.getByText("删除")).toBeDefined();
  expect(screen.getByText("本轮新建")).toBeDefined();
  expect(screen.getByText("a.ts 在这一轮之后被外部修改过，撤销会覆盖那些修改")).toBeDefined();
  expect(h.targets).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("group", { name: "确认撤销文件改动" })).toBeNull();
});

it("撤销调用 files 模式，成功后结果与收起；失败保留确认区和原文", async () => {
  const h = fixture();
  h.rewind.mockRejectedValueOnce(new Error("磁盘拒绝写入"));
  fireEvent.click(screen.getByRole("button", { name: "↶ 撤销" }));
  await screen.findByText("本轮新建");
  fireEvent.click(screen.getByRole("button", { name: "撤销文件改动" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("alert").textContent).toBe("磁盘拒绝写入");
  expect(screen.getByRole("group", { name: "确认撤销文件改动" })).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "撤销文件改动" }));
  await screen.findByText("已撤销 · 还原 1 个文件，删除 1 个");
  expect(h.rewind).toHaveBeenLastCalledWith(8, "files");
  expect(screen.queryByRole("button", { name: "↶ 撤销" })).toBeNull();
  expect(screen.getByRole("button", { name: "文件差异 src/a.ts" })).toBeDefined();
});

it("确认期间新增用户轮立即关闭旧轮确认，不允许撤销较早轮", async () => {
  const h = fixture();
  fireEvent.click(screen.getByRole("button", { name: "↶ 撤销" }));
  await screen.findByText("本轮新建");
  h.props.view.entries.push({
    kind: "user",
    key: "u20",
    seq: 20,
    turnId: "t3",
    content: [{ type: "text", text: "next" }],
  });
  h.rendered.rerender(<Conversation {...h.props} />);
  expect(screen.queryByRole("group", { name: "确认撤销文件改动" })).toBeNull();
  expect(screen.queryByRole("button", { name: "↶ 撤销" })).toBeNull();
  expect(h.rewind).not.toHaveBeenCalled();
});

it("展开文件才读 diff，再次展开命中缓存；计数刷新保持行展开并换 diff", async () => {
  const h = fixture();
  expect(h.diff).not.toHaveBeenCalled();
  const file = screen.getByRole("button", { name: "文件差异 src/a.ts" });
  fireEvent.click(file);
  await screen.findByLabelText("文件差异");
  expect(h.diff).toHaveBeenCalledWith(8, "Z:/project/src/a.ts");
  fireEvent.click(file);
  fireEvent.click(file);
  await waitFor(() => expect(h.diff).toHaveBeenCalledTimes(1));
  expect(file.getAttribute("aria-expanded")).toBe("true");
  await act(async () => {
    h.rendered.rerender(<Conversation {...h.props} />);
  });
  expect(h.diff).toHaveBeenCalledTimes(1);
});

function many(count: number): TurnChanges["files"] {
  return Array.from({ length: count }, (_, i) => ({
    path: `Z:/project/src/file-${i}.ts`,
    status: "modified" as const,
    added: i + 1,
    removed: i,
    restorable: true,
    external: false,
  }));
}

it("超过 3 个文件只露前 3 行，再显示后展开，重新挂载回到 3 行", () => {
  const h = fixture();
  h.latest.files = many(5);
  h.rendered.rerender(<Conversation {...h.props} />);
  const card = screen.getByRole("region", { name: "本轮文件更改 8" });
  expect(within(card).getAllByRole("button", { name: /^文件差异 / })).toHaveLength(3);
  expect(within(card).queryByRole("button", { name: "文件差异 src/file-3.ts" })).toBeNull();
  const more = within(card).getByRole("button", { name: /再显示 2 个文件/ });
  expect(more.querySelector(".fold-arrow.up")).toBeNull();
  fireEvent.click(more);
  expect(within(card).getAllByRole("button", { name: /^文件差异 / })).toHaveLength(5);
  const collapse = within(card).getByRole("button", { name: "收起" });
  expect(collapse.querySelector(".fold-arrow.up")).not.toBeNull();
  cleanup();
  render(<Conversation {...h.props} />);
  expect(
    within(screen.getByRole("region", { name: "本轮文件更改 8" })).getAllByRole("button", {
      name: /^文件差异 /,
    }),
  ).toHaveLength(3);
});

it("标题合计带约；行上没有外部修改与原因，点开 unavailable 显示原因", () => {
  const h = fixture();
  const card = screen.getByRole("region", { name: "本轮文件更改 8" });
  expect(card.textContent).toContain("已编辑 3 个文件");
  expect(card.textContent).toContain("约 +5−2");
  expect(card.textContent).not.toContain("已在外部修改");
  expect(within(card).queryByText("目录")).toBeNull();
  const row = within(card).getByRole("button", { name: "文件差异 untracked" });
  expect(row.getAttribute("title")).toBe("目录");
  fireEvent.click(row);
  expect(within(card).getByText("目录")).toBeDefined();
  expect(h.diff).not.toHaveBeenCalled();
});

it("撤销按钮依据 restorable；确认区仍提醒外部修改", async () => {
  const h = fixture();
  expect(screen.getByRole("button", { name: "↶ 撤销" })).toBeDefined();
  h.latest.files = h.latest.files.map((file) => ({ ...file, restorable: false }));
  h.rendered.rerender(<Conversation {...h.props} />);
  expect(screen.queryByRole("button", { name: "↶ 撤销" })).toBeNull();
  h.latest.files = h.latest.files.map((file, index) => ({ ...file, restorable: index === 0 }));
  h.rendered.rerender(<Conversation {...h.props} />);
  fireEvent.click(screen.getByRole("button", { name: "↶ 撤销" }));
  await screen.findByText("a.ts 在这一轮之后被外部修改过，撤销会覆盖那些修改");
});

it("不超过 3 个文件时没有再显示", () => {
  fixture();
  expect(screen.queryByRole("button", { name: /再显示/ })).toBeNull();
  expect(screen.queryByRole("button", { name: "收起" })).toBeNull();
});

it("无助手文字时卡片落在最后条目之后；全 unavailable 无合计无撤销", () => {
  const h = fixture();
  h.props.view.entries = h.props.view.entries.filter((e) => e.kind !== "assistant");
  h.latest.files = [
    {
      path: "Z:/project/dir",
      status: "modified",
      unavailable: "目录",
      restorable: false,
      external: false,
    },
  ];
  h.rendered.rerender(<Conversation {...h.props} />);
  const card = screen.getByRole("region", { name: "本轮文件更改 8" });
  expect(card.previousElementSibling?.classList.contains("u")).toBe(true);
  expect(card.querySelector(".turn-changes-counts")).toBeNull();
  expect(screen.queryByRole("button", { name: "↶ 撤销" })).toBeNull();
});
