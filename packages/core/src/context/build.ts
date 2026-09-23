/**
 * Context Builder（context.md）：从会话历史组装一个装得进窗口的 ModelRequest。
 * 组装顺序（稳定前缀在前）：基础系统提示 → 工具规格 → 项目指令 → 环境信息 → 历史。
 * Phase 2：应用压缩边界（6.4），并在估算超过阈值时给出 L1 修剪计划（6.5）。
 */
import type { ContentBlock, DurableEvent, HistoryEntry } from "../protocol/index.js";
import type { ModelInfo, ModelMessage, ModelRequest, SystemBlock } from "../provider/index.js";
import type { BuildContextInput, BuiltContext, CompactionPlan, ContextSection } from "./types.js";

/** 单字符估算 token（context.md 第 5 节：字符数 / 4） */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/** 输出预留上限：取 min(model.maxOutputTokens, 此值) */
const OUTPUT_RESERVE_CAP = 16_000;
/** 安全余量（token） */
const SAFETY_MARGIN = 1_024;
/** 预防性修剪阈值：估算超过预算的该比例时给出 prune 计划（context.md 6.5 默认 80%） */
const PRUNE_THRESHOLD = 0.8;

/** 本次请求的可用输入预算（context.md 第 5 节） */
export function inputBudgetTokens(
  model: Pick<ModelInfo, "contextWindow" | "maxOutputTokens">,
  maxOutputOverride?: number,
): number {
  const outputReserve = Math.min(maxOutputOverride ?? model.maxOutputTokens, OUTPUT_RESERVE_CAP);
  return Math.max(0, model.contextWindow - outputReserve - SAFETY_MARGIN);
}
/** 单个指令文件的字符上限 */
export const INSTRUCTION_FILE_MAX_CHARS = 32_000;

const BASE_SYSTEM_PROMPT = `You are Nocturne, an open-source coding agent runtime.
You help the user with software engineering tasks inside the workspace.
Use the provided tools to read and search files. Only operate inside the workspace.
Answer concisely and accurately.`;

function instructionText(
  files: { source: string; content: string; truncated?: boolean | undefined }[],
): string {
  return files
    .map((f) => {
      const body =
        f.truncated === true
          ? `${f.content}\n…[该文件超过 ${INSTRUCTION_FILE_MAX_CHARS} 字符，已截断]`
          : f.content;
      return `# ${f.source}\n\n${body}`;
    })
    .join("\n\n");
}

function environmentText(input: BuildContextInput): string {
  const e = input.environment;
  const lines = [
    `OS: ${e.os}`,
    ...(e.shell !== undefined ? [`Shell: ${e.shell}`] : []),
    `Working directory: ${e.cwd}`,
    `Workspace root: ${e.workspaceRoot}`,
    `Session date: ${e.sessionDate}`,
  ];
  return lines.join("\n");
}

function blockChars(blocks: readonly ContentBlock[]): number {
  let n = 0;
  for (const b of blocks) {
    n += b.text.length;
  }
  return n;
}

/**
 * 全部已闭合步骤边界的 seq（context.md 6.3）：turn.completed，
 * 或某条 message.assistant 的全部工具调用都结算后的最后一个 tool.completed。
 * 只依赖持久化事件类型，纯函数。
 */
