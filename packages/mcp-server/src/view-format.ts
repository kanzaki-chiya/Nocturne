import {
  allPendingPermissions,
  userEntryText,
  type LiveTool,
  type SessionView,
  type ToolEntry,
} from "@nocturne/core/protocol";

export const MAX_MCP_OUTPUT_BYTES = 64 * 1024;
/** 等待类返回中单条工具目标文本的最大字符数（含省略号） */
export const MAX_WAIT_TOOL_TARGET_CHARS = 120;
/** 等待类返回中单次最多列出的最近工具调用条数 */
export const MAX_WAIT_TOOLS_PER_CALL = 20;
/** 等待类返回中本轮首条用户提交文本的最大字符数（含省略号） */
export const MAX_WAIT_USER_TEXT_CHARS = 300;
/** 等待类返回中最后一段回复之前的过程文字最大字符数（含省略号） */
export const MAX_WAIT_PROCESS_TEXT_CHARS = 300;

export type McpSessionStatus =
  "idle" | "running" | "waiting_for_permission" | "waiting_for_answer" | "paused" | "error";

export interface FoldedTurn {
  turnId: string;
  status: "running" | "completed" | "cancelled" | "failed";
  userText: string;
  tools: string[];
  assistantText: string;
  error?: string | undefined;
}

export interface WaitToolCursor {
  turnId: string;
  /** 本轮内已报告给当前 MCP 连接的 callId -> 状态 */
  reportedStates: Map<string, string>;
}

export interface WaitFoldedTurn {
  turnId: string;
  status: FoldedTurn["status"];
  userText: string;
  /** 本轮除首条用户提交外的其余用户输入条目数（如后台命令结果 <shell-result>、插话、Runtime 注入等） */
  extraInputs?: number | undefined;
  tools: string[];
  /** 本次之前（上一次等待返回）已省略的本轮工具调用条数 */
  omittedPreviousTools: number;
  /** 本次新增工具超出单次条数上限时，因上限被省略的较早条数 */
  omittedExcessTools?: number | undefined;
  error?: string | undefined;
}

export interface IncrementalWaitTurnOptions {
  /** 是否推进增量游标（wait: true 与 nocturne_wait 推进；wait: false 不推进） */
  advanceCursor?: boolean | undefined;
  maxTools?: number | undefined;
  maxTargetChars?: number | undefined;
  maxUserTextChars?: number | undefined;
  maxProcessTextChars?: number | undefined;
}

export interface IncrementalWaitTurnResult {
  turn: WaitFoldedTurn | undefined;
  /** 本轮助手回复（保留最后一段完整回复，较早过程文字按上限截断）；与 lastTurn 去重，只放在顶层 reply */
  reply: string;
  nextCursor: WaitToolCursor | undefined;
}

/**
 * 推导会话面向外部 agent 的状态（ADR-0074 §4）：
 * `idle` / `running` / `waiting_for_permission` / `waiting_for_answer` / `paused` / `error`
 */
export function deriveMcpSessionStatus(
  view: SessionView,
  pendingCount = 0,
  paused = false,
): McpSessionStatus {
  if (view.pendingPermission !== undefined || view.pendingSubagentPermissions.length > 0) {
    return "waiting_for_permission";
  }
  if (view.pendingQuestion !== undefined) return "waiting_for_answer";
  if (paused) return "paused";
  if (
    view.currentTurn !== undefined ||
    (view.status !== "idle" && view.status !== "failed") ||
    pendingCount > 0
  ) {
    return "running";
  }
  if (view.lastTurn?.reason === "error" || view.status === "failed") return "error";
  return "idle";
}

