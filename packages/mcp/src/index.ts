/**
 * @nocturne/mcp：MCP stdio 客户端（docs/architecture/mcp.md、ADR-0011）。
 * 装配方（apps/*）注入 RuntimeOptions.mcp；Core 不反向依赖本包。
 */
export { createMcpConnector } from "./connector.js";
