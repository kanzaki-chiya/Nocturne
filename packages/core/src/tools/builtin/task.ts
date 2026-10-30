/**
 * task 工具（subagent.md 第 1 节）：启动一个子会话运行受控 Turn，
 * 把子代理经 finish 提交的结果作为工具结果返回。
 * 普通 ToolDefinition——走与其他工具相同的注册接口与执行管线，
 * Agent Loop 不知道它的存在。子会话的装配由注入的 SubagentLauncher
 * 完成（tools 不 import agent；接口在本模块，实现在 agent/subagent.ts）。
 */
import { createSchemaCompiler } from "../schema.js";
import { subagentSelectionTable, type SubagentProfileConfig } from "../../protocol/index.js";
import type { JsonSchema, SubjectRequest } from "../../protocol/index.js";
import type {
  ExternalAgentInfo,
  ExternalAgentOutcome,
  ExternalAgentRequest,
  SubagentLauncher,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from "../types.js";

interface TaskInput {
  /** 交给子代理的完整任务描述（子会话看不到父会话历史，必须自包含） */
  task: string;
  background?: boolean;
  /** 已启用的外部 agent；与内置子代理的选择字段互斥 */
  agent?: string;
  profile?: string;
  reason?: string;
  /** 工具集预设；缺省 general；与 tools 互斥 */
  preset?: "general" | "explore";
  /** 显式工具名白名单（与 preset 互斥） */
  tools?: string[];
  /** 要求子代理按此 schema 提交结构化结果 */
  outputSchema?: JsonSchema;
  /** 本次调用的超时上限（毫秒），封顶 traits.maxTimeoutMs */
  timeoutMs?: number;
}

/** task 默认/上限超时（subagent.md 第 1 节）；默认值可被 RuntimeOptions.subagent.timeoutMs 覆盖 */
const TASK_DEFAULT_TIMEOUT_MS = 600_000;
const TASK_MAX_TIMEOUT_MS = 3_600_000;

const schemas = createSchemaCompiler({ strict: false });

const DESCRIPTION =
  "在独立的子会话中运行一个受控子代理来完成给定任务，返回子代理提交的结果。" +
  "子代理看不到本会话的历史，task 必须自包含：需要的文件、约束、产出格式都写清楚。" +
  "preset 选择工具集：general（默认，全部可用工具）、explore（只读探索：read/grep/glob 与声明只读的 MCP 工具）；" +
  "也可以用 tools 给出显式白名单（与 preset 互斥）。outputSchema 要求子代理按该 schema 交结构化结果。" +
  "权限注意：子会话是非交互的，无法向用户请求确认——在默认权限规则下需要确认的操作" +
  "（写文件、执行命令、工作区外读取、MCP 调用等）在子会话内会被拒绝；" +
  "只读或探索类任务优先用 explore；需要写入或执行的操作让子代理在结果中说明，由你自己执行。";

/** Core 装配补全工作目录、附件路径和权限回调，工具只负责按输入字段分流。 */
interface ExternalTaskRunner {
  agents: readonly ExternalAgentInfo[];
  run(
    request: Pick<ExternalAgentRequest, "agent" | "task" | "timeoutMs">,
    ctx: ToolContext,
  ): Promise<ExternalAgentOutcome>;
}
/** 后台准入（ADR-0073 §2、§8）：输入工具集与是否外部 agent，拒绝时返回说明 */
export type BackgroundAdmit = (input: {
  tools: readonly Pick<ToolDefinition, "traits">[];
  external?: boolean | undefined;
}) => string | undefined;

/**
 * createTaskTool 工厂（subagent.md 第 3 节）：launcher 由 core/index 装配；
 * 未启用时不注册（模型不可见），而非注册一个永远失败的工具。
 */
export function createTaskTool(
  launcher?: SubagentLauncher,
  externalAgents?: ExternalTaskRunner,
  defaultTimeoutMs: number = TASK_DEFAULT_TIMEOUT_MS,
  profiles: readonly (SubagentProfileConfig & { name: string })[] = [],
  defaultModel?: string,
  /** ADR-0073：宿主开启且在顶层会话时由 core/index 注入准入判断；缺省时 schema 不出现 background */
  background?: BackgroundAdmit,
): ToolDefinition<TaskInput> {
  const agents = externalAgents?.agents ?? [];
  const hasExternalAgents = agents.length > 0;
  const hasProfiles = profiles.length > 0 || hasExternalAgents;
  const available = [
    "default",
    ...profiles.map((profile) => profile.name),
    ...agents.map((agent) => agent.name),
  ];
  const selectedAgent = (input: TaskInput) =>
    agents.find((agent) => agent.name === (input.profile ?? input.agent));
  const validateInput = (input: TaskInput): string | undefined => {
    if (input.agent !== undefined && input.profile !== undefined)
      return "agent 与 profile 不能同时给出";
    const name = input.profile ?? input.agent ?? "default";
    if (!available.includes(name))
      return `档位 ${name} 不存在、已停用或模型不可用；可选：${available.join(", ")}`;
    if (input.background === true) {
      if (background === undefined) return "当前会话不支持后台子代理";
      // 外部 agent 不经内置 launcher，在这里走同一个准入判断
      if (selectedAgent(input) !== undefined) {
        const denied = background({ tools: [], external: true });
        if (denied !== undefined) return denied;
      }
    }
    if (selectedAgent(input) !== undefined) {
      if (
        input.preset !== undefined ||
        input.tools !== undefined ||
        input.outputSchema !== undefined
      ) {
        return "agent 与 preset、tools、outputSchema 互斥";
      }
      return undefined;
    }
    if (launcher === undefined) return "内置子代理未启用，必须给出 agent";
    if (input.preset !== undefined && input.tools !== undefined) {
      return "preset 与 tools 互斥，只能给一个";
    }
    if (input.outputSchema !== undefined) {
      try {
        schemas.compile(input.outputSchema);
      } catch (e) {
        return `outputSchema 无法编译：${e instanceof Error ? e.message : String(e)}`;
      }
    }
    return undefined;
  };
  const invalid = (message: string): ToolResult => ({
    status: "error",
    modelContent: message,
    error: { code: "invalid_input", message },
  });
  /** 实际生效的默认超时（装配可经 RuntimeOptions.subagent.timeoutMs 覆盖），不超过上限 */
  const effectiveDefaultTimeoutMs = Math.min(defaultTimeoutMs, TASK_MAX_TIMEOUT_MS);

  return {
    name: "task",
    description:
      (launcher !== undefined
        ? DESCRIPTION
        : "委派自包含任务给已启用的外部 agent；通过 profile 选择执行者（agent 为兼容别名）。") +
      (hasExternalAgents
        ? `外部 agent：${agents.map((agent) => `${agent.name}${agent.description ? `（${agent.description}）` : ""}`).join("、")}。` +
          "选择外部档位时不得给 preset、tools、outputSchema。" +
          "执行期权限请求经过非交互判定，剩余询问会被拒绝；仅覆盖外部 agent 主动请求的操作，不是沙箱。" +
          "外部 agent 的文件修改不受检查点或按文件回退追踪；费用与额度计在该 agent 自己的账号上。" +
          "外部 agent 看不到 task 工具，不能再委派（不能嵌套）。"
        : "") +
      (hasProfiles ? `\n${subagentSelectionTable(profiles, agents, defaultModel)}` : "") +
      (background
        ? " Use background for independent, read-only, time-consuming research; do not wait or poll for its result."
        : ""),
    inputSchema: {
      type: "object",
      required: ["task"],
      properties: {
        task: { type: "string", description: "子代理的任务描述（自包含）" },
        ...(background
          ? {
              background: {
                type: "boolean",
                description:
                  "Run read-only work in the background and receive its result as a separate message.",
              },
            }
          : {}),
        ...(hasProfiles
          ? {
              profile: { type: "string", enum: available, description: "子代理档位，缺省 default" },
            }
          : {}),
        reason: { type: "string", description: "选择此档位的理由（一句话，最多显示 200 字）" },
        ...(hasExternalAgents
          ? {
              agent: {
                type: "string",
                description: `已启用的外部 agent 名称（${agents.map((agent) => agent.name).join("、")}）；与 preset、tools、outputSchema 互斥`,
              },
            }
          : {}),
        ...(launcher !== undefined
          ? {
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
            }
          : {}),
        timeoutMs: {
          type: "integer",
          minimum: 1,
          description: `本次调用超时上限（毫秒）；省略即默认 ${effectiveDefaultTimeoutMs}；实现、修改代码、审查、调研类任务都不要设短于默认值的超时，只有确定很快的查询才缩短；上限 ${TASK_MAX_TIMEOUT_MS}。`,
        },
      },
      additionalProperties: false,
    },
    // mutates 如实声明（general 子代理可能写文件）；concurrencySafe=false：
    // 无工作区隔离时并行子代理可能同时改同一批文件（subagent.md 第 11 节）
    traits: {
      mutates: true,
      concurrencySafe: false,
      timeoutMs: Math.max(
        effectiveDefaultTimeoutMs,
        ...profiles.map((profile) => profile.timeoutMs ?? effectiveDefaultTimeoutMs),
      ),
      maxTimeoutMs: TASK_MAX_TIMEOUT_MS,
      maxModelChars: 30_000,
    },
    validateInput,

    permissionSubjects(input: TaskInput): SubjectRequest[] {
      const target =
        selectedAgent(input) !== undefined
          ? `external:${selectedAgent(input)?.name}`
          : input.tools !== undefined
            ? "custom"
            : (input.preset ??
              profiles.find((profile) => profile.name === input.profile)?.tools ??
              "general");
      return [{ kind: "subagent", target }];
    },

    async execute(input: TaskInput, ctx: ToolContext): Promise<ToolResult> {
      const invalidReason = validateInput(input);
      if (invalidReason !== undefined) return invalid(invalidReason);
      // 输入的超时上限封顶 maxTimeoutMs 后再交给下层计时器，使
      // launcher/connector 自己的计时器与执行器的兜底一致（都先触发于生效值）
      const timeoutMs =
        input.timeoutMs === undefined ? undefined : Math.min(input.timeoutMs, TASK_MAX_TIMEOUT_MS);
      const agent = selectedAgent(input);
      if (agent !== undefined && externalAgents !== undefined) {
        return externalAgents.run(
          {
            agent: agent.name,
            task: input.task,
            timeoutMs: timeoutMs ?? effectiveDefaultTimeoutMs,
          },
          ctx,
        );
      }
      if (launcher === undefined) return invalid("内置子代理未启用，必须给出 agent");
      const outcome = await launcher.launch(
        {
          task: input.task,
          ...(input.background === true ? { background: true } : {}),
          profile: input.profile ?? input.agent ?? "default",
          ...(input.reason !== undefined
            ? { reason: Array.from(input.reason).slice(0, 200).join("") }
            : {}),
          ...(input.preset !== undefined ? { preset: input.preset } : {}),
          ...(input.tools !== undefined ? { tools: input.tools } : {}),
          ...(input.outputSchema !== undefined ? { outputSchema: input.outputSchema } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
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
          ? `${outcome.error.message}\n\n子会话没有提交结果，以下是它已有的产出（未完成，可能不完整，请自行核对）：\n${outcome.tailText}`
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
