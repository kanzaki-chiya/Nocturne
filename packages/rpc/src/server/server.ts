/**
 * RPC 服务端（ADR-0044）：给定一个 Runtime，把公开 API 映射成 JSON-RPC 方法，
 * 把会话事件推成 `event` 通知。与传输无关：只接收按行收发的 LineTransport。
 *
 * 一个服务端同一时刻只接一个客户端，可同时打开多个会话。权限判定仍只在
 * Runtime 的权限层——这里只转发 `permission.requested` 事件与回复（AGENTS.md 硬性约束）。
 */
import {
  isReasoningEffort,
  MODEL_ROLES,
  type ContentBlock,
  type CreateSessionOptions,
  type JevEndpoint,
  type JevReviewerConfig,
  type ModelRole,
  type PermissionReply,
  type QuestionReply,
  type RewindMode,
  type Runtime,
  type RuntimeEvent,
  type RuntimeSession,
  type SubmitInput,
} from "@nocturne/core";

import {
  encodeMessage,
  invalidRequestFailure,
  isRpcId,
  parseLine,
  RPC_PROTOCOL_VERSION,
  type RpcFailure,
  type RpcId,
  type RpcMessage,
} from "../shared/jsonrpc.js";
import {
  RPC_METHOD_NAMES,
  type RpcMethodName,
  type RpcMethods,
  type SessionOpened,
  type WireAttachment,
} from "../shared/methods.js";
import type { LineTransport } from "../shared/transport.js";
import { MethodNotFoundError, RpcProtocolError, toRpcError } from "./errors.js";
import {
  asParams,
  decodeBase64,
  InvalidParamsError,
  optBool,
  optInt,
  optString,
  reqInt,
  reqModel,
  reqObject,
  reqString,
  type Params,
} from "./params.js";

/** createRuntime 的产物：Runtime 加上服务端要对外报告与收尾的信息 */
export interface RpcRuntimeHandle {
  runtime: Runtime;
  /** 会话日志目录，握手时作为只读信息返回 */
  sessionsDir?: string | undefined;
  /** 全部会话关闭之后调用，释放 Runtime 之外的资源 */
  dispose?: (() => Promise<void> | void) | undefined;
}

export interface RpcServerOptions {
  nocturneVersion: string;
  /**
   * 握手后创建 Runtime：客户端声明的 `interactive` 能力决定 Runtime 的 `interactive`
   * （权限请求能否交给客户端；false 时按非交互规则处理）。
   */
  createRuntime(init: { clientName: string; interactive: boolean }): Promise<RpcRuntimeHandle>;
  /** 订阅回放每批推送的事件数，批间让出事件循环（默认 256） */
  replayChunkSize?: number | undefined;
  /** 回放批间的让出点，默认 setImmediate；测试可注入以在回放中途暂停，制造"回放期间有新事件" */
  replayYield?: (() => Promise<void>) | undefined;
  /** 诊断记录：只含方法名与结果，永远不含参数（参数里可能有密钥明文） */
  diagnostics?: ((record: RpcDiagnostic) => void) | undefined;
}

export type RpcDiagnostic =
  | { kind: "connection"; state: "open" | "closed" }
  | { kind: "request"; id: RpcId; method: string }
  | { kind: "notification"; method: string }
  | { kind: "response"; id: RpcId | null; ok: boolean; errorCode?: string };

export interface RpcServer {
  /** 本服务端实现的请求方法（不含通知）；覆盖测试用它与公开 API 对照 */
  readonly methods: readonly RpcMethodName[];
  /**
   * 在一条传输上服务一个客户端。输入结束时中断 Turn、等待在途请求并刷出回复，
   * 再关闭全部会话（刷盘、释放锁）和释放 Runtime 资源。shutdown 先清理再回复。
   */
  serve(transport: LineTransport): Promise<void>;
}

const DEFAULT_REPLAY_CHUNK = 256;

interface OpenSession {
  session: RuntimeSession;
  unsubscribe: (() => void) | undefined;
  /** 每次 subscribe/unsubscribe/close 递增；回放循环发现自己过期就停手 */
  generation: number;
}