function summarizeToolEntry(tool: ToolEntry): string {
  const name = tool.target?.name ?? tool.name ?? "tool";
  const status = tool.result?.status ?? tool.status;
  let detail = "";
  if (tool.result?.error?.message) {
    detail = tool.result.error.message;
  } else if (tool.subjects.length > 0) {
    detail = tool.subjects.map((s) => s.target).join(", ");
  } else if (
    typeof tool.result?.modelContent === "string" &&
    tool.result.modelContent.trim() !== ""
  ) {
    const firstLine = tool.result.modelContent.trim().split(/\r?\n/)[0] ?? "";
    detail = firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine;
  }
  return `[${name}] ${status}${detail ? ` — ${detail}` : ""}`;
}

function readStringField(input: unknown, keys: readonly string[]): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const record = input as Record<string, unknown>;
  for (const key of keys) {
    const val = record[key];
    if (typeof val === "string" && val.trim() !== "") return val;
  }
  return undefined;
}

function truncateChars(text: string, maxChars: number, forceEllipsis = false): string {
  const limit = Math.max(2, maxChars);
  const chars = Array.from(text);
  if (chars.length > limit) {
    return `${chars.slice(0, limit - 1).join("")}…`;
  }
  if (forceEllipsis) {
    if (chars.length === limit) {
      return `${chars.slice(0, limit - 1).join("")}…`;
    }
    return `${text}…`;
  }
  return text;
}

function collapseToSingleLine(text: string, maxChars: number, firstLineOnly: boolean): string {
  if (firstLineOnly) {
    const nonEmptyLines = text
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter((line) => line !== "");
    const first = nonEmptyLines[0] ?? "";
    if (!first) return "";
    return truncateChars(first, maxChars, nonEmptyLines.length > 1);
  }
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  return truncateChars(collapsed, maxChars, false);
}

/**
 * 为等待类返回生成单行工具调用摘要：工具名、状态、目标。
 * shell 命令只取第一非空行，折叠空白并按上限截断；所有输出均保证不含换行符。
 */
export function summarizeWaitToolEntry(
  tool: ToolEntry,
  maxTargetChars = MAX_WAIT_TOOL_TARGET_CHARS,
): string {
  const name = tool.target?.name ?? tool.name ?? "tool";
  const status = tool.result?.status ?? tool.status;
  const shellSubject = tool.subjects.find((s) => s.kind === "shell");
  const isShell = name === "shell" || shellSubject !== undefined;

  let target = "";
  if (isShell) {
    const command =
      shellSubject?.target ?? readStringField(tool.target?.input ?? tool.input, ["command"]);
    if (command !== undefined) {
      target = collapseToSingleLine(command, maxTargetChars, true);
    }
  }
  if (!target && tool.subjects.length > 0) {
    target = collapseToSingleLine(
      tool.subjects.map((s) => s.target).join(", "),
      maxTargetChars,
      false,
    );
  }
  if (!target) {
    const inputTarget = readStringField(tool.target?.input ?? tool.input, [
      "path",
      "filePath",
      "url",
      "pattern",
      "command",
    ]);
    if (inputTarget !== undefined) {
      target = collapseToSingleLine(inputTarget, maxTargetChars, true);
    }
  }
  if (!target && tool.result?.error?.message) {
    target = collapseToSingleLine(tool.result.error.message, maxTargetChars, false);
  }
  if (
    !target &&
    typeof tool.result?.modelContent === "string" &&
    tool.result.modelContent.trim() !== ""
  ) {
    target = collapseToSingleLine(tool.result.modelContent, maxTargetChars, true);
  }

  return `[${name}] ${status}${target ? ` — ${target}` : ""}`;
}

function summarizeWaitLiveTool(liveTool: LiveTool): string {
  return `[${liveTool.name}] running`;
}

function formatWaitReply(assistantParts: readonly string[], maxProcessTextChars: number): string {
  if (assistantParts.length === 0) return "";
  const finalPart = assistantParts[assistantParts.length - 1] ?? "";
  if (assistantParts.length === 1) return finalPart;
  const processText = assistantParts.slice(0, -1).join("\n\n");
  const trimmedProcess = truncateChars(processText, maxProcessTextChars);
  return `${trimmedProcess}\n\n${finalPart}`;
}

