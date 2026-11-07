import { useEffect, useState } from "react";
import { Box, Text } from "ink";
import type { RuntimeSession } from "@nocturne/core";
import type { BackgroundShellTask } from "@nocturne/core/protocol";
import { PickList } from "./pick-list.js";
import { formatDuration, tailLines, truncateLine } from "../format.js";

export function Tasks({
  session,
  width,
  onClose,
}: {
  session: RuntimeSession;
  width: number;
  onClose: () => void;
}): React.JSX.Element {
  const [tasks, setTasks] = useState<BackgroundShellTask[]>([]);
  const [selected, setSelected] = useState<string>();
  const [output, setOutput] = useState("");
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      const items = session
        .shellTasks()
        .filter((task) => !task.endedAt || Date.now() - Date.parse(task.endedAt) < 300000);
      if (active)
        setTasks(
          items.sort((a, b) => Number(b.status === "running") - Number(a.status === "running")),
        );
      if (selected) {
        const result = await session.shellOutput(selected);
        if (active) setOutput(result.text);
      }
    };
    void refresh().catch(() => undefined);
    const timer = setInterval(() => {
      void refresh().catch(() => undefined);
    }, 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [session, selected]);
  const task = tasks.find((item) => item.taskId === selected);
  if (task)
    return (
      <Box flexDirection="column">
        {tailLines(output, 12).map((line, index) => (
          <Text key={index} wrap="truncate">
            {truncateLine(line, width, "…")}
          </Text>
        ))}
        <PickList
          title={task.name}
          active
          items={task.status === "running" ? [{ value: "stop", label: "停止" }] : []}
          width={width}
          onCancel={() => {
            setSelected(undefined);
          }}
          onPick={() => {
            void session.shellKill(task.taskId).then(() => {
              setSelected(undefined);
            });
          }}
        />
      </Box>
    );
  return (
    <PickList
      title="后台任务"
      width={width}
      active
      items={tasks.map((item) => ({
        value: item.taskId,
        label: `${item.name} · ${item.status} · ${item.exitCode ?? ""} · ${formatDuration(Date.parse(item.endedAt ?? new Date().toISOString()) - Date.parse(item.startedAt))}`,
      }))}
      onCancel={onClose}
      onPick={(id) => {
        setSelected(id);
      }}
    />
  );
}
