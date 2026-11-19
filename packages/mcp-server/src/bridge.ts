import {
  allPendingPermissions,
  type AggregatedPendingPermission,
  type PermissionReply,
  type QuestionAnswer,
  type RuntimeEvent,
  type SessionView,
} from "@nocturne/core/protocol";
import { connectChannel } from "@nocturne/remote";
import {
  createRpcClient,
  RpcError,
  trackSessionView,
  type AgentSelfInfo,
  type LineTransport,
  type RpcClient,
  type RpcSession,
  type SessionViewTracker,
} from "@nocturne/rpc/client";
import { loadOrCreateBridgeIdentity, type BridgeIdentityResult } from "./identity.js";
import { connectAgentPipe, WindowsSidError } from "./pipe.js";
import {
  deriveMcpSessionStatus,
  extractIncrementalWaitTurn,
  formatReadSessionOutput,
  MAX_MCP_OUTPUT_BYTES,
  truncateMcpOutput,
  type McpSessionStatus,
  type WaitToolCursor,
} from "./view-format.js";

export const DESKTOP_NOT_RUNNING_MESSAGE =
  "Nocturne desktop is not running. Ask the user to open it, then retry.";
export const PAIRING_PENDING_MESSAGE = "Waiting for the user to approve this agent in Nocturne.";
export const SUBAGENT_DENIED_MESSAGE = "不能直接操作子代理会话，请通过父会话观察";

export interface McpToolCallResult {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown> | undefined;
  isError?: boolean | undefined;
}

export interface McpProgressUpdate {
  progress: number;
  total?: number | undefined;
  message: string;
}

export interface McpToolCallContext {
  onProgress?: ((update: McpProgressUpdate) => void) | undefined;
}

export interface McpBridgeOptions {
  home?: string | undefined;
  name?: string | undefined;
  pipePath?: string | undefined;
  /** 测试可注入自定义底层传输工厂，跳过系统命名管道/Unix 套接字 */
  connectTransport?: (() => Promise<LineTransport>) | undefined;
}

interface TrackedBridgeSession {
  readonly sessionId: string;
  readonly clientId: string | undefined;
  readonly rpcSession: RpcSession;
  tracker: SessionViewTracker;
  readonly listeners: Set<(view: SessionView, event: RuntimeEvent) => void>;
  readonly waitWakeups: Set<() => void>;
  pendingInputIds: Set<string>;
  paused: boolean;
  startTokenSeq: number;
  activeStartToken: number | undefined;
  inTransition: boolean;
  lastReportedPermissionKeys: Set<string>;
  lastReportedQuestionId: string | undefined;
  waitToolCursor: WaitToolCursor | undefined;
}

export class McpBridge {
  private readonly options: McpBridgeOptions;
  private hostClientName: string | undefined;
  private identityPromise: Promise<BridgeIdentityResult> | undefined;
  private client: RpcClient | undefined;
  private connectingPromise: Promise<RpcClient> | undefined;
  private agentSelf: AgentSelfInfo | undefined;
  private readonly sessions = new Map<string, TrackedBridgeSession>();
  private closed = false;

  constructor(options: McpBridgeOptions = {}) {
    this.options = options;
  }

  /** 记录 MCP 客户端在 initialize 中上报的宿主名称（未显式传 --name 时采用） */
  setHostClientName(name: string | undefined): void {
    if (name !== undefined && name.trim() !== "") {
      this.hostClientName = name.trim();
    }
  }

  get effectiveName(): string {
    const trimmed = this.options.name?.trim();
    if (trimmed !== undefined && trimmed !== "") return trimmed;
    if (this.hostClientName !== undefined && this.hostClientName !== "") return this.hostClientName;
    return "MCP Bridge";
  }

  async getIdentity(): Promise<BridgeIdentityResult> {
    this.identityPromise ??= loadOrCreateBridgeIdentity({
      home: this.options.home,
      name: this.options.name,
    });
    return this.identityPromise;
  }

  /**
   * 尝试预连接桌面后台（供 MCP initialize 阶段非阻塞调用）：
   * - 桌面端运行时：建立加密管道连接并发送 RPC initialize，若未配对则立即触发桌面端配对弹窗；
   * - 桌面端未运行时：静默忽略，保证 MCP initialize 和 tools/list 照常成功。
   */
  async tryPreconnect(): Promise<void> {
    try {
      await this.ensureConnected();
    } catch {
      /* 桌面端未运行时静默忽略 */
    }
  }

  private async ensureConnected(): Promise<RpcClient> {
    if (this.closed) {
      throw new BridgeNotRunningError();
    }
    if (this.client !== undefined) {
      return this.client;
    }
    if (this.connectingPromise !== undefined) {
      return this.connectingPromise;
    }
    const task = (async () => {
      try {
        let transport: LineTransport;
        if (this.options.connectTransport !== undefined) {
          transport = await this.options.connectTransport();
        } else {
          const idResult = await this.getIdentity();
          const frameTransport = await connectAgentPipe({
            home: this.options.home,
            pipePath: this.options.pipePath,
            timeoutMs: 2500,
          });
          transport = await connectChannel(frameTransport, {
            identity: idResult.identity,
          });
        }
        const rpcClient = createRpcClient(transport, {
          clientName: this.effectiveName,
          interactive: false,
          processInfo: {
            pid: process.pid,
            ...(typeof process.ppid === "number" ? { ppid: process.ppid } : {}),
            command: process.argv.join(" "),
            cwd: process.cwd(),
          },
        });
        void rpcClient.closed.then(() => {
          if (this.client === rpcClient) {
            this.client = undefined;
            this.agentSelf = undefined;
            this.clearTrackedSessions();
          }
        });
        rpcClient.onNotification("agent.selfChanged", (info) => {
          if (this.client === rpcClient || this.connectingPromise === task) {
            this.agentSelf = info;
          }
        });
        const initRes = await rpcClient.initialize();
        if (initRes.agent !== undefined) {
          this.agentSelf = initRes.agent;
        }
        this.client = rpcClient;
        return rpcClient;
      } catch (error) {
        if (error instanceof RpcError && error.code === "agent_pairing_pending") {
          throw error;
        }
        if (error instanceof WindowsSidError) {
          throw error;
        }
        throw new BridgeNotRunningError(error instanceof Error ? error.message : String(error));
      } finally {
        this.connectingPromise = undefined;
      }
    })();
    this.connectingPromise = task;
    return task;
  }

