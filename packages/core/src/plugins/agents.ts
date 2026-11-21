/**
 * 解析 Nocturne 自有插件定义的子代理 Markdown 文件（ADR-0105）。
 * 单文件解析出错只跳过该文件并记警告，不影响同插件的技能、Hook、MCP 与其他子代理。
 */
import type { Platform } from "../platform/index.js";
import type { PluginAgentOverview, ReasoningEffort } from "../protocol/index.js";
import {
  MAX_SUBAGENT_BODY_CHARS,
  MAX_SUBAGENT_DESCRIPTION_CHARS,
  parseNocturneSubagentMarkdown,
} from "../config/subagent-markdown.js";
import type { PluginSubagentSpec } from "./types.js";

export const MAX_PLUGIN_AGENT_DESCRIPTION_CHARS = MAX_SUBAGENT_DESCRIPTION_CHARS;
export const MAX_PLUGIN_AGENT_BODY_CHARS = MAX_SUBAGENT_BODY_CHARS;

export interface ParsedPluginAgentMarkdown {
  agent?: {
    name: string;
    description: string;
    prompt: string;
    effort?: ReasoningEffort | undefined;
    tools?: string[] | undefined;
  };
  warnings: string[];
}

export function parsePluginSubagentMarkdown(
  text: string,
  fileName: string,
  pluginLabel: string,
): ParsedPluginAgentMarkdown {
  const parsed = parseNocturneSubagentMarkdown(text, {
    prefix: `plugin ${pluginLabel} 子代理 ${fileName}：`,
    rejectLongDescription: true,
    modelIgnoreReason: "插件不能替用户指定模型",
  });
  return {
    ...(parsed.agent !== undefined
      ? {
          agent: {
            name: parsed.agent.name,
            description: parsed.agent.description,
            prompt: parsed.agent.prompt,
            ...(parsed.agent.effort !== undefined ? { effort: parsed.agent.effort } : {}),
            ...(parsed.agent.tools !== undefined ? { tools: parsed.agent.tools } : {}),
          },
        }
      : {}),
    warnings: parsed.warnings,
  };
}

export async function scanPluginAgentsDir(
  platform: Platform,
  dirPath: string,
  pluginRootReal: string,
  ctx: {
    pluginId: string;
    pluginName: string;
    pluginDisplayName: string;
    pluginLabel: string;
    warnings: string[];
  },
): Promise<{ specs: PluginSubagentSpec[]; overviews: PluginAgentOverview[] }> {
  const { fs, paths } = platform;
  if (!(await fs.exists(dirPath))) {
    ctx.warnings.push(`plugin ${ctx.pluginLabel}：agents 目录不存在`);
    return { specs: [], overviews: [] };
  }
  let stat;
  try {
    stat = await fs.stat(dirPath);
  } catch {
    ctx.warnings.push(`plugin ${ctx.pluginLabel}：无法读取 agents 目录`);
    return { specs: [], overviews: [] };
  }
  if (stat.type !== "directory") {
    ctx.warnings.push(`plugin ${ctx.pluginLabel}：agents 路径不是目录`);
    return { specs: [], overviews: [] };
  }

  let entries;
  try {
    entries = await fs.readdir(dirPath);
  } catch {
    return { specs: [], overviews: [] };
  }

  const specs: PluginSubagentSpec[] = [];
  const overviews: PluginAgentOverview[] = [];
  const seenNames = new Set<string>();

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.type !== "file" && entry.type !== "symlink") continue;
    if (!entry.name.toLowerCase().endsWith(".md")) continue;

    let realPath: string;
    try {
      realPath = await platform.resolveReal(entry.path);
    } catch {
      ctx.warnings.push(`plugin ${ctx.pluginLabel} 子代理 ${entry.name}：路径解析失败，已跳过`);
      continue;
    }
    if (!paths.isWithin(pluginRootReal, realPath)) {
      ctx.warnings.push(`plugin ${ctx.pluginLabel} 子代理 ${entry.name}：越出插件根目录，已跳过`);
      continue;
    }
    let text: string;
    try {
      text = await fs.readTextFile(realPath);
    } catch (e) {
      ctx.warnings.push(
        `plugin ${ctx.pluginLabel} 子代理 ${entry.name}：读取失败（${e instanceof Error ? e.message : String(e)}），已跳过`,
      );
      continue;
    }

    const parsed = parsePluginSubagentMarkdown(text, entry.name, ctx.pluginLabel);
    ctx.warnings.push(...parsed.warnings);
    if (parsed.agent === undefined) continue;

    if (seenNames.has(parsed.agent.name)) {
      ctx.warnings.push(
        `plugin ${ctx.pluginLabel} 子代理 ${entry.name}：名称 "${parsed.agent.name}" 在同插件内重复，已跳过`,
      );
      continue;
    }
    seenNames.add(parsed.agent.name);

    const id = `${ctx.pluginName}:${parsed.agent.name}`;
    specs.push({
      id,
      name: parsed.agent.name,
      pluginId: ctx.pluginId,
      pluginName: ctx.pluginName,
      pluginDisplayName: ctx.pluginDisplayName,
      pluginLabel: ctx.pluginLabel,
      description: parsed.agent.description,
      prompt: parsed.agent.prompt,
      ...(parsed.agent.effort !== undefined ? { effort: parsed.agent.effort } : {}),
      ...(parsed.agent.tools !== undefined ? { tools: parsed.agent.tools } : {}),
    });
    overviews.push({
      id,
      name: parsed.agent.name,
      description: parsed.agent.description,
      ...(parsed.agent.effort !== undefined ? { effort: parsed.agent.effort } : {}),
      ...(parsed.agent.tools !== undefined ? { tools: [...parsed.agent.tools] } : {}),
    });
  }

  return { specs, overviews };
}
