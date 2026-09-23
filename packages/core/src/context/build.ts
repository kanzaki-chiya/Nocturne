/**
 * Context Builder（context.md）：从会话历史组装一个装得进窗口的 ModelRequest。
 * 组装顺序（稳定前缀在前）：基础系统提示 → 工具规格 → 项目指令 → 环境信息 → 历史。
 * Phase 1 不做压缩：overBudget 时由调用方明确报错（context.md 6.7）。
 */
import type { ContentBlock, HistoryEntry } from "../protocol/index.js";
import type { ModelMessage, ModelRequest, SystemBlock } from "../provider/index.js";
import type { BuildContextInput, BuiltContext, ContextSection } from "./types.js";

/** 单字符估算 token（context.md 第 5 节：字符数 / 4） */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/** 输出预留上限：取 min(model.maxOutputTokens, 此值) */
const OUTPUT_RESERVE_CAP = 16_000;
/** 安全余量（token） */
const SAFETY_MARGIN = 1_024;
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

function historyToMessages(
  history: readonly HistoryEntry[],
  currentModelProvider: string,
): { messages: ModelMessage[]; chars: number; entries: number } {
  const messages: ModelMessage[] = [];
  let chars = 0;

  for (const entry of history) {
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
        chars += entry.modelContent.length;
        messages.push({
          role: "tool",
          callId: entry.callId,
          name: entry.name,
          content: entry.modelContent,
          isError: entry.status !== "ok",
        });
        break;
      }
      case "compaction": {
        // Phase 1 不产生压缩事件；加载到历史日志时把摘要作为历史首条信息呈现
        if (entry.compactKind === "summary" && entry.summary !== undefined) {
          const text = `[会话历史摘要]\n${entry.summary}`;
          chars += text.length;
          messages.push({
            role: "user",
            content: [{ type: "text", text }],
          });
        }
        break;
      }
    }
  }
  return { messages, chars, entries: history.length };
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
  const outputReserve = Math.min(model.maxOutputTokens, OUTPUT_RESERVE_CAP);
  const budgetTokens = Math.max(0, model.contextWindow - outputReserve - SAFETY_MARGIN);
  const totalChars = sections.reduce((a, s) => a + s.chars, 0);
  const estimated = sections.reduce((a, s) => a + s.estimatedTokens, 0);
  const overBudget = estimated > budgetTokens;

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
    // Phase 1 无压缩：超预算即无法发出请求
    mustCompact: overBudget,
  };
}