export function closedBoundaries(events: readonly DurableEvent[]): number[] {
  const unsettled = new Set<string>();
  const out: number[] = [];
  for (const e of events) {
    switch (e.type) {
      case "message.assistant": {
        for (const c of e.payload.toolCalls) unsettled.add(c.callId);
        break;
      }
      case "tool.completed": {
        unsettled.delete(e.payload.callId);
        if (unsettled.size === 0) out.push(e.seq);
        break;
      }
      case "turn.completed": {
        out.push(e.seq);
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** 最近一个闭合步骤边界的 seq；没有任何闭合边界时返回 undefined */
export function lastClosedBoundary(events: readonly DurableEvent[]): number | undefined {
  return closedBoundaries(events).at(-1);
}

/**
 * 6.4 压缩边界：最新摘要的 throughSeq（seq ≤ 它的条目被摘要覆盖）、
 * 以及最新摘要之后最大的修剪截止（seq ≤ 它的工具结果显示为占位说明）。
 * 不递增的压缩事件视为不变量被破坏——忽略（context.md 6.4）。
 */
export function compactionCutoffs(history: readonly HistoryEntry[]): {
  summaryThrough: number;
  pruneThrough: number;
} {
  let summaryThrough = 0;
  let summarySeq = 0;
  let pruneThrough = 0;
  for (const e of history) {
    if (e.kind !== "compaction") continue;
    if (e.compactKind === "summary") {
      if (e.throughSeq > summaryThrough) {
        summaryThrough = e.throughSeq;
        summarySeq = e.seq;
        // 新摘要生效后，更早的修剪不再适用（修剪只作用于最新摘要之后）
        pruneThrough = 0;
      }
    } else if (e.seq > summarySeq) {
      pruneThrough = Math.max(pruneThrough, e.throughSeq);
    }
  }
  return { summaryThrough, pruneThrough };
}

/** L1 修剪后工具结果的占位说明（context.md 6.5：保留工具名与参数摘要） */
function prunedPlaceholder(entry: Extract<HistoryEntry, { kind: "tool" }>): string {
  const args = entry.inputSummary !== undefined ? `（${entry.inputSummary}）` : "";
  return `[输出已省略] 工具 ${entry.name}${args} 的结果已被 context.compacted 修剪`;
}

function historyToMessages(
  history: readonly HistoryEntry[],
  currentModelProvider: string,
): { messages: ModelMessage[]; chars: number; entries: number } {
  const messages: ModelMessage[] = [];
  let chars = 0;
  let entries = 0;
  const { summaryThrough, pruneThrough } = compactionCutoffs(history);

  for (const entry of history) {
    // 被最新摘要覆盖的历史（含更早的压缩事件）不再进入上下文
    if (entry.seq <= summaryThrough) continue;
    entries += 1;
    switch (entry.kind) {
      case "user": {
        chars += blockChars(entry.content);
        messages.push({ role: "user", content: entry.content });
        break;
      }
      case "assistant": {
        // context.md 第 7 节：含 Provider 专有数据的推理块只回传同一 Provider
        const content =
          entry.model.provider === currentModelProvider
            ? entry.content
            : entry.content.filter(
                (b) => !(b.type === "reasoning" && b.providerData !== undefined),
              );
        chars += blockChars(content) + JSON.stringify(entry.toolCalls).length;
        messages.push({
          role: "assistant",
          content,
          toolCalls: entry.toolCalls,
        });
        break;
      }
      case "tool": {
        const content = entry.seq <= pruneThrough ? prunedPlaceholder(entry) : entry.modelContent;
        chars += content.length;
        messages.push({
          role: "tool",
          callId: entry.callId,
          name: entry.name,
          content,
          isError: entry.status !== "ok",
        });
        break;
      }
      case "compaction": {
        if (entry.compactKind === "summary" && entry.summary !== undefined) {
          const text = `[会话历史摘要]\n${entry.summary}`;
          chars += text.length;
          messages.push({
            role: "user",
            content: [{ type: "text", text }],
          });
        }
        // prune 事件不产生消息，只改变其上界之前工具结果的呈现
        break;
      }
    }
  }
  return { messages, chars, entries };
}

/**
 * 把有效历史渲染为纯文本转录（供 L2 摘要请求使用）。
 * 与 historyToMessages 走同一套 6.4 规则。
 */
export function renderTranscript(history: readonly HistoryEntry[], provider: string): string {
  const { messages } = historyToMessages(history, provider);
  const lines: string[] = [];
  const blocksText = (blocks: readonly ContentBlock[]) => blocks.map((b) => b.text).join("\n");
  for (const m of messages) {
    if (m.role === "user") {
      lines.push(`[user]\n${blocksText(m.content)}`);
    } else if (m.role === "assistant") {
      const parts = [blocksText(m.content)];
      for (const c of m.toolCalls) {
        parts.push(`调用工具 ${c.name}(${JSON.stringify(c.input ?? {})})`);
      }
      lines.push(`[assistant]\n${parts.filter((p) => p.length > 0).join("\n")}`);
    } else {
      lines.push(`[tool ${m.name}${m.isError ? " error" : ""}] ${m.content}`);
    }
  }
  return lines.join("\n\n");
}

export function buildContext(input: BuildContextInput): BuiltContext {
  const { model } = input;

  // 1. 基础系统提示
  const system: SystemBlock[] = [{ text: BASE_SYSTEM_PROMPT }];
  const sections: ContextSection[] = [
    {
      name: "system",
      source: "nocturne base prompt",
      chars: BASE_SYSTEM_PROMPT.length,
      estimatedTokens: estimateTokens(BASE_SYSTEM_PROMPT.length),
    },
  ];

  // 2. 工具规格（结构化字段，不计入 system 文本，但计入预算与报告）
  const toolsJson = JSON.stringify(input.tools);
  sections.push({
    name: "tools",
    source: `${input.tools.length} tools`,
    chars: toolsJson.length,
    estimatedTokens: estimateTokens(toolsJson.length),
  });

  // 3. 项目指令（用户级 + 各级目录）
  const instrFiles = [
    ...(input.instructions.user !== undefined ? [input.instructions.user] : []),
    ...input.instructions.project,
  ];
  if (instrFiles.length > 0) {
    const text = instructionText(instrFiles);
    system.push({ text });
    sections.push({
      name: "instructions",
      source: instrFiles.map((f) => f.source).join(", "),
      chars: text.length,
      estimatedTokens: estimateTokens(text.length),
      truncated: instrFiles.some((f) => f.truncated === true) || undefined,
    });
  }

  // 4. 环境信息
  const envText = environmentText(input);
  system.push({ text: envText });
  sections.push({
    name: "environment",
    source: input.environment.cwd,
    chars: envText.length,
    estimatedTokens: estimateTokens(envText.length),
  });

  // 5. 历史
  const {
    messages,
    chars: historyChars,
    entries,
  } = historyToMessages(input.history, model.ref.provider);
  for (const m of input.pendingMessages ?? []) {
    messages.push(m);
  }
  const pendingChars = (input.pendingMessages ?? [])
    .map((m) => {
      if (m.role === "tool") return m.content.length;
      return blockChars(m.content);
    })
    .reduce((a, b) => a + b, 0);
  sections.push({
    name: "history",
    source: `${entries} entries`,
    chars: historyChars + pendingChars,
    estimatedTokens: estimateTokens(historyChars + pendingChars),
  });

  // 预算（context.md 第 5 节）
  const budgetTokens = inputBudgetTokens(model);
  const totalChars = sections.reduce((a, s) => a + s.chars, 0);
  const estimated = sections.reduce((a, s) => a + s.estimatedTokens, 0);
  const overBudget = estimated > budgetTokens;

  // 6.5：估算超过阈值（或已超预算）且存在新的闭合边界 → 给出 L1 修剪计划
  const { summaryThrough, pruneThrough } = compactionCutoffs(input.history);
  const boundary = input.events !== undefined ? lastClosedBoundary(input.events) : undefined;
  let compaction: CompactionPlan | undefined;
  if (
    boundary !== undefined &&
    boundary > Math.max(summaryThrough, pruneThrough) &&
    estimated > PRUNE_THRESHOLD * budgetTokens
  ) {
    compaction = { kind: "prune", throughSeq: boundary };
  }

  const request: ModelRequest = {
    model: model.ref.model,
    system,
    messages,
    tools: input.tools,
    maxOutputTokens: model.maxOutputTokens,
    // 可缓存前缀：全部 system 块（base + 指令 + 环境），messages 不计
    cachePrefix: { systemBlocks: system.length, messages: 0 },
  };

  return {
    request,
    report: {
      sections,
      totalChars,
      estimatedTokens: estimated,
      budgetTokens,
    },
    overBudget,
    // 调用方先执行 compaction（若有），执行后重建；无计划可用且仍超预算
    // 才进入 6.6 的"必须压缩却失败"路径
    compaction,
    mustCompact: overBudget,
  };
}
