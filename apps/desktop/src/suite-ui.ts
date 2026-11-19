/**
 * 组曲（Suite）界面的纯逻辑（ADR-0097）：总览分组、线程状态圆点、第二行摘要、
 * `<thread-report>` 汇报行解析与汇报状态圆点。不依赖 React 或 DOM。
 */
import {
  firstSuiteLine,
  type SuiteThreadGroup,
  type SuiteThreadReportStatus,
  type SuiteThreadView,
  type SuiteView,
} from "@nocturne/core/protocol";

import { shortModelName } from "./ensemble-ui";
import { operationForSubjectKind } from "./notify";
import { toolMeta } from "./tool-meta";

/** 组曲状态圆点色调：复用合奏与桌面端语义色 token */
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

export function suiteStatusDot(
  suite: Pick<SuiteView, "needsAttentionThreads"> | undefined,
): "warn" | undefined {
  if (suite === undefined || suite.needsAttentionThreads.length === 0) return undefined;
  return "warn";
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
      const label = toolMeta(thread.toolActivity.tool).label;
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
}

export function parseSuiteThreadReport(text: string): ParsedSuiteThreadReport | undefined {
  const match = /^<thread-report\b([^>]*)>([\s\S]*?)<\/thread-report>\s*$/u.exec(text.trim());
  if (!match) return undefined;
  const rawAttrs = match[1] ?? "";
  const body = match[2] ?? "";
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
  return {
    ...(attrs.thread !== undefined ? { threadId: attrs.thread } : {}),
    ...(attrs.title !== undefined ? { title: attrs.title } : {}),
    ...(attrs.status !== undefined ? { status: attrs.status } : {}),
    line: firstSuiteLine(body) ?? "",
  };
}
