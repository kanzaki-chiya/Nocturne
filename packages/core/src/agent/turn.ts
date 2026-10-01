/**
 * runTurn（agent-loop.md 第 2 节）。
 * 核心不变量：
 * - finish 是 Turn 的唯一出口；出口前结算所有未完成的工具调用
 * - 每个 message.assistant.toolCalls 中的 callId 恰好一个 tool.completed
 * - 持久化失败（session_failed）：立即停止，不再尝试写入（3.6）
 */
import { randomUUID } from "node:crypto";

import {
  attachmentsToLoad,
  buildContext,
  buildSummaryRequest,
  runSummaryCall,
  type CompactionPlan,
} from "../context/index.js";
import {
  clampReasoningEffort,
  isProviderError,
  type ModelRequest,
  type ProviderError,
} from "../provider/index.js";
import type {
  ContentBlock,
  FileRef,
  FinishReason,
  ImageAttachment,
  PermissionReviewedPayload,
  RuntimeStatus,
  TurnEndReason,
  Usage,
} from "../protocol/index.js";
import { SessionError } from "../session/index.js";
import { createExecutionScope, type ExecutionScope } from "../tools/index.js";
import { consumeStream, EmptyResponseError, type StreamAccumulation } from "./stream.js";
import type { TurnDeps } from "./types.js";

function isPersistenceFailure(e: unknown): boolean {
  return e instanceof SessionError && (e.code === "session_failed" || e.code === "session_closed");
}

/**
 * Provider 请求失败的用户可读提示（provider-setup.md 第 1 节）。
 * 向导不做连接测试：密钥/地址/模型 id 的校验推迟到首次真实请求，
 * 这里按 ProviderError.kind 翻译为补救命令。CLI 与 TUI 都渲染
 * turn.completed.error.message，翻译只在这里做一份。
 */
export function providerFailureHint(
  e: ProviderError,
  providerId: string,
  sent?: { reasoningEffort?: string | undefined },
): string {
  switch (e.kind) {
    case "auth":
      return `密钥可能无效：${e.message}（可用 /provider key ${providerId} 更新密钥）`;
    case "network":
    case "timeout":
      return `服务地址不通：${e.message}（可运行 nctrn setup 检查或更新服务商配置）`;
    case "invalid_request":
      // ADR-0018 第 5 节：请求带思考参数时的 400 给档位定向提示
      // （档位声明与实际服务可能不一致——用户声明是声明方的判断）
      if (sent?.reasoningEffort !== undefined) {
        return (
          `该模型可能不支持档位 ${sent.reasoningEffort}：` +
          `${e.message}（可用 /provider thinking ${providerId} 或配置文件调整；` +
          `/effort off 关闭思考后再试）`
        );
      }
      return `模型 id 或地址路径可能有误：${e.message}（可运行 nctrn setup 检查配置，或用 /model 切换模型）`;
    default:
      return e.message;
  }
}

function aborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