  private clearTrackedSessions(): void {
    for (const s of this.sessions.values()) {
      s.listeners.clear();
      s.waitWakeups.clear();
    }
    this.sessions.clear();
  }

  async close(): Promise<void> {
    this.closed = true;
    const current = this.client;
    this.client = undefined;
    this.agentSelf = undefined;
    for (const s of this.sessions.values()) {
      s.listeners.clear();
      s.waitWakeups.clear();
      await s.tracker.stop().catch(() => undefined);
      await s.rpcSession.close().catch(() => undefined);
    }
    this.sessions.clear();
    if (current !== undefined) {
      current.close();
    }
  }

  async callTool(
    name: string,
    rawArgs: Record<string, unknown> | undefined,
    context?: McpToolCallContext,
  ): Promise<McpToolCallResult> {
    const args = rawArgs ?? {};
    try {
      switch (name) {
        case "nocturne_list_sessions":
          return await this.handleListSessions(args);
        case "nocturne_read_session":
          return await this.handleReadSession(args);
        case "nocturne_list_models":
          return await this.handleListModels(args);
        case "nocturne_start_session":
          return await this.handleStartSession(args, context);
        case "nocturne_send":
          return await this.handleSend(args, context);
        case "nocturne_wait":
          return await this.handleWait(args, context);
        case "nocturne_interrupt":
          return await this.handleInterrupt(args);
        case "nocturne_answer":
          return await this.handleAnswer(args, context);
        case "nocturne_respond_permission":
          return await this.handleRespondPermission(args, context);
        default:
          return this.errorResult(`未知的工具：${name}`);
      }
    } catch (error) {
      return this.mapError(error);
    }
  }

  private mapError(error: unknown): McpToolCallResult {
    if (error instanceof BridgeNotRunningError) {
      return this.errorResult(DESKTOP_NOT_RUNNING_MESSAGE);
    }
    if (error instanceof RpcError) {
      if (error.code === "agent_pairing_pending") {
        return this.errorResult(PAIRING_PENDING_MESSAGE);
      }
      if (
        error.code === "connection_closed" ||
        error.code === "runtime_unavailable" ||
        error.code === "shutting_down"
      ) {
        this.client = undefined;
        this.agentSelf = undefined;
        this.clearTrackedSessions();
        return this.errorResult(DESKTOP_NOT_RUNNING_MESSAGE);
      }
      return this.errorResult(error.message);
    }
    return this.errorResult(error instanceof Error ? error.message : String(error));
  }

  private textResult(text: string, structuredContent?: Record<string, unknown>): McpToolCallResult {
    return {
      content: [{ type: "text", text: truncateMcpOutput(text, MAX_MCP_OUTPUT_BYTES) }],
      ...(structuredContent !== undefined ? { structuredContent } : {}),
    };
  }

  private errorResult(text: string): McpToolCallResult {
    return {
      content: [{ type: "text", text: truncateMcpOutput(text, MAX_MCP_OUTPUT_BYTES) }],
      isError: true,
    };
  }

  private async resolveSubagentParentId(
    client: RpcClient,
    sessionId: string,
  ): Promise<string | undefined> {
    try {
      const summaries = await client.runtime.listSessions({ includeSubagents: true });
      return summaries.find((s) => s.id === sessionId)?.parent?.sessionId;
    } catch {
      return undefined;
    }
  }

  private async openSessionForRead(
    client: RpcClient,
    sessionId: string,
  ): Promise<TrackedBridgeSession> {
    const existing = this.sessions.get(sessionId);
    if (existing !== undefined) return existing;
    let clientId: string | undefined;
    try {
      const opened = await client.call("session.open", { sessionId });
      if (opened.meta.parent !== undefined) {
        await client.call("session.close", { sessionId }).catch(() => undefined);
        throw new SubagentSessionError(sessionId, opened.meta.parent.sessionId);
      }
      clientId = opened.meta.client?.id;
    } catch (error) {
      if (error instanceof SubagentSessionError) throw error;
      const parentId = await this.resolveSubagentParentId(client, sessionId);
      if (parentId !== undefined) {
        throw new SubagentSessionError(sessionId, parentId);
      }
      throw error;
    }
    const rpcSession = client.session(sessionId);
    return this.attachTracker(sessionId, rpcSession, clientId);
  }

  private async openSessionForRun(
    client: RpcClient,
    sessionId: string,
  ): Promise<TrackedBridgeSession> {
    const existing = this.sessions.get(sessionId);
    if (existing !== undefined) return existing;
    let rpcSession: RpcSession;
    let clientId: string | undefined;
    try {
      const resumed = await client.runtime.resumeSession(sessionId);
      if (resumed.opened.meta.parent !== undefined) {
        await resumed.session.close().catch(() => undefined);
        throw new SubagentSessionError(sessionId, resumed.opened.meta.parent.sessionId);
      }
      rpcSession = resumed.session;
      clientId = resumed.opened.meta.client?.id;
    } catch (error) {
      if (error instanceof SubagentSessionError) throw error;
      const parentId = await this.resolveSubagentParentId(client, sessionId);
      if (parentId !== undefined) {
        throw new SubagentSessionError(sessionId, parentId);
      }
      throw error;
    }
    return this.attachTracker(sessionId, rpcSession, clientId);
  }

