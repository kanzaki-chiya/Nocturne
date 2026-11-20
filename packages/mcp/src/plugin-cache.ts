/**
 * 插件 MCP 服务器工具列表缓存（ADR-0100 修订第 4 节、ADR-0101 第 2 节）。
 * - 路径：<NOCTURNE_HOME>/plugins/cache/mcp-tools/<slug>__<server>__<hash16>.json
 * - 缓存键：pluginId + serverId + 内置插件版本号（version）或已安装插件指纹（fingerprint）
 * - 写入采用「临时文件 + rename」原子替换；文件损坏、旧 schemaVersion 或键不匹配一律按未命中处理。
 */
import { createHash, randomUUID } from "node:crypto";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpAppToolMeta, Platform, PluginMcpCacheKey } from "@nocturne/core";

export interface CachedPluginMcpToolUi {
  resourceUri?: string | undefined;
  visibility?: ("model" | "app")[] | undefined;
  surface?: string | undefined;
}

export interface CachedPluginMcpTool {
  name: string;
  title?: string | undefined;
  description?: string | undefined;
  inputSchema: Tool["inputSchema"];
  annotations?: Tool["annotations"] | undefined;
  ui?: CachedPluginMcpToolUi | undefined;
}

export const PLUGIN_MCP_CACHE_SCHEMA_VERSION = 2;

export interface PluginMcpCacheEntry {
  schemaVersion: typeof PLUGIN_MCP_CACHE_SCHEMA_VERSION;
  pluginId: string;
  serverId: string;
  keyKind: "version" | "fingerprint";
  keyValue: string;
  serverInfo?: { name: string; version: string } | undefined;
  tools: CachedPluginMcpTool[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function slug(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 40) || "item";
}

export function pluginMcpCacheFileName(pluginId: string, serverId: string): string {
  const digest = createHash("sha256").update(`${pluginId}\0${serverId}`).digest("hex").slice(0, 16);
  return `${slug(pluginId)}__${slug(serverId)}__${digest}.json`;
}

export function pluginMcpCachePath(
  platform: Platform,
  cacheDir: string,
  pluginId: string,
  serverId: string,
): string {
  return platform.paths.join(cacheDir, pluginMcpCacheFileName(pluginId, serverId));
}

function parseCachedToolUi(raw: unknown): CachedPluginMcpToolUi | undefined | null {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) return null;
  let resourceUri: string | undefined;
  if (raw.resourceUri !== undefined) {
    if (typeof raw.resourceUri !== "string" || !raw.resourceUri.startsWith("ui://")) return null;
    resourceUri = raw.resourceUri;
  }
  let visibility: ("model" | "app")[] | undefined;
  if (raw.visibility !== undefined) {
    if (
      !Array.isArray(raw.visibility) ||
      !raw.visibility.every((v): v is "model" | "app" => v === "model" || v === "app")
    ) {
      return null;
    }
    visibility = [...new Set(raw.visibility)];
  }
  let surface: string | undefined;
  if (raw.surface !== undefined) {
    if (typeof raw.surface !== "string" || raw.surface === "") return null;
    surface = raw.surface;
  }
  return {
    ...(resourceUri !== undefined ? { resourceUri } : {}),
    ...(visibility !== undefined ? { visibility } : {}),
    ...(surface !== undefined ? { surface } : {}),
  };
}

function parseCachedTool(raw: unknown): CachedPluginMcpTool | undefined {
  if (!isPlainObject(raw)) return undefined;
  if (typeof raw.name !== "string" || raw.name === "") return undefined;
  if (raw.title !== undefined && typeof raw.title !== "string") return undefined;
  if (raw.description !== undefined && typeof raw.description !== "string") return undefined;
  if (!isPlainObject(raw.inputSchema)) return undefined;
  if (raw.annotations !== undefined && !isPlainObject(raw.annotations)) return undefined;
  const ui = parseCachedToolUi(raw.ui);
  if (ui === null) return undefined;
  return {
    name: raw.name,
    ...(raw.title !== undefined ? { title: raw.title } : {}),
    ...(raw.description !== undefined ? { description: raw.description } : {}),
    inputSchema: raw.inputSchema as Tool["inputSchema"],
    ...(raw.annotations !== undefined ? { annotations: raw.annotations } : {}),
    ...(ui !== undefined ? { ui } : {}),
  };
}

export function cachedToolToAppMeta(tool: CachedPluginMcpTool): McpAppToolMeta {
  return {
    name: tool.name,
    readOnly: tool.annotations?.readOnlyHint === true,
    visibility: tool.ui?.visibility ?? ["model", "app"],
    ...(tool.ui?.resourceUri !== undefined ? { resourceUri: tool.ui.resourceUri } : {}),
    ...(tool.ui?.surface !== undefined ? { surface: tool.ui.surface } : {}),
  };
}

export async function readPluginMcpCache(
  platform: Platform,
  cacheDir: string,
  serverId: string,
  key: PluginMcpCacheKey,
): Promise<PluginMcpCacheEntry | undefined> {
  const filePath = pluginMcpCachePath(platform, cacheDir, key.pluginId, serverId);
  let text: string;
  try {
    text = await platform.fs.readTextFile(filePath);
  } catch {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isPlainObject(raw)) return undefined;
  if (
    raw.schemaVersion !== PLUGIN_MCP_CACHE_SCHEMA_VERSION ||
    raw.pluginId !== key.pluginId ||
    raw.serverId !== serverId ||
    raw.keyKind !== key.keyKind ||
    raw.keyValue !== key.keyValue ||
    !Array.isArray(raw.tools)
  ) {
    return undefined;
  }
  let serverInfo: { name: string; version: string } | undefined;
  if (raw.serverInfo !== undefined) {
    if (
      !isPlainObject(raw.serverInfo) ||
      typeof raw.serverInfo.name !== "string" ||
      typeof raw.serverInfo.version !== "string"
    ) {
      return undefined;
    }
    serverInfo = { name: raw.serverInfo.name, version: raw.serverInfo.version };
  }
  const tools: CachedPluginMcpTool[] = [];
  for (const item of raw.tools) {
    const parsed = parseCachedTool(item);
    if (parsed === undefined) return undefined;
    tools.push(parsed);
  }
  return {
    schemaVersion: PLUGIN_MCP_CACHE_SCHEMA_VERSION,
    pluginId: key.pluginId,
    serverId,
    keyKind: key.keyKind,
    keyValue: key.keyValue,
    ...(serverInfo !== undefined ? { serverInfo } : {}),
    tools,
  };
}

export async function writePluginMcpCache(
  platform: Platform,
  cacheDir: string,
  entry: PluginMcpCacheEntry,
): Promise<void> {
  const filePath = pluginMcpCachePath(platform, cacheDir, entry.pluginId, entry.serverId);
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await platform.fs.mkdir(cacheDir);
    await platform.fs.writeFile(tmpPath, `${JSON.stringify(entry, null, 2)}\n`);
    await platform.fs.rename(tmpPath, filePath);
  } catch {
    await platform.fs.unlink(tmpPath).catch(() => undefined);
  }
}

export function cachedToolsEqual(
  a: readonly CachedPluginMcpTool[],
  b: readonly CachedPluginMcpTool[],
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
