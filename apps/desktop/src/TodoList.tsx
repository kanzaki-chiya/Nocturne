import { useState } from "react";
import type { TodoItem } from "@nocturne/core/protocol";
import type { PrefsStore } from "./prefs";
import "./todos.css";

export function todoSummary(items: readonly TodoItem[]): {
  text: string;
  done: number;
  complete: boolean;
} {
  const done = items.filter((item) => item.status === "completed").length;
  const complete = items.length > 0 && done === items.length;
  const current = items.find((item) => item.status === "in_progress");
  return {
    done,
    complete,
    text:
      items.length === 0
        ? "清空任务清单"
        : `${done}/${items.length}${complete ? " · 全部完成" : current ? ` · 正在：${current.text}` : ""}`,
  };
}

export function TodoProgress({ items }: { items: readonly TodoItem[] }) {
  const { done, complete } = todoSummary(items);
  return (
    <span
      className={`todo-progress${complete ? " complete" : ""}`}
      role="progressbar"
      aria-label="任务进度"
      aria-valuemin={0}
      aria-valuemax={items.length}
      aria-valuenow={done}
    >
      <span style={{ width: `${items.length === 0 ? 0 : (done / items.length) * 100}%` }} />
    </span>
  );
}

export function TodoList({ items }: { items: readonly TodoItem[] }) {
  return (
    <ul className="todo-list" aria-label="任务清单列表">
      {items.map((item, index) => (
        <li key={index} className={`todo-${item.status}`}>
          <span className="todo-mark" aria-hidden="true">
            {item.status === "completed" ? "✓" : item.status === "in_progress" ? "◐" : "○"}
          </span>
          <span className="todo-text">{item.text}</span>
        </li>
      ))}
    </ul>
  );
}

export function TodoPanel({
  items,
  prefs,
}: {
  items: readonly TodoItem[];
  prefs?: PrefsStore | undefined;
}) {
  const [collapsed, setCollapsed] = useState(() => prefs?.get().todosCollapsed ?? false);
  const { done, complete } = todoSummary(items);
  const current = items.find((item) => item.status === "in_progress");
  if (items.length === 0) return null;
  return (
    <section className="todo-panel" aria-label="当前任务清单">
      {!collapsed && <TodoList items={items} />}
      <button
        type="button"
        className="todo-panel-toggle"
        aria-expanded={!collapsed}
        onClick={() => {
          setCollapsed(!collapsed);
          prefs?.update({ todosCollapsed: !collapsed ? true : undefined });
        }}
      >
        <span className={`fold-arrow${collapsed ? "" : " up"}`} aria-hidden="true">
          ▶
        </span>
        <span aria-hidden="true">✓</span>
        <span>
          {done}/{items.length}
        </span>
        <TodoProgress items={items} />
        <span className={`todo-current${complete ? " complete" : ""}`}>
          {complete ? "全部完成" : current ? `正在：${current.text}` : "任务清单"}
        </span>
      </button>
    </section>
  );
}
