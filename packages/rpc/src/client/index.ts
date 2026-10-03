/**
 * @nocturne/rpc/client — RPC 类型化客户端（ADR-0044）。
 * 运行时只依赖 `@nocturne/core/protocol`；对 `@nocturne/core` 只有类型导入。
 */
export {
  createRpcClient,
  encodeBase64,
  RpcError,
  trackSessionView,
  type EventListener,
  type RpcClient,
  type RpcClientOptions,
  type RpcRuntime,
  type RpcSession,
  type SessionViewTracker,
  type SubscribeOptions,
  type Subscription,
} from "./client.js";
export { createMemoryTransportPair, type LineTransport } from "../shared/transport.js";
export { RPC_ERROR, RPC_PROTOCOL_VERSION } from "../shared/jsonrpc.js";
export type {
  ContextSummary,
  InitializeParams,
  InitializeResult,
  RpcMethodName,
  RpcMethods,
  RpcParams,
  RpcResult,
  SessionOpened,
  SessionStateSummary,
  WireAttachment,
} from "../shared/methods.js";
// 视图折叠用的 reducer 就是 protocol 里的同一份
export { createSessionView, reduceSessionView, replaySessionView } from "@nocturne/core/protocol";
