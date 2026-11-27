/**
 * 合奏概览（ADR-0131）的输入规范化、静态校验与幂等指纹。
 * 依赖运行时状态（成员名册、最新帖号、当前概览）的校验在控制器内完成；
 * 这里处理与状态无关的规范化与结构校验，保持纯函数、无 I/O。
 */
import { createHash } from "node:crypto";

import type {
  EnsembleOverviewLineDelta,
  EnsembleOverviewTaskDelta,
  EnsembleTaskStatus,
} from "../protocol/index.js";

/** `ensemble_overview` 工具输入（未规范化） */
export interface EnsembleOverviewToolInput {
  base?: unknown;
  goal?: unknown;
  checkpoints?: unknown;
  lines?: unknown;
  tasks?: unknown;
  removeLines?: unknown;
  removeTasks?: unknown;
}

export interface NormalizedOverviewUpdate {
  base: number;
  goal?: string | null | undefined;
  checkpoints?: string[] | undefined;
  lines?: EnsembleOverviewLineDelta[] | undefined;
  tasks?: EnsembleOverviewTaskDelta[] | undefined;
  removeLines?: string[] | undefined;
  removeTasks?: string[] | undefined;
}

export type NormalizeOverviewResult =
  | { ok: true; update: NormalizedOverviewUpdate }
  | { ok: false; errors: string[] };

const TASK_STATUSES: readonly EnsembleTaskStatus[] = ["todo", "work", "wait", "done"];
const ID_MAX_LENGTH = 80;
const TEXT_MAX_LENGTH = 4000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readId(value: unknown, label: string, errors: string[]): string | undefined {
  if (typeof value !== "string") {
    errors.push(`${label} must be a string.`);
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    errors.push(`${label} must not be empty.`);
    return undefined;
  }
  if (trimmed.length > ID_MAX_LENGTH) {
    errors.push(`${label} must be at most ${ID_MAX_LENGTH} characters.`);
    return undefined;
  }
  return trimmed;
}

function readOptionalText(
  value: unknown,
  label: string,
  errors: string[],
): { present: boolean; value: string | null | undefined } {
  if (value === undefined) return { present: false, value: undefined };
  if (value === null) return { present: true, value: null };
  if (typeof value !== "string") {
    errors.push(`${label} must be a string (or null to clear).`);
    return { present: false, value: undefined };
  }
  if (value.length > TEXT_MAX_LENGTH) {
    errors.push(`${label} must be at most ${TEXT_MAX_LENGTH} characters.`);
    return { present: false, value: undefined };
  }
  return { present: true, value };
}

