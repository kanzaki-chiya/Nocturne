import type { McpServerViewState, SessionView } from "@nocturne/core/protocol";

/**
 * MCP 连接状态类警告的 code（取值见 docs/protocols/events.md 的 runtime.warning）。
 * 服务器连不上、断开、缺凭据、缺环境变量都是运行状态而不是对话内容；view.notices
 * 只增不减，放进消息流会在整个会话里一直挂着。桌面端不在消息流渲染它们，
 * 改由状态栏按 view.mcpServers 的当前状态显示「MCP 未连接」标记（desktop.md）。
 * mcp_tool_conflict、mcp_tools_changed 等其他 MCP 提示仍留在消息流。
 */
export const MCP_STATE_NOTICE_CODES: ReadonlySet<string> = new Set([
  "mcp_server_failed",
  "mcp_server_crashed",
  "mcp_secret_missing",
  "mcp_env_missing",
]);

export interface UnavailableMcpServer extends McpServerViewState {
  name: string;
}

/** 当前处于 failed / crashed 的服务器，按名称排序 */
export function unavailableMcpServers(view: SessionView): UnavailableMcpServer[] {
  return Object.entries(view.mcpServers)
    .filter(([, server]) => server.state === "failed" || server.state === "crashed")
    .map(([name, server]) => ({ name, ...server }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
