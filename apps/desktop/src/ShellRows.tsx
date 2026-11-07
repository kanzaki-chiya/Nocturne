import type { BackgroundShellTask } from "@nocturne/core/protocol";
import { elapsedText } from "./subagent-panel";
import { useNow } from "./use-now";
import { Button, Icon, ICON_SM } from "./ui";
import "./shell.css";

export interface OverviewShells {
  tasks?: readonly BackgroundShellTask[];
  onOpen: (task: BackgroundShellTask) => void;
  onStop?: (task: BackgroundShellTask) => void;
}

export function ShellRows({ tasks = [], onOpen, onStop }: OverviewShells) {
  const now = useNow(tasks.length > 0);
  const visible = tasks
    .filter((task) => !task.endedAt || now - Date.parse(task.endedAt) < 300000)
    .sort((a, b) => Number(b.status === "running") - Number(a.status === "running"));
  if (visible.length === 0) return null;
  return (
    <div className="ovpop-group shell-group" role="group" aria-label="后台任务">
      <div className="ovpop-head">后台任务</div>
      {visible.map((task) => (
        <div
          key={task.taskId}
          className={`ovpop-shell-row${task.status === "running" ? "" : " done"}`}
        >
          <button
            type="button"
            className="ovpop-shell-open"
            onClick={() => {
              onOpen(task);
            }}
          >
            <Icon name="terminal" size={ICON_SM} className="sp-glyph" />
            <span className="shell-name">{task.name || task.command.split(/\r?\n/)[0]}</span>
            <span className="ovpop-n ovpop-time">
              {elapsedText(
                Math.max(0, Date.parse(task.endedAt ?? "") || now) - Date.parse(task.startedAt),
              )}
            </span>
          </button>
          {task.status === "running" && onStop && (
            <Button
              variant="ghost-danger"
              size="sm"
              className="ovpop-cancel shell-stop"
              aria-label="停止"
              onClick={() => {
                onStop(task);
              }}
            >
              停止
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}