  private async attachTracker(
    sessionId: string,
    rpcSession: RpcSession,
    clientId: string | undefined,
  ): Promise<TrackedBridgeSession> {
    const listeners = new Set<(view: SessionView, event: RuntimeEvent) => void>();
    const entry: TrackedBridgeSession = {
      sessionId,
      clientId,
      rpcSession,
      tracker: undefined as unknown as SessionViewTracker,
      listeners,
      waitWakeups: new Set<() => void>(),
      pendingInputIds: new Set<string>(),
      paused: false,
      startTokenSeq: 0,
      activeStartToken: undefined,
      inTransition: false,
      lastReportedPermissionKeys: new Set<string>(),
      lastReportedQuestionId: undefined,
      waitToolCursor: undefined,
    };
    const notifyListeners = (view: SessionView, event: RuntimeEvent): void => {
      for (const fn of [...listeners]) {
        fn(view, event);
      }
    };
    const tracker = await trackSessionView(rpcSession, (view, event) => {
      if (event.type === "turn.started") {
        clearStartTurn(entry);
        entry.inTransition = false;
      } else if (
        (event.type === "runtime.status" && event.payload.status === "idle") ||
        (event.type === "runtime.error" && event.payload.code === "session_failed") ||
        (event.type === "runtime.warning" && event.payload.code === "input_queue_failed")
      ) {
        entry.inTransition = false;
      } else if (event.type === "input.pending") {
        const prevSize = entry.pendingInputIds.size;
        const wasPaused = entry.paused;
        entry.pendingInputIds = new Set(event.payload.items.map((i) => i.id));
        entry.paused = event.payload.paused;
        // Core 取出队首后在 write turn.started 前存在异步间隙：
        // 过渡态仅由下一轮 turn.started、Core 延迟发出的 runtime.status("idle")
        // 或失败事件（runtime.error(session_failed) / runtime.warning(input_queue_failed)）解除，不用魔法计时器猜测
        if (
          prevSize > 0 &&
          entry.pendingInputIds.size === 0 &&
          !wasPaused &&
          view.currentTurn === undefined
        ) {
          entry.inTransition = true;
        }
      }
      notifyListeners(view, event);
    });
    entry.tracker = tracker;
    try {
      const pendingSnap = await rpcSession.pendingInputs();
      entry.pendingInputIds = new Set(pendingSnap.items.map((i) => i.id));
      entry.paused = pendingSnap.paused;
    } catch {
      /* 忽略快照获取失败 */
    }
    this.sessions.set(sessionId, entry);
    return entry;
  }

  private async handleListSessions(args: Record<string, unknown>): Promise<McpToolCallResult> {
    const client = await this.ensureConnected();
    const cwd =
      typeof args.cwd === "string" && args.cwd.trim() !== "" ? args.cwd.trim() : undefined;
    const limit =
      typeof args.limit === "number" && Number.isFinite(args.limit)
        ? Math.max(1, Math.min(200, Math.trunc(args.limit)))
        : 20;
    const all = await client.runtime.listSessions(cwd !== undefined ? { cwd } : undefined);
    const items = all.slice(0, limit).map((s) => ({
      sessionId: s.id,
      title: s.firstText ?? "(无标题)",
      cwd: s.cwd,
      workspaceRoot: s.workspaceRoot,
      updatedAt: new Date(s.mtimeMs).toISOString(),
      createdAt: s.createdAt,
      model: s.model,
      ...(s.client !== undefined ? { client: s.client } : {}),
    }));
    const payload = { total: all.length, sessions: items };
    return this.textResult(JSON.stringify(payload, null, 2), payload);
  }

  private async handleReadSession(args: Record<string, unknown>): Promise<McpToolCallResult> {
    const sessionId = typeof args.sessionId === "string" ? args.sessionId.trim() : "";
    if (!sessionId) {
      return this.errorResult("参数错误：需要非空 sessionId");
    }
    const rawTurns = args.turns ?? args.lastTurns;
    const turns =
      typeof rawTurns === "number" && Number.isFinite(rawTurns)
        ? Math.max(1, Math.trunc(rawTurns))
        : 3;
    const client = await this.ensureConnected();
    const tracked = await this.openSessionForRead(client, sessionId);
    const text = formatReadSessionOutput(tracked.tracker.view, {
      sessionId,
      turns,
      pendingCount: tracked.pendingInputIds.size,
      paused: tracked.paused,
      maxBytes: MAX_MCP_OUTPUT_BYTES,
    });
    return { content: [{ type: "text", text }] };
  }

  private async handleListModels(args: Record<string, unknown>): Promise<McpToolCallResult> {
    const client = await this.ensureConnected();
    const workspaceRoot =
      typeof args.workspaceRoot === "string" && args.workspaceRoot.trim() !== ""
        ? args.workspaceRoot.trim()
        : undefined;
    const [models, defaultModel] = await Promise.all([
      client.runtime.listModels(workspaceRoot !== undefined ? { workspaceRoot } : undefined),
      client.runtime.defaultModel(workspaceRoot !== undefined ? { workspaceRoot } : undefined),
    ]);
    const data = {
      defaultModel: defaultModel ?? null,
      models: models.map((m) => ({
        provider: m.ref.provider,
        model: m.ref.model,
        id: `${m.ref.provider}/${m.ref.model}`,
        ...(m.disabled !== undefined ? { disabled: m.disabled } : {}),
      })),
    };
    return this.textResult(JSON.stringify(data, null, 2), data);
  }

