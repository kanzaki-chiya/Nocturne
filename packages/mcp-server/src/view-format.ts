import { userEntryText, type SessionView, type ToolEntry } from "@nocturne/core/protocol";

export const MAX_MCP_OUTPUT_BYTES = 64 * 1024;

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

/**
 * 推导会话面向外部 agent 的状态（ADR-0074 §4）：
 * `idle` / `running` / `waiting_for_permission` / `waiting_for_answer` / `paused` / `error`
 */
export function deriveMcpSessionStatus(
  view: SessionView,
  pendingCount = 0,
  paused = false,
): McpSessionStatus {
  if (view.pendingPermission !== undefined) return "waiting_for_permission";
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

  const buildPayload = (turns: FoldedTurn[], truncatedNote?: string) => ({
    ...(options?.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
    title: view.title,
    cwd: view.meta?.cwd,
    workspaceRoot: view.meta?.workspaceRoot,
    status,
    turnCount: view.turnCount,
    totalTurnsInView: allTurns.length,
    returnedTurns: turns.length,
    ...(view.pendingPermission !== undefined
      ? {
          pendingPermissions: [
            {
              requestId: view.pendingPermission.requestId,
              toolName: view.pendingPermission.toolName,
              reason: view.pendingPermission.reason,
              subjects: view.pendingPermission.subjects,
            },
          ],
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
