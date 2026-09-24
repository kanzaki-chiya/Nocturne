/**
 * 配置文件 schema（config.md 第 2 节）。
 * 严格 JSON、Zod 校验；未知字段剥离（与事件演进规则一致），
 * 但 provider 条目中出现凭据形字段名时拒绝（config_credential_rejected）。
 */
import { z } from "zod";

import type { ConfigFile } from "./types.js";
import { ConfigError } from "./errors.js";

const subjectKindSchema = z.enum(["read", "edit", "shell", "network", "mcp", "subagent"]);

const permissionRuleSchema = z.object({
  kind: z.union([subjectKindSchema, z.literal("*")]).optional(),
  pattern: z.string().min(1),
  action: z.enum(["allow", "ask", "deny"]),
  where: z.enum(["workspace", "outside"]).optional(),
  label: z.string().optional(),
});

const capabilitiesSchema = z.object({
  toolCalls: z.boolean().optional(),
  parallelToolCalls: z.boolean().optional(),
  reasoning: z.enum(["none", "hidden", "visible"]).optional(),
  reasoningEffort: z.array(z.string()).optional(),
  imageInput: z.boolean().optional(),
  promptCache: z.boolean().optional(),
});

const modelOverrideSchema = z.object({
  displayName: z.string().optional(),
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  capabilities: capabilitiesSchema.optional(),
});

const providerEntrySchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(["openai-compatible", "anthropic"]).optional(),
    baseURL: z.string().min(1).optional(),
    apiKeyEnv: z.string().min(1),
    models: z.record(z.string(), modelOverrideSchema).optional(),
    allowUndeclaredModels: z.boolean().optional(),
    providerOptions: z.record(z.string(), z.unknown()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
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
  model: z.string().min(1).optional(),
  providers: z.array(providerEntrySchema).optional(),
  permissions: z
    .object({
      preset: z.enum(["read-only", "default", "auto-edit", "full-access"]).optional(),
      rules: z.array(permissionRuleSchema).optional(),
    })
    .optional(),
  turn: z
    .object({
      maxSteps: z.number().int().positive().optional(),
      retryLimit: z.number().int().nonnegative().optional(),
      retryBaseDelayMs: z.number().int().nonnegative().optional(),
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

function rejectCredentialKeys(raw: unknown, filePath: string): void {
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
