import type { ToolEntry } from "./view.js";

export const GOAL_CHECK_BACKENDS = ["off", "decision", "smol"] as const;
export type GoalCheckBackend = (typeof GOAL_CHECK_BACKENDS)[number];

export interface GoalCheckConfig {
  backend: GoalCheckBackend;
}

export type GoalCheckOutcome = "passed" | "rejected" | "unavailable";

export interface GoalCheckItemResult {
  index: number;
  passed: boolean;
  confidence?: number | undefined;
  note?: string | undefined;
}

/** `update_goal` 工具结果 `output.check` 的核对结论（ADR-0119）。 */
export interface GoalCheckResult {
  backend: GoalCheckBackend;
  model?: string | undefined;
  result: GoalCheckOutcome;
  items?: GoalCheckItemResult[] | undefined;
  coverage?: boolean | undefined;
  reason?: string | undefined;
}

export const GOAL_CHECK_DISCLOSURE_PREF = "goalCheckDisclosureAccepted";

export function parseGoalCheckAccepted(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((recipient) => recipient.trim())
      .filter(Boolean),
  );
}

export function isGoalCheckBackend(value: unknown): value is GoalCheckBackend {
  return value === "off" || value === "decision" || value === "smol";
}

export function isGoalUnverified(entry: Pick<ToolEntry, "result">): boolean {
  return entry.result?.error?.code === "goal_unverified";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

export function goalCheckFromEntry(
  entry: Pick<ToolEntry, "name" | "target" | "result">,
): GoalCheckResult | undefined {
  if ((entry.target?.name ?? entry.name) !== "update_goal") return undefined;
  const output = entry.result?.output;
  if (!isObject(output) || !isObject(output.check)) return undefined;
  const { backend, coverage, items, model, reason, result } = output.check;
  if (result !== "passed" && result !== "rejected" && result !== "unavailable") return undefined;
  if (!isGoalCheckBackend(backend)) return undefined;
  return {
    backend,
    result,
    model: text(model),
    reason: text(reason),
    coverage: typeof coverage === "boolean" ? coverage : undefined,
    items: Array.isArray(items)
      ? items.flatMap((item: unknown): GoalCheckItemResult[] => {
          if (
            !isObject(item) ||
            typeof item.index !== "number" ||
            !Number.isInteger(item.index) ||
            item.index < 1 ||
            typeof item.passed !== "boolean"
          )
            return [];
          return [{ index: item.index, passed: item.passed, note: text(item.note) }];
        })
      : undefined,
  };
}

interface GoalCheckFailedItem {
  label: string;
  note?: string | undefined;
}

function checklist(source: unknown): readonly unknown[] | undefined {
  return isObject(source) && Array.isArray(source.checklist) ? source.checklist : undefined;
}

export function goalCheckFailedItems(
  entry: Pick<ToolEntry, "name" | "target" | "input" | "result">,
): GoalCheckFailedItem[] {
  const check = goalCheckFromEntry(entry);
  if (check?.result !== "rejected") return [];
  const rows = checklist(entry.result?.output) ?? checklist(entry.target?.input ?? entry.input);
  const failed = (check.items ?? []).flatMap(({ index, passed, note }): GoalCheckFailedItem[] => {
    if (passed) return [];
    const row = rows?.[index - 1];
    const label = isObject(row) ? text(row.item) : undefined;
    return [{ label: label ?? `第 ${index} 项`, note }];
  });
  if (check.coverage === false) {
    failed.push({ label: "清单未覆盖目标的全部要求", note: check.reason });
  }
  return failed;
}

export function goalCheckUnavailableReason(
  entry: Pick<ToolEntry, "name" | "target" | "result">,
): string | undefined {
  const check = goalCheckFromEntry(entry);
  return check?.result === "unavailable" ? check.reason : undefined;
}
