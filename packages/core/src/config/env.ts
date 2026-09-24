/**
 * 环境变量层与命令行参数层（config.md 第 5 节）。
 * 两者都输出 ConfigFile 形状的片段进入统一合并；
 * 凭据值本身不进配置对象，只记录环境变量名（apiKeyEnv）。
 */
import type { CliConfigArgs, ConfigFile, ProviderEntryConfig } from "./types.js";

type EnvReader = (name: string) => string | undefined;

const API_TYPES = new Set(["openai-compatible", "anthropic"]);

/** --model / NOCTURNE_MODEL 允许 "provider/model" 写法：前缀等于 provider id 时剥掉 */
function bareModelId(model: string, providerId: string): string {
  const slash = model.indexOf("/");
  if (slash > 0 && model.slice(0, slash) === providerId) return model.slice(slash + 1);
  return model;
}

function providerEntry(
  type: "openai-compatible" | "anthropic",
  baseURL: string | undefined,
  apiKeyEnv: string,
  model: string | undefined,
): ProviderEntryConfig {
  const entry: ProviderEntryConfig = {
    // 合成条目的 id 取 api-type 值（config.md 第 5 节）
    id: type,
    type,
    apiKeyEnv,
    // 环境变量 / 命令行只给出"当前要用的模型"：清单外模型 id 允许回退目录（cli.md）
    allowUndeclaredModels: true,
  };
  if (baseURL !== undefined && baseURL !== "") entry.baseURL = baseURL;
  if (model !== undefined && model !== "") {
    entry.models = { [bareModelId(model, entry.id)]: {} };
  }
  return entry;
}

export interface LayerFragment {
  file: ConfigFile;
  warnings: string[];
}

/**
 * 环境变量层（config.md 第 5 节）。
 * 合成 Provider 条目的条件：openai-compatible 需要 NOCTURNE_BASE_URL；
 * 显式设置了 NOCTURNE_API_TYPE 时总是合成（anthropic 的 baseURL 可缺省）。
 */
export function envLayerConfig(env: EnvReader): LayerFragment {
  const warnings: string[] = [];
  const file: ConfigFile = {};

  const model = env("NOCTURNE_MODEL");
  if (model !== undefined && model !== "") file.model = model;

  const rawType = env("NOCTURNE_API_TYPE");
  const baseURL = env("NOCTURNE_BASE_URL");
  if (rawType !== undefined && rawType !== "" && !API_TYPES.has(rawType)) {
    warnings.push(`NOCTURNE_API_TYPE 无效："${rawType}"（可选：openai-compatible | anthropic）`);
  } else {
    const type = (rawType ?? "openai-compatible") as "openai-compatible" | "anthropic";
    const explicitlyTyped = rawType !== undefined && rawType !== "";
    const hasRequired = type === "anthropic" || (baseURL !== undefined && baseURL !== "");
    if (explicitlyTyped || hasRequired) {
      if (type === "openai-compatible" && !hasRequired) {
        warnings.push(
          "NOCTURNE_API_TYPE=openai-compatible 但未设置 NOCTURNE_BASE_URL，未合成 Provider",
        );
      } else {
        const apiKeyEnv = type === "anthropic" ? "ANTHROPIC_API_KEY" : "NOCTURNE_API_KEY";
        if (env(apiKeyEnv) === undefined || env(apiKeyEnv) === "") {
          warnings.push(`凭据环境变量 ${apiKeyEnv} 未设置`);
        }
        file.providers = [providerEntry(type, baseURL, apiKeyEnv, model)];
      }
    }
  }
  return { file, warnings };
}

/**
 * 命令行参数层（优先级最高）。--api-type / --base-url / --api-key-env / --model。
 * 显式给出 --api-type 或 --base-url 时合成 Provider 条目（id 取 api-type 值）。
 */
export function cliLayerConfig(args: CliConfigArgs | undefined): LayerFragment {
  const warnings: string[] = [];
  const file: ConfigFile = {};
  if (args === undefined) return { file, warnings };

  if (args.model !== undefined && args.model !== "") file.model = args.model;

  const rawType = args.apiType;
  const explicitlyTyped = rawType !== undefined && rawType !== "";
  if (explicitlyTyped && !API_TYPES.has(rawType)) {
    warnings.push(`--api-type 无效："${rawType}"（可选：openai-compatible | anthropic）`);
    return { file, warnings };
  }
  const hasBaseUrl = args.baseUrl !== undefined && args.baseUrl !== "";
  if (explicitlyTyped || hasBaseUrl) {
    const type = (explicitlyTyped ? rawType : "openai-compatible") as
      "openai-compatible" | "anthropic";
    if (type === "openai-compatible" && !hasBaseUrl) {
      warnings.push("--api-type openai-compatible 需要 --base-url，未合成 Provider");
      return { file, warnings };
    }
    const apiKeyEnv =
      args.apiKeyEnv !== undefined && args.apiKeyEnv !== ""
        ? args.apiKeyEnv
        : type === "anthropic"
          ? "ANTHROPIC_API_KEY"
          : "NOCTURNE_API_KEY";
    file.providers = [providerEntry(type, args.baseUrl, apiKeyEnv, args.model)];
  }
  return { file, warnings };
}
