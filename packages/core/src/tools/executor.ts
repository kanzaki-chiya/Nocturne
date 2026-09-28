/**
 * 执行管线（tools.md 第 3 节）。九步：
 *   1 查找 → 2 校验 → 2.5 PreToolUse Hook → 2.6 输入预检 → 3 权限主体
 *   → 4 解析资源 → 5 权限 → 6 tool.started → 7 执行 → 7.5 PostToolUse
 *   → 8 归一化 → 9 tool.completed
 * 无论在哪一步结束，都恰好产生一个 tool.completed。
 */
import { Ajv, type ValidateFunction } from "ajv";

import type {
  ImageAttachment,
  PermissionSubject,
  SubjectRequest,
  ToolCallRef,
} from "../protocol/index.js";
import { applyBudget } from "./budget.js";
import { writeSpill } from "./spill.js";
import type {
  ExecutionScope,
  ToolDefinition,
  ToolExecution,
  ToolExecutor,
  ToolRegistry,
  ToolResult,
} from "./types.js";

const PATH_KINDS = new Set(["read", "edit"]);

const ajv = new Ajv({ allErrors: true, useDefaults: true, strict: false });
const validators = new WeakMap<ToolDefinition, ValidateFunction>();

function validatorFor(tool: ToolDefinition): ValidateFunction {
  let v = validators.get(tool);
  if (v === undefined) {
    v = ajv.compile(tool.inputSchema);
    validators.set(tool, v);
  }
  return v;
}

function errorResult(code: string, message: string): ToolResult {
  return { status: "error", modelContent: message, error: { code, message } };
}

/** 步骤 4：把未解析主体经 platform 解析为真实路径（路径类主体） */
async function resolveSubjects(
  requests: SubjectRequest[],
  scope: ExecutionScope,
): Promise<PermissionSubject[]> {
  const subjects: PermissionSubject[] = [];
  for (const req of requests) {
    if (PATH_KINDS.has(req.kind)) {
      const resolved = await scope.platform.resolveReal(req.target);
      subjects.push({ kind: req.kind, target: req.target, resolved });
    } else {
      subjects.push({
        kind: req.kind,
        target: req.target,
        shell: req.shell,
        shellRisk: req.shellRisk,
        shellRiskByDialect: req.shellRiskByDialect,
      });
    }
  }
  return subjects;
}

/** 读取中止状态：函数边界避免 TS 属性收窄把后续检查误判为恒假（信号是异步变化的） */
function aborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

