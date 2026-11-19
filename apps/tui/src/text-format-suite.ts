/**
 * 组曲（Suite）TUI 界面的纯逻辑（ADR-0097、tui.md）：五组归约、状态点、第二段摘要、
 * `<thread-report>` 解析与 `/suite <名称或 id>` 匹配。取值规则与桌面端 suite-ui.ts 一致；
 * 不依赖 React/Ink 或 apps/desktop。
 */
import {
  firstSuiteLine,
  type SubjectKind,
  type SuiteRecord,
  type SuiteThreadGroup,
  type SuiteThreadReportStatus,
  type SuiteThreadView,
  type SuiteView,
} from "@nocturne/core/protocol";

import { shortModelName } from "./text-format-ensemble.js";
import type { ThemePalette } from "./theme.js";

export type SuiteDotTone = "work" | "ask" | "pause" | "merge" | "ok" | "wait" | "retired";

export const SUITE_THREAD_GROUPS: readonly { key: SuiteThreadGroup; label: string }[] = [
  { key: "needs_attention", label: "等你处理" },
  { key: "running", label: "进行中" },
  { key: "unmerged", label: "待并回" },
  { key: "idle", label: "空闲" },
  { key: "resolved", label: "已完成" },
];

export interface SuiteThreadGroupSection {
  key: SuiteThreadGroup;
  label: string;
  threads: SuiteThreadView[];
}

export function groupSuiteThreads(threads: readonly SuiteThreadView[]): SuiteThreadGroupSection[] {
  const buckets: Record<SuiteThreadGroup, SuiteThreadView[]> = {
    needs_attention: [],
    running: [],
    unmerged: [],
    idle: [],
    resolved: [],
  };
  for (const thread of threads) {
    buckets[thread.group].push(thread);
  }
  return SUITE_THREAD_GROUPS.map((group) => ({
    key: group.key,
    label: group.label,
    threads: buckets[group.key],
  }));
}

/** 首行淡色计数：各非空组按五组顺序用 ` · ` 连接，如 `等你处理 1 · 待并回 1` */
export function suiteStatusCounts(threads: readonly SuiteThreadView[]): string {
  return groupSuiteThreads(threads)
    .filter((section) => section.threads.length > 0)
    .map((section) => `${section.label} ${section.threads.length}`)
    .join(" · ");
}

/** 状态块列出的线程：只含「等你处理」与「进行中」，前者在前 */
export function suiteStripThreads(suite: SuiteView | undefined): SuiteThreadView[] {
  if (suite === undefined) return [];
  const attention = suite.threads.filter((t) => t.group === "needs_attention");
  const running = suite.threads.filter((t) => t.group === "running");
  return [...attention, ...running];
}

export function suiteThreadDot(
  thread: Pick<
    SuiteThreadView,
    "status" | "pendingPermissions" | "hasPendingQuestion" | "hasUnmergedWorktree" | "resolved"
  >,
): SuiteDotTone {
  if (thread.pendingPermissions.length > 0 || thread.hasPendingQuestion) return "ask";
  if (thread.status === "paused") return "pause";
  if (thread.status === "working") return "work";
  if (thread.hasUnmergedWorktree) return "merge";
  if (thread.resolved) return "retired";
  return "wait";
}

export function suiteReportDotTone(
  status: SuiteThreadReportStatus,
  thread?: Pick<
    SuiteThreadView,
    "status" | "pendingPermissions" | "hasPendingQuestion" | "hasUnmergedWorktree" | "resolved"
  >,
): SuiteDotTone {
  if (status === "paused") return "pause";
  if (thread !== undefined) {
    if (thread.pendingPermissions.length > 0 || thread.hasPendingQuestion) return "ask";
    if (thread.status === "paused") return "pause";
    if (thread.status === "working") return "work";
    if (thread.hasUnmergedWorktree) return "merge";
  }
  return "ok";
}