type Handler<K extends RpcMethodName> = (
  params: Params,
) => Promise<RpcMethods[K]["result"]> | RpcMethods[K]["result"];
type HandlerTable = { [K in RpcMethodName]: Handler<K> };

export function createRpcServer(options: RpcServerOptions): RpcServer {
  let serving = false;
  return {
    methods: RPC_METHOD_NAMES,
    async serve(transport) {
      if (serving) throw new Error("RPC 服务端同一时刻只接一个客户端");
      serving = true;
      try {
        await new Connection(options, transport).run();
      } finally {
        serving = false;
      }
    },
  };
}

class Connection {
  private handle: RpcRuntimeHandle | undefined;
  private initPromise: Promise<void> | undefined;
  private initialized = false;
  private shuttingDown = false;
  private closed = false;
  private inputEnded = false;
  private readonly requests = new Set<Promise<void>>();
  private cleanupPromise: Promise<void> | undefined;
  private readonly sessions = new Map<string, OpenSession>();
  private readonly opening = new Set<Promise<unknown>>();
  private readonly abort = new AbortController();
  private readonly handlers: HandlerTable;

  constructor(
    private readonly options: RpcServerOptions,
    private readonly transport: LineTransport,
  ) {
    this.handlers = this.buildHandlers();
  }

