/**
 * 假 RPC 服务端：createMemoryTransportPair 一端给 createRpcClient，
 * 另一端按方法名查表应答；同时记录全部请求供断言。
 */
import {
  createMemoryTransportPair,
  createRpcClient,
  type LineTransport,
} from "@nocturne/rpc/client";

export interface RpcCall {
  method: string;
  params: Record<string, unknown>;
}

/** 返回值可以是 Promise：用于模拟迟到的响应 */
type Handler = (params: Record<string, unknown>) => unknown;

/** 让 handler 返回 JSON-RPC 错误（code/message/data 原样放进 error 对象）。 */
export class RpcFail {
  constructor(
    readonly code: number,
    readonly message: string,
    readonly data?: { code?: string; field?: string; name?: string },
  ) {}
}

export function fakeServer(handlers: Record<string, Handler | unknown>) {
  const [clientEnd, serverEnd] = createMemoryTransportPair();
  const calls: RpcCall[] = [];
  const notifications: { method: string; params: unknown }[] = [];

  serverEnd.onLine((line) => {
    const request = JSON.parse(line) as {
      id?: unknown;
      method?: string;
      params?: Record<string, unknown>;
    };
    // 通知没有 id：只记录（假服务端不主动发通知，客户端发的通知在此归档）
    if (request.id === undefined) return;
    calls.push({ method: request.method ?? "", params: request.params ?? {} });
    const entry = request.method !== undefined ? handlers[request.method] : undefined;
    if (entry === undefined) {
      serverEnd.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32601, message: `未模拟的方法 ${request.method}` },
        }),
      );
      return;
    }
    const reply = (result: unknown) => {
      if (result instanceof RpcFail) {
        serverEnd.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            error: {
              code: result.code,
              message: result.message,
              ...(result.data !== undefined ? { data: result.data } : {}),
            },
          }),
        );
        return;
      }
      serverEnd.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: result ?? null }));
    };
    const fail = (error: unknown) => {
      serverEnd.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32000, message: String(error) },
        }),
      );
    };
    try {
      const result = typeof entry === "function" ? (entry as Handler)(request.params ?? {}) : entry;
      if (result instanceof Promise) result.then(reply, fail);
      else reply(result);
    } catch (error) {
      fail(error);
    }
  });

  const client = createRpcClient(clientEnd, { clientName: "test", interactive: false });
  return {
    client,
    calls,
    notifications,
    /** 服务端 → 客户端通知 */
    notify(method: string, params: unknown) {
      serverEnd.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
      notifications.push({ method, params });
    },
    server: serverEnd as LineTransport,
    async initialize() {
      await client.initialize();
    },
    close() {
      client.close();
      serverEnd.close();
    },
  };
}

/** initialize 的默认应答 */
export const INIT_RESULT = { protocolVersion: 1, nocturneVersion: "test" };

/** 构造带 initialize 应答的 handlers */
export function withInit(handlers: Record<string, Handler | unknown>) {
  return { initialize: INIT_RESULT, ...handlers };
}
