import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";
import {
  createHarness,
  type DaemonStart,
  type EnsureDaemonOptions,
  type Harness,
  type HarnessOptions,
  type OpenRequest,
} from "@open-artifact/harness-kit";
import {
  HOST_PROTOCOL,
  type AttachParams,
  type EmbedOriginsResult,
  type HostTheme,
  type ShellEventParams,
  type ToolCallResult,
  type ToolName,
  type WakeDeliverParams,
  type WakeDeliverResult,
} from "@open-artifact/protocol";
import {
  openArtifactIdFromUrl,
  type OpenArtifactConnector,
  type OpenArtifactHostEvent,
  type OpenArtifactSessionAccess,
  type OpenArtifactShellEvent,
  type OpenArtifactTheme,
  type OpenArtifactViewTicket,
  type OpenArtifactWakeDelivery,
  type OpenArtifactWakeResult,
  type ToolDefinition,
} from "@nocturne/core";
import { resolveBundledOpenArtifactRuntime } from "./runtime-path.js";
import { sanitizeWakeText, type KnownArtifactMeta } from "./sanitize.js";
import { createOpenArtifactTools } from "./tools.js";

export interface OpenArtifactConnectorOptions {
  /** 覆盖 Open Artifact home 目录（默认读取 OPEN_ARTIFACT_HOME 或 ~/.agents/open-artifact） */
  home?: string | undefined;
  /** 随包交付的 @open-artifact/cli 运行时目录（缺省自动从环境或依赖解析） */
  runtimeDir?: string | undefined;
  /**
   * 视图嵌入模式：
   * - "view"：桌面端受限独立 Webview（短期票据 + shell.event/shell.command 通道）
   * - "none"：终端/无桌面宿主模式，不声称 caps.open
   */
  embedMode?: "view" | "none" | undefined;
  /** 传给 harness-kit 的 embed.origins（view 模式下通常为空数组，页面通过独立视图和票据通信） */
  embedOrigins?: string[] | undefined;
  /** 缺省 true；仅在首次实际需要时按需启动或发现本地 daemon */
  autoStart?: boolean | undefined;
  /** 传给 ensureDaemon 的底层参数（如自定义 bin / env / spawn / timeoutMs） */
  daemon?: EnsureDaemonOptions | undefined;
  /** 测试注入点：替换 createHarness 以便使用 harness-kit/testing 的假 daemon */
  harnessFactory?: ((options: HarnessOptions) => Promise<Harness>) | undefined;
  /** 诊断日志 */
  log?: ((line: string) => void) | undefined;
}

interface RuntimeHandlers {
  onWake: (wake: OpenArtifactWakeDelivery) => Promise<OpenArtifactWakeResult>;
  onHostEvent: (event: OpenArtifactHostEvent) => void;
}

function localOriginsFromResult(result: EmbedOriginsResult | undefined): string[] {
  if (!result) return [];
  const out = new Set<string>();
  for (const entry of result.entries) {
    if (entry.remote) continue;
    const raw = entry.origin ?? entry.pattern;
    if (typeof raw === "string" && raw.trim() !== "") {
      out.add(raw.trim());
    }
  }
  return [...out];
}

function wakeDedupeKey(params: WakeDeliverParams): string {
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify({
      session: params.session ?? null,
      artifactId: params.artifactId || params.source.artifactId,
      reason: params.source.reason,
      from: params.source.from,
      threads: params.source.threads,
      requests: params.source.requests,
      task: params.source.task ?? null,
      text: sanitizeWakeText(params.text),
    }),
  );
  return hash.digest("hex");
}

function toAttachParams(access: OpenArtifactSessionAccess): AttachParams {
  return {
    session: access.sessionId,
    workspace: access.workspace,
    ...(access.title !== undefined ? { title: access.title } : {}),
    role: access.role,
    may: access.may,
  };
}

