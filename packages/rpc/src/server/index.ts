/**
 * @nocturne/rpc/server — RPC 服务端（ADR-0044）。
 * 与传输无关：`createRpcServer(...).serve(transport)`；stdio 是第一种接入。
 */
export { createRpcServer, SENSITIVE_METHODS } from "./server.js";
export type { RpcDiagnostic, RpcRuntimeHandle, RpcServer, RpcServerOptions } from "./server.js";
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
export type { RpcMethodName, RpcMethods } from "../shared/methods.js";