  private async handleStartSession(
    args: Record<string, unknown>,
    context?: McpToolCallContext,
  ): Promise<McpToolCallResult> {
    const cwd = typeof args.cwd === "string" ? args.cwd.trim() : "";
    const prompt = typeof args.prompt === "string" ? args.prompt : "";
    if (!cwd) return this.errorResult("参数错误：需要非空 cwd");
    if (!prompt.trim()) return this.errorResult("参数错误：需要非空 prompt");

    const title =
      typeof args.title === "string" && args.title.trim() !== "" ? args.title.trim() : undefined;
    const model =
      typeof args.model === "string" && args.model.trim() !== "" ? args.model.trim() : undefined;
    const permissionPreset =
      typeof args.permissionPreset === "string" && args.permissionPreset.trim() !== ""
        ? args.permissionPreset.trim()
        : undefined;
    const reasoningEffort =
      typeof args.reasoningEffort === "string" && args.reasoningEffort.trim() !== ""
        ? args.reasoningEffort.trim()
        : undefined;
    const wait = typeof args.wait === "boolean" ? args.wait : true;
    const timeoutSeconds =
      typeof args.timeoutSeconds === "number" && Number.isFinite(args.timeoutSeconds)
        ? args.timeoutSeconds
        : 300;

    const client = await this.ensureConnected();
    const opened = await client.call("runtime.createSession", {
      cwd,
      ...(model !== undefined ? { model } : {}),
      ...(permissionPreset !== undefined ? { permissionPreset } : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    } as never);
    const rpcSession = client.session(opened.sessionId);
    const tracked = await this.attachTracker(opened.sessionId, rpcSession, opened.meta.client?.id);

    let renameError: string | undefined;
    if (title !== undefined) {
      try {
        await client.runtime.renameSession(opened.sessionId, title);
      } catch (error) {
        renameError = error instanceof Error ? error.message : String(error);
      }
    }

    await this.triggerSubmitOnTracked(tracked, prompt);

    if (!wait) {
      return this.buildSessionWaitResult(tracked, {
        advanceCursor: false,
        requestedTitle: title,
        renameError,
      });
    }
    await this.waitForTrackedSessions([tracked], timeoutSeconds, context);
    return this.buildSessionWaitResult(tracked, {
      advanceCursor: true,
      requestedTitle: title,
      renameError,
    });
  }

  private async handleSend(
    args: Record<string, unknown>,
    context?: McpToolCallContext,
  ): Promise<McpToolCallResult> {
    const sessionId = typeof args.sessionId === "string" ? args.sessionId.trim() : "";
    const prompt = typeof args.prompt === "string" ? args.prompt : "";
    if (!sessionId) return this.errorResult("参数错误：需要非空 sessionId");
    if (!prompt.trim()) return this.errorResult("参数错误：需要非空 prompt");

    const wait = typeof args.wait === "boolean" ? args.wait : true;
    const timeoutSeconds =
      typeof args.timeoutSeconds === "number" && Number.isFinite(args.timeoutSeconds)
        ? args.timeoutSeconds
        : 300;

    const client = await this.ensureConnected();
    const tracked = await this.openSessionForRun(client, sessionId);

    // ADR-0074 §4：nocturne_send 走 enqueueInput 的 queue 模式：从不打断，忙时排到下一轮，空闲时立即开始
    await this.triggerEnqueueOnTracked(tracked, prompt);

    if (!wait) {
      return this.buildSessionWaitResult(tracked, { advanceCursor: false });
    }
    await this.waitForTrackedSessions([tracked], timeoutSeconds, context);
    return this.buildSessionWaitResult(tracked, { advanceCursor: true });
  }

  private async handleWait(
    args: Record<string, unknown>,
    context?: McpToolCallContext,
  ): Promise<McpToolCallResult> {
    const hasSingle = args.sessionId !== undefined;
    const hasMulti = args.sessionIds !== undefined;
    if (hasSingle && hasMulti) {
      return this.errorResult("参数错误：sessionId 与 sessionIds 请二选一");
    }
    if (!hasSingle && !hasMulti) {
      return this.errorResult("参数错误：需要非空 sessionId 或 sessionIds");
    }

    const timeoutSeconds =
      typeof args.timeoutSeconds === "number" && Number.isFinite(args.timeoutSeconds)
        ? args.timeoutSeconds
        : 300;

    if (hasSingle) {
      const sessionId = typeof args.sessionId === "string" ? args.sessionId.trim() : "";
      if (!sessionId) return this.errorResult("参数错误：需要非空 sessionId");
      const client = await this.ensureConnected();
      const tracked = await this.openSessionForRead(client, sessionId);
      await this.waitForTrackedSessions([tracked], timeoutSeconds, context);
      return this.buildSessionWaitResult(tracked, { advanceCursor: true });
    }

    if (!Array.isArray(args.sessionIds)) {
      return this.errorResult("参数错误：sessionIds 必须为非空字符串数组");
    }
    const dedupedIds: string[] = [];
    const seen = new Set<string>();
    for (const raw of args.sessionIds) {
      if (typeof raw !== "string" || raw.trim() === "") {
        return this.errorResult("参数错误：sessionIds 只能包含非空字符串");
      }
      const id = raw.trim();
      if (!seen.has(id)) {
        seen.add(id);
        dedupedIds.push(id);
      }
    }
    if (dedupedIds.length === 0) {
      return this.errorResult("参数错误：sessionIds 需要至少一个非空会话 ID");
    }

    const client = await this.ensureConnected();
    const trackedList: TrackedBridgeSession[] = [];
    for (const id of dedupedIds) {
      trackedList.push(await this.openSessionForRead(client, id));
    }
    const { readyIds, timedOut } = await this.waitForTrackedSessions(
      trackedList,
      timeoutSeconds,
      context,
    );
    const sessions = trackedList.map((tracked) => ({
      ...this.buildSessionWaitPayload(tracked, { advanceCursor: true }),
      ready: readyIds.has(tracked.sessionId),
    }));
    const payload: Record<string, unknown> = {
      timedOut,
      readySessionIds: trackedList.map((t) => t.sessionId).filter((id) => readyIds.has(id)),
      sessions,
    };
    return this.textResult(JSON.stringify(payload, null, 2), payload);
  }

  private async handleInterrupt(args: Record<string, unknown>): Promise<McpToolCallResult> {
    const sessionId = typeof args.sessionId === "string" ? args.sessionId.trim() : "";
    if (!sessionId) return this.errorResult("参数错误：需要非空 sessionId");

    const client = await this.ensureConnected();
    await this.openSessionForRun(client, sessionId);
    await client.call("session.interrupt", { sessionId });
    return this.textResult(JSON.stringify({ sessionId, aborted: true }, null, 2));
  }

  private async handleAnswer(
    args: Record<string, unknown>,
    context?: McpToolCallContext,
  ): Promise<McpToolCallResult> {
    const sessionId = typeof args.sessionId === "string" ? args.sessionId.trim() : "";
    if (!sessionId) return this.errorResult("参数错误：需要非空 sessionId");
    const requestId = typeof args.requestId === "string" ? args.requestId.trim() : "";
    if (!requestId) return this.errorResult("参数错误：需要非空 requestId");

    const parsedAnswers = parseQuestionAnswers(args.answers);
    if (!parsedAnswers.ok) {
      return this.errorResult(parsedAnswers.error);
    }

    const wait = typeof args.wait === "boolean" ? args.wait : true;
    const timeoutSeconds =
      typeof args.timeoutSeconds === "number" && Number.isFinite(args.timeoutSeconds)
        ? args.timeoutSeconds
        : 300;

    const client = await this.ensureConnected();
    const tracked = await this.openSessionForRun(client, sessionId);
    await tracked.rpcSession.respondQuestion(requestId, { answers: parsedAnswers.answers });
    tracked.lastReportedQuestionId = requestId;

    if (!wait) {
      return this.buildSessionWaitResult(tracked, { advanceCursor: false });
    }
    await this.waitForTrackedSessions([tracked], timeoutSeconds, context);
    return this.buildSessionWaitResult(tracked, { advanceCursor: true });
  }

  private async handleRespondPermission(
    args: Record<string, unknown>,
    context?: McpToolCallContext,
  ): Promise<McpToolCallResult> {
    const sessionId = typeof args.sessionId === "string" ? args.sessionId.trim() : "";
    if (!sessionId) return this.errorResult("参数错误：需要非空 sessionId");
    const requestId = typeof args.requestId === "string" ? args.requestId.trim() : "";
    if (!requestId) return this.errorResult("参数错误：需要非空 requestId");

    let childSessionId: string | undefined;
    if (args.childSessionId !== undefined) {
      if (typeof args.childSessionId !== "string" || args.childSessionId.trim() === "") {
        return this.errorResult("参数错误：childSessionId 必须为非空字符串");
      }
      childSessionId = args.childSessionId.trim();
    }

    const parsedReply = parsePermissionReply(args.reply);
    if (!parsedReply.ok) {
      return this.errorResult(parsedReply.error);
    }

    const wait = typeof args.wait === "boolean" ? args.wait : true;
    const timeoutSeconds =
      typeof args.timeoutSeconds === "number" && Number.isFinite(args.timeoutSeconds)
        ? args.timeoutSeconds
        : 300;

    const client = await this.ensureConnected();
    const tracked = await this.openSessionForRun(client, sessionId);
    // 权限上限、归属与持久授权校验一律交给 RPC 的 agent 接入层，不在 MCP 桥拦截
    if (childSessionId !== undefined) {
      await tracked.rpcSession.respondSubagentPermission(
        childSessionId,
        requestId,
        parsedReply.reply,
      );
      tracked.lastReportedPermissionKeys.add(subagentPermissionKey(childSessionId, requestId));
    } else {
      await tracked.rpcSession.respondPermission(requestId, parsedReply.reply);
      tracked.lastReportedPermissionKeys.add(requestId);
    }

    if (!wait) {
      return this.buildSessionWaitResult(tracked, { advanceCursor: false });
    }
    await this.waitForTrackedSessions([tracked], timeoutSeconds, context);
    return this.buildSessionWaitResult(tracked, { advanceCursor: true });
  }

  private async triggerEnqueueOnTracked(
    tracked: TrackedBridgeSession,
    prompt: string,
  ): Promise<void> {
    const startToken = beginStartTurn(tracked);
    let initialError: unknown;
    let startedOrSettled = false;

    await new Promise<void>((resolve) => {
      const finish = (): void => {
        if (startedOrSettled) return;
        startedOrSettled = true;
        tracked.listeners.delete(onEvent);
        clearTimeout(shortTimer);
        resolve();
      };
      const onEvent = (_view: SessionView, event: RuntimeEvent): void => {
        if (
          event.type === "turn.started" ||
          (event.type === "input.pending" && event.payload.items.length > 0)
        ) {
          clearStartTurn(tracked, startToken);
          finish();
        }
      };
      tracked.listeners.add(onEvent);
      const shortTimer = setTimeout(finish, 40);
      shortTimer.unref();

      tracked.rpcSession.enqueueInput("queue", { text: prompt }).then(
        (res) => {
          if (res.queued) {
            tracked.pendingInputIds.add(res.id);
          }
          clearStartTurn(tracked, startToken);
          finish();
        },
        (err: unknown) => {
          clearStartTurn(tracked, startToken);
          initialError = err;
          finish();
        },
      );
    });

    if (initialError !== undefined) {
      throw initialError instanceof Error ? initialError : new Error("enqueueInput failed");
    }
  }

  private async triggerSubmitOnTracked(
    tracked: TrackedBridgeSession,
    prompt: string,
  ): Promise<void> {
    const startToken = beginStartTurn(tracked);
    let initialError: unknown;
    let startedOrSettled = false;

    await new Promise<void>((resolve) => {
      const finish = (): void => {
        if (startedOrSettled) return;
        startedOrSettled = true;
        tracked.listeners.delete(onEvent);
        clearTimeout(shortTimer);
        resolve();
      };
      const onEvent = (_view: SessionView, event: RuntimeEvent): void => {
        if (event.type === "turn.started" || event.type === "turn.completed") {
          finish();
        }
      };
      tracked.listeners.add(onEvent);
      const shortTimer = setTimeout(finish, 40);
      shortTimer.unref();

      tracked.rpcSession.submit({ text: prompt }).then(
        () => {
          clearStartTurn(tracked, startToken);
          finish();
        },
        async (err: unknown) => {
          if (err instanceof RpcError && err.code === "session_busy") {
            try {
              const enq = await tracked.rpcSession.enqueueInput("queue", { text: prompt });
              if (enq.queued) tracked.pendingInputIds.add(enq.id);
              clearStartTurn(tracked, startToken);
              finish();
              return;
            } catch (enqErr) {
              clearStartTurn(tracked, startToken);
              initialError = enqErr;
              finish();
              return;
            }
          }
          clearStartTurn(tracked, startToken);
          initialError = err;
          finish();
        },
      );
    });

    if (initialError !== undefined) {
      throw initialError instanceof Error ? initialError : new Error("submit failed");
    }
  }

  private async waitForTrackedSessions(
    trackedList: readonly TrackedBridgeSession[],
    timeoutSeconds: number,
    context?: McpToolCallContext,
  ): Promise<{ readyIds: Set<string>; timedOut: boolean }> {
    const clampedSeconds = Math.min(600, Math.max(0.05, timeoutSeconds));
    const timeoutMs = Math.round(clampedSeconds * 1000);

    await Promise.all(
      trackedList.map(async (tracked) => {
        try {
          const pendingSnap = await tracked.rpcSession.pendingInputs();
          tracked.pendingInputIds = new Set(pendingSnap.items.map((i) => i.id));
          tracked.paused = pendingSnap.paused;
        } catch {
          /* 忽略冲刷失败 */
        }
      }),
    );

    const initialReported = new Map<
      string,
      { permKeys: Set<string>; questionId: string | undefined }
    >();
    for (const tracked of trackedList) {
      initialReported.set(tracked.sessionId, {
        permKeys: new Set(tracked.lastReportedPermissionKeys),
        questionId: tracked.lastReportedQuestionId,
      });
    }

    const isStopped = (tracked: TrackedBridgeSession): boolean => {
      const view = tracked.tracker.view;
      const initial = initialReported.get(tracked.sessionId);
      const pendingPerms = allPendingPermissions(view);
      if (pendingPerms.some((item) => !initial?.permKeys.has(pendingPermissionKey(item)))) {
        return true;
      }
      if (
        view.pendingQuestion !== undefined &&
        view.pendingQuestion.requestId !== initial?.questionId
      ) {
        return true;
      }
      if (
        view.currentTurn === undefined &&
        (view.status === "idle" || view.status === "failed") &&
        tracked.activeStartToken === undefined &&
        !tracked.inTransition &&
        // 非 done 结束（aborted/error）会把剩余待发输入全部暂停；此时会话已停止，不应继续等超时
        (tracked.pendingInputIds.size === 0 || tracked.paused)
      ) {
        return true;
      }
      return false;
    };

    const collectReadyIds = (): Set<string> => {
      const ready = new Set<string>();
      for (const tracked of trackedList) {
        if (isStopped(tracked)) {
          ready.add(tracked.sessionId);
        }
      }
      return ready;
    };

    const immediate = collectReadyIds();
    if (immediate.size > 0) {
      return { readyIds: immediate, timedOut: false };
    }

    const isMulti = trackedList.length > 1;
    let progressStep = 0;
    return await new Promise<{ readyIds: Set<string>; timedOut: boolean }>((resolve) => {
      const bindings: {
        tracked: TrackedBridgeSession;
        onEvent: (view: SessionView, event: RuntimeEvent) => void;
        wake: () => void;
      }[] = [];

      const cleanup = (): void => {
        clearTimeout(timer);
        for (const b of bindings) {
          b.tracked.listeners.delete(b.onEvent);
          b.tracked.waitWakeups.delete(b.wake);
        }
      };

      const timer = setTimeout(() => {
        cleanup();
        const readyIds = collectReadyIds();
        resolve({ readyIds, timedOut: readyIds.size === 0 });
      }, timeoutMs);
      timer.unref();

      const wake = (): void => {
        const readyIds = collectReadyIds();
        if (readyIds.size > 0) {
          cleanup();
          resolve({ readyIds, timedOut: false });
        }
      };

      for (const tracked of trackedList) {
        const prefix = isMulti ? `[${tracked.sessionId}] ` : "";
        const onEvent = (_view: SessionView, event: RuntimeEvent): void => {
          if (context?.onProgress !== undefined) {
            if (event.type === "tool.started") {
              progressStep++;
              context.onProgress({
                progress: progressStep,
                message: `${prefix}调用工具 ${event.payload.name}`,
              });
            } else if (event.type === "tool.completed") {
              progressStep++;
              context.onProgress({
                progress: progressStep,
                message: `${prefix}工具完成 (${event.payload.status})`,
              });
            } else if (event.type === "turn.started") {
              progressStep++;
              context.onProgress({
                progress: progressStep,
                message: `${prefix}开始新一轮执行`,
              });
            } else if (event.type === "turn.completed") {
              progressStep++;
              context.onProgress({
                progress: progressStep,
                message: `${prefix}本轮执行完成`,
              });
            }
          }
          wake();
        };
        bindings.push({ tracked, onEvent, wake });
        tracked.listeners.add(onEvent);
        tracked.waitWakeups.add(wake);
      }
    });
  }

  private buildSessionWaitPayload(
    tracked: TrackedBridgeSession,
    options?: {
      advanceCursor?: boolean | undefined;
      requestedTitle?: string | undefined;
      renameError?: string | undefined;
    },
  ): Record<string, unknown> {
    const view = tracked.tracker.view;
    const pendingCount =
      tracked.pendingInputIds.size + (tracked.activeStartToken !== undefined ? 1 : 0);
    const status = deriveMcpSessionStatus(view, pendingCount, tracked.paused);
    const incremental = extractIncrementalWaitTurn(view, tracked.waitToolCursor, {
      advanceCursor: options?.advanceCursor ?? true,
    });
    if (options?.advanceCursor !== false) {
      tracked.waitToolCursor = incremental.nextCursor;
    }
    const folded = incremental.turn;
    const reply = folded?.assistantText ?? "";

    const turnOutcome = deriveTurnOutcome(status, view);
    const effectiveTitle =
      view.title ??
      (options?.requestedTitle !== undefined && options.renameError === undefined
        ? options.requestedTitle
        : undefined);

    const payload: Record<string, unknown> = {
      sessionId: tracked.sessionId,
      ...(effectiveTitle !== undefined ? { title: effectiveTitle } : {}),
      ...(options?.renameError !== undefined ? { renameError: options.renameError } : {}),
      status,
      turnOutcome,
      reply,
      cwd: view.meta?.cwd,
      workspaceRoot: view.meta?.workspaceRoot,
      turnCount: view.turnCount,
      ...(pendingCount > 0 ? { queuedInputs: tracked.pendingInputIds.size } : {}),
    };

    const pendingPerms = allPendingPermissions(view);
    if (status === "waiting_for_permission" && pendingPerms.length > 0) {
      tracked.lastReportedPermissionKeys = new Set(pendingPerms.map(pendingPermissionKey));
      payload.message = this.buildWaitingForPermissionMessage(tracked);
      payload.pendingPermissions = pendingPerms.map((item) =>
        item.kind === "subagent"
          ? {
              requestId: item.permission.requestId,
              childSessionId: item.permission.childSessionId,
              toolName: item.permission.toolName,
              reason: item.permission.reason,
              subjects: item.permission.subjects,
            }
          : {
              requestId: item.permission.requestId,
              toolName: item.permission.toolName,
              reason: item.permission.reason,
              subjects: item.permission.subjects,
            },
      );
    } else {
      tracked.lastReportedPermissionKeys.clear();
    }

    if (status === "waiting_for_answer" && view.pendingQuestion !== undefined) {
      tracked.lastReportedQuestionId = view.pendingQuestion.requestId;
      payload.message = this.buildWaitingForAnswerMessage(tracked);
      payload.pendingQuestion = {
        requestId: view.pendingQuestion.requestId,
        questions: view.pendingQuestion.questions,
      };
    } else {
      tracked.lastReportedQuestionId = undefined;
    }

    if (status === "running") {
      payload.message =
        "会话仍在运行中，可调用 nocturne_wait 继续等待或调用 nocturne_read_session 查看进展。";
    }

    if (folded !== undefined) {
      payload.lastTurn = folded;
    }

    return payload;
  }

  private isOwnSession(tracked: TrackedBridgeSession): boolean | undefined {
    if (this.agentSelf === undefined) return undefined;
    return tracked.clientId === this.agentSelf.id;
  }

  private canApprovePermissions(): boolean {
    return this.agentSelf?.scope === "run" && this.agentSelf.maxPermissionPreset === "bypass";
  }

  private buildWaitingForPermissionMessage(tracked: TrackedBridgeSession): string {
    const owned = this.isOwnSession(tracked);
    if (this.canApprovePermissions()) {
      if (owned === false) {
        return "Session is waiting for permission. Only the agent that created this session can respond via nocturne_respond_permission; ask the user to respond in Nocturne.";
      }
      return "Session is waiting for permission. Call nocturne_respond_permission with this sessionId and pendingPermissions[].requestId (and childSessionId for subagent requests) to allow (once or session) or deny, or ask the user to respond in Nocturne.";
    }
    if (this.agentSelf !== undefined && (this.agentSelf.scope !== "run" || owned === false)) {
      return "Session is waiting for permission. This agent cannot approve permissions; ask the user to respond in Nocturne.";
    }
    return 'Session is waiting for permission. This agent cannot approve permissions; call nocturne_respond_permission with decision "deny" to reject, or ask the user to respond in Nocturne.';
  }

  private buildWaitingForAnswerMessage(tracked: TrackedBridgeSession): string {
    const owned = this.isOwnSession(tracked);
    if (this.agentSelf !== undefined && (this.agentSelf.scope !== "run" || owned === false)) {
      return "Session is waiting for an answer. Only the agent that created this session can call nocturne_answer; ask the user to respond in Nocturne.";
    }
    return "Session is waiting for an answer. Call nocturne_answer with this sessionId and pendingQuestion.requestId to respond, or ask the user to respond in Nocturne.";
  }

  private buildSessionWaitResult(
    tracked: TrackedBridgeSession,
    options?: {
      advanceCursor?: boolean | undefined;
      requestedTitle?: string | undefined;
      renameError?: string | undefined;
    },
  ): McpToolCallResult {
    const payload = this.buildSessionWaitPayload(tracked, options);
    return this.textResult(JSON.stringify(payload, null, 2), payload);
  }
}

function subagentPermissionKey(childSessionId: string, requestId: string): string {
  return `${childSessionId}:${requestId}`;
}

function pendingPermissionKey(item: AggregatedPendingPermission): string {
  return item.kind === "subagent"
    ? subagentPermissionKey(item.permission.childSessionId, item.permission.requestId)
    : item.permission.requestId;
}

function parsePermissionReply(
  raw: unknown,
): { ok: true; reply: PermissionReply } | { ok: false; error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "参数错误：reply 必须为对象" };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.decision !== "allow" && obj.decision !== "deny") {
    return { ok: false, error: "参数错误：reply.decision 必须为 allow 或 deny" };
  }
  if (obj.stop !== undefined && typeof obj.stop !== "boolean") {
    return { ok: false, error: "参数错误：reply.stop 必须为布尔值" };
  }
  if (obj.feedback !== undefined && typeof obj.feedback !== "string") {
    return { ok: false, error: "参数错误：reply.feedback 必须为字符串" };
  }
  if (obj.remember !== undefined && typeof obj.remember !== "string") {
    return { ok: false, error: "参数错误：reply.remember 必须为字符串" };
  }
  const reply: PermissionReply = {
    decision: obj.decision,
    ...(obj.stop !== undefined ? { stop: obj.stop } : {}),
    ...(obj.remember !== undefined
      ? { remember: obj.remember as PermissionReply["remember"] }
      : {}),
    ...(obj.feedback !== undefined ? { feedback: obj.feedback } : {}),
  };
  return { ok: true, reply };
}

