import { describe, expect, it } from "vitest";
import { createMemoryTransportPair, createRpcClient } from "@nocturne/rpc/client";

import type { DesktopHost } from "../src/host";
import { DesktopError, TauriLineTransport } from "../src/transport";
import type { BackendMessage } from "../src/types";

interface RecordedInvoke {
  cmd: string;
  args: Record<string, unknown> | undefined;
}

/** 假宿主：记录 invoke、保存 channel 回调以便手动推消息、可手动控制 invoke 完成时机 */
function fakeHost() {
  const invokes: RecordedInvoke[] = [];
  const channelCallbacks: ((m: BackendMessage) => void)[] = [];
  const resolvers = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();
  let nextInvokeId = 0;

  const host: DesktopHost & {
    pushMessage: (m: BackendMessage) => void;
    resolveNext: (v: unknown) => void;
    rejectNext: (e: unknown) => void;
    onInvoke?: (r: RecordedInvoke) => Promise<unknown> | unknown;
  } = {
    pushMessage(m) {
      for (const cb of channelCallbacks) cb(m);
    },
    resolveNext(v) {
      const entry = resolvers.get(resolvers.size - 1);
      entry?.resolve(v);
      resolvers.delete(resolvers.size - 1);
    },
    rejectNext(e) {
      const entry = resolvers.get(resolvers.size - 1);
      entry?.reject(e);
      resolvers.delete(resolvers.size - 1);
    },
    invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
      const record: RecordedInvoke = { cmd, args };
      invokes.push(record);
      if (this.onInvoke !== undefined) {
        return Promise.resolve(this.onInvoke(record)) as Promise<T>;
      }
      const id = nextInvokeId++;
      return new Promise<T>((resolve, reject) => {
        resolvers.set(id, {
          resolve: (v) => resolve(v as T),
          reject,
        });
      });
    },
    createChannel(onMessage: (m: BackendMessage) => void): unknown {
      channelCallbacks.push(onMessage);
      return { kind: "channel" };
    },
    openUrl: () => Promise.resolve(),
    pickFolder: () => Promise.resolve(null),
  };

  return {
    host: host as DesktopHost,
    raw: host,
    invokes,
    pushMessage: host.pushMessage,
  };
}

async function openTransport() {
  const f = fakeHost();
  const opening = TauriLineTransport.open(f.host, "Z:\\repo");
  await Promise.resolve();
  (f.raw as { resolveNext: (v: unknown) => void }).resolveNext(1);
  const transport = await opening;
  return { ...f, transport };
}

