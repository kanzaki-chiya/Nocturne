/**
 * 子代理面板的纯逻辑（ADR-0060 第 6 节与修订（五））：概览分组与父 task 行的归属、
 * 状态与耗时的推导、最终结果的提取。界面在 SubagentPane.tsx / PanelChrome.tsx，
 * 观察状态在 subagent-watch.ts。不依赖 React。
 */
import {
  SUBAGENT_TASK_FALLBACK,
  type SessionView,
  type SubagentSummary,
  type ToolCallStatus,
  type ToolEntry,
} from "@nocturne/core/protocol";

import { SUBAGENT_SUMMARY_MAX } from "./side-panel";

/** 外部 agent（ACP）调用：没有 Nocturne 子会话，只在概览里只读展示 */
export interface ExternalRun {
  callId: string;
  agent: string;
  summary: string;
}

/** task 原文压成单行、至多 120 个码点（与 Core 的摘要同一口径，只用于外部调用等没有 child 摘要的场合） */
export function oneLineSummary(text: string): string {
  const flat = text.slice(0, 20_000).replace(/\s+/g, " ").trim();
  return flat === ""
    ? SUBAGENT_TASK_FALLBACK
    : Array.from(flat).slice(0, SUBAGENT_SUMMARY_MAX).join("");
}

/** 工具行是不是 task 调用 */
export function isTaskEntry(entry: {
  kind: string;
  name?: string | undefined;
}): entry is ToolEntry {
  return entry.kind === "tool" && entry.name === "task";
}

/** 父持久工具主体里的外部 agent 名（`subagent` 主体 target = `external:<name>`）；内置为 undefined */
export function externalAgentOf(entry: ToolEntry): string | undefined {
  for (const subject of entry.subjects) {
    if (subject.kind === "subagent" && subject.target.startsWith("external:")) {
      return subject.target.slice("external:".length);
    }
  }
  return undefined;
}

/** 父会话里仍在运行的 task 调用（包含外部与内置） */
function runningTasks(view: Pick<SessionView, "entries">): ToolEntry[] {
  return view.entries.filter(
    (entry): entry is ToolEntry => isTaskEntry(entry) && entry.status === "running",
  );
}

/** 概览里的外部 agent 行：按父持久工具主体识别，不读当前配置 */
export function externalRuns(view: Pick<SessionView, "entries">): ExternalRun[] {
  return runningTasks(view).flatMap((entry) => {
    const agent = externalAgentOf(entry);
    if (agent === undefined) return [];
    const input = entry.input as { task?: unknown } | undefined;
    return [
      {
        callId: entry.callId,
        agent,
        summary: oneLineSummary(typeof input?.task === "string" ? input.task : ""),
      },
    ];
  });
}

/**
 * 需要补查 child 的未结算内置 task 数。外部调用没有 child 可找，不计入；
 * 尚在启动权限确认的（awaiting_permission）还没有 child，也不计入——确认后状态变 running 再计。
 */
export function unsettledBuiltinTasks(view: Pick<SessionView, "entries">): number {
  return runningTasks(view).filter((entry) => externalAgentOf(entry) === undefined).length;
}

/** 父 task 行与 child 的关系（Conversation 的「在面板中查看」按钮据此显示） */
export type SubagentLink =
  { kind: "none" } | { kind: "locating" } | { kind: "ready"; childSessionId: string };

/**
 * task 行的 child 归属：同一父调用意外有多个 child 时取最早创建的一个（summaries 已按
 * startedAt 升序）。运行中还没查到时是 locating；外部调用、尚未确认和已结束的无 child 调用
 * 都是 none——不把「暂时没查到」缓存成永久无 child：目录刷新后同一行会自行变成 ready。
 */
export function linkFor(entry: ToolEntry, summaries: readonly SubagentSummary[]): SubagentLink {
  if (!isTaskEntry(entry) || externalAgentOf(entry) !== undefined) return { kind: "none" };
  const child = summaries.find((summary) => summary.callId === entry.callId);
  if (child !== undefined) return { kind: "ready", childSessionId: child.childSessionId };
  return entry.status === "running" ? { kind: "locating" } : { kind: "none" };
}

/** 概览分组：直接内置、仍在运行的子代理（可点击），按开始时间 */
export function runningBuiltin(summaries: readonly SubagentSummary[]): SubagentSummary[] {
  return summaries.filter((summary) => summary.state === "running");
}

/** 已用时间的人读写法："12 秒" / "1 分 45 秒" / "1 小时 2 分" */
export function elapsedText(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${String(seconds)} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest === 0 ? `${String(minutes)} 分` : `${String(minutes)} 分 ${String(rest)} 秒`;
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes === 0
    ? `${String(hours)} 小时`
    : `${String(hours)} 小时 ${String(restMinutes)} 分`;
}

/** 从 startedAt 到 now 的本地计时（概览的秒数靠本地 timer 刷新，不靠查询） */
export function runningMs(startedAt: string, now: number): number | undefined {
  const started = Date.parse(startedAt);
  return Number.isNaN(started) ? undefined : Math.max(0, now - started);
}