/**
 * 提取等待类返回用的最新轮次增量摘要：
 * - `userText` 只保留本轮首条用户提交文本并截断至 `maxUserTextChars`（默认 300 字符），其余用户条目只计入 `extraInputs`；
 * - 助手回复经 `reply` 返回（不重复放在 `lastTurn`），最后一段回复不截断，较早过程文字按 `maxProcessTextChars` 截断；
 * - 仅列出上次返回后新增或状态有变化的工具调用（同一轮次内）；
 * - 每条工具调用压成单行，shell 命令只取首行并截断；
 * - 单次最多列出最近 `maxTools`（默认 20）条，超出与历史省略数分开注明。
 */
export function extractIncrementalWaitTurn(
  view: SessionView,
  cursor: WaitToolCursor | undefined,
  options?: IncrementalWaitTurnOptions,
): IncrementalWaitTurnResult {
  const maxTools = Math.max(1, options?.maxTools ?? MAX_WAIT_TOOLS_PER_CALL);
  const maxTargetChars = Math.max(2, options?.maxTargetChars ?? MAX_WAIT_TOOL_TARGET_CHARS);
  const maxUserTextChars = Math.max(2, options?.maxUserTextChars ?? MAX_WAIT_USER_TEXT_CHARS);
  const maxProcessTextChars = Math.max(
    2,
    options?.maxProcessTextChars ?? MAX_WAIT_PROCESS_TEXT_CHARS,
  );
  const advanceCursor = options?.advanceCursor ?? true;

  let lastTurnId: string | undefined;
  for (const entry of view.entries) {
    if (entry.kind === "user" || entry.kind === "tool" || entry.kind === "assistant") {
      lastTurnId = entry.turnId;
    }
  }
  for (const liveTool of view.live.tools) {
    if (liveTool.turnId !== undefined) lastTurnId = liveTool.turnId;
  }
  for (const liveAsst of view.live.assistants) {
    if (liveAsst.turnId !== undefined && liveAsst.text.trim() !== "") {
      lastTurnId = liveAsst.turnId;
    }
  }

  if (lastTurnId === undefined) {
    return { turn: undefined, reply: "", nextCursor: cursor };
  }

  let firstUserText: string | undefined;
  let extraInputs = 0;
  const assistantParts: string[] = [];
  const allTools: { id: string; status: string; line: string }[] = [];
  const seenCallIds = new Set<string>();

  for (const entry of view.entries) {
    if (entry.kind === "user" && entry.turnId === lastTurnId) {
      if (firstUserText === undefined) {
        firstUserText = userEntryText(entry);
      } else {
        extraInputs++;
      }
    } else if (entry.kind === "tool" && entry.turnId === lastTurnId) {
      const id = entry.callId || entry.key;
      seenCallIds.add(id);
      const status = entry.result?.status ?? entry.status;
      allTools.push({
        id,
        status,
        line: summarizeWaitToolEntry(entry, maxTargetChars),
      });
    } else if (entry.kind === "assistant" && entry.turnId === lastTurnId) {
      if (entry.text.trim() !== "") assistantParts.push(entry.text);
    }
  }

  for (const liveTool of view.live.tools) {
    if (liveTool.turnId === lastTurnId && !seenCallIds.has(liveTool.callId)) {
      allTools.push({
        id: liveTool.callId,
        status: "running",
        line: summarizeWaitLiveTool(liveTool),
      });
    }
  }

  for (const liveAsst of view.live.assistants) {
    if (liveAsst.turnId === lastTurnId && liveAsst.text.trim() !== "") {
      assistantParts.push(liveAsst.text);
    }
  }

  const prevStates =
    cursor?.turnId === lastTurnId ? cursor.reportedStates : new Map<string, string>();

  let omittedPreviousTools = 0;
  const newTools: { id: string; status: string; line: string }[] = [];
  for (const item of allTools) {
    if (prevStates.get(item.id) === item.status) {
      omittedPreviousTools++;
    } else {
      newTools.push(item);
    }
  }

  const omittedExcessTools = newTools.length > maxTools ? newTools.length - maxTools : 0;
  const visibleTools = omittedExcessTools > 0 ? newTools.slice(-maxTools) : newTools;

  let nextCursor = cursor;
  if (advanceCursor) {
    const reportedStates = new Map<string, string>(prevStates);
    for (const item of allTools) {
      reportedStates.set(item.id, item.status);
    }
    nextCursor = {
      turnId: lastTurnId,
      reportedStates,
    };
  }

  const isCurrent = view.currentTurn?.turnId === lastTurnId;
  let status: FoldedTurn["status"] = "completed";
  let error: string | undefined;
  if (isCurrent) {
    status = "running";
  } else if (view.lastTurn !== undefined) {
    if (view.lastTurn.reason === "error") {
      status = "failed";
      error = "turn failed";
    } else if (view.lastTurn.reason === "aborted") {
      status = "cancelled";
    }
  }

  return {
    turn: {
      turnId: lastTurnId,
      status,
      userText: truncateChars(firstUserText ?? "", maxUserTextChars),
      ...(extraInputs > 0 ? { extraInputs } : {}),
      tools: visibleTools.map((t) => t.line),
      omittedPreviousTools,
      ...(omittedExcessTools > 0 ? { omittedExcessTools } : {}),
      ...(error !== undefined ? { error } : {}),
    },
    reply: formatWaitReply(assistantParts, maxProcessTextChars),
    nextCursor,
  };
}