export function suiteDotGlyph(tone: SuiteDotTone, ascii: boolean): string {
  const solid = ascii ? "*" : "●";
  const hollow = ascii ? "o" : "○";
  return tone === "wait" || tone === "retired" ? hollow : solid;
}

export function suiteDotColor(tone: SuiteDotTone, theme: ThemePalette): string {
  switch (tone) {
    case "ask":
    case "pause":
      return theme.warning;
    case "work":
    case "merge":
      return theme.accent;
    case "ok":
      return theme.success;
    case "wait":
    case "retired":
      return theme.muted;
  }
}

function operationForSubjectKind(kind: SubjectKind | undefined, fallback = "操作"): string {
  switch (kind) {
    case "shell":
      return "执行命令";
    case "edit":
      return "修改文件";
    case "read":
      return "读取文件";
    case "network":
      return "访问网络";
    case "mcp":
      return "调用 MCP 工具";
    case "subagent":
      return "启动子代理";
    case "schedule":
      return "定时任务";
    case "app":
      return "操作软件";
    default:
      return fallback;
  }
}

const SUITE_TOOL_LABELS: Readonly<Record<string, string>> = {
  todo_write: "任务清单",
  note_write: "笔记",
  update_goal: "目标",
  render_html: "页面",
  skill: "技能",
  read: "读取",
  grep: "搜索",
  glob: "查找文件",
  edit: "编辑",
  write: "写入",
  apply_patch: "应用补丁",
  apply_subagent_changes: "并回子代理改动",
  switch_worktree: "切换工作树",
  shell: "命令",
  shell_output: "命令输出",
  shell_kill: "停止命令",
  web_fetch: "读取网页",
  web_search: "网页搜索",
  subagent: "子代理",
  task: "子代理",
  finish: "提交结果",
  ask_user: "提问",
  schedule: "定时任务",
  mcp_search: "搜索 MCP 工具",
  mcp_call: "调用 MCP 工具",
};

export function suiteToolLabel(name: string): string {
  if (name.startsWith("mcp__computer__")) return "电脑操控";
  if (name.startsWith("mcp__")) {
    const rest = name.slice("mcp__".length);
    const sep = rest.indexOf("__");
    if (sep > 0) return `${rest.slice(0, sep)}/${rest.slice(sep + 2)}`;
    return rest === "" ? name : rest;
  }
  return SUITE_TOOL_LABELS[name] ?? name;
}

export function suiteThreadSecondary(
  thread: Pick<
    SuiteThreadView,
    | "group"
    | "status"
    | "pendingPermissions"
    | "hasPendingQuestion"
    | "pauseError"
    | "toolActivity"
    | "lastReportLine"
  >,
): { text: string; warn: boolean } {
  if (thread.pendingPermissions.length > 0) {
    const first = thread.pendingPermissions[0];
    const subject = first?.subjects[0];
    const target = subject?.target.trim();
    const summary =
      target !== undefined && target !== ""
        ? target
        : operationForSubjectKind(subject?.kind, first?.reason ?? "操作");
    return { text: `等待确认 · ${summary}`, warn: true };
  }
  if (thread.hasPendingQuestion) {
    return { text: "等待确认", warn: true };
  }
  if (thread.status === "paused") {
    const msg =
      firstSuiteLine(thread.pauseError?.message ?? "") ??
      thread.pauseError?.code ??
      thread.lastReportLine ??
      "";
    return { text: msg, warn: true };
  }
  if (thread.status === "working") {
    if (thread.toolActivity !== undefined) {
      const label = suiteToolLabel(thread.toolActivity.tool);
      const detail = thread.toolActivity.detail?.trim();
      return {
        text: detail !== undefined && detail !== "" ? `${label} ${detail}` : label,
        warn: false,
      };
    }
    return { text: thread.lastReportLine ?? "", warn: false };
  }
  return { text: thread.lastReportLine ?? "", warn: false };
}

