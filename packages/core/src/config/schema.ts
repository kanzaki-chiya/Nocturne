/**
 * 配置文件 schema（config.md 第 2 节）。
 * 严格 JSON、Zod 校验；未知字段剥离（与事件演进规则一致），
 * 但 provider 条目中出现凭据形字段名时拒绝（config_credential_rejected）。
 */
import { z } from "zod";

import {
  REASONING_EFFORT_LEVELS,
  REASONING_EFFORT_ORDER,
  PERMISSION_PRESET_NAMES,
  parseCompactionThreshold,
} from "../protocol/index.js";
import type { ConfigFile } from "./types.js";
import { ConfigError } from "./errors.js";

const subjectKindSchema = z.enum(["read", "edit", "shell", "network", "mcp", "subagent"]);

/** 逐模型协议（ADR-0026；Responses 由 ADR-0031 §1 接入）：models/userModels 的 protocol 字段取值 */
const modelProtocolSchema = z.enum(["openai-compatible", "anthropic", "openai-responses"]);

/** 思考档位（ADR-0018）：全部七档（含 off）/ 可用档位（六档，不含 off） */
const reasoningEffortSchema = z.enum(REASONING_EFFORT_ORDER);
const reasoningEffortLevelSchema = z.enum(REASONING_EFFORT_LEVELS);

const permissionRuleSchema = z.object({
  kind: z.union([subjectKindSchema, z.literal("*")]).optional(),
  pattern: z.string().min(1),
  action: z.enum(["allow", "ask", "deny"]),
  where: z.enum(["workspace", "outside"]).optional(),
  label: z.string().optional(),
  userOnly: z.boolean().optional(),
});

const capabilitiesSchema = z.object({
  toolCalls: z.boolean().optional(),
  parallelToolCalls: z.boolean().optional(),
  reasoning: z.enum(["none", "hidden", "visible"]).optional(),
  /** 逐模型可用思考档位（ADR-0018）：只接受合法档位名 */
  reasoningEffort: z.array(reasoningEffortLevelSchema).optional(),
  imageInput: z.boolean().optional(),
  promptCache: z.boolean().optional(),
  /** 编辑工具选择（ADR-0035 §5） */
  editTool: z.enum(["edit", "apply_patch"]).optional(),
});

/** 模型条目 schema（config.json 与 providers.json 共用） */
export const modelOverrideSchema = z.object({
  displayName: z.string().optional(),
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  capabilities: capabilitiesSchema.optional(),
  pricing: z
    .object({
      input: z.number().nonnegative().optional(),
      output: z.number().nonnegative().optional(),
    })
    .optional(),
  // ADR-0026 第 2 节：手写协议指定（最高优先级）与上游/手写接口声明
  protocol: modelProtocolSchema.optional(),
  endpoints: z.array(z.string().min(1)).optional(),
});

/** Provider 条目 schema（config.json 与 providers.json 共用） */
export const providerEntrySchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(["openai-compatible", "anthropic"]).optional(),
    baseURL: z.string().min(1).optional(),
    // v0.2：可选——缺省时凭据经凭据索引/系统后端解析（provider-setup.md 第 3 节）
    apiKeyEnv: z.string().min(1).optional(),
    models: z.record(z.string(), modelOverrideSchema).optional(),
    allowUndeclaredModels: z.boolean().optional(),
    providerOptions: z.record(z.string(), z.unknown()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    // 会话标识请求头名（ADR-0031 §3）：如 "x-opencode-session"；
    // 请求带 sessionId 时写该头，未声明不发送任何会话头
    sessionHeader: z.string().min(1).optional(),
    // models.dev 服务商键（ADR-0031 §4）：启用按服务商的接口声明参与合并
    modelsDevProvider: z.string().min(1).optional(),
    // 思考兼容开关（ADR-0018）：format 由预设写死；levels/source 仅为旧文件读取；
    // budgets 覆盖 anthropic 档位预算表（正整数 token 数）
    thinking: z
      .object({
        format: z.enum(["openai", "openrouter"]).optional(),
        levels: z.array(reasoningEffortLevelSchema).optional(),
        source: z.literal("user").optional(),
        budgets: z
          .partialRecord(reasoningEffortLevelSchema, z.number().int().positive())
          .optional(),
      })
      .optional(),
    // 逐模型用户编辑（ADR-0024 第 1 节）：仅向导层 providers.json 有意义
    // （编辑模型页 / /provider model 写入）；作为独立"用户编辑"层参与
    // 逐字段合并，高层条目里的同名字段只作数据
    userModels: z
      .record(
        z.string(),
        z.object({
          displayName: z.string().optional(),
          contextWindow: z.number().int().positive().optional(),
          maxOutputTokens: z.number().int().positive().optional(),
          capabilities: z
            .object({
              reasoning: z.enum(["none", "hidden", "visible"]).optional(),
              imageInput: z.boolean().optional(),
              reasoningEffort: z.array(reasoningEffortLevelSchema).optional(),
              // ADR-0035 §5：编辑页「编辑工具」字段的用户编辑
              editTool: z.enum(["edit", "apply_patch"]).optional(),
            })
            .optional(),
          // ADR-0026 第 7 节：编辑页「协议」字段的用户编辑
          protocol: modelProtocolSchema.optional(),
        }),
      )
      .optional(),
    // 向导/"refresh"写入的上游来源标注（provider-setup.md 第 7 节）
    source: z.literal("upstream").optional(),
    fetchedAt: z.string().optional(),
  })
  .check((ctx) => {
    // openai-compatible（含缺省 type）必须有 baseURL——适配器构造必需
    const e = ctx.value;
    if ((e.type === undefined || e.type === "openai-compatible") && e.baseURL === undefined) {
      ctx.issues.push({
        code: "custom",
        input: e,
        path: ["baseURL"],
        message: "openai-compatible 必须提供 baseURL",
      });
    }
  });