function extractCommentThreadFromWakeText(
  text: string,
): { id: string; where?: string; text: string } | undefined {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("> {")) continue;
    try {
      const parsed = JSON.parse(line.slice(2)) as {
        comment?: {
          id?: unknown;
          where?: unknown;
          messages?: { from?: unknown; text?: unknown }[];
        };
      };
      const comment = parsed.comment;
      if (comment === undefined || typeof comment.id !== "string" || comment.id.trim() === "") {
        continue;
      }
      const msgs = Array.isArray(comment.messages) ? comment.messages : [];
      let userMsg = "";
      for (let i = msgs.length - 1; i >= 0; i -= 1) {
        const candidate = msgs[i];
        if (typeof candidate?.text === "string" && candidate.text.trim() !== "") {
          userMsg = candidate.text.trim();
          if (candidate.from === "user") break;
        }
      }
      const where =
        typeof comment.where === "string" && comment.where.trim() !== ""
          ? comment.where.trim()
          : undefined;
      return {
        id: comment.id.trim(),
        ...(where !== undefined ? { where } : {}),
        text: userMsg,
      };
    } catch {
      // ignore non-JSON blockquote lines
    }
  }
  return undefined;
}

function toWakeDelivery(params: WakeDeliverParams): OpenArtifactWakeDelivery {
  const from = params.source.from;
  const fromKind = from.kind;
  const fromName = from.kind === "collaborator" ? from.name : undefined;
  let threads =
    params.source.threads.length > 0
      ? params.source.threads.map((t) => ({
          id: t.id,
          ...(t.where ? { where: t.where } : {}),
          text: t.text,
        }))
      : undefined;
  let summary = params.source.summary;
  if (threads === undefined) {
    const extracted = extractCommentThreadFromWakeText(params.text);
    if (extracted !== undefined) {
      threads = [extracted];
      if (extracted.text !== "") {
        summary = extracted.text;
      }
    }
  }
  return {
    sessionId: params.session ?? null,
    workspace: params.workspace ?? null,
    artifactUrl: params.artifact || params.source.url,
    artifactId: params.artifactId || params.source.artifactId,
    title: params.source.title,
    text: sanitizeWakeText(params.text),
    reason: params.source.reason,
    fromKind,
    ...(fromName !== undefined ? { fromName } : {}),
    summary,
    ...(threads !== undefined ? { threads } : {}),
    dedupeKey: wakeDedupeKey(params),
  };
}

function toShellEvent(event: ShellEventParams["event"]): OpenArtifactShellEvent | undefined {
  switch (event.openArtifact) {
    case "shell_hello":
      return {
        type: "ready",
        id: event.id,
        title: event.title,
        artifactType: event.type,
      };
    case "place":
      return { type: "place", hash: event.hash };
    case "saved":
      return {
        type: "saved",
        state: event.state,
        leaveLosesWork: event.leaveLosesWork,
      };
    case "open_session":
      return { type: "open_session", sessionId: event.session };
    case "new_session":
      return { type: "new_session", prompt: event.prompt };
    case "open_external":
      return { type: "open_external", url: event.url };
    case "saved_file":
      return { type: "saved_file", path: event.path };
    case "close":
      return { type: "close" };
    default:
      return undefined;
  }
}

