/**
 * 配置收集（cli.md 第 8 节）：CLI 不再自己拼装 Provider 配置——
 * 调用 Core 的 loadConfig 做分层加载，命令行参数是最高优先级层；
 * 这里只做"本次启动是否凑得齐一次会话"的校验与模型引用归一化。
 */
import {
  BUILTIN_MODEL_CATALOG,
  fetchModels,
  loadConfig,
  normalizeModelRef,
  type BuiltinModelLookup,
  type Platform,
  type RuntimeConfig,
} from "@nocturne/core";

import type { CliArgs } from "./args.js";

export interface CliConfig {
  /** loadConfig 产物：注入 createRuntime({ config }) */
  runtime: RuntimeConfig;
  /** "provider/model" 形式的模型引用；恢复且未指定 --model 时缺省（模型以日志为准） */
  model?: string | undefined;
  /** 生效的 Provider id（模型前缀或合成条目 id） */
  providerId?: string | undefined;
  /** 加载与降级警告（原样展示给用户） */
  warnings: string[];
}

export type CollectResult =
  | { ok: true; config: CliConfig }
  | {
      ok: false;
      problems: string[];
      /**
       * 是否存在任何服务商来源（providers.json 条目、config.json providers、
       * 环境变量/命令行合成条目）——全无时报告把 nctrn setup 提示置首
       */
      hasProviderSource: boolean;
    };

type Env = (name: string) => string | undefined;

/** 模型设置编辑的内置目录查询（ADR-0024 第 2 节 builtin 来源标注） */
const builtinModel: BuiltinModelLookup = (providerId, modelId) =>
  BUILTIN_MODEL_CATALOG[providerId]?.[modelId];

/** 生效的 api-type：命令行 > 环境变量 > 默认 openai-compatible */
function effectiveApiType(args: CliArgs, env: Env): string {
  return args.apiType ?? env("NOCTURNE_API_TYPE") ?? "openai-compatible";
}

/** 生效 Provider id（合成条目 id = api-type 值）；--resume --model 归一化用 */
export function effectiveProviderId(args: CliArgs, env: Env = (n) => process.env[n]): string {
  return effectiveApiType(args, env);
}

// 归一化语义属于 Provider 层，由 core 导出（tui.md §9）；此处再导出保持 CLI 内部调用不变
export { normalizeModelRef } from "@nocturne/core";

/**
 * 分层加载并校验启动配置。
 * 校验项（cli.md 第 2 节）：缺模型、Provider 未配置、
 * openai-compatible 缺 baseURL、凭据环境变量未设置——均以退出码 2 报告。
 */
/**
 * /provider add/key/remove/refresh 之后的配置重载（provider-setup.md 第 6 节）：
 * 与 collectConfig 相同的分层参数重跑 loadConfig，结果喂 runtime.updateProviders。
 */
export function makeConfigLoader(
  args: CliArgs,
  platform: Platform,
  env: Env = (n) => process.env[n],
): () => Promise<RuntimeConfig> {
  return () =>
    loadConfig(platform, {
      cliArgs: {
        model: args.model,
        apiType: args.apiType,
        baseUrl: args.baseUrl,
        apiKeyEnv: args.apiKeyEnv,
      },
      env,
      upstreamFetch: (entry, key, signal) =>
        fetchModels(
          {
            type: entry.type ?? "openai-compatible",
            ...(entry.baseURL !== undefined ? { baseURL: entry.baseURL } : {}),
            ...(entry.headers !== undefined ? { headers: entry.headers } : {}),
          },
          key,
          signal,
        ),
      builtinModel,
    });
}

