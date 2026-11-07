import { useRef, useState } from "react";
import type { BackgroundShellTask } from "@nocturne/core/protocol";
import { ShellRows } from "../ShellRows";
import { ShellPane } from "../ShellPane";
import type { ShellSession } from "../use-shell-output";
import { IconButton } from "../ui";
import { IconBack, IconTerminal } from "./icons";
import { Popover } from "./Popover";

export function PhoneTasks({
  tasks = [],
  session,
  connected,
}: {
  tasks?: readonly BackgroundShellTask[];
  session?: ShellSession | undefined;
  connected: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<BackgroundShellTask>();
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      {tasks.length > 0 && (
        <button
          ref={trigger}
          type="button"
          className="phone-icon-button"
          aria-label="后台任务"
          aria-expanded={open}
          onClick={() => {
            setSelected(undefined);
            setOpen((current) => !current);
          }}
        >
          <IconTerminal />
        </button>
      )}
      {open && !selected && (
        <Popover
          anchor={trigger.current}
          label="后台任务"
          wide
          onClose={() => {
            setOpen(false);
          }}
        >
          <div className="phone-task-overview">
            <ShellRows tasks={tasks} onOpen={setSelected} />
          </div>
        </Popover>
      )}
      {open && selected && (
        <div className="phone-task-view" role="dialog" aria-modal="true" aria-label="后台任务">
          <header className="phone-task-head">
            <IconButton
              aria-label="后台任务"
              onClick={() => {
                setSelected(undefined);
              }}
            >
              <IconBack />
            </IconButton>
            <span>后台任务</span>
          </header>
          <ShellPane
            taskId={selected.taskId}
            name={selected.name}
            command={selected.command}
            task={tasks.find((task) => task.taskId === selected.taskId) ?? selected}
            session={session}
            visible={connected}
          />
        </div>
      )}
    </>
  );
}
