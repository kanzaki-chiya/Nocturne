/**
 * 子代理 Markdown 定义解析原语（ADR-0105 插件子代理与 ADR-0108 项目子代理共用）。
 * 支持 Nocturne 原生格式（插件与 `.nocturne/agents/*.md`）与 Claude Code 兼容格式（`.claude/agents/*.md`）。
 */
import { LineCounter, parseDocument } from "yaml";
import {
  isValidSubagentProfileName,
  REASONING_EFFORT_ORDER,
  type ReasoningEffort,
} from "../protocol/index.js";

export const MAX_SUBAGENT_DESCRIPTION_CHARS = 300;
export const MAX_SUBAGENT_BODY_CHARS = 10_000;

const NOCTURNE_KNOWN_KEYS = new Set(["name", "description", "tools", "effort"]);
const CLAUDE_KNOWN_KEYS = new Set(["name", "description", "tools", "disallowedTools", "effort"]);
const EFFORT_SET: ReadonlySet<string> = new Set(REASONING_EFFORT_ORDER);

/** Claude Code 工具名到 Nocturne 内置工具名的映射（ADR-0108） */
export const CLAUDE_CODE_TOOL_MAP: Readonly<Record<string, readonly string[]>> = {
  Read: ["read"],
  Write: ["edit", "write", "apply_patch"],
  Edit: ["edit", "write", "apply_patch"],
  MultiEdit: ["edit", "write", "apply_patch"],
  Glob: ["glob"],
  LS: ["glob"],
  Grep: ["grep"],
  Bash: ["shell", "shell_output", "shell_kill"],
  BashOutput: ["shell_output"],
  KillShell: ["shell_kill"],
  KillBash: ["shell_kill"],
  WebFetch: ["web_fetch"],
  TodoWrite: ["todo_write"],
  Task: ["task"],
  Agent: ["task"],
  Skill: ["skill"],
};

const MCP_TOOL_NAME_RE = /^mcp__[^\s:()]+__[^\s:()]+$/;
const TOOL_SPECIFIER_RE = /^([A-Za-z][A-Za-z0-9_-]*)\s*\([\s\S]*\)$/;

export interface ParsedSubagentMarkdown {
  agent?: {
    name: string;
    description: string;
    prompt: string;
    effort?: ReasoningEffort | undefined;
    tools?: string[] | undefined;
    disallowedTools?: string[] | undefined;
  };
  warnings: string[];
}

interface FrontmatterExtraction {
  fields?: Record<string, unknown>;
  body?: string;
}

function extractFrontmatter(
  text: string,
  prefix: string,
  warnings: string[],
): FrontmatterExtraction {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    warnings.push(`${prefix}缺少 YAML frontmatter，已跳过`);
    return {};
  }
  const end = normalized.indexOf("\n---", 4);
  if (end < 0 || !/^\n---(?:\n|$)/.test(normalized.slice(end))) {
    warnings.push(`${prefix}YAML frontmatter 未闭合，已跳过`);
    return {};
  }

  const lineCounter = new LineCounter();
  const doc = parseDocument(normalized.slice(4, end), { lineCounter, uniqueKeys: true });
  const syntaxError = doc.errors[0];
  if (syntaxError !== undefined) {
    warnings.push(`${prefix}YAML frontmatter 解析失败（${syntaxError.message}），已跳过`);
    return {};
  }

  let rawFields: unknown;
  try {
    rawFields = doc.toJS({ maxAliasCount: 100 }) ?? {};
  } catch (e) {
    warnings.push(
      `${prefix}YAML frontmatter 解析失败（${e instanceof Error ? e.message : String(e)}），已跳过`,
    );
    return {};
  }
  if (typeof rawFields !== "object" || rawFields === null || Array.isArray(rawFields)) {
    warnings.push(`${prefix}YAML frontmatter 必须为字段映射，已跳过`);
    return {};
  }

  return {
    fields: rawFields as Record<string, unknown>,
    body: normalized.slice(end + 4).trim(),
  };
}

function validateBody(body: string, prefix: string, warnings: string[]): boolean {
  if (body === "") {
    warnings.push(`${prefix}角色说明正文不能为空，已跳过`);
    return false;
  }
  if (Array.from(body).length > MAX_SUBAGENT_BODY_CHARS) {
    warnings.push(`${prefix}角色说明正文超过 ${MAX_SUBAGENT_BODY_CHARS} 字上限，已跳过`);
    return false;
  }
  return true;
}

