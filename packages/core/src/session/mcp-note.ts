import type { DurablePayload } from "../protocol/index.js";

/** ADR-0071：措辞只依赖持久字段，恢复时不查询连接状态。 */
export function mcpAvailabilityNote(
  changes: NonNullable<DurablePayload<"session.config_changed">["mcp"]>,
): string {
  return changes
    .map((change) => {
      const server = JSON.stringify(change.server);
      if (change.available) return `MCP server ${server} is available again; its tools are loaded.`;
      const reason = change.reason ? ` (${change.reason.slice(0, 200)})` : "";
      const retry =
        change.autoRetry === false
          ? "Nocturne will not retry it automatically in this session. Ask the user to fix the server, then start a new session."
          : "Nocturne reconnects it automatically, so a new session will not help. If the user needs it, ask them to check that the server is running.";
      return `MCP server ${server} is unavailable${reason}. ${retry}`;
    })
    .map((text) => `[Environment change] ${text}`)
    .join("\n");
}