const hookPointSchema = z.enum([
  "PreToolUse",
  "PostToolUse",
  "PermissionRequest",
  "TurnStart",
  "TurnEnd",
  "SessionStart",
  "SessionEnd",
]);

const hookEntrySchema = z.object({
  /** 工具名通配符（只用于工具相关点位）；缺省或 "*" 匹配全部 */
  matcher: z.string().optional(),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
});

const mcpServerEntrySchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  startupTimeoutMs: z.number().int().positive().optional(),
  callTimeoutMs: z.number().int().positive().optional(),
});

const configFileSchema = z.object({
  compaction: z
    .object({
      threshold: z
        .union([z.string(), z.number()])
        .refine((value) => {
          try {
            parseCompactionThreshold(value);
            return true;
          } catch {
            return false;
          }
        }, "无效的压缩阈值")
        .optional(),
    })
    .optional(),
  modelsDev: z.literal(false).optional(),
  model: z.string().min(1).optional(),
  modelRoles: z
    .object({
      task: z
        .string()
        .regex(/^[^/]+\/.+$/u)
        .optional(),
      vision: z
        .string()
        .regex(/^[^/]+\/.+$/u)
        .optional(),
      smol: z
        .string()
        .regex(/^[^/]+\/.+$/u)
        .optional(),
    })
    .optional(),
  /** 会话默认思考档位（ADR-0018） */
  reasoningEffort: reasoningEffortSchema.optional(),
  /** shell 选择（ADR-0022 第 2 节）：auto | pwsh | powershell | bash | cmd | sh */
  shell: z.enum(["auto", "pwsh", "powershell", "bash", "cmd", "sh"]).optional(),
  /** 非标准安装位置的可执行文件路径；种类仍由 shell 决定 */
  shellPath: z.string().min(1).optional(),
  providers: z.array(providerEntrySchema).optional(),
  permission: z
    .object({
      reviewer: z
        .discriminatedUnion("backend", [
          z.object({
            backend: z.literal("model"),
            model: z.object({ provider: z.string().min(1), model: z.string().min(1) }),
          }),
          z.object({ backend: z.literal("off") }),
          z
            .object({
              backend: z.literal("jev"),
              endpoint: z.enum(["opencode-zen", "typesafe", "custom"]),
              baseURL: z.url().optional(),
              model: z.string().min(1),
              credential: z.union([
                z.object({ provider: z.string().min(1) }).strict(),
                z.object({ env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/) }).strict(),
                z.object({ stored: z.literal(true) }).strict(),
              ]),
              minConfidence: z.number().min(0).max(1).optional(),
            })
            .strict(),
        ])
        .superRefine((reviewer, ctx) => {
          if (reviewer.backend !== "jev") return;
          if (reviewer.endpoint !== "custom" && reviewer.baseURL !== undefined)
            ctx.addIssue({ code: "custom", message: "baseURL 只用于 custom 接入点" });
          if (reviewer.endpoint === "custom") {
            let url: URL | undefined;
            try {
              url = new URL(reviewer.baseURL ?? "");
            } catch {
              /* 校验错误见下 */
            }
            if (
              !url ||
              !["https:", "http:"].includes(url.protocol) ||
              url.username ||
              url.password ||
              url.search ||
              url.hash
            )
              ctx.addIssue({
                code: "custom",
                message: "custom 需要不含凭据、查询或片段的 HTTP(S) baseURL",
              });
          }
        })
        .optional(),
    })
    .optional(),
  permissions: z
    .object({
      preset: z
        .enum([...PERMISSION_PRESET_NAMES, "full-access"])
        .transform((name) => (name === "full-access" ? ("guarded" as const) : name))
        .optional(),
      rules: z.array(permissionRuleSchema).optional(),
    })
    .optional(),
  turn: z
    .object({
      maxSteps: z.number().int().positive().optional(),
      retryLimit: z.number().int().nonnegative().optional(),
      retryBaseDelayMs: z.number().int().nonnegative().optional(),
      firstEventTimeoutMs: z.number().int().positive().optional(),
      idleTimeoutMs: z.number().int().positive().optional(),
    })
    .optional(),
  hooks: z.partialRecord(hookPointSchema, z.array(hookEntrySchema)).optional(),
  mcp: z
    .object({
      servers: z.record(z.string(), mcpServerEntrySchema).optional(),
    })
    .optional(),
});

