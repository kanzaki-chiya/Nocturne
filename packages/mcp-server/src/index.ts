/**
 * `@nocturne/mcp-server` — 对外 MCP 服务器桥（ADR-0074）。
 *
 * 对外是 stdio MCP 服务器（`@modelcontextprotocol/sdk`），对内是连接本机桌面后台的
 * RPC 客户端（`@nocturne/rpc/client` + `@nocturne/remote`）。不依赖 Core 运行时，
 * 不直接读写会话日志或凭据存储。
 */
export {
  DESKTOP_NOT_RUNNING_MESSAGE,
  McpBridge,
  PAIRING_PENDING_MESSAGE,
  SUBAGENT_DENIED_MESSAGE,
  type McpBridgeOptions,
  type McpProgressUpdate,
  type McpToolCallContext,
  type McpToolCallResult,
} from "./bridge.js";
export {
  agentPipeAddress,
  connectAgentPipe,
  createSocketFrameTransport,
  currentUserSid,
  resolveNocturneHome,
  type ConnectAgentPipeOptions,
} from "./pipe.js";
export { loadOrCreateBridgeIdentity, type BridgeIdentityResult } from "./identity.js";
export {
  createNocturneMcpServer,
  NOCTURNE_MCP_TOOLS,
  runNocturneMcpStdioServer,
  type NocturneMcpServerHandle,
  type NocturneMcpServerOptions,
} from "./server.js";
export {
  deriveMcpSessionStatus,
  extractFoldedTurns,
  formatReadSessionOutput,
  MAX_MCP_OUTPUT_BYTES,
  truncateMcpOutput,
  type FoldedTurn,
  type McpSessionStatus,
  type ReadSessionFormatOptions,
} from "./view-format.js";
