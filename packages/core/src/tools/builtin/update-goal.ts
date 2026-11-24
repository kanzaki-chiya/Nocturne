/**
 * update_goal（ADR-0076 §4.2）：模型报告目标结果。只在目标为 active 时注册；
 * 状态写入由注入的 report 完成（目标模块写 session.config_changed.goal），
 * 工具本身不读写会话。
 */
import type { GoalCheckResult, ModelRef, Usage } from "../../protocol/index.js";
import type { ToolDefinition, ToolResult } from "../types.js";

export const UPDATE_GOAL_TOOL_NAME = "update_goal";

export interface UpdateGoalInput {
  status: "met" | "blocked";
  checklist?: { item: string; evidence: string }[] | undefined;
  reason?: string | undefined;
}

export interface UpdateGoalOutput extends UpdateGoalInput {
  check?: GoalCheckResult;
}

export interface UpdateGoalSettlement {
  output: UpdateGoalOutput;
  rejected?: string;
  usage?: Usage | undefined;
  usageModel?: ModelRef | undefined;
}

export interface UpdateGoalAccess {
  /** 目标此刻是否为 active（用户可能刚停止） */
  active(): boolean;
  report(
    input: UpdateGoalInput,
    callId: string,
    signal: AbortSignal,
  ): Promise<UpdateGoalSettlement | undefined>;
}

const fail = (message: string): ToolResult<UpdateGoalOutput> => ({
  status: "error",
  modelContent: message,
  error: { code: "invalid_input", message },
});

export function createUpdateGoalTool(
  access: UpdateGoalAccess,
): ToolDefinition<UpdateGoalInput, UpdateGoalOutput> {
  return {
    name: UPDATE_GOAL_TOOL_NAME,
    description:
      'Report the outcome of the current goal. status "met": every deliverable is verified; give checklist items with concrete evidence. status "blocked": you cannot continue without the user; give the reason.',
    inputSchema: {
      type: "object",
      required: ["status"],
      properties: {
        status: { type: "string", enum: ["met", "blocked"] },
        checklist: {
          type: "array",
          maxItems: 50,
          items: {
            type: "object",
            required: ["item", "evidence"],
            properties: { item: { type: "string" }, evidence: { type: "string" } },
            additionalProperties: false,
          },
        },
        reason: { type: "string" },
      },
      additionalProperties: false,
    },
    traits: { mutates: false, fileEffects: "none", concurrencySafe: false, timeoutMs: 60_000 },
    validateInput(input) {
      if (input.status === "met") {
        if (!input.checklist?.length) return 'status "met" needs at least one checklist item';
        if (input.checklist.some((entry) => !entry.item.trim() || !entry.evidence.trim()))
          return "every checklist item needs non-empty item and evidence";
      }
      if (input.status === "blocked" && !input.reason?.trim())
        return 'status "blocked" needs a reason';
      return undefined;
    },
    permissionSubjects: () => [],
    async execute(input, ctx) {
      if (!access.active()) return fail("No active goal");
      const report: UpdateGoalInput = {
        status: input.status,
        ...(input.status === "met" && input.checklist ? { checklist: input.checklist } : {}),
        ...(input.status === "blocked" && input.reason ? { reason: input.reason.trim() } : {}),
      };
      const settled = await access.report(report, ctx.callId, ctx.signal);
      if (!settled) return fail("No active goal");
      const { output, rejected, usage, usageModel } = settled;
      if (rejected !== undefined) {
        return {
          status: "error",
          modelContent: rejected,
          error: { code: "goal_unverified", message: "Goal evidence could not be verified." },
          output,
          usage,
          usageModel,
        };
      }
      return {
        status: "ok",
        modelContent:
          output.status === "met"
            ? "Goal marked as met."
            : input.status === "met"
              ? (output.reason ?? "Goal marked as blocked.")
              : "Goal marked as blocked. Explain to the user what you need.",
        output,
        usage,
        usageModel,
      };
    },
  };
}