export type SubagentPhase =
  /** 子代理还在运行 */
  | "running"
  /** 子代理已提交结果，但父 task 还没有持久结算：不抢先宣告父调用成功 */
  | "submitted"
  | "ok"
  | "error"
  | "cancelled"
  | "denied"
  | "interrupted"
  /** 日志没有收束事实：运行状态未知，动画停止 */
  | "unsealed"
  /** 已读完但既无父结算也无其他终止事实（例如只读快照尚未判定） */
  | "unknown";

export interface SubagentStatus {
  phase: SubagentPhase;
  label: string;
  /** 动画（转圈、秒数）只在运行中出现 */
  animated: boolean;
  /** 失败/取消的原因文案 */
  error?: string | undefined;
  /** 已知的最终耗时；缺则不编造 */
  durationMs?: number | undefined;
  durationApproximate?: boolean | undefined;
}

const SETTLED_LABEL: Record<ToolCallStatus, { phase: SubagentPhase; label: string }> = {
  ok: { phase: "ok", label: "已完成" },
  error: { phase: "error", label: "失败" },
  cancelled: { phase: "cancelled", label: "已取消" },
  interrupted: { phase: "interrupted", label: "已中断" },
  denied: { phase: "denied", label: "被拒绝" },
};

/** child 视图里已成功提交的 finish：input.result 才是最终结果，modelContent 只是提交回执 */
export function childFinish(view: Pick<SessionView, "entries">): ToolEntry | undefined {
  for (let index = view.entries.length - 1; index >= 0; index -= 1) {
    const entry = view.entries[index];
    if (entry?.kind === "tool" && entry.name === "finish" && entry.status === "ok") return entry;
  }
  return undefined;
}

/** finish 的最终结果正文：字符串按 Markdown，结构化值格式化成 JSON */
export function finalResult(
  view: Pick<SessionView, "entries">,
): { kind: "text"; text: string } | { kind: "json"; text: string } | undefined {
  const finish = childFinish(view);
  const input = finish?.input as { result?: unknown } | undefined;
  if (finish === undefined || input === undefined || !("result" in input)) return undefined;
  if (typeof input.result === "string") return { kind: "text", text: input.result };
  // 结果为 undefined/函数时 JSON.stringify 返回 undefined（lib 类型没写出来）
  const text = JSON.stringify(input.result, null, 2) as string | undefined;
  return text === undefined ? undefined : { kind: "json", text };
}

/**
 * 子代理标签的状态与耗时（ADR 修订（五）第 8 条）：
 * - 状态优先父 task 的持久结算（parent 工具行已结算，或服务端 summary.outcome）；
 * - 耗时优先父 tool.completed.durationMs，其次服务端给的耗时（可能是近似），
 *   都没有就不编造最终耗时；
 * - 父尚未结算但已收到成功 finish：先显示「结果已提交」；
 * - 无终止事实的日志（summary.state = unsealed）：「日志未收束／运行状态未知」，不转圈。
 */
export function subagentStatus(input: {
  summary:
    Pick<SubagentSummary, "state" | "outcome" | "durationMs" | "durationApproximate"> | undefined;
  parent: ToolEntry | undefined;
  childView: Pick<SessionView, "entries"> | undefined;
}): SubagentStatus {
  const { summary, parent, childView } = input;
  // 父日志的结算不能掩盖子日志尚未闭合的事实。
  if (summary?.state === "unsealed") {
    return { phase: "unsealed", label: "日志未收束／运行状态未知", animated: false };
  }
  const parentResult = parent?.result;
  const settled =
    parentResult !== undefined && parent?.status !== "running" && parent?.status !== undefined
      ? {
          status: parentResult.status,
          error: parentResult.error,
          durationMs: parentResult.durationMs,
        }
      : summary?.outcome !== undefined
        ? {
            status: summary.outcome.status,
            error: summary.outcome.error,
            durationMs: undefined,
          }
        : undefined;
  if (settled !== undefined) {
    const kind = SETTLED_LABEL[settled.status];
    const fromSummary = settled.durationMs === undefined && summary?.durationMs !== undefined;
    const durationMs = settled.durationMs ?? summary?.durationMs;
    return {
      phase: kind.phase,
      label: kind.label,
      animated: false,
      ...(settled.error !== undefined ? { error: settled.error.message } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(fromSummary && summary.durationApproximate === true ? { durationApproximate: true } : {}),
    };
  }
  if (summary?.state === "running") {
    // 子代理在跑；已有成功 finish 说明最终结果已提交、正在收尾
    if (childView !== undefined && childFinish(childView) !== undefined) {
      return { phase: "submitted", label: "结果已提交", animated: false };
    }
    return { phase: "running", label: "运行中", animated: true };
  }
  if (childView !== undefined && childFinish(childView) !== undefined) {
    return {
      phase: "submitted",
      label: "结果已提交",
      animated: false,
      ...(summary?.durationMs !== undefined ? { durationMs: summary.durationMs } : {}),
      ...(summary?.durationApproximate === true ? { durationApproximate: true } : {}),
    };
  }
  return {
    phase: "unknown",
    label: summary === undefined ? "正在读取" : "已结束",
    animated: false,
    ...(summary?.durationMs !== undefined ? { durationMs: summary.durationMs } : {}),
    ...(summary?.durationApproximate === true ? { durationApproximate: true } : {}),
  };
}
