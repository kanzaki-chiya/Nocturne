import type { BackgroundShellTask } from "@nocturne/core/protocol";
import { ShellPane } from "../ShellPane";
import type { ShellSession } from "../use-shell-output";

/** 后台命令的抽屉子视图；入口、返回和停止统一由 PhoneSidePanel 持有。 */
export function PhoneTasks({
  task,
  session,
  connected,
}: {
  task: BackgroundShellTask;
  session?: ShellSession | undefined;
  connected: boolean;
}) {
  return (
    <ShellPane
      taskId={task.taskId}
      name={task.name}
      command={task.command}
      task={task}
      session={session}
      visible={connected}
      hideHeader
    />
  );
}
