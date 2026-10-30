import type { RuntimeEvent, SessionView } from "@nocturne/core/protocol";
import { connectChannel } from "@nocturne/remote";
import {
  createRpcClient,
  RpcError,
  trackSessionView,
  type LineTransport,
  type RpcClient,
  type RpcSession,
  type SessionViewTracker,
} from "@nocturne/rpc/client";
import { loadOrCreateBridgeIdentity, type BridgeIdentityResult } from "./identity.js";
import { connectAgentPipe } from "./pipe.js";
import {
  deriveMcpSessionStatus,
  extractFoldedTurns,
  formatReadSessionOutput,
  MAX_MCP_OUTPUT_BYTES,
  truncateMcpOutput,
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
  readonly rpcSession: RpcSession;
  tracker: SessionViewTracker;
  readonly listeners: Set<(view: SessionView, event: RuntimeEvent) => void>;
  pendingInputIds: Set<string>;
  paused: boolean;
  startingTurn: boolean;
  transitionTimer: ReturnType<typeof setTimeout> | undefined;
  inTransition: boolean;
  lastReportedPermissionId: string | undefined;
  lastReportedQuestionId: string | undefined;
}

export class McpBridge {
  private readonly options: McpBridgeOptions;
  private hostClientName: string | undefined;
  private identityPromise: Promise<BridgeIdentityResult> | undefined;
  private client: RpcClient | undefined;
  private connectingPromise: Promise<RpcClient> | undefined;
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
            this.clearTrackedSessions();
          }
        });
        await rpcClient.initialize();
        this.client = rpcClient;
        return rpcClient;
      } catch (error) {
        if (error instanceof RpcError && error.code === "agent_pairing_pending") {
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
      if (s.transitionTimer !== undefined) clearTimeout(s.transitionTimer);
      s.listeners.clear();
    }
    this.sessions.clear();
  }

  async close(): Promise<void> {
    this.closed = true;
    const current = this.client;
    this.client = undefined;
    for (const s of this.sessions.values()) {
      if (s.transitionTimer !== undefined) clearTimeout(s.transitionTimer);
      s.listeners.clear();
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
        case "nocturne_abort":
          return await this.handleAbort(args);
        case "nocturne_status":
          return await this.handleStatus();
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

  private async openSessionForRead(
    client: RpcClient,
    sessionId: string,
  ): Promise<TrackedBridgeSession> {
    const existing = this.sessions.get(sessionId);
    if (existing !== undefined) return existing;
    await client.call("session.open", { sessionId });
    const rpcSession = client.session(sessionId);
    return this.attachTracker(sessionId, rpcSession);
  }

  private async openSessionForRun(
    client: RpcClient,
    sessionId: string,
  ): Promise<TrackedBridgeSession> {
    const existing = this.sessions.get(sessionId);
    if (existing !== undefined) return existing;
    const { session: rpcSession } = await client.runtime.resumeSession(sessionId);
    return this.attachTracker(sessionId, rpcSession);
  }

  private async attachTracker(
    sessionId: string,
    rpcSession: RpcSession,
  ): Promise<TrackedBridgeSession> {
    const listeners = new Set<(view: SessionView, event: RuntimeEvent) => void>();
    const entry: TrackedBridgeSession = {
      sessionId,
      rpcSession,
      tracker: undefined as unknown as SessionViewTracker,
      listeners,
      pendingInputIds: new Set<string>(),
      paused: false,
      startingTurn: false,
      transitionTimer: undefined,
      inTransition: false,
      lastReportedPermissionId: undefined,
      lastReportedQuestionId: undefined,
    };
    const notifyListeners = (view: SessionView, event: RuntimeEvent): void => {
      for (const fn of [...listeners]) {
        fn(view, event);
      }
    };
    const tracker = await trackSessionView(rpcSession, (view, event) => {
      if (event.type === "turn.started") {
        entry.startingTurn = false;
        entry.inTransition = false;
        if (entry.transitionTimer !== undefined) {
          clearTimeout(entry.transitionTimer);
          entry.transitionTimer = undefined;
        }
      } else if (event.type === "input.pending") {
        const prevSize = entry.pendingInputIds.size;
        entry.pendingInputIds = new Set(event.payload.items.map((i) => i.id));
        entry.paused = event.payload.paused;
        if (prevSize > 0 && entry.pendingInputIds.size === 0 && view.currentTurn === undefined) {
          entry.inTransition = true;
          if (entry.transitionTimer !== undefined) clearTimeout(entry.transitionTimer);
          entry.transitionTimer = setTimeout(() => {
            entry.inTransition = false;
            entry.transitionTimer = undefined;
            notifyListeners(view, event);
          }, 60);
          entry.transitionTimer.unref();
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
    const tracked = await this.attachTracker(opened.sessionId, rpcSession);

    await this.triggerSubmitOnTracked(tracked, prompt);

    if (!wait) {
      return this.buildSessionWaitResult(tracked);
    }
    await this.waitForTrackedSession(tracked, timeoutSeconds, context);
    return this.buildSessionWaitResult(tracked);
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
      return this.buildSessionWaitResult(tracked);
    }
    await this.waitForTrackedSession(tracked, timeoutSeconds, context);
    return this.buildSessionWaitResult(tracked);
  }

  private async handleWait(
    args: Record<string, unknown>,
    context?: McpToolCallContext,
  ): Promise<McpToolCallResult> {
    const sessionId = typeof args.sessionId === "string" ? args.sessionId.trim() : "";
    if (!sessionId) return this.errorResult("参数错误：需要非空 sessionId");
    const timeoutSeconds =
      typeof args.timeoutSeconds === "number" && Number.isFinite(args.timeoutSeconds)
        ? args.timeoutSeconds
        : 300;

    const client = await this.ensureConnected();
    const tracked = await this.openSessionForRead(client, sessionId);
    await this.waitForTrackedSession(tracked, timeoutSeconds, context);
    return this.buildSessionWaitResult(tracked);
  }

  private async handleAbort(args: Record<string, unknown>): Promise<McpToolCallResult> {
    const sessionId = typeof args.sessionId === "string" ? args.sessionId.trim() : "";
    if (!sessionId) return this.errorResult("参数错误：需要非空 sessionId");

    const client = await this.ensureConnected();
    await this.openSessionForRun(client, sessionId);
    await client.call("session.abort", { sessionId });
    return this.textResult(JSON.stringify({ sessionId, aborted: true }, null, 2));
  }

  private async handleStatus(): Promise<McpToolCallResult> {
    const client = await this.ensureConnected();
    const idResult = await this.getIdentity();
    const sessions = await client.runtime.listSessions();
    return this.textResult(
      JSON.stringify(
        {
          connected: true,
          bridge: {
            id: idResult.identity.id,
            name: this.effectiveName,
            fingerprint: idResult.fingerprint,
          },
          sessionCount: sessions.length,
          openSessionsInBridge: [...this.sessions.keys()],
          recentSessions: sessions.slice(0, 5).map((s) => ({
            sessionId: s.id,
            title: s.firstText ?? "(无标题)",
            cwd: s.cwd,
            updatedAt: new Date(s.mtimeMs).toISOString(),
          })),
        },
        null,
        2,
      ),
    );
  }

  private async triggerEnqueueOnTracked(
    tracked: TrackedBridgeSession,
    prompt: string,
  ): Promise<void> {
    tracked.startingTurn = true;
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
          event.type === "turn.completed" ||
          event.type === "input.pending"
        ) {
          tracked.startingTurn = false;
          finish();
        }
      };
      tracked.listeners.add(onEvent);
      const shortTimer = setTimeout(finish, 40);
      shortTimer.unref();

      tracked.rpcSession.enqueueInput("queue", { text: prompt }).then(
        (res) => {
          tracked.startingTurn = false;
          if (res.queued) {
            tracked.pendingInputIds.add(res.id);
          }
          finish();
        },
        (err: unknown) => {
          tracked.startingTurn = false;
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
    tracked.startingTurn = true;
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
          tracked.startingTurn = false;
          finish();
        },
        async (err: unknown) => {
          tracked.startingTurn = false;
          if (err instanceof RpcError && err.code === "session_busy") {
            try {
              const enq = await tracked.rpcSession.enqueueInput("queue", { text: prompt });
              if (enq.queued) tracked.pendingInputIds.add(enq.id);
              finish();
              return;
            } catch (enqErr) {
              initialError = enqErr;
              finish();
              return;
            }
          }
          initialError = err;
          finish();
        },
      );
    });

    if (initialError !== undefined) {
      throw initialError instanceof Error ? initialError : new Error("submit failed");
    }
  }

  private async waitForTrackedSession(
    tracked: TrackedBridgeSession,
    timeoutSeconds: number,
    context?: McpToolCallContext,
  ): Promise<void> {
    const clampedSeconds = Math.min(600, Math.max(0.05, timeoutSeconds));
    const timeoutMs = Math.round(clampedSeconds * 1000);

    try {
      const pendingSnap = await tracked.rpcSession.pendingInputs();
      tracked.pendingInputIds = new Set(pendingSnap.items.map((i) => i.id));
      tracked.paused = pendingSnap.paused;
    } catch {
      /* 忽略冲刷失败 */
    }

    const initialPermId = tracked.lastReportedPermissionId;
    const initialQuestionId = tracked.lastReportedQuestionId;

    const isStopped = (): boolean => {
      const view = tracked.tracker.view;
      if (
        view.pendingPermission !== undefined &&
        view.pendingPermission.requestId !== initialPermId
      ) {
        return true;
      }
      if (
        view.pendingQuestion !== undefined &&
        view.pendingQuestion.requestId !== initialQuestionId
      ) {
        return true;
      }
      if (
        view.currentTurn === undefined &&
        (view.status === "idle" || view.status === "failed") &&
        !tracked.startingTurn &&
        !tracked.inTransition &&
        tracked.pendingInputIds.size === 0
      ) {
        return true;
      }
      return false;
    };

    if (isStopped()) return;

    let progressStep = 0;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, timeoutMs);
      timer.unref();

      const onEvent = (_view: SessionView, event: RuntimeEvent): void => {
        if (context?.onProgress !== undefined) {
          if (event.type === "tool.started") {
            progressStep++;
            context.onProgress({
              progress: progressStep,
              message: `调用工具 ${event.payload.name}`,
            });
          } else if (event.type === "tool.completed") {
            progressStep++;
            context.onProgress({
              progress: progressStep,
              message: `工具完成 (${event.payload.status})`,
            });
          } else if (event.type === "turn.started") {
            progressStep++;
            context.onProgress({
              progress: progressStep,
              message: "开始新一轮执行",
            });
          } else if (event.type === "turn.completed") {
            progressStep++;
            context.onProgress({
              progress: progressStep,
              message: "本轮执行完成",
            });
          }
        }
        if (isStopped()) {
          cleanup();
          resolve();
        }
      };

      const cleanup = (): void => {
        clearTimeout(timer);
        tracked.listeners.delete(onEvent);
      };

      tracked.listeners.add(onEvent);
    });
  }

  private buildSessionWaitResult(tracked: TrackedBridgeSession): McpToolCallResult {
    const view = tracked.tracker.view;
    const pendingCount = tracked.pendingInputIds.size + (tracked.startingTurn ? 1 : 0);
    const status = deriveMcpSessionStatus(view, pendingCount, tracked.paused);
    const folded = extractFoldedTurns(view).at(-1);
    const reply = folded?.assistantText ?? "";

    const turnOutcome =
      status === "idle"
        ? view.lastTurn?.reason === "aborted"
          ? "aborted"
          : "done"
        : status === "error"
          ? "error"
          : status;

    const payload: Record<string, unknown> = {
      sessionId: tracked.sessionId,
      status,
      turnOutcome,
      reply,
      cwd: view.meta?.cwd,
      workspaceRoot: view.meta?.workspaceRoot,
      turnCount: view.turnCount,
      ...(pendingCount > 0 ? { queuedInputs: tracked.pendingInputIds.size } : {}),
    };

    if (status === "waiting_for_permission" && view.pendingPermission !== undefined) {
      tracked.lastReportedPermissionId = view.pendingPermission.requestId;
      payload.message = "Ask the user to respond in Nocturne.";
      payload.pendingPermissions = [
        {
          requestId: view.pendingPermission.requestId,
          toolName: view.pendingPermission.toolName,
          reason: view.pendingPermission.reason,
          subjects: view.pendingPermission.subjects,
        },
      ];
    } else {
      tracked.lastReportedPermissionId = undefined;
    }

    if (status === "waiting_for_answer" && view.pendingQuestion !== undefined) {
      tracked.lastReportedQuestionId = view.pendingQuestion.requestId;
      payload.message = "Ask the user to respond in Nocturne.";
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

    return this.textResult(JSON.stringify(payload, null, 2), payload);
  }
}

class BridgeNotRunningError extends Error {
  constructor(cause?: string) {
    super(cause ?? DESKTOP_NOT_RUNNING_MESSAGE);
    this.name = "BridgeNotRunningError";
  }
}