export function createToolExecutor(registry: ToolRegistry): ToolExecutor {
  return {
    async execute(call: ToolCallRef, scope: ExecutionScope): Promise<ToolExecution> {
      const startedAt = Date.now();
      const { turnId } = scope;
      let stopTurn = false;
      // 结果附件的来源（ADR-0023）：找到工具后按其 origin 标记更新；
      // finish 闭包先于 tool 定义，不能反向收窄，故单独持有
      let attachmentSource: ImageAttachment["source"] = "read";

      /** 步骤 9：唯一出口——归一化 + 发出恰好一个 tool.completed */
      async function finish(
        status: ToolExecution["status"],
        result: ToolResult,
      ): Promise<ToolExecution> {
        const budget = applyBudget(result);
        // 超预算时把完整输出落盘到本会话附件目录（tools.md 第 4 节）；
        // 写盘失败降级为普通截断，并在 modelContent 里如实说明
        let spillPath: string | undefined;
        let modelContent = budget.result.modelContent;
        if (budget.truncated) {
          if (scope.attachmentsDir !== undefined) {
            try {
              spillPath = await writeSpill({
                fs: scope.platform.fs,
                paths: scope.platform.paths,
                attachmentsDir: scope.attachmentsDir,
                sessionId: scope.sessionId,
                callId: call.callId,
                content: result.modelContent,
              });
            } catch {
              spillPath = undefined;
            }
          }
          modelContent +=
            spillPath !== undefined
              ? `\n\n[完整输出已写入 ${spillPath}（本会话内可用 read 查看）]`
              : "\n\n[完整输出未保留：落盘不可用或写入失败]";
        }
        // 图片附件落盘（ADR-0023 第 2 节）：字节经 AttachmentStore 存入会话
        // 附件目录，tool.completed 只带 ImageAttachment 引用。单张失败不拖垮
        // 结果——成功的照常引用，失败的在 modelContent 末尾注明并记诊断
        let attachments: ImageAttachment[] | undefined;
        const attSpecs = result.attachments;
        if (attSpecs !== undefined && attSpecs.length > 0) {
          const source = attachmentSource;
          attachments = [];
          for (const att of attSpecs) {
            if (scope.attachments === undefined) {
              modelContent += "\n\n[图片附件保存失败：附件目录不可用]";
              scope.diagnostics?.record("tool.attachment_failed", {
                callId: call.callId,
                name: call.name,
                error: "附件目录不可用",
              });
              continue;
            }
            try {
              attachments.push(
                await scope.attachments.save({
                  data: att.data,
                  mimeType: att.mimeType,
                  source,
                  ...(att.label !== undefined ? { label: att.label } : {}),
                }),
              );
            } catch (e) {
              const why = e instanceof Error ? e.message : String(e);
              modelContent += `\n\n[图片附件保存失败：${why}]`;
              scope.diagnostics?.record("tool.attachment_failed", {
                callId: call.callId,
                name: call.name,
                error: why,
              });
            }
          }
          if (attachments.length === 0) attachments = undefined;
        }
        await scope.events.emit(
          "tool.completed",
          {
            callId: call.callId,
            name: call.name,
            status,
            modelContent,
            output: budget.result.output,
            error: budget.result.status === "error" ? budget.result.error : undefined,
            truncated: budget.truncated || undefined,
            spillPath,
            ...(attachments !== undefined ? { attachments } : {}),
            durationMs: Date.now() - startedAt,
          },
          { turnId },
        );
        return {
          status,
          result: { ...budget.result, modelContent },
          stopTurn,
        };
      }

      if (scope.signal.aborted) {
        return finish("cancelled", errorResult("cancelled", "调用已被中断"));
      }

      // 1. 查找
      const tool = registry.get(call.name);
      if (tool === undefined) {
        const names = registry
          .list()
          .map((t) => t.name)
          .join(", ");
        return finish(
          "error",
          errorResult("unknown_tool", `未知工具 "${call.name}"。可用工具：${names || "（无）"}`),
        );
      }
      attachmentSource = tool.origin === "mcp" ? "mcp" : "read";

      // 2. 校验并规范化输入
      if (call.input === undefined || call.input === null) {
        return finish(
          "error",
          errorResult(
            "invalid_input",
            `工具 "${call.name}" 的输入缺失或无法解析${call.rawInput !== undefined ? `：${call.rawInput.slice(0, 200)}` : ""}`,
          ),
        );
      }
      let input: unknown = structuredClone(call.input);
      if (!validatorFor(tool)(input)) {
        const detail = ajv.errorsText(validatorFor(tool).errors, {
          separator: "; ",
        });
        return finish(
          "error",
          errorResult("invalid_input", `工具 "${call.name}" 输入不符合 schema：${detail}`),
        );
      }

      // 2.5 PreToolUse Hook（hooks.md 第 4 节）：在输入校验之后、主体解析之前运行。
      // 只能收紧——无 allow；deny/ask 经权限层语义处理，updatedInput 重新校验。
      let hookAskReason: string | undefined;
      if (scope.hooks !== undefined) {
        const hookOut = await scope.hooks.run(
          "PreToolUse",
          { turnId, callId: call.callId, tool: call.name, input },
          scope.signal,
        );
        if (hookOut?.decision === "deny") {
          const reason = hookOut.reason ?? "PreToolUse Hook 拒绝";
          await scope.events.emit(
            "permission.resolved",
            {
              callId: call.callId,
              action: "deny",
              source: "hook",
              rule: "hook PreToolUse",
            },
            { turnId },
          );
          return finish("denied", errorResult("permission_denied", `Hook 拒绝：${reason}`));
        }
        if (hookOut?.updatedInput !== undefined) {
          const updated = structuredClone(hookOut.updatedInput);
          if (!validatorFor(tool)(updated)) {
            const detail = ajv.errorsText(validatorFor(tool).errors, { separator: "; " });
            return finish(
              "error",
              errorResult(
                "invalid_input",
                `工具 "${call.name}" 经 Hook 修改后的输入不符合 schema：${detail}`,
              ),
            );
          }
          input = updated;
        }
        if (hookOut?.decision === "ask") {
          hookAskReason = hookOut.reason ?? "PreToolUse Hook 要求确认";
        }
      }

      // 2.6 输入预检（tool-api.md 第 1 节 validateInput）：可选纯函数，作用在
      // Hook 修改后的输入上；返回错误说明即以 invalid_input 拒绝——不请求权限、
      // 不发 tool.started，由 finish 统一发出恰好一个 tool.completed。
      if (tool.validateInput !== undefined) {
        let message: string | undefined;
        try {
          message = tool.validateInput(input, scope);
        } catch (e) {
          return finish(
            "error",
            errorResult("tool_failed", `工具 "${call.name}" validateInput 抛出异常：${String(e)}`),
          );
        }
        if (message !== undefined) {
          return finish("error", errorResult("invalid_input", message));
        }
      }

      // 3. 权限主体（纯函数）
      let requests: SubjectRequest[];
      try {
        requests = tool.permissionSubjects(input, scope);
      } catch (e) {
        return finish(
          "error",
          errorResult(
            "tool_failed",
            `工具 "${call.name}" permissionSubjects 抛出异常：${String(e)}`,
          ),
        );
      }

      // 4. 解析资源（唯一做 I/O 的准备步骤）
      let subjects: PermissionSubject[];
      try {
        subjects = await resolveSubjects(requests, scope);
      } catch (e) {
        return finish(
          "error",
          errorResult(
            "resource_unavailable",
            `无法解析权限主体：${e instanceof Error ? e.message : String(e)}`,
          ),
        );
      }

      // 5. 权限（闸门封装 ask 的等待与取消）
      if (aborted(scope.signal)) {
        return finish("cancelled", errorResult("cancelled", "调用已被中断"));
      }
      const gateStart = Date.now();
      let outcome;
      try {
        outcome = await scope.gate.check(
          subjects,
          call.callId,
          scope.signal,
          {
            turnId,
            events: scope.events,
          },
          {
            forceAsk: hookAskReason !== undefined,
            askReason: hookAskReason,
            tool: call.name,
            input,
          },
        );
      } catch (e) {
        if (aborted(scope.signal)) {
          return finish("cancelled", errorResult("cancelled", "调用已被中断"));
        }
        return finish(
          "error",
          errorResult("tool_failed", `权限判定异常：${e instanceof Error ? e.message : String(e)}`),
        );
      }
      // 等待 ask 回复期间被中断（resolved 已由 gate 发出）
      if (outcome.cancelled === true) {
        return finish("cancelled", errorResult("cancelled", "等待权限回复期间被中断"));
      }
      const { decision } = outcome;
      scope.diagnostics?.record("tool.permission", {
        callId: call.callId,
        tool: call.name,
        subjects: subjects.map((s) => ({ kind: s.kind, target: s.target })),
        action: decision.action,
        source: decision.source,
        rule: decision.matchedRule?.description,
        durationMs: Date.now() - gateStart,
      });
      if (decision.action !== "allow") {
        stopTurn = outcome.stopTurn === true;
        // events.md：被规则直接拒绝的调用发出 permission.resolved（ask 流程已由 gate 发出）
        if (outcome.resolvedEmitted !== true) {
          await scope.events.emit(
            "permission.resolved",
            {
              callId: call.callId,
              action: "deny",
              source: decision.source,
              rule: decision.matchedRule?.description ?? decision.reason,
            },
            { turnId },
          );
        }
        return finish("denied", errorResult("permission_denied", `权限拒绝：${decision.reason}`));
      }

      // 6. tool.started（写入成功后才继续执行）
      await scope.events.emit(
        "tool.started",
        {
          callId: call.callId,
          name: call.name,
          input,
          subjects: outcome.subjects,
          permission: {
            action: decision.action,
            source: decision.source,
            rule: decision.matchedRule?.description,
          },
        },
        { turnId },
      );

      // 7. 执行（AbortSignal 传播到工具；超时并入口径）
      const timeoutMs = Math.min(
        tool.traits.timeoutMs,
        tool.traits.maxTimeoutMs ?? tool.traits.timeoutMs,
      );
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const combined = AbortSignal.any([scope.signal, timeoutSignal]);
      const toolCtx = {
        cwd: scope.cwd,
        workspaceRoot: scope.workspaceRoot,
        paths: scope.paths,
        sessionId: scope.sessionId,
        turnId,
        callId: call.callId,
        signal: combined,
        subjects: outcome.subjects,
        permissions: {
          check: (req: SubjectRequest) => scope.gate.checkLexical(req),
        },
        fs: scope.platform.fs,
        process: scope.platform.process,
        readState: scope.readState,
        ...(scope.shellEnvStrip !== undefined ? { shellEnvStrip: scope.shellEnvStrip } : {}),
        shell: scope.shell,
        progress: (chunk: string, stream?: "stdout" | "stderr" | "info") => {
          scope.events.emitEphemeral(
            "tool.progress",
            { callId: call.callId, stream: stream ?? "info", chunk },
            { turnId },
          );
        },
      };

      let result: ToolResult;
      const execStart = Date.now();
      try {
        result = await tool.execute(input, toolCtx);
      } catch (e) {
        if (aborted(scope.signal)) {
          return finish("cancelled", errorResult("cancelled", "调用已被中断"));
        }
        if (aborted(timeoutSignal)) {
          return finish(
            "error",
            errorResult("timeout", `工具 "${call.name}" 超过 ${timeoutMs}ms 超时`),
          );
        }
        return finish(
          "error",
          errorResult(
            "tool_failed",
            `工具 "${call.name}" 抛出异常：${e instanceof Error ? e.message : String(e)}`,
          ),
        );
      }
      if (aborted(scope.signal)) {
        return finish("cancelled", errorResult("cancelled", "调用已被中断"));
      }

      scope.diagnostics?.record("tool.exec", {
        callId: call.callId,
        tool: call.name,
        status: result.status,
        durationMs: Date.now() - execStart,
        modelChars: result.modelContent.length,
      });

      // 7.5 PostToolUse Hook（hooks.md）：观察结果、追加反馈；不修改结果本体
      if (scope.hooks !== undefined) {
        const hookOut = await scope.hooks.run(
          "PostToolUse",
          {
            turnId,
            callId: call.callId,
            tool: call.name,
            input,
            result: {
              status: result.status,
              modelContent: result.modelContent.slice(0, 4_000),
              error: result.status === "error" ? result.error : undefined,
            },
          },
          scope.signal,
        );
        if (hookOut?.feedback !== undefined && hookOut.feedback !== "") {
          result = {
            ...result,
            modelContent: `${result.modelContent}\n\n[hook] ${hookOut.feedback.slice(0, 4_000)}`,
          };
        }
      }
      return finish(result.status, result);
    },
  };
}
