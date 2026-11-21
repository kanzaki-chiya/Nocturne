import type { ReasoningEffort, SubagentProfileConfig } from "../protocol/index.js";

/** 插件定义的子代理运行时输入（ADR-0105）：供配置层解析为统一档位形状 */
export interface PluginSubagentDefinition {
  /** 档位 id：`<插件 name>:<子代理 name>` */
  id: string;
  /** 来源插件 id，如 `nocturne:pptx@builtin` */
  pluginId: string;
  /** 来源插件 name，如 `pptx` */
  pluginName: string;
  /** 来源插件显示名，如 `演示文档` */
  pluginDisplayName: string;
  description: string;
  /** 角色说明正文（追加在固定子代理提示词之后） */
  prompt: string;
  effort?: ReasoningEffort | undefined;
  /** 允许的工具名白名单（与子会话可选池取交集） */
  tools?: readonly string[] | undefined;
}

/** 统一的子代理档位解析结果（涵盖 default、用户档位与插件子代理） */
export interface ResolvedSubagentProfile<T> {
  model: T;
  profile: SubagentProfileConfig;
  /** 插件子代理专属：角色说明正文 */
  rolePrompt?: string | undefined;
  /** 插件子代理专属：来源插件信息 */
  sourcePlugin?:
    | {
        id: string;
        name: string;
        displayName: string;
      }
    | undefined;
  /** 插件子代理专属：工具名白名单（与子会话可选池取交集） */
  allowedTools?: readonly string[] | undefined;
}

/** 模型解析由装配层注入，配置层不依赖 Provider。 */
export function resolveSubagentProfile<T>(
  name: string,
  profiles: Readonly<Record<string, SubagentProfileConfig>>,
  resolveModel: (ref: string) => T | undefined,
  currentModel: T,
  defaultModel: T,
  pluginSubagents?: Readonly<Record<string, PluginSubagentDefinition>>,
  pluginModels?: Readonly<Record<string, string>>,
): ResolvedSubagentProfile<T> | undefined {
  if (name === "default")
    return { model: defaultModel, profile: { description: "通用", enabled: true } };
  const profile = profiles[name];
  if (profile !== undefined) {
    if (!profile.enabled) return undefined;
    const model = profile.model === undefined ? currentModel : resolveModel(profile.model);
    return model === undefined ? undefined : { model, profile };
  }
  const pluginAgent = pluginSubagents?.[name];
  if (pluginAgent === undefined) return undefined;
  const configuredModel = pluginModels?.[name];
  const model = configuredModel === undefined ? defaultModel : resolveModel(configuredModel);
  if (model === undefined) return undefined;
  return {
    model,
    profile: {
      description: pluginAgent.description,
      ...(configuredModel !== undefined ? { model: configuredModel } : {}),
      ...(pluginAgent.effort !== undefined ? { effort: pluginAgent.effort } : {}),
      enabled: true,
    },
    rolePrompt: pluginAgent.prompt,
    sourcePlugin: {
      id: pluginAgent.pluginId,
      name: pluginAgent.pluginName,
      displayName: pluginAgent.pluginDisplayName,
    },
    ...(pluginAgent.tools !== undefined ? { allowedTools: pluginAgent.tools } : {}),
  };
}