function spawnHiddenDaemon(start: DaemonStart) {
  mkdirSync(dirname(start.logFile), { recursive: true });
  const fd = openSync(start.logFile, "a");
  try {
    const child = spawn(process.execPath, [start.bin, ...start.args], {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", fd, fd],
      env: { ...start.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    child.on("error", () => undefined);
    child.unref();
    return child;
  } finally {
    closeSync(fd);
  }
}

export function createOpenArtifactConnector(
  options: OpenArtifactConnectorOptions = {},
): OpenArtifactConnector {
  const embedMode = options.embedMode ?? "view";
  const createHarnessFn = options.harnessFactory ?? createHarness;
  const knownArtifacts = new Map<string, KnownArtifactMeta>();
  const sessionAccessMap = new Map<string, OpenArtifactSessionAccess>();
  const activeViews = new Map<string, string>();
  let currentTheme: HostTheme = { scheme: "light" };
  let cachedLocalOrigins: string[] = [];
  let runtimeHandlers: RuntimeHandlers | undefined;
  let harnessPromise: Promise<Harness> | undefined;
  let harnessInstance: Harness | undefined;
  let closed = false;

  const hostHelloCommand = (theme: HostTheme) => ({
    openArtifact: "host_hello" as const,
    caps: {
      sessions: true,
      toolbar: true,
      switcher: true,
    },
    agentName: "Nocturne",
    harness: "nocturne",
    protocol: HOST_PROTOCOL,
    theme,
  });

  const emitHostEvent = (event: OpenArtifactHostEvent): void => {
    runtimeHandlers?.onHostEvent(event);
  };

  const refreshLocalOrigins = async (harness: Harness): Promise<string[]> => {
    try {
      const res = await harness.embedOrigins();
      const next = localOriginsFromResult(res);
      cachedLocalOrigins = next;
      return next;
    } catch {
      return cachedLocalOrigins;
    }
  };

  const buildTicket = async (
    harness: Harness,
    request: OpenRequest,
  ): Promise<OpenArtifactViewTicket> => {
    const allowedOrigins = await refreshLocalOrigins(harness);
    const id = openArtifactIdFromUrl(request.url) ?? request.url;
    const cached = knownArtifacts.get(id);
    if (request.view) {
      activeViews.set(request.view, request.url);
    }
    return {
      url: request.url,
      id,
      ...(request.title !== undefined
        ? { title: request.title }
        : cached?.title !== undefined
          ? { title: cached.title }
          : {}),
      ...(cached?.type !== undefined ? { type: cached.type } : {}),
      embedUrl: request.embedUrl,
      viewUrl: request.viewUrl,
      ...(request.view !== undefined ? { view: request.view } : {}),
      allowedOrigins,
    };
  };

  const attachTrackedSessions = async (harness: Harness): Promise<void> => {
    for (const access of sessionAccessMap.values()) {
      await harness.attach(toAttachParams(access)).catch(() => undefined);
    }
  };

  const ensureHarness = async (): Promise<Harness> => {
    if (closed) {
      throw new Error("Open Artifact connector has been closed");
    }
    if (harnessInstance !== undefined) {
      if (!harnessInstance.connected) {
        await harnessInstance.ready();
      }
      return harnessInstance;
    }
    harnessPromise ??= (async () => {
      const bundled = resolveBundledOpenArtifactRuntime(options.runtimeDir);
      const harnessOpts: HarnessOptions = {
        harness: "nocturne",
        agentName: "Nocturne",
        commands: ["artifact"],
        caps: {
          tools: "native",
          library: "own",
          wake: { resume: true, mode: "auto" },
          commands: { names: ["artifact"] },
        },
        ...(bundled !== undefined
          ? {
              runtime: {
                dir: bundled.dir,
                version: bundled.version,
                update: "bundled",
              },
            }
          : {}),
        ...(options.home !== undefined ? { home: options.home } : {}),
        ...(options.autoStart !== undefined ? { autoStart: options.autoStart } : {}),
        daemon: {
          ...options.daemon,
          spawn: options.daemon?.spawn ?? spawnHiddenDaemon,
        },
        ...(options.log !== undefined ? { log: options.log } : {}),
        ...(embedMode === "view"
          ? {
              embed: {
                mode: "view",
                origins: options.embedOrigins ?? [],
                remote: "deny",
              },
              open: async (request: OpenRequest) => {
                const h = harnessInstance;
                const ticket =
                  h !== undefined
                    ? await buildTicket(h, request)
                    : {
                        url: request.url,
                        id: openArtifactIdFromUrl(request.url) ?? request.url,
                        ...(request.title !== undefined ? { title: request.title } : {}),
                        embedUrl: request.embedUrl,
                        viewUrl: request.viewUrl,
                        ...(request.view !== undefined ? { view: request.view } : {}),
                        allowedOrigins: cachedLocalOrigins,
                      };
                if (request.view) {
                  activeViews.set(request.view, request.url);
                }
                emitHostEvent({
                  kind: "open",
                  sessionId: request.session ?? null,
                  ticket,
                });
                return true;
              },
            }
          : {}),
        wake: async (params: WakeDeliverParams): Promise<WakeDeliverResult> => {
          if (runtimeHandlers === undefined) {
            return { status: "failed" };
          }
          const delivery = toWakeDelivery(params);
          const answer = await runtimeHandlers.onWake(delivery);
          const daemonStatus = answer.status === "queued" ? "delivered" : answer.status;
          return {
            status: daemonStatus,
            ...(answer.session !== undefined ? { session: answer.session } : {}),
          };
        },
      };

      const harness = await createHarnessFn(harnessOpts);
      // close() 可能在异步 createHarnessFn 期间被调用
      if (closed as boolean) {
        harness.close();
        throw new Error("Open Artifact connector closed during startup");
      }
      harnessInstance = harness;

      harness.on("state", (state) => {
        if (state === "connected") {
          void refreshLocalOrigins(harness).then((next) => {
            emitHostEvent({ kind: "origins", allowedOrigins: next });
          });
        }
      });

      harness.on("event", (event) => {
        if (event.type === "embed/origins") {
          const next = localOriginsFromResult(event);
          cachedLocalOrigins = next;
          emitHostEvent({ kind: "origins", allowedOrigins: next });
        }
      });

      harness.on("shell", (params) => {
        const artifactUrl =
          params.event.openArtifact === "shell_hello"
            ? params.event.artifact
            : (activeViews.get(params.view) ?? "");
        if (params.event.openArtifact === "shell_hello") {
          activeViews.set(params.view, params.event.artifact);
          knownArtifacts.set(params.event.id, {
            title: params.event.title,
            type: params.event.type,
          });
          void harness
            .shellCommand(params.view, hostHelloCommand(currentTheme))
            .catch(() => undefined);
        } else if (params.event.openArtifact === "close") {
          activeViews.delete(params.view);
        }
        const mapped = toShellEvent(params.event);
        if (mapped !== undefined) {
          emitHostEvent({
            kind: "shell",
            view: params.view,
            artifactUrl,
            event: mapped,
          });
        }
      });

      harness.on("artifact", (report) => {
        if (report.change === "removed") {
          knownArtifacts.delete(report.artifact.id);
        } else {
          knownArtifacts.set(report.artifact.id, {
            title: report.artifact.title,
            type: report.artifact.type,
          });
        }
        emitHostEvent({
          kind: "artifact_changed",
          sessionId: report.session ?? null,
          url: report.artifact.url,
          id: report.artifact.id,
          title: report.artifact.title,
          artifactType: report.artifact.type,
          change: report.change,
        });
      });

      if (!harness.connected) {
        await harness.ready();
      }
      await refreshLocalOrigins(harness);
      await attachTrackedSessions(harness);
      return harness;
    })().catch((err: unknown) => {
      harnessPromise = undefined;
      harnessInstance = undefined;
      throw err;
    });
    return await harnessPromise;
  };

  const ensureSessionAttached = async (
    harness: Harness,
    sessionId: string,
    workspace: string,
  ): Promise<void> => {
    const existing = sessionAccessMap.get(sessionId);
    const access: OpenArtifactSessionAccess = existing ?? {
      sessionId,
      workspace,
      role: "main",
      may: { create: true, modify: true, remove: true, reply: true },
    };
    const next: OpenArtifactSessionAccess =
      access.workspace === workspace ? access : { ...access, workspace };
    sessionAccessMap.set(sessionId, next);
    await harness.attach(toAttachParams(next)).catch(() => undefined);
  };

  const callTool = async (
    name: ToolName,
    args: Record<string, unknown>,
    caller: { sessionId: string; workspace: string },
  ): Promise<ToolCallResult> => {
    const harness = await ensureHarness();
    await ensureSessionAttached(harness, caller.sessionId, caller.workspace);
    return await harness.call(name, args, {
      session: caller.sessionId,
      workspace: caller.workspace,
    });
  };

  return {
    tools(scope: { mainSession: boolean }): ToolDefinition[] {
      return createOpenArtifactTools({ callTool, knownArtifacts }, scope);
    },

    bindRuntime(handlers: RuntimeHandlers): void {
      runtimeHandlers = handlers;
    },

    async syncSession(
      access: OpenArtifactSessionAccess,
      opts?: { ensure?: boolean },
    ): Promise<void> {
      sessionAccessMap.set(access.sessionId, access);
      if (harnessInstance === undefined && opts?.ensure !== true) {
        return;
      }
      const harness = await ensureHarness();
      await harness.attach(toAttachParams(access));
    },

    async setSessionStatus(
      sessionId: string,
      workspace: string,
      status: "running" | "idle",
    ): Promise<void> {
      const harness = harnessInstance;
      if (!harness?.connected) return;
      await harness.status({ session: sessionId, workspace }, status);
    },

    async renameSession(sessionId: string, workspace: string, title: string): Promise<void> {
      const prev = sessionAccessMap.get(sessionId);
      if (prev !== undefined) {
        sessionAccessMap.set(sessionId, { ...prev, workspace, title });
      }
      const harness = harnessInstance;
      if (!harness?.connected) return;
      await harness.rename({ session: sessionId, workspace }, title);
    },

    async detachSession(sessionId: string, workspace: string): Promise<void> {
      sessionAccessMap.delete(sessionId);
      const harness = harnessInstance;
      if (!harness?.connected) return;
      await harness.detach({ session: sessionId, workspace });
    },

    async notifyFilesWritten(
      paths: readonly string[],
      caller: { sessionId: string; workspace: string },
    ): Promise<void> {
      if (paths.length === 0) return;
      const harness = harnessInstance;
      if (!harness?.connected) return;
      await harness.wrote([...paths], {
        session: caller.sessionId,
        workspace: caller.workspace,
      });
    },

    async readSelectionContext(
      url: string,
      caller: { sessionId: string; workspace: string },
    ): Promise<string | undefined> {
      const harness = harnessInstance;
      if (!harness?.connected) return undefined;
      try {
        const ctx = await harness.context(url, {
          session: caller.sessionId,
          workspace: caller.workspace,
        });
        const block = harness.contextBlock(ctx);
        return block.trim() !== "" ? block : undefined;
      } catch {
        return undefined;
      }
    },

    async openView(
      url: string,
      opts?: { theme?: OpenArtifactTheme | undefined },
    ): Promise<OpenArtifactViewTicket> {
      if (opts?.theme !== undefined) {
        currentTheme = {
          scheme: opts.theme.scheme,
          ...(opts.theme.accent !== undefined ? { accent: opts.theme.accent } : {}),
        };
      }
      const harness = await ensureHarness();
      const request = await harness.view(url);
      return await buildTicket(harness, request);
    },

    async resolveLocalUrl(url: string): Promise<{
      url: string;
      viewUrl: string;
      title?: string | undefined;
      type?: string | undefined;
    }> {
      const harness = await ensureHarness();
      const viewUrl = await harness.viewUrl(url);
      if (viewUrl === null) {
        throw new Error(`未找到本地 Open Artifact 作品：${url}`);
      }
      const id = openArtifactIdFromUrl(url);
      const cached = id !== undefined ? knownArtifacts.get(id) : undefined;
      return {
        url,
        viewUrl,
        ...(cached?.title !== undefined ? { title: cached.title } : {}),
        ...(cached?.type !== undefined ? { type: cached.type } : {}),
      };
    },

    async getEmbedOrigins(): Promise<string[]> {
      if (harnessInstance === undefined) {
        return cachedLocalOrigins;
      }
      return await refreshLocalOrigins(harnessInstance);
    },

    async setTheme(theme: OpenArtifactTheme): Promise<void> {
      currentTheme = {
        scheme: theme.scheme,
        ...(theme.accent !== undefined ? { accent: theme.accent } : {}),
      };
      const harness = harnessInstance;
      if (!harness?.connected) return;
      const command = hostHelloCommand(currentTheme);
      await Promise.all(
        [...activeViews.keys()].map((view) =>
          harness.shellCommand(view, command).catch(() => undefined),
        ),
      );
    },

    closeView(view: string): void {
      activeViews.delete(view);
    },

    close(): void {
      closed = true;
      activeViews.clear();
      // 普通退出只断开自己的连接，绝不关闭 daemon（ADR-0125）
      harnessInstance?.close();
      harnessInstance = undefined;
      harnessPromise = undefined;
    },
  };
}