function parseQuestionAnswers(
  raw: unknown,
): { ok: true; answers: QuestionAnswer[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) {
    return { ok: false, error: "参数错误：answers 必须为数组" };
  }
  const answers: QuestionAnswer[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item: unknown = raw[i];
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return { ok: false, error: `参数错误：answers[${i}] 必须为对象` };
    }
    const obj = item as Record<string, unknown>;
    if ("declined" in obj && obj.declined !== undefined) {
      if (obj.declined !== true) {
        return { ok: false, error: `参数错误：answers[${i}].declined 仅支持 true` };
      }
      if ("selected" in obj || "text" in obj) {
        return {
          ok: false,
          error: `参数错误：answers[${i}] 声明 declined: true 时不可同时提供 selected 或 text`,
        };
      }
      answers.push({ declined: true });
      continue;
    }
    let selected: string[];
    if (obj.selected === undefined) {
      selected = [];
    } else if (
      Array.isArray(obj.selected) &&
      obj.selected.every((s): s is string => typeof s === "string")
    ) {
      selected = obj.selected;
    } else {
      return { ok: false, error: `参数错误：answers[${i}].selected 必须为字符串数组` };
    }
    if (obj.text !== undefined && typeof obj.text !== "string") {
      return { ok: false, error: `参数错误：answers[${i}].text 必须为字符串` };
    }
    answers.push({
      selected,
      ...(obj.text !== undefined ? { text: obj.text } : {}),
    });
  }
  return { ok: true, answers };
}

