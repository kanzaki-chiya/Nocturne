/**
 * 解析 Nocturne 自有插件定义的子代理 Markdown 文件（ADR-0105）。
 * 单文件解析出错只跳过该文件并记警告，不影响同插件的技能、Hook、MCP 与其他子代理。
 */
import { LineCounter, parseDocument } from "yaml";
import type { Platform } from "../platform/index.js";
import {
  isValidSubagentProfileName,
  REASONING_EFFORT_ORDER,
  type PluginAgentOverview,
  type ReasoningEffort,
} from "../protocol/index.js";
import type { PluginSubagentSpec } from "./types.js";

export const MAX_PLUGIN_AGENT_DESCRIPTION_CHARS = 300;
export const MAX_PLUGIN_AGENT_BODY_CHARS = 10_000;

const KNOWN_FRONTMATTER_KEYS = new Set(["name", "description", "tools", "effort"]);
const EFFORT_SET: ReadonlySet<string> = new Set(REASONING_EFFORT_ORDER);

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
  const warnings: string[] = [];
  const prefix = `plugin ${pluginLabel} 子代理 ${fileName}：`;
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    warnings.push(`${prefix}缺少 YAML frontmatter，已跳过`);
    return { warnings };
  }
  const end = normalized.indexOf("\n---", 4);
  if (end < 0 || !/^\n---(?:\n|$)/.test(normalized.slice(end))) {
    warnings.push(`${prefix}YAML frontmatter 未闭合，已跳过`);
    return { warnings };
  }

  const lineCounter = new LineCounter();
  const doc = parseDocument(normalized.slice(4, end), { lineCounter, uniqueKeys: true });
  const syntaxError = doc.errors[0];
  if (syntaxError !== undefined) {
    warnings.push(`${prefix}YAML frontmatter 解析失败（${syntaxError.message}），已跳过`);
    return { warnings };
  }

  let rawFields: unknown;
  try {
    rawFields = doc.toJS({ maxAliasCount: 100 }) ?? {};
  } catch (e) {
    warnings.push(
      `${prefix}YAML frontmatter 解析失败（${e instanceof Error ? e.message : String(e)}），已跳过`,
    );
    return { warnings };
  }
  if (typeof rawFields !== "object" || rawFields === null || Array.isArray(rawFields)) {
    warnings.push(`${prefix}YAML frontmatter 必须为字段映射，已跳过`);
    return { warnings };
  }
  const fields = rawFields as Record<string, unknown>;

  // 忽略其他字段（含 model），每条记录警告；插件不能替用户指定模型
  for (const key of Object.keys(fields)) {
    if (KNOWN_FRONTMATTER_KEYS.has(key)) continue;
    if (key === "model") {
      warnings.push(`${prefix}忽略不支持的字段 model（插件不能替用户指定模型）`);
    } else {
      warnings.push(`${prefix}忽略未知字段 ${key}`);
    }
  }

  // name：必填，规则同 isValidSubagentProfileName
  if (typeof fields.name !== "string" || !isValidSubagentProfileName(fields.name)) {
    warnings.push(`${prefix}缺少或无效的 name 字段，已跳过`);
    return { warnings };
  }
  const name = fields.name;

  // description：必填，非空，不超过 300 字（不截断）
  if (typeof fields.description !== "string" || fields.description.trim() === "") {
    warnings.push(`${prefix}缺少有效的 description 字段，已跳过`);
    return { warnings };
  }
  const description = fields.description.trim();
  if (Array.from(description).length > MAX_PLUGIN_AGENT_DESCRIPTION_CHARS) {
    warnings.push(`${prefix}description 超过 ${MAX_PLUGIN_AGENT_DESCRIPTION_CHARS} 字上限，已跳过`);
    return { warnings };
  }

  // tools：可选，非空字符串数组
  let tools: string[] | undefined;
  if (fields.tools !== undefined) {
    if (
      !Array.isArray(fields.tools) ||
      !fields.tools.every((item): item is string => typeof item === "string" && item.trim() !== "")
    ) {
      warnings.push(`${prefix}tools 必须是非空字符串数组，已跳过`);
      return { warnings };
    }
    tools = [...new Set(fields.tools.map((item) => item.trim()))];
  }

  // effort：可选，取值同档位 effort
  let effort: ReasoningEffort | undefined;
  if (fields.effort !== undefined) {
    if (typeof fields.effort !== "string" || !EFFORT_SET.has(fields.effort)) {
      warnings.push(`${prefix}effort 字段无效，已跳过`);
      return { warnings };
    }
    effort = fields.effort as ReasoningEffort;
  }

  // 正文：必填，非空，最长 10,000 字
  const body = normalized.slice(end + 4).trim();
  if (body === "") {
    warnings.push(`${prefix}角色说明正文不能为空，已跳过`);
    return { warnings };
  }
  if (Array.from(body).length > MAX_PLUGIN_AGENT_BODY_CHARS) {
    warnings.push(`${prefix}角色说明正文超过 ${MAX_PLUGIN_AGENT_BODY_CHARS} 字上限，已跳过`);
    return { warnings };
  }

  return {
    agent: {
      name,
      description,
      prompt: body,
      ...(effort !== undefined ? { effort } : {}),
      ...(tools !== undefined ? { tools } : {}),
    },
    warnings,
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