export async function collectConfig(
  args: CliArgs,
  platform: Platform,
  env: Env = (n) => process.env[n],
  options?: { requireModel?: boolean | undefined },
): Promise<CollectResult> {
  const requireModel = options?.requireModel !== false;
  const runtime = await loadConfig(platform, {
    cliArgs: {
      model: args.model,
      apiType: args.apiType,
      baseUrl: args.baseUrl,
      apiKeyEnv: args.apiKeyEnv,
    },
    env,
    // /provider refresh 的上游获取（provider-setup.md 第 6 节）：
    // config 不依赖 provider，这里桥接 provider 层的 fetchModels
    upstreamFetch: (entry, key, signal) =>
      fetchModels(
        {
          type: entry.type ?? "openai-compatible",
          ...(entry.baseURL !== undefined ? { baseURL: entry.baseURL } : {}),
          ...(entry.headers !== undefined ? { headers: entry.headers } : {}),
        },
        key,
        signal,
      ),
    builtinModel,
  });
  const resolved = runtime.base;
  const problems: string[] = [];
  const warnings: string[] = [...resolved.warnings];

  // 模型来源决定归一化规则（cli.md §2、config.md §2）：
  //   --model / NOCTURNE_MODEL → "当前 Provider 内"的模型 id（含命名空间写法）；
  //   配置文件 model → 字面 "provider/model"
  const cliOrEnvModel =
    args.model !== undefined && args.model !== "" ? args.model : env("NOCTURNE_MODEL");
  let model: string | undefined;
  let providerId: string | undefined;
  if (cliOrEnvModel !== undefined && cliOrEnvModel !== "") {
    providerId = effectiveApiType(args, env);
    const norm = normalizeModelRef(cliOrEnvModel, providerId);
    if (!norm.ok)
      return {
        ok: false,
        problems: [norm.problem],
        hasProviderSource: resolved.providers.length > 0,
      };
    model = norm.ref;
  } else {
    const configured = resolved.model;
    if (configured === undefined || configured === "") {
      if (requireModel) {
        problems.push("缺少模型：--model <id> / NOCTURNE_MODEL / 配置文件 model");
        // 继续校验 Provider/凭据，一次列全缺失项（cli.md 第 2 节）
        providerId = effectiveApiType(args, env);
      }
    } else {
      const slash = configured.indexOf("/");
      if (slash <= 0) {
        problems.push(`配置文件 model 必须是 "provider/model" 形式，收到 "${configured}"`);
        return { ok: false, problems, hasProviderSource: resolved.providers.length > 0 };
      }
      providerId = configured.slice(0, slash);
      model = configured;
    }
  }

  // requireModel=false 且没有模型来源（恢复路径）：不校验 Provider——
  // 恢复的模型无法解析时由 Runtime 报 invalid_model 并提示 --model
  if (providerId !== undefined) {
    const provider = resolved.providers.find((p) => p.id === providerId);
    if (provider === undefined) {
      problems.push(
        `Provider "${providerId}" 未配置：设置 NOCTURNE_BASE_URL/--base-url，` +
          `或在 <NOCTURNE_HOME>/config.json 的 providers 中声明`,
      );
    } else {
      const type = provider.type ?? "openai-compatible";
      if (
        type === "openai-compatible" &&
        (provider.baseURL === undefined || provider.baseURL === "")
      ) {
        problems.push(`Provider "${providerId}" 缺少 baseURL（openai-compatible 必需）`);
      }
      // 凭据解析顺序（provider-setup.md 第 3 节）：apiKeyEnv 已设置 →
      // 环境变量；否则凭据索引。都没有 → 提示 nctrn setup
      const envKey =
        provider.apiKeyEnv !== undefined && env(provider.apiKeyEnv) !== ""
          ? env(provider.apiKeyEnv)
          : undefined;
      if (envKey === undefined && !runtime.credentials.has(provider.id)) {
        problems.push(
          provider.apiKeyEnv !== undefined
            ? `缺少凭据：环境变量 ${provider.apiKeyEnv} 未设置，凭据存储中也没有 "${provider.id}" 的密钥——运行 nctrn setup 或用 /provider key 配置`
            : `缺少凭据：Provider "${provider.id}" 未配置密钥——运行 nctrn setup 或用 /provider key 配置`,
        );
      }
    }
  }

  if (problems.length > 0) {
    return { ok: false, problems, hasProviderSource: resolved.providers.length > 0 };
  }

  return {
    ok: true,
    config: { runtime, model, providerId, warnings },
  };
}

/**
 * 「配置不完整」报告文本（cli.md 第 2 节）：
 * - 非 TTY：原样列出缺失项，不含向导提示（脚本场景输出稳定）；
 * - 交互终端：追加 nctrn setup 提示；完全无服务商来源时提示置首，
 *   环境变量/手写说明退为次要选项（首次体验场景）。
 */
export function configProblemsReport(
  problems: string[],
  options: { tty: boolean; hasProviderSource: boolean },
): string {
  const list = problems.map((p) => `  - ${p}`).join("\n");
  if (!options.tty) return `配置不完整：\n${list}\n`;
  const hint = "  首次使用？运行 nctrn setup 配置服务商与密钥";
  return options.hasProviderSource
    ? `配置不完整：\n${list}\n${hint}\n`
    : `配置不完整：\n${hint}\n${list}\n`;
}
