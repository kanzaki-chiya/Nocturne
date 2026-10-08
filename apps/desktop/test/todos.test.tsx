import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { TodoItem } from "@nocturne/core/protocol";
import { TodoPanel } from "../src/TodoList";
import { Composer } from "../src/Composer";
import { createPrefsStore, PREFS_KEY } from "../src/prefs";

afterEach(() => {
  cleanup();
  localStorage.clear();
});
const items: TodoItem[] = [
  { text: "已完成任务", status: "completed" },
  { text: "正在实现", status: "in_progress" },
  { text: "等待验证", status: "pending" },
];

it("有清单渲染、无清单不渲染；开关在列表下方", () => {
  const { rerender } = render(<TodoPanel items={items} />);
  expect(screen.getByRole("region", { name: "当前任务清单" })).toBeTruthy();
  const list = screen.getByRole("list", { name: "任务清单列表" });
  expect(list.nextElementSibling?.tagName).toBe("BUTTON");
  expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("1");
  rerender(<TodoPanel items={[]} />);
  expect(screen.queryByRole("region", { name: "当前任务清单" })).toBeNull();
});

it("开关隐藏列表、更新 aria-expanded 与 prefs；重新挂载恢复", () => {
  const prefs = createPrefsStore(localStorage);
  const { unmount } = render(<TodoPanel items={items} prefs={prefs} />);
  const toggle = screen.getByRole("button");
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(toggle.querySelector(".fold-arrow.up")).not.toBeNull();
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("list")).toBeNull();
  expect(JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}")).toMatchObject({
    todosCollapsed: true,
  });
  unmount();
  render(<TodoPanel items={items} prefs={createPrefsStore(localStorage)} />);
  expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(screen.getByRole("button"));
  expect(screen.getByRole("list")).toBeTruthy();
  expect(prefs.get().todosCollapsed).toBe(true);
});

it("全部完成开关显示全部完成", () => {
  render(<TodoPanel items={items.map((item) => ({ ...item, status: "completed" }))} />);
  expect(screen.getByRole("button").textContent).toContain("3/3");
  expect(screen.getByText("全部完成").className).toContain("complete");
});

it("草稿不显示常驻清单，会话 Composer 接入清单", () => {
  const props = {
    running: false,
    onSubmit: () => true,
    onInterrupt: () => undefined,
    onSlash: () => true,
    fileRefs: null,
    pickImages: async () => [],
    todos: items,
  };
  const { rerender } = render(<Composer {...props} />);
  expect(screen.queryByRole("region", { name: "当前任务清单" })).toBeNull();
  rerender(<Composer {...props} variant="session" />);
  expect(screen.getByRole("region", { name: "当前任务清单" })).toBeTruthy();
});