  run(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.diagnose({ kind: "connection", state: "open" });
      this.transport.onLine((line) => {
        this.onLine(line);
      });
      this.transport.onClose(() => {
        this.inputEnded = true;
        for (const entry of this.sessions.values()) entry.session.interrupt();
        void (async () => {
          await Promise.allSettled([...this.requests]);
          await this.transport.flush?.();
          await this.cleanup();
          this.closed = true;
          this.diagnose({ kind: "connection", state: "closed" });
          resolve();
        })();
      });
    });
  }

  // ── 报文收发 ─────────────────────────────────────────────

  private diagnose(record: RpcDiagnostic): void {
    try {
      this.options.diagnostics?.(record);
    } catch {
      // 诊断回调出错不影响服务
    }
  }

  private send(message: RpcMessage): void {
    if (this.closed) return;
    try {
      this.transport.send(encodeMessage(message));
    } catch {
      // 传输已断开：由 onClose 收尾
    }
  }

  private fail(failure: RpcFailure): void {
    this.diagnose({
      kind: "response",
      id: failure.id,
      ok: false,
      ...(failure.error.data?.code !== undefined ? { errorCode: failure.error.data.code } : {}),
    });
    this.send(failure);
  }

  private onLine(line: string): void {
    if (line.trim() === "") return;
    const parsed = parseLine(line);
    if (parsed.kind === "error") {
      this.fail(parsed.failure);
      return;
    }
    const message = parsed.message;
    const id = message.id;
    const method = message.method;
    if (message.jsonrpc !== "2.0") {
      this.fail(invalidRequestFailure(isRpcId(id) ? id : null, 'jsonrpc 必须是 "2.0"'));
      return;
    }
    if (typeof method !== "string") {
      // 客户端发来的应答：服务端不发请求，直接忽略
      if ("result" in message || "error" in message) return;
      this.fail(invalidRequestFailure(isRpcId(id) ? id : null, "缺少 method"));
      return;
    }
    if (id === undefined) {
      this.onNotification(method, message.params);
      return;
    }
    if (!isRpcId(id)) {
      this.fail(invalidRequestFailure(null, "id 必须是字符串或数字"));
      return;
    }
    const request = this.onRequest(id, method, message.params);
    this.requests.add(request);
    void request.finally(() => this.requests.delete(request));
  }

  private onNotification(method: string, params: unknown): void {
    this.diagnose({ kind: "notification", method });
    if (method === "session.interrupt") this.interrupt(params);
    // 其他通知没有定义，忽略
  }

  private interrupt(params: unknown): void {
    try {
      const sessionId = reqString(asParams(params), "sessionId");
      this.sessions.get(sessionId)?.session.interrupt();
    } catch {
      // 通知没有应答：参数不对就当没发
    }
  }

  private async onRequest(id: RpcId, method: string, params: unknown): Promise<void> {
    this.diagnose({ kind: "request", id, method });
    try {
      let result: unknown;
      if (method === "session.interrupt") {
        // 允许以请求形式发中断（便于需要确认送达的客户端）
        this.interrupt(params);
        result = null;
      } else {
        result = await this.dispatch(method, params);
      }
      this.diagnose({ kind: "response", id, ok: true });
      this.send({ jsonrpc: "2.0", id, result: result ?? null });
      if (method === "shutdown") this.transport.close();
    } catch (error) {
      const err = toRpcError(error);
      this.fail({ jsonrpc: "2.0", id, error: err });
    }
  }

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    if (!Object.hasOwn(this.handlers, method)) {
      throw new MethodNotFoundError(method);
    }
    const name = method as RpcMethodName;
    if (name !== "initialize" && name !== "shutdown") {
      // 管线化的客户端可能在 initialize 未返回时就发后续请求：等握手结束
      if (this.initPromise !== undefined) await this.initPromise.catch(() => undefined);
      if (!this.initialized) {
        throw new RpcProtocolError("not_initialized", "第一条请求必须是 initialize");
      }
      if (this.shuttingDown) throw new RpcProtocolError("shutting_down", "服务端正在关闭");
    }
    const handler = this.handlers[name] as (p: Params) => unknown;
    const result = handler(asParams(params));
    // EOF 可能发生在等待 initialize 时；刚开始的 Turn/压缩同样必须中断。
    if (this.inputEnded) {
      for (const entry of this.sessions.values()) entry.session.interrupt();
    }
    return await result;
  }

  // ── 生命周期 ─────────────────────────────────────────────

  /** 中断运行中的 Turn、关闭全部会话、释放 Runtime 资源；幂等 */
  private cleanup(): Promise<void> {
    this.cleanupPromise ??= (async () => {
      this.shuttingDown = true;
      this.abort.abort();
      // 握手与会话打开可能还在途中：等它们落定，新打开的会话在 register 里被直接关闭
      await this.initPromise?.catch(() => undefined);
      await Promise.allSettled([...this.opening]);
      const entries = [...this.sessions.values()];
      this.sessions.clear();
      for (const entry of entries) {
        entry.generation++;
        entry.unsubscribe?.();
        entry.session.interrupt();
      }
      await Promise.allSettled(entries.map((entry) => entry.session.close()));
      await this.handle?.dispose?.();
    })();
    return this.cleanupPromise;
  }

  private runtime(): Runtime {
    if (this.handle === undefined) {
      throw new RpcProtocolError("not_initialized", "第一条请求必须是 initialize");
    }
    return this.handle.runtime;
  }

  private session(p: Params): OpenSession {
    const sessionId = reqString(p, "sessionId");
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) {
      throw new RpcProtocolError("unknown_session", `没有打开的会话：${sessionId}`);
    }
    return entry;
  }

  /** 登记一个新打开的会话；服务端已在关闭时直接关掉它 */
  private async register(session: RuntimeSession): Promise<SessionOpened> {
    if (this.shuttingDown) {
      await session.close().catch(() => undefined);
      throw new RpcProtocolError("shutting_down", "服务端正在关闭");
    }
    this.sessions.set(session.id, { session, unsubscribe: undefined, generation: 0 });
    const state = session.state();
    return {
      sessionId: session.id,
      meta: state.meta,
      config: state.config,
      warnings: [...session.warnings],
      ...(session.recovery !== undefined ? { recovery: session.recovery } : {}),
      lastSeq: state.lastSeq,
    };
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.opening.add(promise);
    const done = () => {
      this.opening.delete(promise);
    };
    promise.then(done, done);
    return promise;
  }

  // ── 订阅与回放 ───────────────────────────────────────────

  /**
   * 先挂监听并缓冲，再推 seq > afterSeq 的持久事件（分批，批间让出事件循环），
   * 之后按 seq 去重冲刷缓冲，再转实时（events.md 第 1 节、ADR-0044 第 5 节）。
   * 临时事件不回放，只有订阅之后发生的才会推。
   */
  private async subscribe(entry: OpenSession, afterSeq: number): Promise<number> {
    entry.unsubscribe?.();
    const generation = ++entry.generation;
    const sessionId = entry.session.id;
    const chunk = Math.max(1, this.options.replayChunkSize ?? DEFAULT_REPLAY_CHUNK);
    let lastSeq = afterSeq;
    let replaying = true;
    const buffer: RuntimeEvent[] = [];

    const push = (event: RuntimeEvent): void => {
      if (entry.generation !== generation) return;
      if ("seq" in event) {
        // 持久事件按 seq 去重：已在回放里推过的（含"已写日志、尚未分发给监听器"的）跳过
        if (event.seq <= lastSeq) return;
        lastSeq = event.seq;
      }
      this.send({ jsonrpc: "2.0", method: "event", params: { sessionId, event } });
    };

    entry.unsubscribe = entry.session.subscribe((event) => {
      if (replaying) buffer.push(event);
      else push(event);
    });

    const snapshot = entry.session.durableEvents().filter((event) => event.seq > afterSeq);
    for (let i = 0; i < snapshot.length; i += chunk) {
      if (entry.generation !== generation) return lastSeq;
      for (const event of snapshot.slice(i, i + chunk)) push(event);
      if (i + chunk < snapshot.length) {
        await (this.options.replayYield?.() ?? new Promise<void>((r) => setImmediate(r)));
      }
    }
    replaying = false;
    for (const event of buffer.splice(0)) push(event);
    return lastSeq;
  }

  // ── 方法表 ───────────────────────────────────────────────

  private buildHandlers(): HandlerTable {
    return {
      initialize: async (p) => {
        if (this.initPromise !== undefined) {
          throw new RpcProtocolError("already_initialized", "initialize 只能调用一次");
        }
        const version = reqInt(p, "protocolVersion");
        if (version !== RPC_PROTOCOL_VERSION) {
          throw new RpcProtocolError(
            "protocol_version_mismatch",
            `协议版本不一致：客户端 ${version}，服务端 ${RPC_PROTOCOL_VERSION}`,
          );
        }
        const clientName = reqString(p, "clientName");
        const interactive = optBool(reqObject(p, "capabilities"), "interactive") ?? false;
        const init = this.options
          .createRuntime({ clientName, interactive })
          .then((handle) => {
            this.handle = handle;
            this.initialized = true;
          })
          .catch((error: unknown) => {
            // 创建失败：允许客户端修正后重试
            this.initPromise = undefined;
            throw error;
          });
        this.initPromise = init;
        await init;
        return {
          protocolVersion: RPC_PROTOCOL_VERSION,
          nocturneVersion: this.options.nocturneVersion,
          ...(this.handle?.sessionsDir !== undefined
            ? { sessionsDir: this.handle.sessionsDir }
            : {}),
        };
      },
      shutdown: async () => {
        await this.cleanup();
        return null;
      },

      "runtime.listSessions": (p) => {
        const cwd = optString(p, "cwd");
        const includeSubagents = optBool(p, "includeSubagents");
        return this.runtime().listSessions({
          ...(cwd !== undefined ? { cwd } : {}),
          ...(includeSubagents !== undefined ? { includeSubagents } : {}),
        });
      },
      "runtime.createSession": (p) =>
        this.track(
          (async () => {
            const options: CreateSessionOptions = { model: reqModel(p, "model") };
            const preset = optString(p, "permissionPreset");
            if (preset !== undefined) options.permissionPreset = preset;
            const effort = optString(p, "reasoningEffort");
            if (effort !== undefined) {
              if (!isReasoningEffort(effort)) {
                throw new InvalidParamsError(`reasoningEffort 不是已知档位：${effort}`);
              }
              options.reasoningEffort = effort;
            }
            return await this.register(await this.runtime().createSession(options));
          })(),
        ),
      "runtime.resumeSession": (p) =>
        this.track(
          (async () => {
            const sessionId = reqString(p, "sessionId");
            if (this.sessions.has(sessionId)) {
              throw new RpcProtocolError(
                "session_already_open",
                `会话已在本连接中打开：${sessionId}`,
              );
            }
            const force = optBool(p, "force");
            const model =
              p.model === undefined || p.model === null ? undefined : reqModel(p, "model");
            const session = await this.runtime().resumeSession(sessionId, {
              ...(force !== undefined ? { force } : {}),
              ...(model !== undefined ? { model } : {}),
            });
            return await this.register(session);
          })(),
        ),
      "runtime.forkSession": async (p) => {
        const targetSeq = optInt(p, "targetSeq");
        const sessionId = await this.runtime().forkSession(reqString(p, "sessionId"), {
          ...(targetSeq !== undefined ? { targetSeq } : {}),
        });
        return { sessionId };
      },
      "runtime.listModels": () => this.runtime().listModels(),
      "runtime.defaultModel": () => this.runtime().defaultModel() ?? null,
      "runtime.listRecentModels": () => this.runtime().listRecentModels(),
      "runtime.describeSettings": () => this.runtime().describeSettings(),
      "runtime.updateSettings": (p) => {
        const reviewerKey = optString(p, "reviewerKey");
        return this.runtime().updateSettings(
          reqObject(p, "patch"),
          reviewerKey !== undefined ? { reviewerKey } : undefined,
        );
      },
      "runtime.setDefaultModel": (p) => {
        const effort = optString(p, "reasoningEffort");
        if (effort !== undefined && !isReasoningEffort(effort)) {
          throw new InvalidParamsError(`reasoningEffort 不是已知档位：${effort}`);
        }
        return this.runtime().setDefaultModel(reqString(p, "model"), effort ?? null);
      },
      "runtime.describeModelRoles": () => this.runtime().describeModelRoles(),
      "runtime.setModelRole": (p) => {
        const role = reqString(p, "role");
        if (!(MODEL_ROLES as readonly string[]).includes(role)) {
          throw new InvalidParamsError(`role 必须是 ${MODEL_ROLES.join("/")} 之一`);
        }
        return this.runtime().setModelRole(role as ModelRole, optString(p, "ref") ?? null);
      },
      "runtime.getPreference": (p) => this.runtime().getPreference(reqString(p, "key")) ?? null,
      "runtime.setPreference": async (p) => {
        await this.runtime().setPreference(reqString(p, "key"), optString(p, "value"));
        return null;
      },
      "runtime.listReviewerProviders": () => this.runtime().listReviewerProviders(),
      "runtime.defaultReviewer": (p) => {
        const baseURL = optString(p, "baseURL");
        return this.runtime().defaultReviewer(reqString(p, "endpoint") as JevEndpoint, baseURL);
      },
      "runtime.listReviewerModels": (p) =>
        this.runtime().listReviewerModels(
          reqObject(p, "reviewer") as unknown as JevReviewerConfig,
          this.abort.signal,
        ),

      "session.subscribe": async (p) => {
        const entry = this.session(p);
        const lastSeq = await this.subscribe(entry, optInt(p, "afterSeq") ?? 0);
        return { lastSeq };
      },
      "session.unsubscribe": (p) => {
        const entry = this.session(p);
        entry.generation++;
        entry.unsubscribe?.();
        entry.unsubscribe = undefined;
        return null;
      },
      "session.submit": async (p) => {
        const { session } = this.session(p);
        const input: SubmitInput = {};
        const text = optString(p, "text");
        if (text !== undefined) input.text = text;
        if (p.content !== undefined && p.content !== null) {
          input.content = parseContent(p.content);
        }
        if (p.attachments !== undefined && p.attachments !== null) {
          input.attachments = parseAttachments(p.attachments);
        }
        return await session.submit(input);
      },
      "session.respondPermission": async (p) => {
        await this.session(p).session.respondPermission(
          reqString(p, "requestId"),
          reqObject(p, "reply") as unknown as PermissionReply,
        );
        return null;
      },
      "session.respondQuestion": async (p) => {
        await this.session(p).session.respondQuestion(
          reqString(p, "requestId"),
          reqObject(p, "reply") as unknown as QuestionReply,
        );
        return null;
      },
      "session.setModel": async (p) => {
        await this.session(p).session.setModel(reqModel(p, "model"));
        return null;
      },
      "session.setPermissionPreset": async (p) => {
        await this.session(p).session.setPermissionPreset(reqString(p, "name"));
        return null;
      },
      "session.setReasoningEffort": async (p) => {
        await this.session(p).session.setReasoningEffort(reqString(p, "level"));
        return null;
      },
      "session.setShell": async (p) => {
        await this.session(p).session.setShell(reqString(p, "kind"));
        return null;
      },
      "session.compact": async (p) => {
        await this.session(p).session.compact();
        return null;
      },
      "session.rewindTargets": (p) => this.session(p).session.rewindTargets(),
      "session.rewind": (p) => {
        const mode = reqString(p, "mode");
        return this.session(p).session.rewind(reqInt(p, "targetSeq"), mode as RewindMode);
      },
      "session.state": (p) => {
        const state = this.session(p).session.state();
        return {
          meta: state.meta,
          config: state.config,
          todos: state.todos,
          usage: state.usage,
          lastSeq: state.lastSeq,
          openTurn: state.openTurn,
        };
      },
      "session.describeContext": (p) => {
        const built = this.session(p).session.describeContext();
        return {
          report: built.report,
          overBudget: built.overBudget,
          mustCompact: built.mustCompact,
          ...(built.compaction !== undefined ? { compaction: built.compaction } : {}),
          ...(built.missingAttachments !== undefined
            ? { missingAttachments: built.missingAttachments }
            : {}),
        };
      },
      "session.reasoningEffortInfo": (p) => this.session(p).session.reasoningEffortInfo(),
      "session.shellInfo": (p) => this.session(p).session.shellInfo(),
      "session.listShells": (p) => this.session(p).session.listShells(),
      "session.visionInfo": (p) => this.session(p).session.visionInfo(),
      "session.mcpServers": (p) => this.session(p).session.mcpServers(),
      "session.fileIndex": (p) => this.session(p).session.fileIndex(),
      "session.readInputHistory": (p) => this.session(p).session.readInputHistory(),
      "session.recordInputHistory": async (p) => {
        await this.session(p).session.recordInputHistory(reqString(p, "text"));
        return null;
      },
      "session.close": async (p) => {
        const entry = this.session(p);
        this.sessions.delete(entry.session.id);
        entry.generation++;
        entry.unsubscribe?.();
        await entry.session.close();
        return null;
      },
    };
  }
}