/**
 * 解析 Nocturne 原生子代理 Markdown（插件与 `.nocturne/agents/*.md` 共用）。
 * - 插件传 `rejectLongDescription: true`（超过 300 字整条跳过）；
 * - 项目 `.nocturne/agents/*.md` 传 `rejectLongDescription: false`（保留全文，选择表里截断）。
 */
export function parseNocturneSubagentMarkdown(
  text: string,
  options: {
    prefix: string;
    rejectLongDescription: boolean;
    modelIgnoreReason: string;
  },
): ParsedSubagentMarkdown {
  const warnings: string[] = [];
  const { prefix } = options;
  const extracted = extractFrontmatter(text, prefix, warnings);
  if (extracted.fields === undefined || extracted.body === undefined) {
    return { warnings };
  }
  const { fields, body } = extracted;

  for (const key of Object.keys(fields)) {
    if (NOCTURNE_KNOWN_KEYS.has(key)) continue;
    if (key === "model") {
      warnings.push(`${prefix}忽略不支持的字段 model（${options.modelIgnoreReason}）`);
    } else {
      warnings.push(`${prefix}忽略未知字段 ${key}`);
    }
  }

  if (typeof fields.name !== "string" || !isValidSubagentProfileName(fields.name)) {
    warnings.push(`${prefix}缺少或无效的 name 字段，已跳过`);
    return { warnings };
  }
  const name = fields.name;

  if (typeof fields.description !== "string" || fields.description.trim() === "") {
    warnings.push(`${prefix}缺少有效的 description 字段，已跳过`);
    return { warnings };
  }
  const description = fields.description.trim();
  if (
    options.rejectLongDescription &&
    Array.from(description).length > MAX_SUBAGENT_DESCRIPTION_CHARS
  ) {
    warnings.push(`${prefix}description 超过 ${MAX_SUBAGENT_DESCRIPTION_CHARS} 字上限，已跳过`);
    return { warnings };
  }

  let tools: string[] | undefined;
  if (fields.tools !== undefined) {
    if (
      !Array.isArray(fields.tools) ||
      !fields.tools.every((item): item is string => typeof item === "string" && item.trim() !== "")
    ) {
      warnings.push(`${prefix}tools 必须是非空字符串数组，已跳过`);
      return { warnings };
    }
    tools = [...new Set(fields.tools.map((item) => item.trim()))];
  }

  let effort: ReasoningEffort | undefined;
  if (fields.effort !== undefined) {
    if (typeof fields.effort !== "string" || !EFFORT_SET.has(fields.effort)) {
      warnings.push(`${prefix}effort 字段无效，已跳过`);
      return { warnings };
    }
    effort = fields.effort as ReasoningEffort;
  }

  if (!validateBody(body, prefix, warnings)) {
    return { warnings };
  }

  return {
    agent: {
      name,
      description,
      prompt: body,
      ...(effort !== undefined ? { effort } : {}),
      ...(tools !== undefined ? { tools } : {}),
    },
    warnings,
  };
}

/** 按逗号拆分工具字符串，保留括号限定符内部的逗号（如 `Agent(a, b), Read`） */
function splitCommaToolList(raw: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "(") depth++;
    else if (ch === ")" && depth > 0) depth--;
    else if (ch === "," && depth === 0) {
      const part = raw.slice(start, i).trim();
      if (part !== "") items.push(part);
      start = i + 1;
    }
  }
  const tail = raw.slice(start).trim();
  if (tail !== "") items.push(tail);
  return items;
}

function parseRawToolList(
  value: unknown,
  fieldName: "tools" | "disallowedTools",
  prefix: string,
  warnings: string[],
): string[] | null {
  if (typeof value === "string") {
    return splitCommaToolList(value);
  }
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (const entry of value) {
      if (typeof entry !== "string") {
        warnings.push(`${prefix}${fieldName} 必须是逗号分隔字符串或字符串列表，已跳过`);
        return null;
      }
      const trimmed = entry.trim();
      if (trimmed !== "") items.push(trimmed);
    }
    return items;
  }
  warnings.push(`${prefix}${fieldName} 必须是逗号分隔字符串或字符串列表，已跳过`);
  return null;
}

function mapClaudeToolEntry(entry: string, stripSpecifier: boolean): readonly string[] | undefined {
  const direct = CLAUDE_CODE_TOOL_MAP[entry];
  if (direct !== undefined) return direct;
  if (MCP_TOOL_NAME_RE.test(entry)) return [entry];
  if (stripSpecifier) {
    const match = TOOL_SPECIFIER_RE.exec(entry);
    const base = match?.[1];
    if (base !== undefined) {
      const mapped = CLAUDE_CODE_TOOL_MAP[base];
      if (mapped !== undefined) return mapped;
      if (MCP_TOOL_NAME_RE.test(base)) return [base];
    }
  }
  return undefined;
}

