/** ADR-0028：工具输入与持久事件共用的清单边界。 */
export type TodoStatus = "pending" | "in_progress" | "completed";
export interface TodoItem {
  text: string;
  status: TodoStatus;
}

export function parseTodoItems(value: unknown): TodoItem[] | undefined {
  if (!Array.isArray(value) || value.length > 20) return undefined;
  const items: TodoItem[] = [];
  for (const raw of value as unknown[]) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const keys = Object.keys(raw);
    if (keys.length !== 2 || !keys.includes("text") || !keys.includes("status")) return undefined;
    const { text, status } = raw as { text: unknown; status: unknown };
    if (typeof text !== "string" || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(text))
      return undefined;
    const trimmed = text.trim();
    if (trimmed === "" || Array.from(trimmed).length > 200) return undefined;
    if (status !== "pending" && status !== "in_progress" && status !== "completed")
      return undefined;
    items.push({ text: trimmed, status });
  }
  return items;
}

export function todoItemsFromCompletion(payload: {
  name: string;
  status: string;
  output?: unknown;
}): TodoItem[] | undefined {
  if (payload.name !== "todo_write" || payload.status !== "ok") return undefined;
  const output = payload.output;
  if (output === null || typeof output !== "object" || Array.isArray(output)) return undefined;
  if (Object.keys(output).length !== 1 || !("items" in output)) return undefined;
  return parseTodoItems(output.items);
}

export function todoSnapshotLines(items: readonly TodoItem[]): string[] {
  const done = items.filter((item) => item.status === "completed").length;
  return [
    `已完成 ${done}/${items.length}`,
    ...items.map(
      (item, i) =>
        `${i + 1}. ${item.status === "completed" ? "[x]" : item.status === "in_progress" ? "[>]" : "[ ]"} ${item.text}`,
    ),
  ];
}
