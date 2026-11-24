import { CREDENTIAL_NAME } from "../config/schema.js";
import type { DurableEvent, PermissionSubject } from "../protocol/index.js";

export const GOAL_RECORD_BUDGET = 60_000;

export interface GoalChecklistItem {
  item: string;
  evidence: string;
}

const PRIVATE_KEY = /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/gi;
const TOKEN =
  /(?<![\w-])(?:sk-|ghp_|gho_|github_pat_|ntn_|xox[abp]-|AIza|AKIA)[A-Za-z0-9_-]{4,}(?![\w-])/g;
const BEARER = /\bBearer[ \t]+[A-Za-z0-9._~+/=-]+/gi;
const JSON_VALUE = /(("(?:[^"\\]|\\[\s\S])*")\s*:\s*)"(?:[^"\\]|\\[\s\S])*"/g;
const ASSIGNMENT =
  /\b([\w.-]+)([ \t]*=[ \t]*)("(?:[^"\\]|\\[\s\S])*"|'(?:[^']|'')*'|[^\s"'`;,&|<>\])}]+)/g;

export function redactGoalText(text: string): string {
  return text
    .replace(PRIVATE_KEY, "<redacted>")
    .replace(BEARER, "Bearer <redacted>")
    .replace(TOKEN, "<redacted>")
    .replace(JSON_VALUE, (match: string, prefix: string, key: string) => {
      if (CREDENTIAL_NAME.test(key)) return `${prefix}"<redacted>"`;
      if (!key.includes("\\")) return match;
      try {
        return CREDENTIAL_NAME.test(JSON.parse(key) as string) ? `${prefix}"<redacted>"` : match;
      } catch {
        return match;
      }
    })
    .replace(ASSIGNMENT, (match: string, key: string, separator: string, value: string) => {
      if (!CREDENTIAL_NAME.test(key)) return match;
      const quote = value.startsWith('"') || value.startsWith("'") ? value[0] : "";
      return `${key}${separator}${quote}<redacted>${quote}`;
    });
}

interface GoalToolRecord {
  tool: string;
  status: string;
  subject?: string | undefined;
  exitCode?: number | undefined;
  result?: string | undefined;
}

export interface GoalCheckInput {
  objective: string;
  checklist: GoalChecklistItem[];
  records: (string | ({ number: number } & GoalToolRecord))[];
}

function objectOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function lastResultText(value: string): string | undefined {
  const text = redactGoalText(value)
    .split(/\r\n|\n|\r/)
    .slice(-40)
    .join("\n");
  return text.slice(-4000) || undefined;
}

function changedFiles(output: Record<string, unknown> | undefined): string[] {
  const files = Array.isArray(output?.files) ? output.files.map(objectOf) : [output];
  return files.flatMap((file) => {
    if (typeof file?.path !== "string") return [];
    let added = 0;
    let removed = 0;
    if (typeof file.diff === "string") {
      let inHunk = false;
      for (const line of file.diff.split("\n")) {
        if (line.startsWith("@@ ")) inHunk = true;
        if (!inHunk) continue;
        if (line.startsWith("+")) added++;
        if (line.startsWith("-")) removed++;
      }
    }
    const paths = typeof file.movedTo === "string" ? `${file.path} → ${file.movedTo}` : file.path;
    return [`${redactGoalText(paths)} +${added} −${removed}`];
  });
}

/** Reuses effective durable events, in invocation order even if parallel calls finish out of order. */
export function assembleGoalCheckInput(
  objective: string,
  checklist: readonly GoalChecklistItem[],
  events: readonly DurableEvent[],
  since: number,
  sensitive: (subjects: readonly PermissionSubject[]) => boolean,
): GoalCheckInput {
  const toolEvents = events.filter((event) => event.seq >= since && event.turnId);
  const calls = new Map<string, number>();
  const started = new Map<string, Extract<DurableEvent, { type: "tool.started" }>["payload"]>();
  const completed: Extract<DurableEvent, { type: "tool.completed" }>["payload"][] = [];
  for (const event of toolEvents) {
    switch (event.type) {
      case "message.assistant":
        for (const { callId } of event.payload.toolCalls) {
          if (!calls.has(callId)) calls.set(callId, calls.size);
        }
        break;
      case "tool.started":
        if (!calls.has(event.payload.callId)) calls.set(event.payload.callId, calls.size);
        started.set(event.payload.callId, event.payload);
        break;
      case "tool.completed":
        completed.push(event.payload);
        if (!calls.has(event.payload.callId)) calls.set(event.payload.callId, calls.size);
        break;
    }
  }
  completed.sort((a, b) => (calls.get(a.callId) ?? 0) - (calls.get(b.callId) ?? 0));
  const retained: GoalCheckInput["records"] = [];
  let recordChars = 0;
  for (const [index, event] of [...completed.entries()].reverse()) {
    const start = started.get(event.callId);
    const record: GoalToolRecord = {
      tool: start?.target?.name ?? event.name,
      status: event.status,
    };
    if (start && !event.sensitiveForModel && !sensitive(start.subjects)) {
      const output = objectOf(event.output);
      const subjects = start.subjects;
      const editedPaths = subjects
        .filter(({ kind }) => kind === "edit")
        .map(({ target }) => target);
      const edits = changedFiles(output);
      if (editedPaths.length > 0 || (start.mutates === true && edits.length > 0)) {
        record.subject =
          (edits.length > 0 ? edits : editedPaths.map((path) => redactGoalText(path)))
            .join("\n")
            .slice(0, 4000) || undefined;
      } else {
        record.subject =
          subjects
            .map(({ target }) => redactGoalText(target))
            .join("\n")
            .slice(0, 4000) || undefined;
        if (typeof output?.exitCode === "number") record.exitCode = output.exitCode;
        const instructions = subjects.some(
          ({ kind, target, resolved }) =>
            kind === "read" &&
            [target, resolved].some((path) => /(?:^|[\\/])AGENTS\.md$/i.test(path ?? "")),
        );
        if (!event.attachments?.length && !instructions) {
          record.result = lastResultText(event.modelContent);
        }
      }
    }
    const numbered = { number: index + 1, ...record };
    const size = JSON.stringify(numbered).length;
    const omitted = index > 0 ? JSON.stringify(`省略 ${index} 条`).length + 1 : 0;
    if (recordChars + size + retained.length + omitted + 2 > GOAL_RECORD_BUDGET) break;
    retained.push(numbered);
    recordChars += size;
  }
  retained.reverse();
  if (retained.length < completed.length)
    retained.unshift(`省略 ${completed.length - retained.length} 条`);
  return {
    objective: redactGoalText(objective),
    checklist: checklist.map(({ item, evidence }) => ({
      item: redactGoalText(item),
      evidence: redactGoalText(evidence).slice(0, 1000),
    })),
    records: retained,
  };
}
