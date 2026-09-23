/**
 * Phase 2 Provider 配置收集（cli.md 第 7 节）。
 * 来源只有环境变量 + 命令行参数（参数优先）；组装成
 * RuntimeOptions.providerConfigs 交给 createRuntime。config 模块落地后
 * 只换"来源"，注入形态不变。
 */
import type { ProviderConfig } from "@nocturne/core";

import type { CliArgs } from "./args.js";

export type ApiType = "openai-compatible" | "anthropic";

export interface CliConfig {
  providerConfig: ProviderConfig;
  /** "provider/model" 形式的模型引用 */
  model: string;
  providerId: string;
}

export type CollectResult = { ok: true; config: CliConfig } | { ok: false; problems: string[] };

type Env = (name: string) => string | undefined;

export function collectConfig(args: CliArgs, env: Env = (n) => process.env[n]): CollectResult {
  const problems: string[] = [];

  const apiType = args.apiType ?? env("NOCTURNE_API_TYPE") ?? "openai-compatible";
  if (apiType !== "openai-compatible" && apiType !== "anthropic") {
    problems.push(`--api-type 无效："${apiType}"（可选：openai-compatible | anthropic）`);
  }
  const validType = apiType as ApiType;

  const baseURL = args.baseUrl ?? env("NOCTURNE_BASE_URL");
  if (validType === "openai-compatible" && (baseURL === undefined || baseURL === "")) {
    problems.push("缺少 --base-url / NOCTURNE_BASE_URL（openai-compatible 必需）");
  }

  const apiKeyEnv =
    args.apiKeyEnv ?? (validType === "anthropic" ? "ANTHROPIC_API_KEY" : "NOCTURNE_API_KEY");
  const key = env(apiKeyEnv);
  if (key === undefined || key === "") {
    problems.push(`缺少凭据：环境变量 ${apiKeyEnv} 未设置`);
  }

  const modelId = args.model ?? env("NOCTURNE_MODEL");
  if (modelId === undefined || modelId === "") {
    problems.push("缺少 --model / NOCTURNE_MODEL");
  }

  if (problems.length > 0) return { ok: false, problems };

  const providerId = validType;
  // --model 允许 provider/model 写法：前缀等于当前 provider 时剥掉；
  // 前缀是另一种 api-type（用户明显指了别的 Provider）时拒绝；
  // 其余含斜杠的值（如 deepseek/deepseek-v4.1-flash）按模型 id 原样使用。
  let bareModel = modelId ?? "";
  const slash = bareModel.indexOf("/");
  if (slash > 0) {
    const p = bareModel.slice(0, slash);
    if (p === providerId) {
      bareModel = bareModel.slice(slash + 1);
    } else if (p === "openai-compatible" || p === "anthropic") {
      return {
        ok: false,
        problems: [`--model 的 provider "${p}" 与当前 Provider "${providerId}" 不一致`],
      };
    }
  }
  const model = `${providerId}/${bareModel}`;

  const providerConfig: ProviderConfig =
    validType === "anthropic"
      ? {
          id: providerId,
          type: "anthropic",
          ...(baseURL !== undefined && baseURL !== "" ? { baseURL } : {}),
          apiKeyEnv,
          models: { [bareModel]: {} },
        }
      : {
          id: providerId,
          baseURL: baseURL ?? "",
          apiKeyEnv,
          models: { [bareModel]: {} },
        };

  return { ok: true, config: { providerConfig, model, providerId } };
}
