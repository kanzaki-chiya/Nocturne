/**
 * 长期记忆（ADR-0098）共享类型与纯校验函数。
 * 属于 @nocturne/core/protocol，无 Node 或运行时依赖。
 */

export const MEMORY_SCOPES = ["global", "project", "suite"] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

/** 记忆条目名称正则：小写字母、数字和连字符，同范围内唯一 */
export const MEMORY_NAME_RE = /^[a-z0-9][a-z0-9-]*$(?![\s\S])/;

/** 单个范围的索引注入字符上限（ADR-0098 §3） */
export const MEMORY_INDEX_MAX_CHARS = 25_000;

/** 写入指导文案（ADR-0098 §3、§4）：供可写会话的 context 前言与 memory_write 描述共用 */
export const MEMORY_WRITE_GUIDANCE =
  "When to save or update memories: save when the user states a preference or role, corrects an approach, confirms a non-obvious workflow, or shares project constraints not visible in code. Do not save facts derivable from code or git history, session-specific details, or secrets, tokens, and passwords. Check the index for an existing entry on the same topic before writing and overwrite it; delete memories with memory_delete if you find they are wrong or outdated.";

export interface MemoryEntryMeta {
  name: string;
  description: string;
  type: MemoryType;
  /** ISO 8601 最后修改时间 */
  updatedAt: string;
}

export interface MemoryEntry extends MemoryEntryMeta {
  scope: MemoryScope;
  /** Markdown 正文（不含 YAML 前言） */
  content: string;
  /** 文件全文（含 YAML 前言） */
  raw: string;
}

export interface MemoryScopeOverview {
  enabled: boolean;
  dir: string;
  entries: MemoryEntryMeta[];
  warnings: string[];
}

export interface OtherProjectMemory {
  key: string;
  path: string;
  count: number;
}

export interface MemoryDescription {
  global: MemoryScopeOverview;
  project?: MemoryScopeOverview | undefined;
  otherProjects: OtherProjectMemory[];
}

export interface MemoryScopeIndex {
  scope: MemoryScope;
  /** 范围内索引文本（`- <name> (<type>): <description>`，空范围为 `(empty)`） */
  text: string;
  count: number;
  truncated?: boolean | undefined;
}

export interface MemoryContextSnapshot {
  writable: boolean;
  scopes: readonly MemoryScopeIndex[];
}

export interface MemorySettings {
  global: boolean;
  project: boolean;
}

export interface MemoryScopeTarget {
  scope: MemoryScope;
  key?: string | undefined;
  workspaceRoot?: string | undefined;
}

export interface ReadMemoryInput extends MemoryScopeTarget {
  name: string;
}

export interface DeleteMemoryInput extends MemoryScopeTarget {
  name: string;
}

export type ClearMemoryInput = MemoryScopeTarget;

export function isMemoryScope(value: unknown): value is MemoryScope {
  return typeof value === "string" && (MEMORY_SCOPES as readonly string[]).includes(value);
}

export function isMemoryType(value: unknown): value is MemoryType {
  return typeof value === "string" && (MEMORY_TYPES as readonly string[]).includes(value);
}

export function isValidMemoryName(value: unknown): value is string {
  return typeof value === "string" && MEMORY_NAME_RE.test(value);
}
