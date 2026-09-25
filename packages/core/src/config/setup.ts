/**
 * 向导配置层（provider-setup.md 第 2 节）：<NOCTURNE_HOME>/providers.json
 * 是机器维护文件（原子写），分层顺序为 内置默认 < 向导 < 用户 < 项目 <
 * 环境变量 < 命令行参数。同 id 条目高层覆盖低层（与 config.json 同规则）。
 * 本文件还含 recent-models.json（最近使用模型，最多 10 条）。
 */
import { z } from "zod";

import type { Platform } from "../platform/index.js";
import type { ModelRef } from "../protocol/index.js";
import { ConfigError } from "./errors.js";
import { writeJsonAtomic } from "./files.js";
import { providerEntrySchema, rejectCredentialKeys } from "./schema.js";
import type {
  CredentialStore,
  ProviderEntryConfig,
  ProviderOverview,
  ProviderSetupFile,
  UpstreamFetch,
} from "./types.js";

const SETUP_FILE_VERSION = 1;
const RECENT_LIMIT = 10;

const setupFileSchema = z.object({
  version: z.literal(SETUP_FILE_VERSION),
  model: z.string().min(1).optional(),
  providers: z.array(providerEntrySchema).optional(),
});

const recentFileSchema = z.object({
  version: z.literal(1),
  models: z.array(z.string()),
});

export interface ProviderSetupState {
  /** 解析后的 providers.json（无效时为 undefined） */
  file: ProviderSetupFile | undefined;
  /** 文件损坏/版本不符的人读警告（provider_setup_invalid） */
  warning?: string | undefined;
}

/** 读取 providers.json：损坏/版本不符 → 忽略 + 警告（不阻塞启动） */
export async function loadProviderSetup(
  platform: Platform,
  nocturneHome: string,
): Promise<ProviderSetupState> {
  const { fs, paths } = platform;
  const path = paths.join(nocturneHome, "providers.json");
  if (!(await fs.exists(path))) return { file: undefined };
  try {
    const raw: unknown = JSON.parse(await fs.readTextFile(path));
    // 与 config.json 同一套凭据字段硬拒绝：providers.json 同样不许内联密钥
    rejectCredentialKeys(raw, path);
    const parsed = setupFileSchema.safeParse(raw);
    if (!parsed.success) throw new Error("schema mismatch");
    return { file: parsed.data };
  } catch {
    return {
      file: undefined,
      warning: `向导配置 ${path} 损坏或版本不符，已忽略（可运行 nctrn setup 重新配置）`,
    };
  }
}

/** 整文件原子写 providers.json（目录以 0700 创建） */
export async function writeProviderSetup(
  platform: Platform,
  nocturneHome: string,
  file: ProviderSetupFile,
): Promise<void> {
  await writeJsonAtomic(
    platform.fs,
    platform.paths,
    platform.paths.join(nocturneHome, "providers.json"),
    { ...file, version: SETUP_FILE_VERSION },
    { dirMode: 0o700 },
  );
}

/** 从 baseURL 提取主机名（/provider 列表只显示主机名） */
export function hostOf(baseURL: string | undefined): string | undefined {
  if (baseURL === undefined || baseURL === "") return undefined;
  try {
    return new URL(baseURL).host;
  } catch {
    return undefined;
  }
}

export interface DescribeLayers {
  /** 各层 providers 条目（低→高）：向导、用户、项目（可信）、环境变量、命令行 */
  setup?: readonly ProviderEntryConfig[] | undefined;
  user?: readonly ProviderEntryConfig[] | undefined;
  project?: readonly ProviderEntryConfig[] | undefined;
  env?: readonly ProviderEntryConfig[] | undefined;
  cli?: readonly ProviderEntryConfig[] | undefined;
}

const LAYER_ORDER = ["setup", "user", "project", "env", "cli"] as const;
type LayerName = (typeof LAYER_ORDER)[number];

/**
 * /provider 列表数据：按分层顺序合并各层 Provider 条目并标注来源。
 * 同 id 高层胜出；向导层条目被更高层同名覆盖时标 overridden。
 */
