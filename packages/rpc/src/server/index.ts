/**
 * @nocturne/rpc/server — RPC 服务端（ADR-0044）。
 * 与传输无关：`createRpcServer(...).serve(transport)`；stdio 是第一种接入。
 */
export {
  createRpcServer,
  SENSITIVE_METHODS,
  REMOTE_METHODS,
  AGENT_READONLY_METHODS,
  AGENT_RUN_METHODS,
  REMOTE_MESSAGE_LIMIT,
  remoteAttachmentLimit,
} from "./server.js";
export type {
  RpcDiagnostic,
  RpcRuntimeHandle,
  RpcServer,
  RpcServerOptions,
  ServeConnectionOptions,
} from "./server.js";
export {
  agentPipeAddress,
  connectAgentPipe,
  createSocketFrameTransport,
  currentUserSid,
  listenAgentPipe,
  readWindowsPipeAclRules,
  resolveNocturneHome,
  restrictWindowsPipeAclToCurrentUser,
  type AgentPipeListener,
  type ConnectAgentPipeOptions,
  type ListenAgentPipeOptions,
  type WindowsPipeAclRule,
} from "./agent/pipe.js";
export { createStdioTransport } from "./stdio.js";
export {
  CONFIG_METHODS,
  CONFIG_NOT_MAPPED,
  PROVIDER_FUNCTION_METHODS,
  PROVIDER_FUNCTIONS_NOT_MAPPED,
  RUNTIME_METHODS,
  RUNTIME_NOT_MAPPED,
  SESSION_METHODS,
  SESSION_NOT_MAPPED,
} from "./coverage.js";
export { createMemoryTransportPair } from "../shared/transport.js";
export type { LineTransport } from "../shared/transport.js";
export { RPC_ERROR, RPC_PROTOCOL_VERSION } from "../shared/jsonrpc.js";
export type {
  AgentDevice,
  AgentPairingRequest,
  AgentProcessInfo,
  AgentScope,
  AgentStatus,
  RpcMethodName,
  RpcMethods,
} from "../shared/methods.js";
