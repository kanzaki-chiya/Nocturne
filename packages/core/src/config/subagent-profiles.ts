import type { SubagentProfileConfig } from "../protocol/index.js";

/** 模型解析由装配层注入，配置层不依赖 Provider。 */
export function resolveSubagentProfile<T>(
  name: string,
  profiles: Readonly<Record<string, SubagentProfileConfig>>,
  resolveModel: (ref: string) => T | undefined,
  currentModel: T,
  defaultModel: T,
): { model: T; profile: SubagentProfileConfig } | undefined {
  if (name === "default")
    return { model: defaultModel, profile: { description: "通用", enabled: true } };
  const profile = profiles[name];
  if (!profile?.enabled) return undefined;
  const model = profile.model === undefined ? currentModel : resolveModel(profile.model);
  return model === undefined ? undefined : { model, profile };
}
