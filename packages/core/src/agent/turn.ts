/**
 * runTurn（agent-loop.md 第 2 节）。
 * 核心不变量：
 * - finish 是 Turn 的唯一出口；出口前结算所有未完成的工具调用
 * - 每个 message.assistant.toolCalls 中的 callId 恰好一个 tool.completed
 * - 持久化失败（session_failed）：立即停止，不再尝试写入（3.6）
 */
import { randomUUID } from "node:crypto";

import { buildContext } from "../context/index.js";
import { isProviderError } from "../provider/index.js";
import type {
  ContentBlock,
  FinishReason,
  RuntimeStatus,
  TurnEndReason,
  Usage,
} from "../protocol/index.js";
import { SessionError } from "../session/index.js";
import { createExecutionScope, type ExecutionScope } from "../tools/index.js";
import { consumeStream, type StreamAccumulation } from "./stream.js";
import type { TurnDeps } from "./types.js";

function isPersistenceFailure(e: unknown): boolean {
  return e instanceof SessionError && (e.code === "session_failed" || e.code === "session_closed");
}

function aborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

export async function runTurn(
  deps: TurnDeps,
  content: ContentBlock[],
): Promise<TurnEndReason | "failed"> {
  const { session, signal, config } = deps;
  const counters = { turn: 0, message: 0, call: 0 };
  const id = (kind: "turn" | "message" | "call") =>
    deps.newId !== undefined
      ? deps.newId(kind)
      : `${kind}-${++counters[kind]}-${randomUUID().slice(0, 8)}`;

  const turnId = id("turn");
  const turnUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  };
  let steps = 0;
  let callSeq = 0;
  const nextCallId = () => `${turnId}-call-${++callSeq}`;

  const status = (s: RuntimeStatus) => {
    session.emitEphemeral("runtime.status", { status: s }, { turnId });
  };

  const addUsage = (u: Usage | undefined) => {
    if (u === undefined) return;
    turnUsage.inputTokens += u.inputTokens;
    turnUsage.outputTokens += u.outputTokens;
    turnUsage.cacheReadTokens += u.cacheReadTokens ?? 0;
    turnUsage.cacheWriteTokens += u.cacheWriteTokens ?? 0;
    turnUsage.reasoningTokens += u.reasoningTokens ?? 0;
  };

  /** Turn 唯一出口：结算未完成调用 → turn.completed（持久化失败时直接返回） */
  async function finish(
    reason: TurnEndReason,
    error?: { code: string; message: string },
  ): Promise<TurnEndReason> {
    if (session.health !== "ok") return reason; // 3.6：无法再可靠写入
    // 结算本 Turn 中尚未 tool.completed 的调用
    for (const call of session.state().unsettledCalls.values()) {
      if (call.turnId !== turnId) continue;
      await session.emit(
        "tool.completed",
        {
          callId: call.callId,
          name: call.name,
          status: "cancelled",
          modelContent: `[调用未执行：Turn 以 ${reason} 结束]`,
          error: {
            code: reason === "aborted" ? "cancelled" : "turn_ended",
            message: `Turn 以 ${reason} 结束，调用被结算`,
          },
        },
        { turnId },
      );
    }
    await session.emit(
      "turn.completed",
      { reason, steps, usage: { ...turnUsage }, error },
      { turnId },
    );
    status("idle");
    await session.flush().catch(() => undefined);
    return reason;
  }

  /** 写入 assistant 消息（完整或中断时的部分内容） */
  async function emitAssistant(
    acc: StreamAccumulation,
    messageId: string,
    finishReason: FinishReason | "aborted",
  ): Promise<void> {
    addUsage(acc.usage);
    await session.emit(
      "message.assistant",
      {
        messageId,
        model: deps.model.model.ref,
        content: acc.content,
        toolCalls: acc.toolCalls,
        usage: acc.usage,
        finishReason,
      },
      { turnId },
    );
  }

  function executionScope(): ExecutionScope {
    const state = session.state();
    return createExecutionScope(deps.execEnv, {
      cwd: state.meta.cwd,
      workspaceRoot: state.meta.workspaceRoot,
      sessionId: session.id,
      turnId,
      signal,
      events: {
        emit: (type, payload, options) =>
          session.emit(type, payload, options ?? {}).then(() => undefined),
        emitEphemeral: (type, payload, options) => {
          session.emitEphemeral(type, payload, options ?? {});
        },
      },
    });
  }

  try {
    // ── 开始 ──
    const turnIndex = session.durableEvents().filter((e) => e.type === "turn.started").length + 1;
    await session.emit("turn.started", { turnIndex }, { turnId });
    await session.emit("message.user", { messageId: id("message"), content }, { turnId });

    // ── Step 循环 ──
    for (;;) {
      if (aborted(signal)) return await finish("aborted");
      if (steps >= config.maxSteps) return await finish("max_steps");
      steps += 1;

      // 1. 构建上下文（纯计算）
      status("thinking");
      const state = session.state();
      const built = buildContext({
        history: state.history,
        model: deps.model.model,
        tools: deps.tools.specs(),
        instructions: deps.instructions,
        environment: deps.environment,
      });
      if (built.overBudget || built.mustCompact) {
        // Phase 1 无压缩：明确报错，不静默截断（context.md 6.7）
        return await finish("error", {
          code: "context_overflow",
          message: `上下文超出预算（估算 ${built.report.estimatedTokens} / 预算 ${built.report.budgetTokens} token）`,
        });
      }

      // 2. 调用模型并消费流
      const messageId = id("message");
      const outcome = await consumeStream(deps, built.request, turnId, messageId, nextCallId);

      if (outcome.kind === "aborted") {
        await emitAssistant(outcome.acc, messageId, "aborted");
        return await finish("aborted");
      }
      if (outcome.kind === "failed") {
        await emitAssistant(outcome.acc, messageId, "aborted");
        const e = outcome.error;
        return await finish("error", {
          code: isProviderError(e) ? `provider_${e.kind}` : "provider_error",
          message: e instanceof Error ? e.message : String(e),
        });
      }

      // 3. emit message.assistant，按结束原因分流
      const reason = outcome.finishReason;
      await emitAssistant(outcome.acc, messageId, reason);

      if (reason === "length") return await finish("truncated");
      if (reason === "content_filter") return await finish("refused");
      if (reason === "other") {
        return await finish("error", {
          code: "unexpected_finish",
          message: "Provider 以意外原因结束",
        });
      }
      const toolCalls = outcome.acc.toolCalls;
      if (reason === "stop" && toolCalls.length === 0) {
        return await finish("done");
      }
      if (reason === "tool_calls" && toolCalls.length === 0) {
        return await finish("error", {
          code: "unexpected_finish",
          message: "Provider 报告 tool_calls 但未给出工具调用",
        });
      }
      // stop/tool_calls 且存在调用 → 按模型给出的顺序执行

      // 4. 执行工具
      for (const call of toolCalls) {
        if (aborted(signal)) break;
        status("running_tool");
        const execution = await deps.executor.execute(call, executionScope());
        if (execution.stopTurn) {
          return await finish("aborted");
        }
        status("thinking");
      }
      if (aborted(signal)) return await finish("aborted");
      // 回到循环顶部：工具结果已持久化，下一次 build 带给模型（3.1）
    }
  } catch (e) {
    if (isPersistenceFailure(e)) {
      // 3.6：会话进入 failed，立即停止，不再写入任何事件
      return "failed";
    }
    if (aborted(signal)) {
      try {
        return await finish("aborted");
      } catch (inner) {
        if (!isPersistenceFailure(inner)) throw inner;
        return "failed";
      }
    }
    // Runtime 内部错误：记录并结束 Turn，不把堆栈交给模型（3.4）
    try {
      session.emitEphemeral(
        "runtime.error",
        {
          code: "runtime_internal",
          message: e instanceof Error ? e.message : String(e),
        },
        { turnId },
      );
      return await finish("error", {
        code: "runtime_internal",
        message: e instanceof Error ? e.message : String(e),
      });
    } catch (inner) {
      if (!isPersistenceFailure(inner)) throw inner;
      return "failed";
    }
  }
}