export function describeProviderLayers(
  layers: DescribeLayers,
  credentials: CredentialStore,
  env: (name: string) => string | undefined,
): ProviderOverview[] {
  const byId = new Map<string, { entry: ProviderEntryConfig; layer: LayerName }>();
  const setupIds = new Set<string>();
  for (const layer of LAYER_ORDER) {
    for (const entry of layers[layer] ?? []) {
      if (layer === "setup") setupIds.add(entry.id);
      byId.set(entry.id, { entry, layer });
    }
  }
  return [...byId.values()].map(({ entry, layer }) => {
    const apiKeyEnv = entry.apiKeyEnv;
    const envSet = apiKeyEnv !== undefined && env(apiKeyEnv) !== undefined && env(apiKeyEnv) !== "";
    const keySource = envSet
      ? ("env" as const)
      : credentials.has(entry.id)
        ? ("credential" as const)
        : ("missing" as const);
    return {
      id: entry.id,
      type: entry.type ?? "openai-compatible",
      host: hostOf(entry.baseURL),
      keySource,
      keyEnvName: apiKeyEnv,
      origin: layer,
      overridden: setupIds.has(entry.id) && layer !== "setup",
      modelCount: Object.keys(entry.models ?? {}).length,
      // 向导可管理 = 定义它的最高层是向导层（config.json 同名覆盖后不接管）
      managed: layer === "setup",
    };
  });
}

/** 保存/更新向导条目：同 id 条目整体替换（向导写完整条目）；key 经凭据存储写入后端 */
export async function saveSetupProvider(
  platform: Platform,
  nocturneHome: string,
  credentials: CredentialStore,
  entry: ProviderEntryConfig,
  opts?: {
    key?: string | undefined;
    /** 设为默认：写入 providers.json 的 model 字段（"provider/model" 全形） */
    defaultModel?: string | undefined;
  },
): Promise<void> {
  const state = await loadProviderSetup(platform, nocturneHome);
  const providers = (state.file?.providers ?? []).filter((p) => p.id !== entry.id);
  providers.push(entry);
  const file: ProviderSetupFile = {
    version: SETUP_FILE_VERSION,
    ...(state.file?.model !== undefined ? { model: state.file.model } : {}),
    providers,
    ...(opts?.defaultModel !== undefined ? { model: opts.defaultModel } : {}),
  };
  // 先写凭据（后端不可用时直接拒绝，不留半截条目）
  if (opts?.key !== undefined) {
    await credentials.set(entry.id, opts.key);
  }
  await writeProviderSetup(platform, nocturneHome, file);
}

/** 删除向导条目与凭据；条目不由向导层定义时拒绝 */
export async function removeSetupProvider(
  platform: Platform,
  nocturneHome: string,
  credentials: CredentialStore,
  providerId: string,
): Promise<void> {
  const state = await loadProviderSetup(platform, nocturneHome);
  const entries = state.file?.providers ?? [];
  if (!entries.some((p) => p.id === providerId)) {
    throw new ConfigError(
      "config_invalid",
      `服务商 "${providerId}" 不是向导写入的条目；手写在 config.json 或其他层的条目请编辑对应文件`,
    );
  }
  await credentials.delete(providerId);
  await writeProviderSetup(platform, nocturneHome, {
    version: SETUP_FILE_VERSION,
    ...(state.file?.model !== undefined ? { model: state.file.model } : {}),
    providers: entries.filter((p) => p.id !== providerId),
  });
}

/** 写入默认模型字段（保留其余内容） */
export async function setSetupDefaultModel(
  platform: Platform,
  nocturneHome: string,
  model: string,
): Promise<void> {
  const state = await loadProviderSetup(platform, nocturneHome);
  await writeProviderSetup(platform, nocturneHome, {
    version: SETUP_FILE_VERSION,
    model,
    ...(state.file?.providers !== undefined ? { providers: state.file.providers } : {}),
  });
}

/**
 * /provider refresh：重新获取上游模型列表与限额，写回 providers.json。
 * upstreamFetch 由 core/index 注入 provider 层的 fetchModels（config 不依赖 provider）。
 */