function readOptionalOwner(value: unknown, label: string, errors: string[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${label} must be a non-empty member name or "maestro".`);
    return undefined;
  }
  return value.trim();
}

function readOptionalPost(value: unknown, label: string, errors: string[]): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    errors.push(`${label} must be a positive integer post number (or null to clear).`);
    return undefined;
  }
  return value;
}

function normalizeLineDelta(raw: unknown, index: number, errors: string[]): EnsembleOverviewLineDelta | undefined {
  const label = `lines[${index}]`;
  if (!isRecord(raw)) {
    errors.push(`${label} must be an object.`);
    return undefined;
  }
  const id = readId(raw.id, `${label}.id`, errors);
  if (id === undefined) return undefined;
  const out: EnsembleOverviewLineDelta = { id };
  const title = readOptionalText(raw.title, `${label}.title`, errors);
  if (title.present) {
    if (title.value === null) {
      errors.push(`${label}.title cannot be null; omit it to keep the current title.`);
    } else if (title.value !== undefined && title.value.trim() === "") {
      errors.push(`${label}.title must not be empty.`);
    } else if (title.value !== undefined) {
      out.title = title.value;
    }
  }
  const owner = readOptionalOwner(raw.owner, `${label}.owner`, errors);
  if (owner !== undefined) out.owner = owner;
  const post = readOptionalPost(raw.post, `${label}.post`, errors);
  if (post !== undefined) out.post = post;
  if (raw.progress !== undefined) {
    if (raw.progress === null) {
      out.progress = null;
    } else if (!isRecord(raw.progress)) {
      errors.push(`${label}.progress must be an object (or null to clear).`);
    } else {
      const text = readOptionalText(raw.progress.text, `${label}.progress.text`, errors);
      if (text.present === false || text.value === undefined || text.value === null) {
        if (!errors.some((e) => e.startsWith(`${label}.progress.text`))) {
          errors.push(`${label}.progress.text must be a string.`);
        }
      } else if (text.value.trim() === "") {
        errors.push(`${label}.progress.text must not be empty.`);
      } else {
        const progress: { text: string; post?: number; wait?: boolean } = { text: text.value };
        const progressPost = readOptionalPost(raw.progress.post, `${label}.progress.post`, errors);
        if (progressPost !== undefined && progressPost !== null) progress.post = progressPost;
        if (raw.progress.wait !== undefined) {
          if (typeof raw.progress.wait !== "boolean") {
            errors.push(`${label}.progress.wait must be a boolean.`);
          } else {
            progress.wait = raw.progress.wait;
          }
        }
        out.progress = progress;
      }
    }
  }
  if (raw.before !== undefined) {
    const before = readId(raw.before, `${label}.before`, errors);
    if (before !== undefined) {
      if (before === id) {
        errors.push(`${label}.before must not reference the line itself.`);
      } else {
        out.before = before;
      }
    }
  }
  return out;
}

function normalizeTaskDelta(raw: unknown, index: number, errors: string[]): EnsembleOverviewTaskDelta | undefined {
  const label = `tasks[${index}]`;
  if (!isRecord(raw)) {
    errors.push(`${label} must be an object.`);
    return undefined;
  }
  const id = readId(raw.id, `${label}.id`, errors);
  const line = readId(raw.line, `${label}.line`, errors);
  if (id === undefined || line === undefined) return undefined;
  const out: EnsembleOverviewTaskDelta = { id, line };
  const title = readOptionalText(raw.title, `${label}.title`, errors);
  if (title.present) {
    if (title.value === null) {
      errors.push(`${label}.title cannot be null; omit it to keep the current title.`);
    } else if (title.value !== undefined && title.value.trim() === "") {
      errors.push(`${label}.title must not be empty.`);
    } else if (title.value !== undefined) {
      out.title = title.value;
    }
  }
  if (raw.status !== undefined) {
    if (typeof raw.status !== "string" || !TASK_STATUSES.includes(raw.status as EnsembleTaskStatus)) {
      errors.push(`${label}.status must be one of ${TASK_STATUSES.join(", ")}.`);
    } else {
      out.status = raw.status as EnsembleTaskStatus;
    }
  }
  const owner = readOptionalOwner(raw.owner, `${label}.owner`, errors);
  if (owner !== undefined) out.owner = owner;
  const post = readOptionalPost(raw.post, `${label}.post`, errors);
  if (post !== undefined) out.post = post;
  return out;
}

function readIdArray(raw: unknown, label: string, errors: string[]): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    errors.push(`${label} must be an array of ids.`);
    return undefined;
  }
  const out: string[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const id = readId(raw[i], `${label}[${i}]`, errors);
    if (id !== undefined) out.push(id);
  }
  return out;
}

const KNOWN_KEYS = new Set(["base", "goal", "checkpoints", "lines", "tasks", "removeLines", "removeTasks"]);

/**
 * 规范化并做与状态无关的校验；返回的 `update` 只含规范化后的值。
 * 全部错误一次性返回，便于模型一次修正（ADR-0131 §3 的原子性前提）。
 */
export function normalizeOverviewInput(raw: unknown): NormalizeOverviewResult {
  const errors: string[] = [];
  if (!isRecord(raw)) {
    return { ok: false, errors: ["Input must be an object."] };
  }
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) errors.push(`Unknown field "${key}".`);
  }

  if (typeof raw.base !== "number" || !Number.isInteger(raw.base) || raw.base < 0) {
    errors.push("`base` must be a non-negative integer: the `revision` from your latest overview read (use 0 before the first update).");
  }
  const base = typeof raw.base === "number" && Number.isInteger(raw.base) ? raw.base : -1;

  const out: NormalizedOverviewUpdate = { base: Math.max(0, base) };

  if (raw.goal !== undefined) {
    const goal = readOptionalText(raw.goal, "goal", errors);
    if (goal.present) {
      if (goal.value !== null && goal.value !== undefined && goal.value.trim() === "") {
        errors.push("`goal` must not be empty (pass null to clear it).");
      } else if (goal.value !== undefined) {
        out.goal = goal.value;
      }
    }
  }

  if (raw.checkpoints !== undefined) {
    if (!Array.isArray(raw.checkpoints)) {
      errors.push("`checkpoints` must be an array of strings.");
    } else {
      const list: string[] = [];
      let failed = false;
      for (let i = 0; i < raw.checkpoints.length; i += 1) {
        const item = raw.checkpoints[i];
        if (typeof item !== "string" || item.trim() === "") {
          errors.push(`checkpoints[${i}] must be a non-empty string.`);
          failed = true;
        } else if (item.length > TEXT_MAX_LENGTH) {
          errors.push(`checkpoints[${i}] must be at most ${TEXT_MAX_LENGTH} characters.`);
          failed = true;
        } else {
          list.push(item.trim());
        }
      }
      if (!failed) out.checkpoints = list;
    }
  }

  if (raw.lines !== undefined) {
    if (!Array.isArray(raw.lines)) {
      errors.push("`lines` must be an array of line updates.");
    } else {
      const list: EnsembleOverviewLineDelta[] = [];
      let failed = false;
      for (let i = 0; i < raw.lines.length; i += 1) {
        const before = errors.length;
        const item = normalizeLineDelta(raw.lines[i], i, errors);
        if (errors.length > before) failed = true;
        if (item !== undefined) list.push(item);
      }
      if (!failed) out.lines = list;
    }
  }

  if (raw.tasks !== undefined) {
    if (!Array.isArray(raw.tasks)) {
      errors.push("`tasks` must be an array of task updates.");
    } else {
      const list: EnsembleOverviewTaskDelta[] = [];
      let failed = false;
      for (let i = 0; i < raw.tasks.length; i += 1) {
        const before = errors.length;
        const item = normalizeTaskDelta(raw.tasks[i], i, errors);
        if (errors.length > before) failed = true;
        if (item !== undefined) list.push(item);
      }
      if (!failed) out.tasks = list;
    }
  }

  const removeLines = readIdArray(raw.removeLines, "removeLines", errors);
  if (removeLines !== undefined) out.removeLines = removeLines;
  const removeTasks = readIdArray(raw.removeTasks, "removeTasks", errors);
  if (removeTasks !== undefined) out.removeTasks = removeTasks;

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, update: out };
}

/** 规范化输入的稳定字符串表示（键序固定、缺省字段省略） */
export function canonicalizeOverviewUpdate(update: NormalizedOverviewUpdate): string {
  const sortObject = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortObject);
    if (isRecord(value)) {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value).sort()) {
        if (value[key] !== undefined) out[key] = sortObject(value[key]);
      }
      return out;
    }
    return value;
  };
  return JSON.stringify(sortObject(update));
}

/** 幂等指纹：同一规范化输入无论什么时候重试都得到同一哈希（ADR-0131 §3） */
export function overviewFingerprint(update: NormalizedOverviewUpdate): string {
  return createHash("sha256").update(canonicalizeOverviewUpdate(update), "utf8").digest("hex");
}

// ── 依赖运行时状态的校验（控制器调用；仍是纯函数） ─────────────

export interface OverviewStateContext {
  /** 当前概览中存在的线 id 集合 */
  lineIds: ReadonlySet<string>;
  /** 任务 id 集合（全部线） */
  taskIds: ReadonlySet<string>;
  /** 本场可用负责人名（含 "maestro" 与已移除成员的历史名） */
  owners: ReadonlySet<string>;
  /** 已发帖的最大帖号；未发帖为 0 */
  lastPost: number;
}

/**
 * 依赖运行时状态校验规范化更新（ADR-0131 §3 的原子前提）：
 * - 负责人必须引用本场身份（`maestro` 或曾在场成员，含已移除）；
 * - 新建线/任务必须带齐必填字段；
 * - `before` 目标必须在应用时存在（已存在或同批靠前新建）；
 * - 任务目标线必须在更新后存在；
 * - post 引用必须是已存在的帖号；
 * - 同 id 不得同时 upsert 又 remove。
 * 全部问题一次性返回，不部分写入。
 */
export function validateOverviewState(
  update: NormalizedOverviewUpdate,
  context: OverviewStateContext,
): string[] {
  const errors: string[] = [];
  const removeLines = new Set(update.removeLines ?? []);
  const removeTasks = new Set(update.removeTasks ?? []);

  const checkOwner = (owner: string | undefined, label: string): void => {
    if (owner === undefined) return;
    if (!context.owners.has(owner)) {
      errors.push(`${label}: unknown owner "${owner}" — owners must be "maestro" or an ensemble member name (current or removed).`);
    }
  };
  const checkPost = (post: number | null | undefined, label: string): void => {
    if (post === undefined || post === null) return;
    if (post > context.lastPost) {
      errors.push(`${label}: post #${post} does not exist yet — only posts 1..${context.lastPost} have been posted. Publish or locate the post first, then update the overview.`);
    }
  };

  // 1. upsert 与 remove 冲突
  for (const line of update.lines ?? []) {
    if (removeLines.has(line.id)) {
      errors.push(`lines: id "${line.id}" appears in both lines and removeLines.`);
    }
  }
  for (const task of update.tasks ?? []) {
    if (removeTasks.has(task.id)) {
      errors.push(`tasks: id "${task.id}" appears in both tasks and removeTasks.`);
    }
  }

  // 2. 线 upsert：`before` 按数组顺序判定（模拟应用过程）
  const lineIds = new Set(context.lineIds);
  for (const id of removeLines) lineIds.delete(id);
  for (const line of update.lines ?? []) {
    const label = `lines["${line.id}"]`;
    const exists = lineIds.has(line.id);
    if (!exists) {
      if (line.title === undefined) {
        errors.push(`${label}: new lines require a non-empty \`title\`.`);
      }
      if (line.owner === undefined) {
        errors.push(`${label}: new lines require an \`owner\`.`);
      }
    }
    checkOwner(line.owner, label);
    checkPost(line.post ?? undefined, label);
    checkPost(line.progress !== undefined && line.progress !== null ? line.progress.post : undefined, label);
    if (line.before !== undefined && !lineIds.has(line.before)) {
      errors.push(`${label}: \`before\` target "${line.before}" is not a known line — it must already exist or appear earlier in this update's lines array.`);
    }
    lineIds.add(line.id);
  }

  // 3. 任务 upsert：目标线在更新后必须存在
  const taskIds = new Set(context.taskIds);
  for (const id of removeTasks) taskIds.delete(id);
  for (const task of update.tasks ?? []) {
    const label = `tasks["${task.id}"]`;
    if (!lineIds.has(task.line)) {
      errors.push(`${label}: line "${task.line}" does not exist (was it removed or never created?).`);
    }
    const exists = taskIds.has(task.id);
    if (!exists) {
      if (task.title === undefined) {
        errors.push(`${label}: new tasks require a non-empty \`title\`.`);
      }
      if (task.owner === undefined) {
        errors.push(`${label}: new tasks require an \`owner\`.`);
      }
      if (task.status === undefined) {
        errors.push(`${label}: new tasks require a \`status\` (todo, work, wait, done).`);
      }
    }
    checkOwner(task.owner, label);
    checkPost(task.post ?? undefined, label);
    taskIds.add(task.id);
  }

  return errors;
}