/**
 * 解析 Claude Code 兼容格式的子代理 Markdown（`.claude/agents/*.md`，ADR-0108）。
 */
export function parseClaudeSubagentMarkdown(
  text: string,
  options: { prefix: string },
): ParsedSubagentMarkdown {
  const warnings: string[] = [];
  const { prefix } = options;
  const extracted = extractFrontmatter(text, prefix, warnings);
  if (extracted.fields === undefined || extracted.body === undefined) {
    return { warnings };
  }
  const { fields, body } = extracted;

  // 其余不支持字段（model、permissionMode、mcpServers、hooks、maxTurns 等）合并成一条警告
  const ignoredKeys = Object.keys(fields).filter((key) => !CLAUDE_KNOWN_KEYS.has(key));
  if (ignoredKeys.length > 0) {
    warnings.push(`${prefix}忽略不支持的字段：${ignoredKeys.join("、")}`);
  }

  if (typeof fields.name !== "string" || !isValidSubagentProfileName(fields.name)) {
    warnings.push(`${prefix}缺少或无效的 name 字段，已跳过`);
    return { warnings };
  }
  const name = fields.name;

  if (typeof fields.description !== "string" || fields.description.trim() === "") {
    warnings.push(`${prefix}缺少有效的 description 字段，已跳过`);
    return { warnings };
  }
  const description = fields.description.trim();

  // effort：取值合法就用，否则忽略并警告（不跳过文件）
  let effort: ReasoningEffort | undefined;
  if (fields.effort !== undefined) {
    if (typeof fields.effort === "string" && EFFORT_SET.has(fields.effort)) {
      effort = fields.effort as ReasoningEffort;
    } else {
      const rawEffort =
        typeof fields.effort === "string" ? fields.effort : JSON.stringify(fields.effort);
      warnings.push(`${prefix}忽略无效的 effort 字段（${rawEffort}）`);
    }
  }

  // tools 与 disallowedTools 映射
  let mappedTools: string[] | undefined;
  if (fields.tools !== undefined) {
    const rawTools = parseRawToolList(fields.tools, "tools", prefix, warnings);
    if (rawTools === null) return { warnings };
    const result: string[] = [];
    const seen = new Set<string>();
    for (const entry of rawTools) {
      const mapped = mapClaudeToolEntry(entry, false);
      if (mapped === undefined) {
        warnings.push(`${prefix}忽略无法映射的 tools 项 "${entry}"`);
        continue;
      }
      for (const toolName of mapped) {
        if (!seen.has(toolName)) {
          seen.add(toolName);
          result.push(toolName);
        }
      }
    }
    mappedTools = result;
  }

  let mappedDisallowed: string[] | undefined;
  if (fields.disallowedTools !== undefined) {
    const rawDisallowed = parseRawToolList(
      fields.disallowedTools,
      "disallowedTools",
      prefix,
      warnings,
    );
    if (rawDisallowed === null) return { warnings };
    const result: string[] = [];
    const seen = new Set<string>();
    for (const entry of rawDisallowed) {
      const mapped = mapClaudeToolEntry(entry, true);
      if (mapped === undefined) {
        warnings.push(`${prefix}忽略无法映射的 disallowedTools 项 "${entry}"`);
        continue;
      }
      for (const toolName of mapped) {
        if (!seen.has(toolName)) {
          seen.add(toolName);
          result.push(toolName);
        }
      }
    }
    mappedDisallowed = result;
  }

  let tools: string[] | undefined;
  let disallowedTools: string[] | undefined;
  if (mappedTools !== undefined) {
    const deny = new Set(mappedDisallowed ?? []);
    tools = mappedTools.filter((t) => !deny.has(t));
  } else if (mappedDisallowed !== undefined && mappedDisallowed.length > 0) {
    disallowedTools = mappedDisallowed;
  }

  if (!validateBody(body, prefix, warnings)) {
    return { warnings };
  }

  return {
    agent: {
      name,
      description,
      prompt: body,
      ...(effort !== undefined ? { effort } : {}),
      ...(tools !== undefined ? { tools } : {}),
      ...(disallowedTools !== undefined ? { disallowedTools } : {}),
    },
    warnings,
  };
}