export async function runTurn(
  deps: TurnDeps,
  content: ContentBlock[],
  attachments?: ImageAttachment[],
  fileRefs?: FileRef[],
): Promise<TurnEndReason | "failed"> {
  const { session, signal, config } = deps;
  const counters = { message: 0, call: 0 };
  // turnIndex 由日志推导（恢复后继续递增）；turnId 编号与之一致，
  // 避免恢复后 turnId 重新从 1 开始造成的误导（唯一性由随机后缀保证）
  const turnIndex = session.durableEvents().filter((e) => e.type === "turn.started").length + 1;
  const id = (kind: "message" | "call") =>
    deps.newId !== undefined
      ? deps.newId(kind)
      : `${kind}-${++counters[kind]}-${randomUUID().slice(0, 8)}`;

  const turnId =
    deps.newId !== undefined ? deps.newId("turn") : `turn-${turnIndex}-${randomUUID().slice(0, 8)}`;
  // ADR-0023：sha256 → base64 的 Turn 内缓存，避免每个 Step 重复读盘/编码；
  // 加载失败记 null，本 Turn 内不再重试；每请求最多 20 张，无需另设上限
  const imageCache = new Map<string, string | null>();
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
    // TurnEnd Hook（hooks.md）：仅通知，无效果；失败已在 runner 内降级
    await deps.execEnv.hooks
      ?.run("TurnEnd", { turnId, reason, steps, usage: { ...turnUsage } })
      .catch(() => undefined);
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
    if (acc.content.length === 0 && acc.toolCalls.length === 0) return;
    await session.emit(
      "message.assistant",
      {
        messageId,
        model: deps.model.model.ref,
        // ADR-0026 §6：记录产生本条消息的生效协议；无协议的 Provider 不写
        ...(deps.model.model.protocol !== undefined ? { protocol: deps.model.model.protocol } : {}),
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
        emit: async (type, payload, options) => {
          await session.emit(type, payload, options ?? {});
          if (type === "permission.reviewed")
            addUsage((payload as PermissionReviewedPayload).usage);
        },
        emitEphemeral: (type, payload, options) => {
          session.emitEphemeral(type, payload, options ?? {});
        },
      },
      // ADR-0035 §5：每次调用按当时模型的编辑工具能力筛选——
      // 模型切换后下一次调用即生效
      editTool: deps.model.model.capabilities.editTool,
    });
  }

  // context.md 6.5：每类压缩每个 Turn 至多一次（成功或失败均不重复）
  let pruneAttempted = false;
  let summaryAttempted = false;
  let forceCompaction = false;
  /** 最近一次请求实际携带的思考档位（invalid_request 定向提示用） */
  let sentEffort: string | undefined;
  // 思考档位快照（ADR-0018 §3）：Turn 开始时对会话意图按模型可用集合
  // 就近降档一次并固定，本 Turn 内所有模型请求一致使用。Turn 中途的
  // 档位变更只写持久化配置（session.config_changed），不影响本 Turn
  // 请求，下一 Turn 生效——同一助手回合（含工具循环）内切换思考模式
  // 违反 Anthropic 对 thinking 的单一模式约束（off→启用会被拒）。
  const turnEffort = clampReasoningEffort(
    session.state().config.reasoningEffort,
    deps.model.model.capabilities.reasoningEffort,
  );

  /**
   * 执行一次 L2 摘要计划：成功写 context.compacted(kind="summary") 并返回 true；
   * 失败或中断不写任何压缩事件（context.md 6.6），返回 false。
   */
  async function runSummaryPlan(plan: CompactionPlan): Promise<boolean> {
    const request: ModelRequest = {
      ...(plan.summaryRequest ??
        buildSummaryRequest({
          history: session.state().history,
          model: deps.model.model,
          throughSeq: plan.throughSeq,
        })),
      // ADR-0031 §3：摘要请求同属本会话，同样携带会话 ID
      sessionId: deps.rootSessionId ?? session.id,
    };
    let summary: string;
    try {
      summary = await runSummaryCall(
        deps.model,
        request,
        signal,
        config.firstEventTimeoutMs,
        config.idleTimeoutMs,
      );
    } catch {
      return false;
    }
    if (aborted(signal)) return false;
    await session.emit(
      "context.compacted",
      { kind: "summary", throughSeq: plan.throughSeq, summary },
      { turnId },
    );
    return true;
  }

  try {
    // ── 开始 ──
    await session.emit("turn.started", { turnIndex }, { turnId });
    await session.emit(
      "message.user",
      {
        messageId: id("message"),
        content,
        ...(attachments?.length ? { attachments } : {}),
        ...(fileRefs?.length ? { fileRefs } : {}),
      },
      { turnId },
    );

    // TurnStart Hook（hooks.md 第 1 节）：block → Turn 以 error(hook_blocked) 结算
    const startHook = await deps.execEnv.hooks
      ?.run(
        "TurnStart",
        {
          turnId,
          text: content
            .filter((b): b is { type: "text"; text: string } => b.type === "text")
            .map((b) => b.text)
            .join("\n"),
        },
        signal,
      )
      .catch(() => undefined);
    if (startHook?.block === true) {
      return await finish("error", {
        code: "hook_blocked",
        message: startHook.reason ?? "TurnStart Hook 拦截",
      });
    }

    // ── Step 循环 ──
    for (;;) {
      if (aborted(signal)) return await finish("aborted");
      // 3.8：maxSteps 未配置时不限步数——不会因步数上限结束；正常由模型
      // stop 或用户中断收尾，其他失败/拒绝出口遵循原有规则
      if (config.maxSteps !== undefined && steps >= config.maxSteps) {
        return await finish("max_steps");
      }
      steps += 1;

      // 1. 构建上下文（纯计算）
      status("thinking");
      const state = session.state();
      // ADR-0023：把将进入请求的图片附件引用经 AttachmentStore 读为
      // base64 交给 Builder（Loop 做 I/O，Builder 纯计算）。store 缺失
      // 视同全部缺失（attachmentData 为空 Map → 缺失占位 + 诊断）。
      const imageRefs = attachmentsToLoad(state.history, deps.model.model, session.durableEvents());
      let attachmentData: ReadonlyMap<string, string> | undefined;
      if (imageRefs.length > 0) {
        const store = deps.execEnv.attachments;
        const data = new Map<string, string>();
        for (const ref of imageRefs) {
          let b64 = imageCache.get(ref.sha256);
          if (b64 === undefined) {
            const bytes = store !== undefined ? await store.load(ref) : undefined;
            b64 = bytes === undefined ? null : Buffer.from(bytes).toString("base64");
            imageCache.set(ref.sha256, b64);
          }
          if (b64 !== null) data.set(ref.sha256, b64);
        }
        attachmentData = data;
      }
      const built = buildContext({
        history: state.history,
        todos: state.todos,
        model: deps.model.model,
        tools: deps.tools.specs(deps.model.model.capabilities.editTool),
        instructions: deps.instructions,
        environment: deps.environment,
        events: session.durableEvents(),
        compactionThreshold: deps.compactionThreshold,
        compactionState: { pruneAttempted, summaryAttempted, force: forceCompaction },
        ...(deps.basePrompt !== undefined ? { basePrompt: deps.basePrompt } : {}),
        ...(attachmentData !== undefined ? { attachmentData } : {}),
      });
      if (built.missingAttachments !== undefined) {
        for (const att of built.missingAttachments) {
          deps.execEnv.diagnostics?.record("context.attachment_missing", {
            turnId,
            file: att.file,
            sha256: att.sha256,
          });
        }
      }
      deps.execEnv.diagnostics?.record("context.build", {
        turnId,
        sections: built.report.sections.map((s) => ({
          name: s.name,
          chars: s.chars,
          estimatedTokens: s.estimatedTokens,
          truncated: s.truncated,
        })),
        totalChars: built.report.totalChars,
        estimatedTokens: built.report.estimatedTokens,
        budgetTokens: built.report.budgetTokens,
        overBudget: built.overBudget,
        compaction: built.compaction?.kind,
      });
      // 6.5：执行压缩计划——L1 修剪 / L2 摘要各至多一次；
      // 预防性压缩失败降级为未压缩继续，必须压缩失败走 6.6 报错
      const plan = built.compaction;
      if (plan?.kind === "prune" && !pruneAttempted) {
        pruneAttempted = true;
        forceCompaction = false;
        status("compacting");
        await session.emit(
          "context.compacted",
          { kind: "prune", throughSeq: plan.throughSeq },
          { turnId },
        );
        continue;
      }
      if (plan?.kind === "summary" && !summaryAttempted) {
        summaryAttempted = true;
        status("compacting");
        const ok = await runSummaryPlan(plan);
        if (aborted(signal)) return await finish("aborted");
        if (ok) {
          forceCompaction = false;
          continue;
        }
        if (!built.mustCompact) {
          session.emitEphemeral(
            "runtime.warning",
            {
              code: "compaction_failed",
              message: "预防性摘要压缩失败，按未压缩历史继续",
            },
            { turnId },
          );
        } else {
          return await finish("error", {
            code: "compaction_failed",
            message:
              `上下文超出预算（估算 ${built.report.estimatedTokens} / 预算 ${built.report.budgetTokens} token）` +
              `且摘要压缩失败；请使用 /compact 压缩或切换到更大窗口的模型`,
          });
        }
      }
      if (built.overBudget || built.mustCompact) {
        // 6.6：必须压缩却没有可行路径 → 明确报错，不静默截断
        return await finish("error", {
          code: "compaction_failed",
          message: `上下文超出预算（估算 ${built.report.estimatedTokens} / 预算 ${built.report.budgetTokens} token）；请使用 /compact 压缩或切换到更大窗口的模型`,
        });
      }

      // 2. 调用模型并消费流（toolChoice 注入点：subagent.md 第 2 节兜底轮）
      const messageId = id("message");
      // 思考档位（ADR-0018）：使用 Turn 开始时快照的 turnEffort，本 Turn
      // 内请求档位固定不变；off / 无可用档 → 不携带（适配器 omit）。
      // 强制 toolChoice 轮（子代理 finish 兜底轮）Runtime 不携带档位，
      // 整轮关闭思考——适配器层 toolChoice+档位共存时丢弃 toolChoice，
      // 故此处先行规避。
      const effort = deps.toolChoice === undefined ? turnEffort : undefined;
      sentEffort = effort;
      const request = {
        ...built.request,
        // ADR-0031 §3：Runtime 为每个模型请求填会话 ID（子代理填根会话 ID）
        sessionId: deps.rootSessionId ?? session.id,
        ...(effort !== undefined ? { reasoningEffort: effort } : {}),
        ...(deps.toolChoice !== undefined ? { toolChoice: deps.toolChoice } : {}),
      };
      const outcome = await consumeStream(deps, request, turnId, messageId, nextCallId);

      if (outcome.kind === "aborted") {
        await emitAssistant(outcome.acc, messageId, "aborted");
        return await finish("aborted");
      }
      if (outcome.kind === "failed") {
        await emitAssistant(outcome.acc, messageId, "aborted");
        const e = outcome.error;
        // 6.5：Provider 报告 context_overflow → 逐档升级：
        // 先 L1 修剪（有新边界时），否则 L2 摘要；都不可用才按 6.6 结束
        if (isProviderError(e) && e.kind === "context_overflow") {
          if (!pruneAttempted || !summaryAttempted) {
            forceCompaction = true;
            continue;
          }
          return await finish("error", {
            code: "compaction_failed",
            message: `Provider 报告上下文溢出且无可行压缩路径：${e.message}；请使用 /compact 或切换更大窗口的模型`,
          });
        }
        return await finish("error", {
          code:
            e instanceof EmptyResponseError
              ? "provider_empty_response"
              : isProviderError(e)
                ? `provider_${e.kind}`
                : "provider_error",
          message: isProviderError(e)
            ? providerFailureHint(e, deps.model.model.ref.provider, {
                reasoningEffort: sentEffort,
              })
            : e instanceof Error
              ? e.message
              : String(e),
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
        // 注入的结束谓词（subagent.md 第 2 节）：调用方判定 Turn 已完成，
        // 正常 done 收尾——Agent Loop 不读工具名
        if (deps.shouldFinish?.(session.state()) === true) {
          return await finish("done");
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