export async function refreshUpstreamLimits(
  platform: Platform,
  nocturneHome: string,
  credentials: CredentialStore,
  env: (name: string) => string | undefined,
  upstreamFetch: UpstreamFetch | undefined,
  providerId: string,
): Promise<void> {
  const state = await loadProviderSetup(platform, nocturneHome);
  const entry = state.file?.providers?.find((p) => p.id === providerId);
  if (entry === undefined) {
    throw new ConfigError(
      "config_invalid",
      `服务商 "${providerId}" 不是向导写入的条目，无法 refresh`,
    );
  }
  if (upstreamFetch === undefined) {
    throw new ConfigError("config_unavailable", "上游获取不可用（缺少 fetchModels 注入）");
  }
  // 凭据解析顺序与适配器一致：apiKeyEnv 非空 → 环境变量；否则凭据索引
  const envKey = entry.apiKeyEnv !== undefined ? env(entry.apiKeyEnv) : undefined;
  const key = envKey !== undefined && envKey !== "" ? envKey : await credentials.get(providerId);
  const upstream = await upstreamFetch(entry, key);
  const models: NonNullable<ProviderEntryConfig["models"]> = {};
  for (const m of upstream) {
    models[m.id] = {
      ...(m.displayName !== undefined ? { displayName: m.displayName } : {}),
      ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
      ...(m.maxOutputTokens !== undefined ? { maxOutputTokens: m.maxOutputTokens } : {}),
      ...(m.pricing !== undefined ? { pricing: m.pricing } : {}),
      ...(m.capabilities !== undefined
        ? {
            capabilities: {
              ...(m.capabilities.reasoning !== undefined
                ? { reasoning: m.capabilities.reasoning }
                : {}),
              ...(m.capabilities.imageInput !== undefined
                ? { imageInput: m.capabilities.imageInput }
                : {}),
            },
          }
        : {}),
    };
  }
  const updated: ProviderEntryConfig = {
    ...entry,
    models,
    source: "upstream",
    fetchedAt: new Date().toISOString(),
  };
  const providers = (state.file?.providers ?? []).map((p) => (p.id === providerId ? updated : p));
  await writeProviderSetup(platform, nocturneHome, {
    version: SETUP_FILE_VERSION,
    ...(state.file?.model !== undefined ? { model: state.file.model } : {}),
    providers,
  });
}

// ── recent-models.json ───────────────────────────────────

/** 读取最近模型列表（损坏时按空处理——最坏后果是最近列表为空） */
export async function readRecentModels(
  platform: Platform,
  nocturneHome: string,
): Promise<ModelRef[]> {
  const { fs, paths } = platform;
  const path = paths.join(nocturneHome, "recent-models.json");
  if (!(await fs.exists(path))) return [];
  try {
    const raw: unknown = JSON.parse(await fs.readTextFile(path));
    const parsed = recentFileSchema.safeParse(raw);
    if (!parsed.success) return [];
    const out: ModelRef[] = [];
    for (const s of parsed.data.models) {
      const i = s.indexOf("/");
      if (i > 0 && i < s.length - 1) {
        out.push({ provider: s.slice(0, i), model: s.slice(i + 1) });
      }
    }
    return out.slice(0, RECENT_LIMIT);
  } catch {
    return [];
  }
}

/** 记录一次模型使用：去重置顶、最多 10 条、原子写 */
export async function recordRecentModel(
  platform: Platform,
  nocturneHome: string,
  ref: ModelRef,
): Promise<void> {
  const current = await readRecentModels(platform, nocturneHome);
  const id = `${ref.provider}/${ref.model}`;
  const models = [
    id,
    ...current.map((r) => `${r.provider}/${r.model}`).filter((s) => s !== id),
  ].slice(0, RECENT_LIMIT);
  await writeJsonAtomic(
    platform.fs,
    platform.paths,
    platform.paths.join(nocturneHome, "recent-models.json"),
    { version: 1, models },
    { dirMode: 0o700 },
  );
}
