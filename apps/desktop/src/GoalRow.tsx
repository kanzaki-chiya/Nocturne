import { useEffect, useState } from "react";
import {
  formatGoalDuration,
  goalElapsedMs,
  goalReasonText,
  type GoalState,
} from "@nocturne/core/protocol";
import { IconButton } from "./ui";
import "./goal-row.css";

export interface GoalActions {
  onStopGoal: () => void | Promise<void>;
  onResumeGoal: () => void | Promise<void>;
  onCancelGoal: () => void | Promise<void>;
}

export function useGoalExpansion(goal: GoalState | undefined) {
  const [expansion, setExpansion] = useState<{ since: number; expanded: boolean }>();
  return [
    !!(goal && expansion?.since === goal.since && expansion.expanded),
    (expanded: boolean) => {
      setExpansion(goal ? { since: goal.since, expanded } : undefined);
    },
  ] as const;
}

function GoalClock({ goal }: { goal: GoalState }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (goal.turnStartedAt === undefined) return;
    setNow(Date.now());
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [goal.turnStartedAt]);
  return <span className="goal-time">{formatGoalDuration(goalElapsedMs(goal, now))}</span>;
}

function GoalIcon({ kind }: { kind: "expand" | "collapse" | "pause" | "resume" | "cancel" }) {
  const paths = {
    expand: "M8.5 2.5h3v3M11.5 2.5L8 6M5.5 11.5h-3v-3M2.5 11.5L6 8",
    collapse: "M8 3v3h3M8 6l3.5-3.5M6 11V8H3M6 8l-3.5 3.5",
    pause: "M5 3v8M9 3v8",
    resume: "M4 2.5v9l7-4.5z",
    cancel: "M3.5 3.5l7 7M10.5 3.5l-7 7",
  };
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path
        d={paths[kind]}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 桌面和手机共用的目标行；展开状态由容器持有，以便清单开关也能收起目标。 */
export function GoalRow({
  goal,
  expanded,
  onExpand,
  onError,
  detailInRow = true,
  ...actions
}: {
  goal: GoalState;
  expanded: boolean;
  onExpand: (expanded: boolean) => void;
  onError: (error: unknown) => void;
  detailInRow?: boolean;
} & GoalActions) {
  const active = goal.status === "active";
  const invoke = (action: () => void | Promise<void>) => {
    try {
      void Promise.resolve(action()).catch(onError);
    } catch (error) {
      onError(error);
    }
  };
  return (
    <div className={`goal-row${active ? "" : " goal-off"}`}>
      <div className="goal-row-head">
        <div className="goal-row-line">
          <span className="goal-mode-ref">/goal</span>
          {!expanded && (
            <span className="goal-objective" title={goal.objective}>
              {goal.objective}
            </span>
          )}
        </div>
        <GoalClock goal={goal} />
        <IconButton
          size="sm"
          className="goal-action"
          aria-label={expanded ? "收起" : "展开"}
          title={expanded ? "收起" : "展开"}
          aria-expanded={expanded}
          onClick={() => {
            onExpand(!expanded);
          }}
        >
          <GoalIcon kind={expanded ? "collapse" : "expand"} />
        </IconButton>
        <IconButton
          size="sm"
          className="goal-action"
          aria-label={active ? "暂停" : "继续"}
          title={active ? "暂停" : "继续"}
          onClick={() => {
            invoke(active ? actions.onStopGoal : actions.onResumeGoal);
          }}
        >
          <GoalIcon kind={active ? "pause" : "resume"} />
        </IconButton>
        <IconButton
          size="sm"
          className="goal-action"
          aria-label="取消"
          title="取消"
          onClick={() => {
            invoke(actions.onCancelGoal);
          }}
        >
          <GoalIcon kind="cancel" />
        </IconButton>
      </div>
      {expanded && detailInRow && <GoalDetail goal={goal} />}
    </div>
  );
}

export function GoalDetail({ goal }: { goal: GoalState }) {
  const reason = goal.status === "blocked" && goal.reason ? goalReasonText(goal.reason) : undefined;
  return (
    <div className={`goal-detail${goal.status === "active" ? "" : " goal-off"}`}>
      <div className="goal-detail-text">{goal.objective}</div>
      {reason && <div className="goal-reason">受阻：{reason}</div>}
    </div>
  );
}