/**
 * 从 `SessionView.entries` 按 `turnId` 聚合折叠所有轮次：
 * 每轮只含用户消息、单行工具调用摘要与最终回复文本，不展开完整 diff 或大段命令输出。
 */
export function extractFoldedTurns(view: SessionView): FoldedTurn[] {
  const turnOrder: string[] = [];
  const turnMap = new Map<
    string,
    {
      turnId: string;
      userParts: string[];
      tools: string[];
      assistantParts: string[];
    }
  >();

  const ensureTurn = (turnId: string) => {
    let t = turnMap.get(turnId);
    if (t === undefined) {
      t = { turnId, userParts: [], tools: [], assistantParts: [] };
      turnMap.set(turnId, t);
      turnOrder.push(turnId);
    }
    return t;
  };

  for (const entry of view.entries) {
    if (entry.kind === "user") {
      const t = ensureTurn(entry.turnId);
      const text = userEntryText(entry);
      if (text.trim() !== "") t.userParts.push(text);
    } else if (entry.kind === "tool") {
      const t = ensureTurn(entry.turnId);
      t.tools.push(summarizeToolEntry(entry));
    } else if (entry.kind === "assistant") {
      const t = ensureTurn(entry.turnId);
      if (entry.text.trim() !== "") t.assistantParts.push(entry.text);
    }
  }

  for (const liveTool of view.live.tools) {
    if (liveTool.turnId !== undefined) {
      const t = ensureTurn(liveTool.turnId);
      t.tools.push(`[${liveTool.name}] running`);
    }
  }
  for (const liveAsst of view.live.assistants) {
    if (liveAsst.turnId !== undefined && liveAsst.text.trim() !== "") {
      const t = ensureTurn(liveAsst.turnId);
      t.assistantParts.push(liveAsst.text);
    }
  }

  return turnOrder.map((turnId, idx) => {
    const t = turnMap.get(turnId) ?? { turnId, userParts: [], tools: [], assistantParts: [] };
    const isCurrent = view.currentTurn?.turnId === turnId;
    const isLast = idx === turnOrder.length - 1;
    let status: FoldedTurn["status"] = "completed";
    let error: string | undefined;
    if (isCurrent) {
      status = "running";
    } else if (isLast && view.lastTurn !== undefined) {
      if (view.lastTurn.reason === "error") {
        status = "failed";
        error = "turn failed";
      } else if (view.lastTurn.reason === "aborted") {
        status = "cancelled";
      }
    }
    return {
      turnId,
      status,
      userText: t.userParts.join("\n"),
      tools: t.tools,
      assistantText: t.assistantParts.join("\n\n"),
      ...(error !== undefined ? { error } : {}),
    };
  });
}