/**
 * provider 条目中出现这些字段名（小写比较）视为试图内联凭据，
 * 拒绝整份配置而不是静默剥离——剥离会让用户以为凭据已生效。
 * `apiKeyEnv` 是合法字段，不在此列。
 */
const CREDENTIAL_KEYS = new Set([
  "apikey",
  "api_key",
  "key",
  "token",
  "secret",
  "password",
  "authorization",
  "auth",
  "credential",
  "credentials",
  "bearer",
]);

/** mcp.servers.*.env 中合法的凭据引用形态：`${NAME}` 引用运行时环境变量 */
const ENV_REFERENCE = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;
const CREDENTIAL_NAME = /key|token|secret|password|credential|auth/i;

/**
 * 凭据字段硬拒绝（config.md 第 3 节）：providers 条目的内联凭据字段、
 * mcp.servers.*.env 的疑似凭据字面量。parseConfigFile 与 providers.json
 * 的加载共用——配置文件的任何位置都不允许出现密钥值。
 */
export function rejectCredentialKeys(raw: unknown, filePath: string): void {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return;
  const providers = (raw as { providers?: unknown }).providers;
  if (Array.isArray(providers)) {
    for (const entry of providers as unknown[]) {
      if (typeof entry !== "object" || entry === null) continue;
      for (const key of Object.keys(entry)) {
        if (CREDENTIAL_KEYS.has(key.toLowerCase())) {
          throw new ConfigError(
            "config_credential_rejected",
            `provider 条目不允许内联凭据字段 "${key}"；凭据只经环境变量进入，请改用 apiKeyEnv 指定变量名`,
            filePath,
          );
        }
      }
    }
  }
  // MCP env：凭据形变量名只接受 ${NAME} 引用，拒绝疑似凭据字面量（config.md 第 3 节）
  const servers = (raw as { mcp?: { servers?: unknown } }).mcp?.servers;
  if (typeof servers !== "object" || servers === null) return;
  for (const [name, server] of Object.entries(servers as Record<string, unknown>)) {
    const env = (server as { env?: unknown } | null)?.env;
    if (typeof env !== "object" || env === null) continue;
    for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
      if (typeof value === "string" && CREDENTIAL_NAME.test(key) && !ENV_REFERENCE.test(value)) {
        throw new ConfigError(
          "config_credential_rejected",
          `mcp.servers.${name}.env.${key} 疑似内联凭据；请写成 "${key}": "\${${key}}" 引用环境变量`,
          filePath,
        );
      }
    }
  }
}

/**
 * 校验一份已解析的 JSON 为 ConfigFile。
 * 抛出 ConfigError；调用方决定快速失败（用户配置）还是忽略（项目配置）。
 */
export function parseConfigFile(raw: unknown, filePath: string): ConfigFile {
  rejectCredentialKeys(raw, filePath);
  const parsed = configFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue !== undefined ? `${issue.path.join(".")}: ${issue.message}` : "unknown";
    throw new ConfigError("config_invalid", `配置不符合 schema（${where}）`, filePath, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}
