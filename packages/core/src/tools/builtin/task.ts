/**
 * task 工具（subagent.md 第 1 节）：启动一个子会话运行受控 Turn，
 * 把子代理经 finish 提交的结果作为工具结果返回。
 * 普通 ToolDefinition——走与其他工具相同的注册接口与执行管线，
 * Agent Loop 不知道它的存在。子会话的装配由注入的 SubagentLauncher
 * 完成（tools 不 import agent；接口在本模块，实现在 agent/subagent.ts）。
 */
import { Ajv } from "ajv";
import type { JsonSchema, SubjectRequest } from "../../protocol/index.js";
import type { SubagentLauncher, ToolContext, ToolDefinition, ToolResult } from "../types.js";

interface TaskInput {
  /** 交给子代理的完整任务描述（子会话看不到父会话历史，必须自包含） */
  task: string;
  /** 工具集预设；缺省 general；与 tools 互斥 */
  preset?: "general" | "explore";
  /** 显式工具名白名单（与 preset 互斥） */
  tools?: string[];
  /** 要求子代理按此 schema 提交结构化结果 */
  outputSchema?: JsonSchema;
  /** 本次调用的超时上限（毫秒），封顶 traits.maxTimeoutMs */
  timeoutMs?: number;
}

const ajv = new Ajv({ strict: false });

const DESCRIPTION =
  "在独立的子会话中运行一个受控子代理来完成给定任务，返回子代理提交的结果。" +
  "子代理看不到本会话的历史，task 必须自包含：需要的文件、约束、产出格式都写清楚。" +
  "preset 选择工具集：general（默认，全部可用工具）、explore（只读探索：read/grep/glob 与声明只读的 MCP 工具）；" +
  "也可以用 tools 给出显式白名单（与 preset 互斥）。outputSchema 要求子代理按该 schema 交结构化结果。" +
  "权限注意：子会话是非交互的，无法向用户请求确认——在默认权限规则下需要确认的操作" +
  "（写文件、执行命令、工作区外读取、MCP 调用等）在子会话内会被拒绝；" +
  "只读或探索类任务优先用 explore；需要写入或执行的操作让子代理在结果中说明，由你自己执行。";

/**
 * createTaskTool 工厂（subagent.md 第 3 节）：launcher 由 core/index 装配；
 * 未启用时不注册（模型不可见），而非注册一个永远失败的工具。
 */
export function createTaskTool(launcher: SubagentLauncher): ToolDefinition<TaskInput> {
  const invalid = (message: string): ToolResult => ({
    status: "error",
    modelContent: message,
    error: { code: "invalid_input", message },
  });

  return {
    name: "task",
    description: DESCRIPTION,
    inputSchema: {
      type: "object",
      required: ["task"],
      properties: {
        task: { type: "string", description: "子代理的任务描述（自包含）" },
        preset: {
          type: "string",
          enum: ["general", "explore"],
          description: "工具集预设，默认 general；与 tools 互斥",
        },
        tools: {
          type: "array",
          items: { type: "string" },
          description: "显式工具名白名单；与 preset 互斥",
        },
        outputSchema: {
          type: "object",
          description: "子代理 finish 结果必须符合的 JSON Schema",
        },
        timeoutMs: {
          type: "integer",
          minimum: 1,
          description: "本次调用超时上限（毫秒）",
        },
      },
      additionalProperties: false,
    },
    // mutates 如实声明（general 子代理可能写文件）；concurrencySafe=false：
    // 无工作区隔离时并行子代理可能同时改同一批文件（subagent.md 第 11 节）
    traits: {
      mutates: true,
      concurrencySafe: false,
      timeoutMs: 600_000,
      maxTimeoutMs: 3_600_000,
      maxModelChars: 30_000,
    },

    permissionSubjects(input: TaskInput): SubjectRequest[] {
      // subagent 主体：预设名或 "custom"（tools 白名单）
      const target = input.tools !== undefined ? "custom" : (input.preset ?? "general");
      return [{ kind: "subagent", target }];
    },

    async execute(input: TaskInput, ctx: ToolContext): Promise<ToolResult> {
      if (input.preset !== undefined && input.tools !== undefined) {
        return invalid("preset 与 tools 互斥，只能给一个");
      }
      if (input.outputSchema !== undefined) {
        try {
          ajv.compile(input.outputSchema);
        } catch (e) {
          return invalid(`outputSchema 无法编译：${e instanceof Error ? e.message : String(e)}`);
        }
      }
      const outcome = await launcher.launch(
        {
          task: input.task,
          ...(input.preset !== undefined ? { preset: input.preset } : {}),
          ...(input.tools !== undefined ? { tools: input.tools } : {}),
          ...(input.outputSchema !== undefined ? { outputSchema: input.outputSchema } : {}),
          ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        },
        ctx,
      );
      if (outcome.status === "ok") {
        return {
          status: "ok",
          modelContent: outcome.resultText,
          output: outcome.stats,
        };
      }
      const modelContent =
        outcome.tailText !== undefined && outcome.tailText !== ""
          ? `${outcome.error.message}\n\n子会话最后的输出尾部：\n${outcome.tailText}`
          : outcome.error.message;
      return {
        status: "error",
        modelContent,
        output: outcome.stats,
        error: outcome.error,
      };
    },
  };
}
