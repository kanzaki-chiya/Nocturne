import type { ToolEntry } from "@nocturne/core/protocol";

export function webFetchSummary(entry: ToolEntry): string | undefined {
  if (entry.name !== "web_fetch") return undefined;
  const output = entry.result?.output;
  if (typeof output !== "object" || output === null) return entry.result?.error?.message;
  const value = output as {
    status?: number;
    contentType?: string;
    title?: string;
    chars?: number;
    finalUrl?: string;
    url?: string;
    truncatedBytes?: boolean;
  };
  return [
    value.title,
    value.status === undefined ? undefined : `HTTP ${value.status}`,
    value.contentType,
    value.chars === undefined ? undefined : `${value.chars} 字符`,
    value.truncatedBytes ? "页面过大，只处理了前 5 MB" : undefined,
    value.finalUrl !== value.url ? value.finalUrl : undefined,
  ]
    .filter((part) => part !== undefined && part !== "")
    .join(" · ");
}
