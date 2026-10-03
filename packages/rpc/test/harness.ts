import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createCredentialStore,
  createPlatform,
  createRuntime,
  FakeProvider,
  loadConfig,
  type CredentialBackend,
  type CredentialStore,
  type FakeScript,
  type ModelInfo,
  type Runtime,
  type RuntimeConfig,
  type RuntimeSession,
  type UpstreamModelEntry,
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

export interface ProviderHarness extends Harness {
  /** 本连接的 <NOCTURNE_HOME>（providers.json、credentials.json 所在） */
  home: string;
  /** 握手时注入的配置对象（重载前的"启动时对象"） */
  config: RuntimeConfig;
  credentials: CredentialStore;
  /** reload 被调用的次数（含并发度统计） */
  reloadCount: () => number;
  maxConcurrentReloads: () => number;
  /** 服务端发给客户端的每一行线上报文（原文；敏感参数检查用） */
  wire: string[];
}

export interface ProviderHarnessOptions extends HarnessOptions {
  /** 凭据后端：默认 memory（可写不落盘）；none 表示"无系统后端"场景 */
  credentialBackend?: CredentialBackend;
  /** 直接注入凭据存储（覆盖 credentialBackend；敏感参数测试注入抛错的 store） */
  credentials?: CredentialStore;
  /** 注入 loadConfig 的 env（隔离真实环境变量，只含测试变量） */
  env?: Record<string, string>;
  /** refreshUpstreamLimits 的上游实现返回的模型 */
  upstreamModels?: UpstreamModelEntry[];
  /** 复用既有配置对象（模拟新连接注入同一份配置；缺省按 home 新加载） */
  config?: RuntimeConfig;
  /** reload 抛错（验证"重载失败则请求失败、写入已生效"的语义） */
  reloadError?: Error;
  /** 不注入 providerConfig（provider.* / login.* 全部报 provider_config_unavailable） */
  noProviderConfig?: boolean;
}

/**
 * 带真实 RuntimeConfig 的连接：临时 NOCTURNE_HOME、注入的 env、
 * memory/none 凭据后端、离线 modelsDevFetch/upstreamFetch；完全离线。
 * reload 与首次加载用同一组参数（复用同一个凭据 store 实例），并计数/记录并发度。
 */
export async function connectWithConfig(
  options: ProviderHarnessOptions = {},
): Promise<ProviderHarness> {
  const ws = options.ws ?? tmpDir("nct-rpc-ws-");
  // 复用既有配置对象时沿用它的 home（providers.json 必须还是那一份）
  const home = options.config?.nocturneHome ?? tmpDir("nct-rpc-home-");
  const platform = createPlatform();
  const env = (name: string): string | undefined => options.env?.[name];
  const credentials =
    options.credentials ??
    options.config?.credentials ??
    (
      await createCredentialStore(platform, home, {
        backend: options.credentialBackend ?? "memory",
      })
    ).store;
  const load = (): Promise<RuntimeConfig> =>
    loadConfig(platform, {
      nocturneHome: home,
      env,
      credentials,
      modelsDevFetch: () => Promise.reject(new Error("离线测试：models.dev 不可用")),
      upstreamFetch: () => Promise.resolve(options.upstreamModels ?? []),
    });
  const config = options.config ?? (await load());
  let reloadCount = 0;
  let inflight = 0;
  let maxInflight = 0;
  const reload = async (): Promise<RuntimeConfig> => {
    reloadCount += 1;
    inflight += 1;
    maxInflight = Math.max(maxInflight, inflight);
    try {
      if (options.reloadError !== undefined) throw options.reloadError;
      return await load();
    } finally {
      inflight -= 1;
    }
  };
  const provider =
    options.provider ?? new FakeProvider({ scripts: options.scripts ?? [], models: VISION_MODELS });
  const inits: Harness["inits"] = [];
  const runtimes: Runtime[] = [];
  const opened = new Map<string, RuntimeSession>();
  const diagnostics: RpcDiagnostic[] = [];
  let disposed = false;
  const server = createRpcServer({
    nocturneVersion: "0.0.0-test",
    diagnostics: (record) => diagnostics.push(record),
    createRuntime: async (init) => {
      inits.push(init);
      const runtime = await createRuntime({
        cwd: ws,
        config,
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
        sessionsDir: config.sessionsDir,
        dispose: () => {
          disposed = true;
        },
        ...(options.noProviderConfig === true
          ? {}
          : { providerConfig: { config, reload, workspaceRoot: ws } }),
      };
    },
  });
  const [serverEnd, clientEnd] = createMemoryTransportPair();
  const served = server.serve(serverEnd);
  const wire: string[] = [];
  const recordingEnd: LineTransport = {
    send: (line) => clientEnd.send(line),
    onLine: (handler) => {
      clientEnd.onLine((line) => {
        wire.push(line);
        handler(line);
      });
    },
    onClose: (handler) => clientEnd.onClose(handler),
    close: () => clientEnd.close(),
    ...(clientEnd.flush !== undefined
      ? { flush: () => clientEnd.flush?.() ?? Promise.resolve() }
      : {}),
  };
  const client = createRpcClient(recordingEnd, {
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
    sessionsDir: config.sessionsDir,
    inits,
    runtimes,
    durable: (sessionId) => opened.get(sessionId)?.durableEvents() ?? [],
    diagnostics,
    served,
    disposed: () => disposed,
    home,
    config,
    credentials,
    reloadCount: () => reloadCount,
    maxConcurrentReloads: () => maxInflight,
    wire,
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
