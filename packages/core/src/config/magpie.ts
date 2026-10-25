/**
 * Magpie 接入层（ADR-0062）：读取 `<NOCTURNE_HOME>/magpie.json`，把 Magpie 在 Agent 页
 * 写入的网关地址、客户端 key 引用、模型清单与默认模型转成一份 ConfigFile 层。
 *
 * 该文件由 Magpie 的 Agent 插件维护，Nocturne 只读、从不写；断开时 Magpie 删除它写过的键，
 * 文件里没有 `magpie.baseURL` 即视为未接入。网关 key 不进入配置对象：条目用 `external-file`
 * 鉴权在请求时读这个文件（凭据硬拒绝与 mtime 重读沿用 ADR-0042）。
 */
import { z } from "zod";

import { REASONING_EFFORT_LEVELS, type ReasoningEffortLevel } from "../protocol/index.js";
import type { Platform } from "../platform/index.js";
import type { ConfigFile, ModelOverrideShape, ProviderEntryConfig } from "./types.js";

export const MAGPIE_PROVIDER_ID = "magpie";
export const MAGPIE_FILE_NAME = "magpie.json";
/** Magpie 网关识别会话的请求头（Magpie docs/integrating.md） */
export const MAGPIE_SESSION_HEADER = "X-Magpie-Session";

const positive = z.number().positive().optional().catch(undefined);

const magpieModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional().catch(undefined),
  context: positive,
  output: positive,
  images: z.boolean().optional().catch(undefined),
  efforts: z.array(z.string()).optional().catch(undefined),
  /** 网关不经翻译直通的接口路径（Magpie 的 native_endpoints） */
  endpoints: z.array(z.string().min(1)).optional().catch(undefined),
  /** USD / 每百万 token */
  pricing: z
    .object({
      input: z.number().nonnegative().optional(),
      output: z.number().nonnegative().optional(),
      cacheRead: z.number().nonnegative().optional(),
      cacheWrite: z.number().nonnegative().optional(),
    })
    .optional()
    .catch(undefined),
});

const magpieFileSchema = z.object({
  model: z.string().optional().catch(undefined),
  magpie: z
    .object({
      baseURL: z.string().min(1).optional(),
      models: z.array(z.unknown()).optional(),
    })
    .optional(),
});

export interface MagpieLayer {
  /** 未接入（文件缺失、`magpie.baseURL` 缺失）或文件无效时为 undefined */
  file?: ConfigFile | undefined;
  warnings: string[];
}

function isEffort(value: string): value is ReasoningEffortLevel {
  return (REASONING_EFFORT_LEVELS as readonly string[]).includes(value);
}

function toModel(raw: z.infer<typeof magpieModelSchema>): ModelOverrideShape {
  const efforts = (raw.efforts ?? []).filter(isEffort);
  const model: ModelOverrideShape = {};
  if (raw.name !== undefined && raw.name !== "") model.displayName = raw.name;
  if (raw.context !== undefined) model.contextWindow = Math.floor(raw.context);
  if (raw.output !== undefined) model.maxOutputTokens = Math.floor(raw.output);
  if (raw.endpoints !== undefined && raw.endpoints.length > 0) model.endpoints = raw.endpoints;
  if (raw.pricing !== undefined && Object.keys(raw.pricing).length > 0) model.pricing = raw.pricing;
  const capabilities: NonNullable<ModelOverrideShape["capabilities"]> = {};
  if (raw.images !== undefined) capabilities.imageInput = raw.images;
  if (efforts.length > 0) capabilities.reasoningEffort = efforts;
  if (Object.keys(capabilities).length > 0) model.capabilities = capabilities;
  return model;
}

/**
 * 读取并转换 magpie.json。文件损坏或形状不符只告警并按未接入处理，
 * 不阻塞启动（Magpie 可能正在写入）。
 */
export async function loadMagpieLayer(platform: Platform, path: string): Promise<MagpieLayer> {
  const { fs } = platform;
  if (!(await fs.exists(path))) return { warnings: [] };
  const invalid = (reason: string): MagpieLayer => ({
    warnings: [`magpie_config_invalid：${path} ${reason}，已忽略 Magpie 接入`],
  });
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readTextFile(path));
  } catch (e) {
    return invalid(`无法读取或不是合法 JSON（${e instanceof Error ? e.message : String(e)}）`);
  }
  const parsed = magpieFileSchema.safeParse(raw);
  if (!parsed.success) return invalid("不符合约定的形状");
  const section = parsed.data.magpie;
  // 断开后 Magpie 删除它写的键，可能留下空的 magpie 对象或孤立的 model
  if (section?.baseURL === undefined) return { warnings: [] };

  const warnings: string[] = [];
  const models: Record<string, ModelOverrideShape> = {};
  let dropped = 0;
  for (const item of section.models ?? []) {
    const parsedModel = magpieModelSchema.safeParse(item);
    if (!parsedModel.success) {
      dropped += 1;
      continue;
    }
    models[parsedModel.data.id] = toModel(parsedModel.data);
  }
  if (dropped > 0)
    warnings.push(`magpie_config_invalid：${path} 中有 ${dropped} 个模型条目无效，已忽略`);

  const entry: ProviderEntryConfig = {
    id: MAGPIE_PROVIDER_ID,
    displayName: "Magpie",
    type: "openai-compatible",
    baseURL: section.baseURL,
    auth: {
      kind: "external-file",
      path,
      keyPath: ["magpie", "key"],
      renewHint: "在 Magpie 的 Agent 页重新连接 Nocturne",
    },
    sessionHeader: MAGPIE_SESSION_HEADER,
    models,
  };
  const file: ConfigFile = { providers: [entry] };
  // 默认模型只接受指向 Magpie 条目的引用：Magpie 页选「自己的模型」时留下的值不在此生效
  const model = parsed.data.model;
  if (model?.startsWith(`${MAGPIE_PROVIDER_ID}/`) === true) file.model = model;
  return { file, warnings };
}
