import {
  estimateTokens,
  type JsonSchema,
  type McpToolSearchMode,
  type ToolSpec,
} from "../protocol/index.js";
import type { McpServerStatus, ToolDefinition } from "./types.js";

export type { McpToolSearchMode };

export const MCP_SEARCH_TOOL_NAME = "mcp_search";
export const MCP_CALL_TOOL_NAME = "mcp_call";
export const MCP_TOOL_SEARCH_AUTO_THRESHOLD = 10_000;
export const MAX_MCP_SEARCH_RESULTS = 5;

const CJK_CHAR_RE =
  /[\p{Unified_Ideograph}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script=Hangul}]/gu;
const WORD_RE = /[a-z0-9]+/gu;

/** 从 MCP 工具注册名 `mcp__<server>__<tool>` 提取服务器名。 */
export function mcpServerOfTool(tool: Pick<ToolDefinition, "name">): string {
  if (tool.name.startsWith("mcp__")) {
    const rest = tool.name.slice("mcp__".length);
    const sep = rest.indexOf("__");
    if (sep > 0) return rest.slice(0, sep);
  }
  return "mcp";
}

/** 估算一组 MCP 工具定义序列化后的 token 数（与 Context Builder 工具定义段同口径）。 */
export function estimateMcpToolsTokens(tools: readonly ToolDefinition[]): number {
  if (tools.length === 0) return 0;
  const specs: ToolSpec[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
  return estimateTokens(JSON.stringify(specs));
}

/** ADR-0067 §4：判定当前会话是否启用 MCP 工具按需加载。 */
export function shouldEnableMcpToolSearch(
  tools: readonly ToolDefinition[],
  mode: McpToolSearchMode = "auto",
): boolean {
  if (tools.length === 0) return false;
  if (mode === "always") return true;
  if (mode === "never") return false;
  return estimateMcpToolsTokens(tools) > MCP_TOOL_SEARCH_AUTO_THRESHOLD;
}

/** 递归提取 JSON Schema 中的参数名与参数说明。 */
function extractSchemaTerms(
  schema: unknown,
  paramNames: Set<string>,
  paramDescs: string[],
  visited = new Set<unknown>(),
): void {
  if (schema === null || typeof schema !== "object" || visited.has(schema)) return;
  visited.add(schema);
  const obj = schema as Record<string, unknown>;
  if (obj.properties !== null && typeof obj.properties === "object") {
    for (const [key, prop] of Object.entries(obj.properties as Record<string, unknown>)) {
      paramNames.add(key.toLowerCase());
      if (prop !== null && typeof prop === "object") {
        const desc = (prop as { description?: unknown }).description;
        if (typeof desc === "string" && desc !== "") paramDescs.push(desc.toLowerCase());
        extractSchemaTerms(prop, paramNames, paramDescs, visited);
      }
    }
  }
  if (obj.items !== undefined) {
    extractSchemaTerms(obj.items, paramNames, paramDescs, visited);
  }
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    if (Array.isArray(obj[key])) {
      for (const sub of obj[key] as unknown[]) {
        extractSchemaTerms(sub, paramNames, paramDescs, visited);
      }
    }
  }
}

/** 拆分搜索词：英文/数字按词段拆分，CJK 字符按单字拆分（不区分大小写）。 */
export function tokenizeMcpQuery(query: string): { words: string[]; cjk: string[] } {
  const lower = query.toLowerCase().trim();
  const words = [...new Set(lower.match(WORD_RE) ?? [])];
  const cjk = [...new Set(lower.match(CJK_CHAR_RE) ?? [])];
  return { words, cjk };
}

/**
 * ADR-0067 §1：按关键词在 MCP 工具池中匹配名称、说明和参数名（不区分大小写，CJK 按字拆分），
 * 最多返回 5 个结果；完整工具名（`mcp__<server>__<tool>`）可直接精确命中。
 */