describe("TauriLineTransport", () => {
  it("open 时 invoke backend_open 带 workspace 与 channel，返回 backendId", async () => {
    const { invokes, transport } = await openTransport();
    expect(transport.backendId).toBe(1);
    expect(invokes[0]?.cmd).toBe("backend_open");
    expect(invokes[0]?.args?.workspace).toBe("Z:\\repo");
    expect(invokes[0]?.args?.channel).toBeDefined();
  });

  it("注册 onLine 前到达的行被缓冲并按序交付", async () => {
    const { pushMessage, transport } = await openTransport();
    pushMessage({ kind: "line", line: "first" });
    pushMessage({ kind: "line", line: "second" });
    const lines: string[] = [];
    transport.onLine((l) => lines.push(l));
    expect(lines).toEqual(["first", "second"]);
    pushMessage({ kind: "line", line: "third" });
    expect(lines).toEqual(["first", "second", "third"]);
  });

  it("多次 send 即使 invoke 乱序完成也按调用顺序发出", async () => {
    const f = fakeHost();
    const opening = TauriLineTransport.open(f.host, "Z:\\repo");
    await Promise.resolve();
    f.raw.resolveNext(1);
    const transport = await opening;

    const deferreds: (() => void)[] = [];
    f.raw.onInvoke = () => new Promise((resolve) => deferreds.push(() => resolve(null)));

    transport.send("one");
    transport.send("two");
    transport.send("three");
    // 链上第一个 invoke 已发出，后面的排队等待
    await new Promise((r) => setTimeout(r, 0));
    expect(f.invokes.filter((i) => i.cmd === "backend_send")).toHaveLength(1);
    // 逐个放行，后续 invoke 才依次发出
    for (const release of deferreds.splice(0)) release();
    await new Promise((r) => setTimeout(r, 0));
    for (const release of deferreds.splice(0)) release();
    await new Promise((r) => setTimeout(r, 0));
    for (const release of deferreds.splice(0)) release();
    await transport.flush();
    const sends = f.invokes.filter((i) => i.cmd === "backend_send");
    expect(sends.map((s) => s.args?.line)).toEqual(["one", "two", "three"]);
  });

  it("第二次 backend_send invoke 在第一次 resolve 之后才发生", async () => {
    const f = fakeHost();
    const opening = TauriLineTransport.open(f.host, "Z:\\repo");
    await Promise.resolve();
    f.raw.resolveNext(1);
    const transport = await opening;

    const gates: (() => void)[] = [];
    const sendCalls: string[] = [];
    f.raw.onInvoke = (r) => {
      sendCalls.push(String(r.args?.line));
      return new Promise((resolve) => gates.push(() => resolve(null)));
    };
    transport.send("a");
    transport.send("b");
    await new Promise((r) => setTimeout(r, 0));
    expect(sendCalls).toEqual(["a"]);
    gates[0]?.();
    await new Promise((r) => setTimeout(r, 0));
    expect(sendCalls).toEqual(["a", "b"]);
    gates[1]?.();
    await transport.flush();
  });

  it("send 失败被吞掉", async () => {
    const f = fakeHost();
    const opening = TauriLineTransport.open(f.host, "Z:\\repo");
    await Promise.resolve();
    f.raw.resolveNext(1);
    const transport = await opening;
    f.raw.onInvoke = () => Promise.reject(new Error("write failed"));
    transport.send("x");
    await expect(transport.flush()).resolves.toBeUndefined();
  });

  it("closed 消息触发 onClose 一次且在之前的行之后；exited 带出 code/stderr", async () => {
    const { pushMessage, transport } = await openTransport();
    pushMessage({ kind: "line", line: "L1" });
    const order: string[] = [];
    transport.onLine((l) => order.push(`line:${l}`));
    let closes = 0;
    transport.onClose(() => {
      closes += 1;
      order.push("close");
    });
    pushMessage({ kind: "line", line: "L2" });
    pushMessage({ kind: "closed", code: 3, stderr: ["e1"] });
    expect(order).toEqual(["line:L1", "line:L2", "close"]);
    expect(closes).toBe(1);
    await expect(transport.exited).resolves.toEqual({ code: 3, stderr: ["e1"] });
    // 再注册 onClose 不再触发（已 fired）
    transport.onClose(() => {
      closes += 1;
    });
    expect(closes).toBe(1);
  });

  it("closed 在 onLine 注册前到达时缓冲行交付完才触发 onClose", async () => {
    const { pushMessage, transport } = await openTransport();
    const order: string[] = [];
    pushMessage({ kind: "line", line: "a" });
    pushMessage({ kind: "closed", code: 0, stderr: [] });
    // closed 已到但 onLine 尚未注册：不提前触发
    transport.onClose(() => order.push("close"));
    expect(order).toEqual([]);
    transport.onLine((l) => order.push(`line:${l}`));
    expect(order).toEqual(["line:a", "close"]);
  });

  it("关闭后 send 无操作", async () => {
    const f = fakeHost();
    const opening = TauriLineTransport.open(f.host, "Z:\\repo");
    await Promise.resolve();
    f.raw.resolveNext(1);
    const transport = await opening;
    f.pushMessage({ kind: "closed", code: 0, stderr: [] });
    f.raw.onInvoke = () => Promise.resolve(null);
    transport.send("late");
    await transport.flush();
    expect(f.invokes.filter((i) => i.cmd === "backend_send")).toHaveLength(0);
  });

  it("close() 只 invoke 一次 backend_close", async () => {
    const f = fakeHost();
    const opening = TauriLineTransport.open(f.host, "Z:\\repo");
    await Promise.resolve();
    f.raw.resolveNext(1);
    const transport = await opening;
    f.raw.onInvoke = () => Promise.resolve(null);
    transport.close();
    transport.close();
    await new Promise((r) => setTimeout(r, 0));
    expect(f.invokes.filter((i) => i.cmd === "backend_close")).toHaveLength(1);
  });

  it("backend_open 拒绝时抛 DesktopError 并带 code", async () => {
    const f = fakeHost();
    const opening = TauriLineTransport.open(f.host, "Z:\\nope");
    await Promise.resolve();
    f.raw.rejectNext({ code: "invalid_workspace", message: "工作区目录不存在" });
    await expect(opening).rejects.toMatchObject({
      name: "DesktopError",
      code: "invalid_workspace",
    });
    await expect(opening).rejects.toBeInstanceOf(DesktopError);
  });
});

describe("端到端：TauriLineTransport + createRpcClient", () => {
  it("经内存管道完成握手并列出会话，initialize 参数正确", async () => {
    const f = fakeHost();
    const [clientEnd, serverEnd] = createMemoryTransportPair();

    // 服务端发来的每一行转成 channel line 消息推给 transport
    clientEnd.onLine((line) => {
      f.pushMessage({ kind: "line", line });
    });

    // 假宿主把 backend_send 的行转给内存管道另一端
    f.raw.onInvoke = (r) => {
      if (r.cmd === "backend_open") return 42;
      if (r.cmd === "backend_send") {
        clientEnd.send(String(r.args?.line));
        return null;
      }
      return null;
    };

    // 最小 JSON-RPC 应答者：回 initialize 与 runtime.listSessions
    const seen: { method?: string; params?: unknown }[] = [];
    serverEnd.onLine((line) => {
      const msg = JSON.parse(line) as {
        id?: number;
        method: string;
        params?: unknown;
      };
      seen.push({ method: msg.method, params: msg.params });
      if (msg.method === "initialize") {
        serverEnd.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: { protocolVersion: 1, nocturneVersion: "0.5.0" },
          }),
        );
      } else if (msg.method === "runtime.listSessions") {
        serverEnd.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: [
              {
                id: "s1",
                createdAt: "2026-10-01T00:00:00Z",
                cwd: "Z:\\repo",
                workspaceRoot: "Z:\\repo",
                model: { provider: "p", model: "m" },
                mtimeMs: 1,
              },
            ],
          }),
        );
      }
    });

    const transport = await TauriLineTransport.open(f.host, "Z:\\repo");
    const client = createRpcClient(transport, {
      clientName: "nocturne-desktop",
      interactive: true,
    });
    const initResult = await client.initialize();
    expect(initResult.protocolVersion).toBe(1);
    const init = seen.find((s) => s.method === "initialize");
    const params = init?.params as { clientName: string; capabilities: { interactive: boolean } };
    expect(params.clientName).toBe("nocturne-desktop");
    expect(params.capabilities.interactive).toBe(true);

    const sessions = await client.runtime.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe("s1");
  });
});
