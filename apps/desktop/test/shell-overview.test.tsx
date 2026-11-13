import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { BackgroundShellTask, SwarmMemberView, SwarmView } from "@nocturne/core/protocol";
import { SessionOverview } from "../src/PanelChrome";
import { parseStoredTabs, restoreTabs, storedTabs } from "../src/side-panel";

const running: BackgroundShellTask = {
  taskId: "run",
  callId: "call",
  name: "running fixture",
  command: "node fixture",
  logPath: "/log",
  outputChars: 0,
  status: "running",
  startedAt: "2026-11-08T00:00:00Z",
};
const done: BackgroundShellTask = {
  ...running,
  taskId: "done",
  name: "ended fixture",
  status: "exited",
  endedAt: "2026-11-08T00:00:05Z",
  exitCode: 0,
};
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
function overview(tasks: BackgroundShellTask[], open = vi.fn(), kill = vi.fn()) {
  return (
    <SessionOverview
      project="test"
      workspace="Z:/test"
      totals={{ added: 0, removed: 0, files: 0 }}
      rightOffset={0}
      onOpenChanges={vi.fn()}
      shells={{ tasks, onOpen: open, onStop: kill }}
    />
  );
}
it("shell tabs validate, deduplicate and restore descriptors even without a live task", () => {
  const tab = {
    id: "tab",
    kind: "shell" as const,
    taskId: "missing",
    name: "fixture",
    command: "node fixture",
  };
  const parsed = parseStoredTabs([
    tab,
    { ...tab, id: "duplicate" },
    { ...tab, id: "bad", taskId: 1 },
  ]);
  expect(parsed).toEqual([tab]);
  expect(storedTabs(restoreTabs(parsed, tab.id, () => "new").tabs)).toEqual([tab]);
});
it("shell overview hides an empty group", () => {
  render(overview([]));
  expect(screen.queryByRole("group", { name: "后台任务" })).toBeNull();
});
it("shell overview sorts running first, opens output and stops from a sibling button", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-08T00:00:10Z"));
  const open = vi.fn();
  const kill = vi.fn();
  render(overview([done, running], open, kill));
  const group = screen.getByRole("group", { name: "后台任务" });
  expect(group.querySelector("button")?.textContent).toContain("running fixture");
  fireEvent.click(screen.getByRole("button", { name: /running fixture/ }));
  expect(open).toHaveBeenCalledWith(running);
  const stop = screen.getByRole("button", { name: "停止" });
  fireEvent.focus(screen.getByRole("button", { name: /running fixture/ }));
  fireEvent.mouseOver(group.querySelector(".ovpop-shell-row") as HTMLElement);
  fireEvent.click(stop);
  expect(kill).toHaveBeenCalledWith(running);
  expect(stop.parentElement?.querySelector("button button")).toBeNull();
  expect(group.querySelector(".done")?.textContent).toContain("5 秒");
});
it("shell overview shares a clock for ticking and expiry at five minutes", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-08T00:05:04Z"));
  render(overview([done, running]));
  expect(screen.getByText("ended fixture")).toBeTruthy();
  act(() => {
    vi.advanceTimersByTime(1000);
  });
  expect(screen.queryByText("ended fixture")).toBeNull();
  expect(screen.getByText("5 分 5 秒")).toBeTruthy();
});

function makeSwarmMember(name: string, overrides: Partial<SwarmMemberView> = {}): SwarmMemberView {
  return {
    name,
    childSessionId: `child-${name}`,
    charter: { owns: `${name}.ts`, handsOff: "other", doneWhen: "pass" },
    model: { provider: "anthropic", model: "claude-sonnet-4.5" },
    preset: "general",
    isolated: false,
    status: "working",
    pendingPermissions: [],
    ...overrides,
  };
}

