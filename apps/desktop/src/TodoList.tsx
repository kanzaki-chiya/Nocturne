import { useState } from "react";
import type { TodoItem } from "@nocturne/core/protocol";
import { visibleGoal, type GoalState } from "@nocturne/core/protocol";
import { GoalDetail, GoalRow, useGoalExpansion, type GoalActions } from "./GoalRow";
import type { PrefsStore } from "./prefs";
import "./todos.css";

/** count 是「N/M」，note 是弱化的附注（全部完成 / 正在：…，R4 不写中点）；text 供悬停提示 */
export function todoSummary(items: readonly TodoItem[]): {
  text: string;
  count: string;
  note: string;
  done: number;
  complete: boolean;
} {
  const done = items.filter((item) => item.status === "completed").length;
  const complete = items.length > 0 && done === items.length;
  const current = items.find((item) => item.status === "in_progress");
  const count = items.length === 0 ? "清空任务清单" : `${done}/${items.length}`;
  const note =
    items.length === 0 ? "" : complete ? "全部完成" : current ? `正在：${current.text}` : "";
  return { done, complete, count, note, text: note === "" ? count : `${count}，${note}` };
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
  goal,
  goalActions,
  onGoalError = () => undefined,
}: {
  items: readonly TodoItem[];
  prefs?: PrefsStore | undefined;
  goal?: GoalState | undefined;
  goalActions?: GoalActions | undefined;
  onGoalError?: ((error: unknown) => void) | undefined;
}) {
  const [collapsed, setCollapsed] = useState(() => prefs?.get().todosCollapsed ?? false);
  const shownGoal = visibleGoal(goal);
  const [goalExpanded, setGoalExpanded] = useGoalExpansion(shownGoal);
  const { done, complete } = todoSummary(items);
  const current = items.find((item) => item.status === "in_progress");
  if (items.length === 0 && shownGoal === undefined) return null;
  return (
    <section className="todo-panel" aria-label="当前任务清单">
      {shownGoal && goalActions && (
        <GoalRow
          goal={shownGoal}
          expanded={goalExpanded}
          onExpand={setGoalExpanded}
          onError={onGoalError}
          detailInRow={items.length === 0 || collapsed}
          {...goalActions}
        />
      )}
      {items.length > 0 &&
        !collapsed &&
        (goalExpanded && shownGoal ? (
          <div className="goal-content-grid">
            <div aria-hidden="true">
              <TodoList items={items} />
            </div>
            <GoalDetail goal={shownGoal} />
          </div>
        ) : (
          <TodoList items={items} />
        ))}
      {items.length > 0 && (
        <button
          type="button"
          className="todo-panel-toggle"
          aria-expanded={!collapsed}
          onClick={() => {
            if (goalExpanded) {
              setGoalExpanded(false);
              if (collapsed) {
                setCollapsed(false);
                prefs?.update({ todosCollapsed: undefined });
              }
              return;
            }
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
      )}
    </section>
  );
}