export function searchMcpTools(
  tools: readonly ToolDefinition[],
  query: string,
  server?: string,
): ToolDefinition[] {
  const serverFilter = server?.trim().toLowerCase();
  const candidates =
    serverFilter !== undefined && serverFilter !== ""
      ? tools.filter((t) => mcpServerOfTool(t).toLowerCase() === serverFilter)
      : tools;
  if (candidates.length === 0) return [];

  const q = query.trim().toLowerCase();
  if (q === "") return candidates.slice(0, MAX_MCP_SEARCH_RESULTS);

  // 完整工具名精确命中
  const exact = candidates.find((t) => t.name.toLowerCase() === q);
  if (exact !== undefined) return [exact];

  const { words, cjk } = tokenizeMcpQuery(q);
  const scored: { tool: ToolDefinition; score: number; index: number }[] = [];

  for (const [index, tool] of candidates.entries()) {
    const fullName = tool.name.toLowerCase();
    const serverName = mcpServerOfTool(tool).toLowerCase();
    const shortName = fullName.startsWith(`mcp__${serverName}__`)
      ? fullName.slice(`mcp__${serverName}__`.length)
      : fullName;
    const nameParts = new Set(shortName.split(/_+/).filter(Boolean));
    const desc = tool.description.toLowerCase();
    const paramNames = new Set<string>();
    const paramDescs: string[] = [];
    extractSchemaTerms(tool.inputSchema, paramNames, paramDescs);
    const allDesc = paramDescs.length > 0 ? `${desc}\n${paramDescs.join("\n")}` : desc;

    let score = 0;
    if (shortName === q || `${serverName}/${shortName}` === q) score += 500;
    else if (fullName.includes(q)) score += 120;
    if (paramNames.has(q)) score += 80;
    if (allDesc.includes(q)) score += 40;

    for (const word of words) {
      if (nameParts.has(word) || serverName === word) score += 30;
      else if (fullName.includes(word)) score += 20;
      if (paramNames.has(word)) score += 18;
      else if ([...paramNames].some((p) => p.includes(word))) score += 12;
      if (allDesc.includes(word)) score += 10;
    }

    for (const ch of cjk) {
      if (fullName.includes(ch)) score += 12;
      if ([...paramNames].some((p) => p.includes(ch))) score += 8;
      if (allDesc.includes(ch)) score += 5;
    }

    if (score > 0) {
      scored.push({ tool, score, index });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, MAX_MCP_SEARCH_RESULTS).map((entry) => entry.tool);
}

export interface McpSearchMatch {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface McpSearchOutput {
  query: string;
  server?: string | undefined;
  matches: McpSearchMatch[];
}

function formatSearchMatches(
  matches: readonly ToolDefinition[],
  query: string,
  server: string | undefined,
  serverNames: readonly string[],
): string {
  if (matches.length === 0) {
    const scopeText = server !== undefined && server !== "" ? `（限定服务器 ${server}）` : "";
    const avail =
      serverNames.length > 0 ? `可用服务器：${serverNames.join(", ")}` : "当前无可用 MCP 服务器";
    return `未找到匹配 "${query}" 的 MCP 工具${scopeText}。${avail}`;
  }
  return matches
    .map(
      (t) =>
        `### ${t.name}\n说明：${t.description || "（无说明）"}\n参数 schema：${JSON.stringify(t.inputSchema)}`,
    )
    .join("\n\n");
}

/**
 * ADR-0067 §1–§2：构造按需模式下的 `mcp_search` 与 `mcp_call` 工具对。
 * - `mcp_search` 说明按服务器列出全部工具名，模型搜到后用 `mcp_call` 调用；
 * - `mcp_call` 通过 `traits.dispatch` 将调用解析为目标 MCP 工具与参数对象。
 */
export function createMcpOnDemandTools(
  mcpTools: readonly ToolDefinition[],
  availableServers: readonly string[] = [],
  serverStatus: () => readonly McpServerStatus[] = () => [],
): {
  searchTool: ToolDefinition<{ query: string; server?: string | undefined }, McpSearchOutput>;
  callTool: ToolDefinition<{ tool: string; arguments?: Record<string, unknown> | undefined }>;
} {
  const byServer = new Map<string, string[]>();
  const toolMap = new Map<string, ToolDefinition>();
  for (const t of mcpTools) {
    toolMap.set(t.name, t);
    const srv = mcpServerOfTool(t);
    const list = byServer.get(srv) ?? [];
    list.push(t.name);
    byServer.set(srv, list);
  }
  const serverNames = [...new Set([...availableServers, ...byServer.keys()])];
  const catalogLines = [...byServer.entries()].map(
    ([srv, names]) => `- ${srv}: ${names.join(", ")}`,
  );

  const searchDescription = [
    "按关键词搜索当前会话可用的 MCP 工具，返回最多 5 个匹配工具的完整名称、说明与参数 inputSchema。找到目标工具后用 mcp_call 调用；传入完整工具名可直接精确查看其定义。",
    ...(catalogLines.length > 0 ? ["可用 MCP 工具（按服务器）：", ...catalogLines] : []),
  ].join("\n");

  const searchTool: ToolDefinition<
    { query: string; server?: string | undefined },
    McpSearchOutput
  > = {
    name: MCP_SEARCH_TOOL_NAME,
    description: searchDescription,
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "搜索关键词（匹配工具名、说明与参数名，不区分大小写；可传完整工具名精确查看）",
        },
        server: {
          type: "string",
          description: "可选：限定在指定 MCP 服务器内搜索",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    traits: {
      mutates: false,
      fileEffects: "none",
      concurrencySafe: true,
      timeoutMs: 5_000,
    },
    permissionSubjects: () => [],
    execute(input) {
      const matched = searchMcpTools(mcpTools, input.query, input.server);
      const matches: McpSearchMatch[] = matched.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
      return Promise.resolve({
        status: "ok",
        modelContent: formatSearchMatches(matched, input.query, input.server, serverNames),
        output: {
          query: input.query,
          ...(input.server !== undefined && input.server !== "" ? { server: input.server } : {}),
          matches,
        },
      });
    },
  };

  const callTool: ToolDefinition<{
    tool: string;
    arguments?: Record<string, unknown> | undefined;
  }> = {
    name: MCP_CALL_TOOL_NAME,
    description:
      "按完整名称调用当前会话可用的 MCP 工具（如 mcp__<server>__<tool>），arguments 传入目标工具的参数对象。",
    inputSchema: {
      type: "object",
      properties: {
        tool: {
          type: "string",
          description: "目标 MCP 工具的完整名称（如 mcp__<server>__<tool>）",
        },
        arguments: {
          type: "object",
          description: "传给目标 MCP 工具的参数对象",
        },
      },
      required: ["tool"],
      additionalProperties: false,
    },
    traits: {
      mutates: mcpTools.some((t) => t.traits.mutates),
      ...(mcpTools.length > 0 && mcpTools.every((t) => t.traits.fileEffects === "none")
        ? { fileEffects: "none" as const }
        : {}),
      concurrencySafe: true,
      timeoutMs: 60_000,
      dispatch(raw) {
        const input = raw as { tool?: unknown; arguments?: unknown };
        const targetName = typeof input.tool === "string" ? input.tool.trim() : "";
        const target = toolMap.get(targetName);
        if (target === undefined) {
          const unavailable = serverStatus().find(
            (s) =>
              ["failed", "crashed", "starting"].includes(s.state) &&
              targetName.startsWith(`mcp__${s.name.toLowerCase().replace(/[^a-z0-9_]/g, "_")}__`),
          );
          const problem =
            unavailable === undefined
              ? `MCP 工具 "${targetName}" 不存在或不在本会话工具池中。`
              : `MCP 服务器 "${unavailable.name}" 当前不可用（${(unavailable.state === "starting" ? "startup timed out" : (unavailable.error ?? "未知原因")).slice(0, 200)}）。`;
          return {
            code: "unknown_tool",
            error: `${problem}可用服务器：${serverNames.length > 0 ? serverNames.join(", ") : "（无）"}。请先用 mcp_search 搜索可用工具，再用 mcp_call 调用。`,
          };
        }
        if (
          input.arguments !== undefined &&
          (typeof input.arguments !== "object" ||
            input.arguments === null ||
            Array.isArray(input.arguments))
        ) {
          return {
            code: "invalid_input",
            error: `工具 "${target.name}" 的 arguments 必须是对象\n目标工具 inputSchema：${JSON.stringify(target.inputSchema)}`,
          };
        }
        return {
          tool: target,
          input: input.arguments ?? {},
        };
      },
    },
    permissionSubjects: () => [],
    execute() {
      return Promise.reject(new Error("mcp_call 应由执行器经 traits.dispatch 分派"));
    },
  };

  return { searchTool, callTool };
}