export function suiteThreadModelLabel(thread: Pick<SuiteThreadView, "model">): string {
  return shortModelName(thread.model);
}

function unescapeXmlAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export interface ParsedSuiteThreadReport {
  threadId?: string | undefined;
  title?: string | undefined;
  status?: string | undefined;
  line: string;
  body: string;
}

export function parseSuiteThreadReport(text: string): ParsedSuiteThreadReport | undefined {
  const match = /^<thread-report\b([^>]*)>([\s\S]*?)<\/thread-report>\s*$/u.exec(text.trim());
  if (!match) return undefined;
  const rawAttrs = match[1] ?? "";
  const rawBody = match[2] ?? "";
  const attrs: Record<string, string> = {};
  const attrRe = /(\w+)="([^"]*)"/gu;
  let attrMatch: RegExpExecArray | null;
  while ((attrMatch = attrRe.exec(rawAttrs)) !== null) {
    const key = attrMatch[1];
    const val = attrMatch[2];
    if (key !== undefined && val !== undefined) {
      attrs[key] = unescapeXmlAttr(val);
    }
  }
  const body = rawBody
    .replace(/^\r?\n/, "")
    .replace(/\r?\n$/, "")
    .trim();
  return {
    ...(attrs.thread !== undefined ? { threadId: attrs.thread } : {}),
    ...(attrs.title !== undefined ? { title: attrs.title } : {}),
    ...(attrs.status !== undefined ? { status: attrs.status } : {}),
    line: firstSuiteLine(body) ?? "",
    body,
  };
}

export type SuiteMatchResult =
  | { kind: "ok"; suite: SuiteRecord }
  | { kind: "not_found" }
  | { kind: "ambiguous"; matches: SuiteRecord[] };

/** `/suite <名称或 id>` 匹配：名称精确优先，其次 id 精确，其次唯一前缀（名称优先于 id） */
export function matchSuiteTarget(
  suites: readonly SuiteRecord[],
  rawTarget: string,
): SuiteMatchResult {
  const query = rawTarget.trim();
  if (query === "") return { kind: "not_found" };
  const exactName = suites.filter((s) => s.name === query);
  if (exactName.length === 1 && exactName[0] !== undefined) {
    return { kind: "ok", suite: exactName[0] };
  }
  if (exactName.length > 1) return { kind: "ambiguous", matches: exactName };

  const exactId = suites.find((s) => s.id === query);
  if (exactId !== undefined) return { kind: "ok", suite: exactId };

  const lower = query.toLowerCase();
  const exactNameCi = suites.filter((s) => s.name.toLowerCase() === lower);
  if (exactNameCi.length === 1 && exactNameCi[0] !== undefined) {
    return { kind: "ok", suite: exactNameCi[0] };
  }
  if (exactNameCi.length > 1) return { kind: "ambiguous", matches: exactNameCi };

  const namePrefix = suites.filter((s) => s.name.startsWith(query));
  if (namePrefix.length === 1 && namePrefix[0] !== undefined) {
    return { kind: "ok", suite: namePrefix[0] };
  }
  if (namePrefix.length > 1) return { kind: "ambiguous", matches: namePrefix };

  const namePrefixCi = suites.filter((s) => s.name.toLowerCase().startsWith(lower));
  if (namePrefixCi.length === 1 && namePrefixCi[0] !== undefined) {
    return { kind: "ok", suite: namePrefixCi[0] };
  }
  if (namePrefixCi.length > 1) return { kind: "ambiguous", matches: namePrefixCi };

  const idPrefix = suites.filter((s) => s.id.startsWith(query));
  if (idPrefix.length === 1 && idPrefix[0] !== undefined) {
    return { kind: "ok", suite: idPrefix[0] };
  }
  if (idPrefix.length > 1) return { kind: "ambiguous", matches: idPrefix };

  return { kind: "not_found" };
}
