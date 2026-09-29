import { parseTodoItems, type TodoItem } from "../../protocol/index.js";
import type { ToolDefinition } from "../types.js";

export const todoWriteTool: ToolDefinition<{ items: TodoItem[] }, { items: TodoItem[] }> = {
  name: "todo_write",
  description:
    "长任务需要跟踪步骤时，提交完整清单以替换当前会话清单；items: [] 清空。每项状态为 pending、in_progress 或 completed。",
  inputSchema: {
    type: "object",
    required: ["items"],
    properties: {
      items: {
        type: "array",
        maxItems: 20,
        items: {
          type: "object",
          required: ["text", "status"],
          properties: {
            text: { type: "string" },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
  traits: { mutates: false, concurrencySafe: false, timeoutMs: 5_000 },
  validateInput(input) {
    return parseTodoItems(input.items) === undefined
      ? "任务清单无效：最多 20 项，每项文本须为单行、非空且不超过 200 字符"
      : undefined;
  },
  permissionSubjects: () => [],
  execute(input) {
    const items = parseTodoItems(input.items);
    if (items === undefined) throw new Error("validated todo input became invalid");
    return Promise.resolve({
      status: "ok",
      modelContent: `任务清单已更新：${items.length} 项。`,
      output: { items },
    } as const);
  },
};