function parseContent(value: unknown): ContentBlock[] {
  if (!Array.isArray(value)) throw new InvalidParamsError("content 必须是数组");
  for (const block of value) {
    if (
      typeof block !== "object" ||
      block === null ||
      typeof (block as { type?: unknown }).type !== "string"
    ) {
      throw new InvalidParamsError("content 的每一项必须是带 type 的对象");
    }
  }
  return value as ContentBlock[];
}

function parseAttachments(value: unknown): NonNullable<SubmitInput["attachments"]> {
  if (!Array.isArray(value)) throw new InvalidParamsError("attachments 必须是数组");
  return value.map((raw: unknown, i) => {
    const o = asParams(raw) as Partial<Record<keyof WireAttachment, unknown>>;
    if (typeof o.data !== "string") {
      throw new InvalidParamsError(`attachments[${i}].data 必须是 base64 字符串`);
    }
    if (typeof o.mimeType !== "string") {
      throw new InvalidParamsError(`attachments[${i}].mimeType 必须是字符串`);
    }
    if (o.label !== undefined && typeof o.label !== "string") {
      throw new InvalidParamsError(`attachments[${i}].label 必须是字符串`);
    }
    return {
      data: decodeBase64(o.data, `attachments[${i}].data`),
      mimeType: o.mimeType as WireAttachment["mimeType"],
      ...(o.label !== undefined ? { label: o.label } : {}),
    };
  });
}
