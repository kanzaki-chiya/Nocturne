/**
 * 对话里的子代理入口与只读渲染（ADR-0060 第 6 节与修订（五）第 4、6、7 条）：
 * 父 task 行的「在面板中查看」、只读视图没有任何写入口，缺省行为不变。
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createSessionView, reduceSessionView, type SessionView } from "@nocturne/core/protocol";
import type { RpcSession } from "@nocturne/rpc/client";
import { afterEach, expect, it, vi } from "vitest";

import { createAttachmentImageSource } from "../src/attachment-images";
import {
  Conversation,
  type ConversationProps,
  type ReadOnlyConversationProps,
  type SubagentLinks,
} from "../src/Conversation";
import { linkFor } from "../src/subagent-panel";
import {
  assistantMessage,
  durable,
  externalEntry,
  settled,
  summary,
  taskEntry,
  toolCompleted,
  toolStarted,
  userMessage,
} from "./subagent-fixtures";

afterEach(cleanup);

const noop = () => undefined;

function liveProps(view: SessionView, links?: SubagentLinks): ConversationProps {
  return {
    session: { id: "p" } as unknown as RpcSession,
    view,
    openUrl: vi.fn(),
    cwd: "Z:/p",
    subscribeEvents: () => noop,
    images: createAttachmentImageSource(),
    busy: false,
    ...(links !== undefined ? { subagentLinks: links } : {}),
  };
}

function readOnlyProps(
  view: SessionView,
  over: Partial<ReadOnlyConversationProps> = {},
): ReadOnlyConversationProps {
  return {
    session: { id: "child-1", readOnly: true, readAttachment: vi.fn() },
    readOnly: { frozen: false },
    view,
    openUrl: vi.fn(),
    cwd: "Z:/p",
    subscribeEvents: () => noop,
    images: createAttachmentImageSource(),
    busy: false,
    ...over,
  };
}

function parentView(...entries: ReturnType<typeof taskEntry>[]): SessionView {
  const view = createSessionView();
  view.entries = entries;
  return view;
}

function linksFor(
  summaries: ReturnType<typeof summary>[],
  open = vi.fn(),
): SubagentLinks & { open: ReturnType<typeof vi.fn> } {
  return { link: (entry) => linkFor(entry, summaries), open };
}

const viewButton = () => screen.queryByRole("button", { name: "在面板中查看" });

it("缺省（手机、没连后台）：task 行没有「在面板中查看」，行为与渲染不变", () => {
  render(<Conversation {...liveProps(parentView(taskEntry()))} />);
  expect(viewButton()).toBeNull();
  expect(screen.queryByText("正在定位…")).toBeNull();
  // 行本身照常渲染子任务
  expect(screen.getByLabelText("工具 task")).toBeTruthy();
});

it("运行中查到 child 即可点；独立按钮不触发行的展开/收起；点击带上 childSessionId", () => {
  const links = linksFor([summary({ childSessionId: "child-9" })]);
  render(<Conversation {...liveProps(parentView(taskEntry()), links)} />);
  const row = screen.getByLabelText("工具 task");
  const details = row.querySelector("details");
  expect(details?.open).toBe(false);
  const button = viewButton();
  expect(button).toBeTruthy();
  expect((button as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(button as HTMLElement);
  expect(links.open).toHaveBeenCalledWith("child-9");
  // 没有触发展开
  expect(details?.open).toBe(false);
  expect(row.querySelector(".tool-line")?.getAttribute("aria-expanded")).toBe("false");
});

it("运行中还没查到：显示「正在定位…」且不可点；查到后同一行自行变成可点", () => {
  const view = parentView(taskEntry());
  const first = linksFor([]);
  const { rerender } = render(<Conversation {...liveProps(view, first)} />);
  const locating = screen.getByRole("button", { name: "正在定位…" });
  expect((locating as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(locating);
  expect(first.open).not.toHaveBeenCalled();
  expect(viewButton()).toBeNull();
  // 目录刷新后：不是永久缓存成「无子会话」
  const second = linksFor([summary()]);
  rerender(<Conversation {...liveProps(view, second)} />);
  expect(screen.queryByText("正在定位…")).toBeNull();
  expect(viewButton()).toBeTruthy();
});

it("完成、失败、取消的 task 只要有关联 child 都可点；无 child 的失败和启动确认中不显示", () => {
  const done = taskEntry({
    callId: "c-ok",
    key: "t:c-ok",
    status: "ok",
    result: settled("ok"),
  });
  const failed = taskEntry({
    callId: "c-err",
    key: "t:c-err",
    status: "error",
    result: settled("error"),
  });
  const cancelled = taskEntry({
    callId: "c-cancel",
    key: "t:c-cancel",
    status: "cancelled",
    result: settled("cancelled"),
  });
  const noChild = taskEntry({
    callId: "c-none",
    key: "t:c-none",
    status: "error",
    result: settled("error"),
  });
  const asking = taskEntry({ callId: "c-ask", key: "t:c-ask", status: "awaiting_permission" });
  const links = linksFor([
    summary({ callId: "c-ok", childSessionId: "k1", state: "ended" }),
    summary({ callId: "c-err", childSessionId: "k2", state: "ended" }),
    summary({ callId: "c-cancel", childSessionId: "k3", state: "ended" }),
  ]);
  render(
    <Conversation {...liveProps(parentView(done, failed, cancelled, noChild, asking), links)} />,
  );
  expect(screen.getAllByRole("button", { name: "在面板中查看" })).toHaveLength(3);
  expect(screen.queryByText("正在定位…")).toBeNull();
  for (const [index, child] of ["k1", "k2", "k3"].entries()) {
    fireEvent.click(screen.getAllByRole("button", { name: "在面板中查看" })[index] as HTMLElement);
    expect(links.open).toHaveBeenLastCalledWith(child);
  }
});

it("ACP 外部 agent 行保留原有进度与结果，不提供「在面板中查看」", () => {
  const ext = externalEntry("claude", { liveOutput: "外部进度一行" });
  const links = linksFor([summary({ callId: "ext-1" })]);
  render(<Conversation {...liveProps(parentView(ext), links)} />);
  expect(viewButton()).toBeNull();
  expect(screen.queryByText("正在定位…")).toBeNull();
  expect(screen.getByText("外部进度一行")).toBeTruthy();
});

// ── 只读渲染 ──

function childView(): SessionView {
  const view = createSessionView();
  const events = [
    userMessage(1, "检查依赖方向并汇报"),
    durable("turn.started", 2, { turnIndex: 1 }),
    toolStarted(3, "r1", "read", { path: "a.ts" }),
    toolCompleted(4, "r1", "read", "ok", "读完了"),
    assistantMessage(5, "依赖方向正常"),
    userMessage(6, "请用 finish 提交结果"),
    toolStarted(7, "f1", "finish", { result: "全部正常" }),
    toolCompleted(8, "f1", "finish", "ok", "结果已提交给父会话。"),
    durable("turn.completed", 9, {
      reason: "done",
      steps: 2,
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
  ];
  for (const event of events) reduceSessionView(view, event);
  return view;
}

it("只读视图：任务与催促折叠展示，思考/工具/输出照常渲染，没有任何写入口", () => {
  render(<Conversation {...readOnlyProps(childView())} />);
  // 任务原文与催促：只读折叠块，标签区分
  const blocks = document.querySelectorAll("details.ro-user");
  expect(blocks).toHaveLength(2);
  expect(blocks[0]?.querySelector(".ro-user-tag")?.textContent).toBe("任务");
  expect(blocks[1]?.querySelector(".ro-user-tag")?.textContent).toBe("催促");
  expect(blocks[0]?.querySelector(".ro-user-preview")?.textContent).toBe("检查依赖方向并汇报");
  // 展开才有原文（保留复制）
  const first = blocks[0] as HTMLDetailsElement;
  act(() => {
    first.open = true;
  });
  expect(first.querySelector(".u-text")?.textContent).toBe("检查依赖方向并汇报");
  expect(within(first).getByRole("button", { name: "复制" })).toBeTruthy();
  // 输出与工具
  expect(screen.getByText("依赖方向正常")).toBeTruthy();
  expect(screen.getByLabelText("工具 read")).toBeTruthy();
  expect(screen.getByLabelText("工具 finish")).toBeTruthy();
  // 没有输入框，也没有重发、编辑、分叉、撤销、中断
  expect(document.querySelector("textarea, input[type=text]")).toBeNull();
  for (const name of [/编辑并重发/, /^重发$/, /分叉/, /撤销/, /中断/, /发送/]) {
    expect(screen.queryByRole("button", { name })).toBeNull();
  }
  // 复制回复保留
  expect(screen.getByRole("button", { name: "复制回复" })).toBeTruthy();
});

it("只读视图里嵌套的 task 行不出现「在面板中查看」，即使上层传了入口", () => {
  const view = createSessionView();
  view.entries = [taskEntry({ status: "ok", result: settled("ok") })];
  const links = linksFor([summary()]);
  // 类型上只读 props 传不进 subagentLinks；运行时也不能因为多传了就出现按钮
  const props = { ...readOnlyProps(view), subagentLinks: links } as ReadOnlyConversationProps;
  render(<Conversation {...props} />);
  expect(screen.getByLabelText("工具 task")).toBeTruthy();
  expect(viewButton()).toBeNull();
});

it("只读视图的待决权限：只给提示，没有应答按钮，按键不起作用；未收束的明确标历史", () => {
  const view = childView();
  reduceSessionView(
    view,
    durable("permission.requested", 9, {
      requestId: "req-1",
      callId: "w1",
      subjects: [{ kind: "edit", target: "x.txt" }],
      reason: "需要确认",
      options: ["allow_once", "deny"],
    }),
  );
  expect(view.pendingPermission).toBeDefined();
  const { rerender } = render(<Conversation {...readOnlyProps(view)} />);
  expect(screen.getByText("确认仍在主对话处理；此处不能批准。")).toBeTruthy();
  for (const name of [/允许/, /拒绝/]) expect(screen.queryByRole("button", { name })).toBeNull();
  // 快捷键没有任何响应：不抛错、不出现卡片
  for (const key of ["1", "2", "Enter", "Escape", "y", "n"]) {
    fireEvent.keyDown(document.body, { key });
  }
  expect(screen.queryByRole("button", { name: /允许/ })).toBeNull();
  // 未收束：明确是历史日志里没有结算的请求
  rerender(<Conversation {...readOnlyProps(view, { readOnly: { frozen: true } })} />);
  expect(screen.getByText(/历史日志里没有结算的确认请求/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /允许|拒绝/ })).toBeNull();
});

it("未收束的只读视图：仍在 running 的工具行不转圈、不计时，标「未收束」；不伪造 reducer 事件", () => {
  vi.useFakeTimers();
  try {
    const view = createSessionView();
    for (const event of [
      userMessage(1, "任务"),
      durable("turn.started", 2, { turnIndex: 1 }),
      toolStarted(3, "s1", "shell", { command: "sleep 100" }),
    ]) {
      reduceSessionView(view, event);
    }
    const before = JSON.stringify(view.entries);
    const revision = view.revision;
    const { rerender } = render(<Conversation {...readOnlyProps(view)} />);
    // 还没冻结：运行中的行转圈
    expect(document.querySelector(".tool-spin")).not.toBeNull();
    rerender(<Conversation {...readOnlyProps(view, { readOnly: { frozen: true } })} />);
    expect(document.querySelector(".tool-spin")).toBeNull();
    expect(document.querySelector(".tool.running")).toBeNull();
    expect(screen.getByText("未收束")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(document.querySelector(".tool-secs")).toBeNull();
    // 视图没有被改动：不补 turn.completed、不改工具状态
    expect(view.revision).toBe(revision);
    expect(JSON.stringify(view.entries)).toBe(before);
    expect(view.currentTurn).toBeDefined();
  } finally {
    vi.useRealTimers();
  }
});