it("合奏概览分组：进行中显示在变更之后子代理之前、结束后隐藏、待确认警告色、点击打开面板与成员", () => {
  const apiMember = makeSwarmMember("api-1", {
    isolated: true,
    activity: { kind: "tool", tool: "edit", detail: "src/api.ts" },
  });
  const uiMember = makeSwarmMember("ui-1", {
    profile: "deep",
    pendingPermissions: [
      { requestId: "r1", callId: "c1", reason: "cmd", subjects: [], options: [] },
    ],
    activity: { kind: "permission", target: "pnpm test" },
  });
  const removedMember = makeSwarmMember("old-1", { status: "removed" });
  const activeSwarm: SwarmView = {
    createdSeq: 1,
    title: "登录页改造与接口联调",
    status: "active",
    coordinator: {
      model: { provider: "anthropic", model: "claude-opus-4.6" },
      status: "working",
      awaitingPermission: false,
    },
    members: [apiMember, uiMember, removedMember],
    awaitingPermissionMembers: ["ui-1"],
    posts: [],
  };
  const onOpenBoard = vi.fn();
  const onOpenMember = vi.fn();
  const { container, rerender } = render(
    <SessionOverview
      project="test"
      workspace="Z:/test"
      totals={{ added: 0, removed: 0, files: 0 }}
      rightOffset={0}
      onOpenChanges={vi.fn()}
      swarm={{ swarm: activeSwarm, onOpenBoard, onOpenMember }}
      subagents={{
        running: [
          {
            parentSessionId: "p",
            callId: "sub-1",
            childSessionId: "child-sub-1",
            profile: "quick",
            model: "fake/m1",
            taskSummary: "检索文件",
            state: "running",
            startedAt: "2026-11-08T00:00:00Z",
          },
        ],
        external: [],
        onOpen: vi.fn(),
      }}
    />,
  );

  // 分组顺序：变更按钮 -> 合奏分组 -> 子代理分组
  const children = Array.from(container.querySelector(".ovpop")?.children ?? []);
  const changesIdx = children.findIndex((el) => el.textContent?.includes("变更"));
  const swarmIdx = children.findIndex((el) => el.getAttribute("aria-label") === "合奏");
  const subIdx = children.findIndex((el) => el.getAttribute("aria-label") === "子代理");
  expect(swarmIdx).toBeGreaterThan(changesIdx);
  expect(subIdx).toBeGreaterThan(swarmIdx);

  const swarmGroup = screen.getByRole("group", { name: "合奏" });
  expect(swarmGroup.querySelector(".sp-swarm-dot.warn")).not.toBeNull();
  expect(screen.queryByText("old-1")).toBeNull();
  expect(swarmGroup.textContent).toContain("claude-sonnet-4.5 · 独立工作树");
  expect(swarmGroup.textContent).toContain("deep");

  // 待确认成员：头像 warn 描边与摘要 warn 类
  const memberButtons = swarmGroup.querySelectorAll<HTMLButtonElement>(".ovpop-swarm-member");
  expect(memberButtons).toHaveLength(2);
  expect(memberButtons[0]?.querySelector(".swarm-av.warn")).toBeNull();
  expect(memberButtons[1]?.querySelector(".swarm-av.warn")).not.toBeNull();
  expect(memberButtons[1]?.querySelector(".ovpop-agent-summary.warn")?.textContent).toBe(
    "等待确认：pnpm test",
  );

  fireEvent.click(screen.getByRole("button", { name: /登录页改造与接口联调/ }));
  expect(onOpenBoard).toHaveBeenCalledTimes(1);
  const secondMember = memberButtons[1];
  if (!secondMember) throw new Error("missing second member button");
  fireEvent.click(secondMember);
  expect(onOpenMember).toHaveBeenCalledWith(uiMember);

  // 结束后整组隐藏
  rerender(
    <SessionOverview
      project="test"
      workspace="Z:/test"
      totals={{ added: 0, removed: 0, files: 0 }}
      rightOffset={0}
      onOpenChanges={vi.fn()}
      swarm={{ swarm: { ...activeSwarm, status: "ended" }, onOpenBoard, onOpenMember }}
    />,
  );
  expect(screen.queryByRole("group", { name: "合奏" })).toBeNull();
});
