import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { GoalState, TodoItem } from "@nocturne/core/protocol";
import { TodoPanel } from "../src/TodoList";
import { GoalRow } from "../src/GoalRow";

const objective = "编写解析器并验证全部示例";
const goal = (status: GoalState["status"], reason?: string): GoalState => ({
  objective,
  status,
  reason,
  since: 1,
  rounds: 2,
  maxRounds: 10,
  maxMinutes: 60,
  activeMs: 728_000,
});
const items: TodoItem[] = [
  { text: "已完成", status: "completed" },
  { text: "进行中", status: "in_progress" },
  { text: "待办", status: "pending" },
];
const actions = { onStopGoal: vi.fn(), onResumeGoal: vi.fn(), onCancelGoal: vi.fn() };
afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.clearAllMocks();
});

it("目标置于清单之前，展开全文占位，点进度收起但不更改清单偏好", () => {
  const prefs = { get: () => ({ todosCollapsed: false }), update: vi.fn() };
  render(
    <TodoPanel items={items} goal={goal("active")} goalActions={actions} prefs={prefs as never} />,
  );
  const panel = screen.getByRole("region", { name: "当前任务清单" });
  expect(panel.firstElementChild?.className).toBe("goal-row");
  expect(screen.getByText("12分8秒")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "展开" }));
  expect(screen.getByText(objective).closest(".goal-detail")).toBeTruthy();
  expect(panel.querySelector('[aria-hidden="true"] .todo-list')).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /1\/3/ }));
  expect(screen.queryByRole("button", { name: "收起" })).toBeNull();
  expect(screen.getByRole("list", { name: "任务清单列表" })).toBeTruthy();
  expect(prefs.update).not.toHaveBeenCalled();
});

it("无清单也显示目标，各状态控制与可见性", () => {
  const { rerender } = render(<TodoPanel items={[]} goal={goal("active")} goalActions={actions} />);
  fireEvent.click(screen.getByRole("button", { name: "暂停" }));
  expect(actions.onStopGoal).toHaveBeenCalledTimes(1);
  rerender(<TodoPanel items={[]} goal={goal("blocked", "no progress")} goalActions={actions} />);
  fireEvent.click(screen.getByRole("button", { name: "展开" }));
  expect(screen.getByText(/受阻：/).className).toBe("goal-reason");
  fireEvent.click(screen.getByRole("button", { name: "继续" }));
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(actions.onResumeGoal).toHaveBeenCalledTimes(1);
  expect(actions.onCancelGoal).toHaveBeenCalledTimes(1);
  for (const status of ["stopped", "limit"] as const) {
    rerender(
      <TodoPanel
        items={[]}
        goal={goal(status, status === "stopped" ? "user" : undefined)}
        goalActions={actions}
      />,
    );
    expect(screen.getByText("/goal")).toBeTruthy();
  }
  for (const g of [goal("met"), goal("stopped", "rewound"), undefined]) {
    rerender(<TodoPanel items={[]} goal={g} goalActions={actions} />);
    expect(screen.queryByText("/goal")).toBeNull();
  }
});

it("清单原本折叠时，展开目标不改变偏好，点进度仍会显示清单", () => {
  const prefs = { get: () => ({ todosCollapsed: true }), update: vi.fn() };
  render(
    <TodoPanel items={items} goal={goal("active")} goalActions={actions} prefs={prefs as never} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "展开" }));
  expect(prefs.update).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /1\/3/ }));
  expect(screen.getByRole("list", { name: "任务清单列表" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "收起" })).toBeNull();
});

it("换目标或继续目标后全文默认收起", () => {
  const { rerender } = render(<TodoPanel items={[]} goal={goal("active")} goalActions={actions} />);
  fireEvent.click(screen.getByRole("button", { name: "展开" }));
  expect(screen.getByRole("button", { name: "收起" })).toBeTruthy();
  rerender(<TodoPanel items={[]} goal={{ ...goal("active"), since: 20 }} goalActions={actions} />);
  expect(screen.getByRole("button", { name: "展开" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "收起" })).toBeNull();
});

it("运行秒表只更新子组件，不导致父面板随秒重渲染；无 turn 不设 timer", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:08Z"));
  const spy = vi.spyOn(window, "setInterval");
  let parentRenders = 0;
  function Parent({ current }: { current: GoalState }) {
    parentRenders++;
    return <TodoPanel items={items} goal={current} goalActions={actions} />;
  }
  const { rerender } = render(<Parent current={goal("active")} />);
  expect(spy).not.toHaveBeenCalled();
  rerender(
    <Parent current={{ ...goal("active"), activeMs: 0, turnStartedAt: "2026-01-01T00:00:00Z" }} />,
  );
  const before = parentRenders;
  act(() => vi.advanceTimersByTime(2000));
  expect(screen.getByText("10秒")).toBeTruthy();
  expect(parentRenders).toBe(before);
  rerender(<Parent current={{ ...goal("stopped"), activeMs: 10_000 }} />);
  expect(vi.getTimerCount()).toBe(0);
  act(() => vi.advanceTimersByTime(2000));
  expect(screen.getByText("10秒")).toBeTruthy();
  spy.mockRestore();
});

it("目标行组件本身不含清单；展开、暂停与取消保持触控按钮", () => {
  function Mobile() {
    const [expanded, setExpanded] = useState(false);
    return (
      <div className="phone">
        <GoalRow
          goal={goal("active")}
          expanded={expanded}
          onExpand={setExpanded}
          onError={() => undefined}
          {...actions}
        />
      </div>
    );
  }
  const { container } = render(<Mobile />);
  expect(container.querySelector(".todo-list")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "展开" }));
  expect(container.querySelector(".goal-detail-text")?.textContent).toBe(objective);
  fireEvent.click(screen.getByRole("button", { name: "暂停" }));
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(actions.onStopGoal).toHaveBeenCalledTimes(1);
  expect(actions.onCancelGoal).toHaveBeenCalledTimes(1);
});
