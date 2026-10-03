import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createRuntime,
  FakeProvider,
  type FakeScript,
  type ModelInfo,
  type Runtime,
  type RuntimeSession,
} from "@nocturne/core";
import type { DurableEvent } from "@nocturne/core/protocol";
import {
  createRpcClient,
  createMemoryTransportPair,
  type RpcClient,
  type LineTransport,
} from "@nocturne/rpc/client";
import { createRpcServer, type RpcDiagnostic, type RpcServer } from "@nocturne/rpc/server";

const roots: string[] = [];

export function tmpDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

export function cleanupTmp(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}

export const MODEL = "fake/fake-model";

/** 带图片输入能力的假模型（附件测试用） */
export const VISION_MODELS: ModelInfo[] = [
  {
    ref: { provider: "fake", model: "fake-model" },
    capabilities: {
      toolCalls: true,
      parallelToolCalls: true,
      reasoning: "none",
      imageInput: true,
      promptCache: false,
      editTool: "edit",
    },
  },
];

export const textScript = (text: string): FakeScript => [
  { type: "text_delta", text },
  { type: "finish", reason: "stop" },
];

export interface Harness {
  server: RpcServer;
  client: RpcClient;
  /** client 使用的传输端（测试可直接关闭它模拟断线） */
  clientTransport: LineTransport;
  provider: FakeProvider;
  ws: string;
  sessionsDir: string;
  /** createRuntime 工厂收到的握手信息 */
  inits: { clientName: string; interactive: boolean }[];
  runtimes: Runtime[];
  /** 服务端 Runtime 里打开过的进程内会话（同一份持久事件的"进程内"一侧） */
  durable(sessionId: string): readonly DurableEvent[];
  diagnostics: RpcDiagnostic[];
  /** serve() 的 promise：断开或 shutdown 清理完成后 resolve */
  served: Promise<void>;
  disposed: () => boolean;
}

export interface HarnessOptions {
  scripts?: FakeScript[];
  provider?: FakeProvider;
  interactive?: boolean;
  initialize?: boolean;
  replayChunkSize?: number;
  replayYield?: () => Promise<void>;
  sessionsDir?: string;
  ws?: string;
}

/** 内存管道连接 server 与 client；不 initialize 时由测试自己握手 */
export async function connect(options: HarnessOptions = {}): Promise<Harness> {
  const ws = options.ws ?? tmpDir("nct-rpc-ws-");
  const sessionsDir = options.sessionsDir ?? tmpDir("nct-rpc-sessions-");
  const provider =
    options.provider ?? new FakeProvider({ scripts: options.scripts ?? [], models: VISION_MODELS });
  const inits: Harness["inits"] = [];
  const runtimes: Runtime[] = [];
  const opened = new Map<string, RuntimeSession>();
  const diagnostics: RpcDiagnostic[] = [];
  let disposed = false;
  const server = createRpcServer({
    nocturneVersion: "0.0.0-test",
    ...(options.replayChunkSize !== undefined ? { replayChunkSize: options.replayChunkSize } : {}),
    ...(options.replayYield !== undefined ? { replayYield: options.replayYield } : {}),
    diagnostics: (record) => diagnostics.push(record),
    createRuntime: async (init) => {
      inits.push(init);
      const runtime = await createRuntime({
        cwd: ws,
        sessionsDir,
        providers: [provider],
        interactive: init.interactive,
      });
      runtimes.push(runtime);
      const remember = (session: RuntimeSession): RuntimeSession => {
        opened.set(session.id, session);
        return session;
      };
      const observed: Runtime = {
        ...runtime,
        createSession: async (o) => remember(await runtime.createSession(o)),
        resumeSession: async (id, o) => remember(await runtime.resumeSession(id, o)),
      };
      return {
        runtime: observed,
        sessionsDir,
        dispose: () => {
          disposed = true;
        },
      };
    },
  });
  const [serverEnd, clientEnd] = createMemoryTransportPair();
  const served = server.serve(serverEnd);
  const client = createRpcClient(clientEnd, {
    clientName: "rpc-test",
    interactive: options.interactive ?? true,
  });
  if (options.initialize !== false) await client.initialize();
  return {
    server,
    client,
    clientTransport: clientEnd,
    provider,
    ws,
    sessionsDir,
    inits,
    runtimes,
    durable: (sessionId) => opened.get(sessionId)?.durableEvents() ?? [],
    diagnostics,
    served,
    disposed: () => disposed,
  };
}

export async function until(
  check: () => boolean,
  label = "条件",
  timeoutMs = 10_000,
): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export interface RawHarness {
  send(message: unknown): void;
  sendLine(line: string): void;
  /** 收到的全部报文（已解析） */
  received: Record<string, unknown>[];
  waitFor(match: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>;
  served: Promise<void>;
  transport: LineTransport;
  inits: Harness["inits"];
}

/** 不带 client：直接按行与服务端说话，测试协议层行为 */
export async function connectRaw(options: HarnessOptions = {}): Promise<RawHarness> {
  const ws = options.ws ?? tmpDir("nct-rpc-ws-");
  const sessionsDir = options.sessionsDir ?? tmpDir("nct-rpc-sessions-");
  const provider =
    options.provider ?? new FakeProvider({ scripts: options.scripts ?? [], models: VISION_MODELS });
  const inits: Harness["inits"] = [];
  const server = createRpcServer({
    nocturneVersion: "0.0.0-test",
    createRuntime: async (init) => {
      inits.push(init);
      return {
        runtime: await createRuntime({
          cwd: ws,
          sessionsDir,
          providers: [provider],
          interactive: init.interactive,
        }),
      };
    },
  });
  const [serverEnd, clientEnd] = createMemoryTransportPair();
  const served = server.serve(serverEnd);
  const received: Record<string, unknown>[] = [];
  const waiters: {
    match: (m: Record<string, unknown>) => boolean;
    resolve: (m: Record<string, unknown>) => void;
  }[] = [];
  clientEnd.onLine((line) => {
    const message = JSON.parse(line) as Record<string, unknown>;
    received.push(message);
    for (const w of [...waiters]) {
      if (w.match(message)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(message);
      }
    }
  });
  clientEnd.onClose(() => undefined);
  return {
    send: (message) => {
      clientEnd.send(JSON.stringify(message));
    },
    sendLine: (line) => {
      clientEnd.send(line);
    },
    received,
    waitFor: (match) => {
      const found = received.find(match);
      if (found !== undefined) return Promise.resolve(found);
      return new Promise((resolve) => waiters.push({ match, resolve }));
    },
    served,
    transport: clientEnd,
    inits,
  };
}