/**
 * 按字节上限截断任意文本输出（超过 64 KB 时截断并附加明确说明）。
 */
export function truncateMcpOutput(text: string, maxBytes = MAX_MCP_OUTPUT_BYTES): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return text;
  const notice = "\n\n[输出已超过 64 KB 上限，已截断较早或超长内容]";
  const noticeBytes = Buffer.byteLength(notice, "utf8");
  const budget = Math.max(0, maxBytes - noticeBytes);
  let end = budget;
  while (end > 0 && ((buf[end] ?? 0) & 0b1100_0000) === 0b1000_0000) {
    end--;
  }
  return buf.subarray(0, end).toString("utf8") + notice;
}

export interface ReadSessionFormatOptions {
  sessionId?: string | undefined;
  lastTurns?: number | undefined;
  turns?: number | undefined;
  pendingCount?: number | undefined;
  paused?: boolean | undefined;
  maxBytes?: number | undefined;
}

/**
 * 生成 `nocturne_read_session` 的折叠输出文本，遵守 `turns`（缺省 3）与 64 KB 上限。
 */
export function formatReadSessionOutput(
  view: SessionView,
  options?: ReadSessionFormatOptions,
): string {
  const lastTurns = Math.max(1, options?.turns ?? options?.lastTurns ?? 3);
  const maxBytes = options?.maxBytes ?? MAX_MCP_OUTPUT_BYTES;
  const pendingCount = options?.pendingCount ?? 0;
  const paused = options?.paused ?? false;

  const allTurns = extractFoldedTurns(view);
  const selected = allTurns.slice(-lastTurns);
  const status = deriveMcpSessionStatus(view, pendingCount, paused);

  const pendingPerms = allPendingPermissions(view);
  const buildPayload = (turns: FoldedTurn[], truncatedNote?: string) => ({
    ...(options?.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
    title: view.title,
    cwd: view.meta?.cwd,
    workspaceRoot: view.meta?.workspaceRoot,
    status,
    turnCount: view.turnCount,
    totalTurnsInView: allTurns.length,
    returnedTurns: turns.length,
    ...(pendingPerms.length > 0
      ? {
          pendingPermissions: pendingPerms.map((item) =>
            item.kind === "subagent"
              ? {
                  requestId: item.permission.requestId,
                  childSessionId: item.permission.childSessionId,
                  toolName: item.permission.toolName,
                  reason: item.permission.reason,
                  subjects: item.permission.subjects,
                }
              : {
                  requestId: item.permission.requestId,
                  toolName: item.permission.toolName,
                  reason: item.permission.reason,
                  subjects: item.permission.subjects,
                },
          ),
        }
      : {}),
    ...(view.pendingQuestion !== undefined
      ? {
          pendingQuestion: {
            requestId: view.pendingQuestion.requestId,
            questions: view.pendingQuestion.questions.map((q) => q.question),
          },
        }
      : {}),
    turns,
    ...(truncatedNote !== undefined ? { note: truncatedNote } : {}),
  });

  const currentTurns = [...selected];
  let json = JSON.stringify(buildPayload(currentTurns), null, 2);
  if (Buffer.byteLength(json, "utf8") <= maxBytes) {
    return json;
  }

  const truncationMsg = "输出超过 64 KB 上限，已截断较早轮次或超长内容";
  while (currentTurns.length > 1) {
    currentTurns.shift();
    json = JSON.stringify(buildPayload(currentTurns, truncationMsg), null, 2);
    if (Buffer.byteLength(json, "utf8") <= maxBytes) {
      return json;
    }
  }

  return truncateMcpOutput(json, maxBytes);
}