/** 标记一次新的 Turn 启动窗口，返回只属于本次触发的令牌，避免前序 RPC 迟到完成误清状态。 */
function beginStartTurn(tracked: TrackedBridgeSession): number {
  const token = ++tracked.startTokenSeq;
  tracked.activeStartToken = token;
  return token;
}

/** 清除当前启动窗口标记（传入 token 时仅当仍匹配本次触发才清除），并唤醒等待中的观察者。 */
function clearStartTurn(tracked: TrackedBridgeSession, token?: number): void {
  if (token !== undefined && tracked.activeStartToken !== token) return;
  if (tracked.activeStartToken === undefined) return;
  tracked.activeStartToken = undefined;
  for (const wake of [...tracked.waitWakeups]) {
    wake();
  }
}

/** 根据桥接状态与刚结束的 Turn 原因推导 `turnOutcome`；队列暂停时保留刚结束轮次的真实结果。 */
function deriveTurnOutcome(status: McpSessionStatus, view: SessionView): string {
  if (status === "idle") {
    return view.lastTurn?.reason === "aborted" ? "aborted" : "done";
  }
  if (status === "error") return "error";
  if (status === "paused") {
    if (view.lastTurn?.reason === "aborted") return "aborted";
    if (view.lastTurn?.reason === "error" || view.status === "failed") return "error";
  }
  return status;
}

class BridgeNotRunningError extends Error {
  constructor(cause?: string) {
    super(cause ?? DESKTOP_NOT_RUNNING_MESSAGE);
    this.name = "BridgeNotRunningError";
  }
}

class SubagentSessionError extends Error {
  readonly sessionId: string;
  readonly parentSessionId: string;

  constructor(sessionId: string, parentSessionId: string) {
    super(
      `会话 ${sessionId} 是子代理会话，不能直接等待或操作；请改为等待或观察其父会话：${parentSessionId}`,
    );
    this.name = "SubagentSessionError";
    this.sessionId = sessionId;
    this.parentSessionId = parentSessionId;
  }
}
