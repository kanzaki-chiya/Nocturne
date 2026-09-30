/** ask_user 的持久条目显示；不读取 modelContent 或客户端临时摘要。 */
import type { ToolEntry } from "@nocturne/core/protocol";

export function questionToolLines(entry: ToolEntry): string[] {
  const input = entry.input as { questions?: unknown[] } | undefined;
  const count = Array.isArray(input?.questions) ? input.questions.length : 0;
  const title = `? 提问${count > 1 ? `（${count} 题）` : ""}`;
  if (!entry.result) return [title];
  const error = entry.result.error;
  if (entry.status === "cancelled" || entry.status === "interrupted") return [title, "已取消"];
  if (error?.code === "timeout") return [title, "已超时"];
  if (error?.code === "not_interactive") return [title, "无法提问（非交互）"];
  if (entry.status !== "ok") return [title, error?.message ?? "无法提问"];
  const output = entry.result.output as { answers?: unknown[] } | undefined;
  if (!Array.isArray(output?.answers)) return [title, "无法读取回答"];
  return [
    title,
    ...output.answers.map((raw) => {
      if (typeof raw !== "object" || raw === null) return "无法读取回答";
      const a = raw as {
        question?: unknown;
        declined?: unknown;
        selected?: unknown;
        text?: unknown;
      };
      const answer =
        a.declined === true
          ? "拒绝回答"
          : [
              ...(Array.isArray(a.selected)
                ? a.selected.filter((s): s is string => typeof s === "string")
                : []),
              ...(typeof a.text === "string" && a.text !== "" ? [a.text] : []),
            ].join("、") || "（未回答）";
      return `${typeof a.question === "string" ? a.question : ""} → ${answer}`;
    }),
  ];
}
