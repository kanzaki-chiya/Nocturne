import { useState } from "react";
import type { TodoItem } from "@nocturne/core/protocol";
import { visibleGoal, type GoalState } from "@nocturne/core/protocol";
import { GoalDetail, GoalRow, useGoalExpansion, type GoalActions } from "./GoalRow";
import type { PrefsStore } from "./prefs";
import { ICON_SM, Icon } from "./ui";
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

/** 手机会话页自己的折叠状态：默认收起、单独存本机，桌面 prefs 不受影响。 */
export interface TodoPanelMobile {
  collapsed: boolean;
  onChange: (collapsed: boolean) => void;
}

export function TodoPanel({
  items,
  prefs,
  goal,
  goalActions,
  onGoalError = () => undefined,
  mobile,
}: {
  items: readonly TodoItem[];
  prefs?: PrefsStore | undefined;
  goal?: GoalState | undefined;
  goalActions?: GoalActions | undefined;
  onGoalError?: ((error: unknown) => void) | undefined;
  mobile?: TodoPanelMobile | undefined;
}) {
  const [innerCollapsed, setInnerCollapsed] = useState(() => prefs?.get().todosCollapsed ?? false);
  const collapsed = mobile?.collapsed ?? innerCollapsed;
  const setCollapsed = (next: boolean) => {
    if (mobile) {
      mobile.onChange(next);
      return;
    }
    setInnerCollapsed(next);
    prefs?.update({ todosCollapsed: next ? true : undefined });
  };
  const shownGoal = visibleGoal(goal);
  const [goalExpanded, setGoalExpanded] = useGoalExpansion(shownGoal);
  const { done, complete } = todoSummary(items);
  const current = items.find((item) => item.status === "in_progress");
  if (items.length === 0 && shownGoal === undefined) return null;
  const body =
    !collapsed && goalExpanded && shownGoal ? (
      <div className="goal-content-grid">
        <div aria-hidden="true">
          <TodoList items={items} />
        </div>
        <GoalDetail goal={shownGoal} />
      </div>
    ) : (
      <TodoList items={items} />
    );
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
      {/* 手机保留清单 DOM，让 CSS 能做展开/收起过渡；桌面照旧按状态挂载 */}
      {items.length > 0 &&
        (mobile ? (
          <div className="todo-panel-body" data-expanded={!collapsed} aria-hidden={collapsed}>
            {body}
          </div>
        ) : (
          !collapsed && body
        ))}
      {items.length > 0 && (
        <button
          type="button"
          className="todo-panel-toggle"
          aria-expanded={!collapsed}
          onClick={() => {
            if (goalExpanded) {
              setGoalExpanded(false);
              if (collapsed) setCollapsed(false);
              return;
            }
            setCollapsed(!collapsed);
          }}
        >
          <Icon
            name="right_small"
            size={ICON_SM}
            className={`fold-arrow${collapsed ? "" : " up"}`}
          />
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
