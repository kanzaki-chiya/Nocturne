import type { BackgroundShellTask } from "@nocturne/core/protocol";
import { useShellOutput, type ShellSession } from "./use-shell-output";
import { useStickyOutput } from "./useStickyOutput";
import { useNow } from "./use-now";
import { elapsedText } from "./subagent-panel";
import { Button, Icon, ICON_SM } from "./ui";
import "./shell.css";

export interface ShellPaneProps {
  taskId: string;
  name: string;
  command: string;
  task?: BackgroundShellTask | undefined;
  session?: ShellSession | undefined;
  visible: boolean;
}

export function ShellPane({ taskId, name, command, task, session, visible }: ShellPaneProps) {
  const output = useShellOutput(session, taskId, task, visible);
  const current = output.task;
  const now = useNow(visible && current?.status === "running");
  const scroll = useStickyOutput(output.text);
  const stop = () => {
    void session?.shellKill(taskId).catch(() => undefined);
  };
  return (
    <section className="shell-pane" aria-label={name || command}>
      <header className="shell-head">
        <Icon name="terminal" size={ICON_SM} />
        <span className="shell-name shell-command-name" title={command}>
          {command}
        </span>
        {current && (
          <span
            className={`shell-status${current.exitCode !== undefined && current.exitCode !== 0 ? " err" : ""}`}
            role="status"
          >
            {current.status === "running" ? (
              <>
                <span className="tool-spin" aria-hidden="true" />
                运行中
              </>
            ) : typeof current.exitCode === "number" ? (
              `退出码 ${current.exitCode}`
            ) : (
              "停止"
            )}
          </span>
        )}
        {current && (
          <span className="shell-time">
            {elapsedText(
              Math.max(
                0,
                (current.endedAt ? Date.parse(current.endedAt) : now) -
                  Date.parse(current.startedAt),
              ),
            )}
          </span>
        )}
        {current?.status === "running" && (
          <Button variant="ghost-danger" size="sm" disabled={!session} onClick={stop}>
            停止
          </Button>
        )}
      </header>
      <pre ref={scroll} className="shell-output" data-testid="shell-output">
        {output.text}
      </pre>
    </section>
  );
}

export function ShellToolOutput({
  session,
  task,
  enabled,
}: {
  session: ShellSession;
  task: BackgroundShellTask;
  enabled: boolean;
}) {
  const output = useShellOutput(session, task.taskId, task, enabled);
  const scroll = useStickyOutput(output.text);
  return (
    <div className="tool-payload tool-shell">
      <pre className="tool-command">
        <span>$ </span>
        {task.command}
      </pre>
      <pre ref={scroll} className="conversation-tool-output" data-testid="shell-tool-output">
        {output.text}
      </pre>
    </div>
  );
}
