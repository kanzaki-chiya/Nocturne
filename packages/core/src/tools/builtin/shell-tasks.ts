import type { BackgroundShells } from "../background-shell.js";
import type { ToolDefinition } from "../types.js";

export function shellTaskTools(tasks: BackgroundShells): ToolDefinition[] {
  const output: ToolDefinition<{ id?: string; since?: "start" }> = {
    name: "shell_output",
    description:
      '读取本会话后台命令的新输出；since: "start" 从头读；不带 id 列出全部任务。不要循环轮询。',
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, since: { const: "start" } },
      additionalProperties: false,
    },
    traits: { mutates: false, concurrencySafe: true },
    permissionSubjects: () => [],
    async execute(input) {
      try {
        const value = input.id
          ? await tasks.output(input.id, input.since)
          : tasks.list().map((task) => ({
              ...task,
              command: task.command.split(/\r?\n/)[0],
              durationMs: Math.max(
                0,
                Date.parse(task.endedAt ?? new Date().toISOString()) - Date.parse(task.startedAt),
              ),
            }));
        return { status: "ok", modelContent: JSON.stringify(value), output: value };
      } catch (cause) {
        const message = String(cause);
        return {
          status: "error",
          modelContent: message,
          error: { code: "invalid_input", message },
        };
      }
    },
  };
  const kill: ToolDefinition<{ id: string }> = {
    name: "shell_kill",
    description: "停止本会话的后台命令进程树，结束结果另行送达。",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" } },
      additionalProperties: false,
    },
    traits: { mutates: true, concurrencySafe: false },
    permissionSubjects: () => [],
    async execute(input) {
      try {
        await tasks.kill(input.id);
        return {
          status: "ok",
          modelContent: JSON.stringify(tasks.list().find((task) => task.taskId === input.id)),
        };
      } catch (cause) {
        const message = String(cause);
        return {
          status: "error",
          modelContent: message,
          error: { code: "invalid_input", message },
        };
      }
    },
  };
  return [output, kill];
}
