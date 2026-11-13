/**
 * 子代理档位（ADR-0058）：用户命名的「模型 + 思考强度 + 工具集上限」组合，
 * `task` 工具的 `profile` 字段从中挑选执行者。类型与纯函数放 protocol，
 * 客户端（桌面/TUI）与 Core 共用同一份校验与显示规则。
 */
import type { ModelPricing } from "./pricing.js";
import type { ReasoningEffort } from "./types.js";
import type { ToolEntry } from "./view.js";
import { subagentProfile } from "./subagent-result.js";

/** `default` 是保留档位名：即今天的 modelRoles.task 行为，不能用作自定义档位名 */
export const DEFAULT_SUBAGENT_PROFILE = "default";

/** 档位名：小写字母、数字、`-`，最长 32（与外部 agent 共用命名空间） */
export function isValidSubagentProfileName(name: string): boolean {
  // (?![\s\S]) 要求真实字符串末尾，不接受 $ 可匹配的末尾换行
  return /^[a-z0-9-]{1,32}$(?![\s\S])/.test(name) && name !== DEFAULT_SUBAGENT_PROFILE;
}

/** `reason` 的显示上限：超出部分由显示侧截断（slice 即规则，不另设包装） */
export const MAX_SUBAGENT_REASON_CHARS = 200;

/** settings.json `subagents.profiles.<name>` 的档位声明（ADR-0058 第 1 节） */
export interface SubagentProfileConfig {
  /** 何时用（给模型看）：用户写的说明，进入 `task` 描述的选择表 */
  description: string;
  /** "provider/model"；缺省 = 跟随当前会话模型 */
  model?: string | undefined;
  /** 思考强度；缺省 = 跟随父会话档位（再按子模型就近降档） */
  effort?: ReasoningEffort | undefined;
  /** 工具集上限；缺省 general。模型调用只能在此之上收窄，不能放宽 */
  tools?: "general" | "explore" | undefined;
  /** 该档位的默认超时（毫秒）；请求的 timeoutMs 仍可覆盖，不封顶 */
  timeoutMs?: number | undefined;
  enabled: boolean;
}

/** Runtime.describeSubagentProfiles 的档位条目（含可用性判定，ADR-0058 第 2 节） */
export interface SubagentProfileInfo extends SubagentProfileConfig {
  name: string;
  /** 已启用且（声明的）模型在注册表可用；不可用的档位不进 `task` 可选表 */
  available: boolean;
  source: "default" | "settings" | "user" | "project" | "env" | "cli";
}

export interface SubagentProfilesDescription {
  /** 全部自定义档位（含停用）；`default` 档位不在内——它的模型即 modelRoles.task */
  profiles: SubagentProfileInfo[];
  /** `task` 工具描述末尾的自动选择表（与 Core 注册工具时同一生成函数） */
  selectionTable: string;
  /** 与外部 agent 命名空间冲突等降级说明 */
  warnings: string[];
}

function formatProfilePricing(pricing: ModelPricing | undefined): string {
  if (pricing?.input === undefined || pricing.output === undefined) return "";
  return `，$${pricing.input}/$${pricing.output}`;
}

function formatModelPricingEn(pricing: ModelPricing | undefined): string {
  if (pricing?.input === undefined || pricing.output === undefined) return "";
  return ` ($${pricing.input}/$${pricing.output} per 1M input/output tokens)`;
}

/**
 * Ensemble 工具说明中的已启用模型列表（ADR-0089 §3）：与 `subagentSelectionTable` 同源价格格式，
 * 供指挥按用户在 `/ensemble` 中点名的模型精确匹配。
 */
export function ensembleEnabledModelsTable(
  models: readonly { provider: string; model: string; name?: string | undefined }[],
  pricing?: (modelKey: string) => ModelPricing | undefined,
): string {
  if (models.length === 0) return "Enabled models: (none)";
  return [
    "Enabled models (`model` parameter accepts `provider/model` or a uniquely matching `model` id):",
    ...models.map((item) => {
      const key = `${item.provider}/${item.model}`;
      const label =
        item.name !== undefined && item.name !== "" && item.name !== item.model
          ? ` — ${item.name}`
          : "";
      return `  - ${key}${label}${formatModelPricingEn(pricing?.(key))}`;
    }),
  ].join("\n");
}

/** Core 与客户端共用的模型可见选择表；不负责解析模型或权限。 */
export function subagentSelectionTable(
  profiles: readonly (SubagentProfileConfig & {
    name: string;
    pricing?: ModelPricing | undefined;
  })[],
  agents: readonly { name: string; description?: string | undefined }[] = [],
  defaultModel?: string,
  pricing?: ModelPricing | ((model: string | undefined) => ModelPricing | undefined),
): string {
  const resolvePricing = (
    model: string | undefined,
    explicit?: ModelPricing,
  ): ModelPricing | undefined => {
    if (explicit !== undefined) return explicit;
    if (typeof pricing === "function") return pricing(model);
    return undefined;
  };
  const defaultPricing = typeof pricing === "function" ? pricing(defaultModel) : pricing;
  return [
    "按任务难度和性质挑最便宜的够用档位（单价为每百万 token 的输入/输出美元）；拿不准用 default。",
    `  - default：通用。（${defaultModel ?? "跟随当前模型"}，跟随会话${formatProfilePricing(defaultPricing)}）`,
    ...profiles.map(
      (profile) =>
        `  - ${profile.name}：${profile.description}（${profile.model ?? "跟随当前模型"}，${profile.effort ?? "跟随会话"}${profile.tools === "explore" ? "，只读" : ""}${formatProfilePricing(resolvePricing(profile.model, profile.pricing))}）`,
    ),
    ...agents.map(
      (agent) =>
        `  - ${agent.name}（外部 agent）：${agent.description ?? "委派自包含任务"}；费用与额度计在该 agent 自己的账号上。`,
    ),
    "给出 profile 后，只能再用 preset/tools 把工具集收窄，不能放宽。",
  ].join("\n");
}

export function subagentRowInfo(entry: ToolEntry): {
  profile?: string;
  reason?: string;
  model?: string;
  effort?: string;
} {
  if (entry.name !== "task") return {};
  const input = entry.input as Record<string, unknown> | undefined;
  const output = entry.result?.output as Record<string, unknown> | undefined;
  const live = /子代理模型：([^\n]+) · (\w+)/u.exec(entry.liveOutput);
  const profile = subagentProfile(input);
  return {
    ...(profile ? { profile } : {}),
    ...(typeof input?.reason === "string"
      ? { reason: Array.from(input.reason).slice(0, 200).join("") }
      : {}),
    ...(typeof output?.model === "string"
      ? { model: output.model }
      : live
        ? { model: live[1] }
        : typeof input?.model === "string"
          ? { model: input.model }
          : {}),
    ...(typeof output?.reasoningEffort === "string"
      ? { effort: output.reasoningEffort }
      : live
        ? { effort: live[2] }
        : typeof input?.effort === "string"
          ? { effort: input.effort }
          : {}),
  };
}
