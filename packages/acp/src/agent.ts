/**
 * Nocturne ACP Agent 服务端（ADR-0120 §1–3）。
 *
 * 将官方 ACP SDK（@agentclientprotocol/sdk）的 JSON-RPC 请求与通知映射到 Core 公开 API：
 * - initialize：协议版本协商，如实声明已实现的能力
 * - session/new：校验宿主绝对 cwd，按会话隔离接入宿主 mcpServers（stdio / Streamable HTTP）
 * - session/prompt：单会话串行（拒绝重入）、多会话按 sessionId 隔离、转发文本与工具增量
 * - session/request_permission：桥接 Core 权限层的 ask 请求，拒绝/取消/断线失败关闭
 * - session/cancel / session/close / EOF：中止在途 turn、释放本连接会话与 MCP 资源
 */
import type { Readable, Writable } from "node:stream";
import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type AgentConnection,
  type AgentContext,
  type ContentBlock as AcpContentBlock,
  type InitializeRequest,
  type InitializeResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type McpServer as AcpMcpServer,
  type NewSessionRequest,
  type NewSessionResponse,
  type PermissionOption as AcpPermissionOption,
  type PromptRequest,
  type PromptResponse,
  type SessionConfigOption,
  type SessionConfigSelectOption,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SessionUpdate,
  type StopReason,
  type Stream,
  type ToolCallContent,
  type ToolCallLocation,
  type ToolCallStatus as AcpToolCallStatus,
  type ToolKind,
} from "@agentclientprotocol/sdk";
import {
  RuntimeCommandError,
  type McpServerConfig,
  type McpValue,
  type ModelInfo,
  type ModelRef,
  type PermissionOption,
  type PermissionReply,
  type PermissionSubject,
  type Platform,
  type Runtime,
  type RuntimeEvent,
  type RuntimeSession,
  type SessionMcpInjection,
  type SubagentPendingPermission,
  type TurnEndReason,
} from "@nocturne/core";
import { effectiveEvents, userEntryText } from "@nocturne/core/protocol";

const MAX_TOOL_PROGRESS_CHARS = 32_768;
const MAX_TITLE_TARGET_CHARS = 80;

export interface AcpAgentDiagnostic {
  event: string;
  sessionId?: string | undefined;
  method?: string | undefined;
  detail?: string | undefined;
}

export interface AcpAgentOptions {
  /** Core Runtime 实例（生命周期由调用方管理） */
  runtime: Runtime;
  /** 平台抽象（路径与目录校验） */
  platform: Platform;
  /** Agent 版本号（写入 initialize.agentInfo.version） */
  version: string;
  /** 可选默认模型覆盖（如 CLI --model / NOCTURNE_MODEL） */
  model?: string | ModelRef | undefined;
  /** 可选权限预设覆盖（如 CLI --preset） */
  permissionPreset?: string | undefined;
  /**
   * 按工作区解析并校验模型；返回 undefined 时由 agent 返回引导运行 `nctrn setup` 的配置错误。
   * 未提供时依次使用 options.model、runtime.defaultModel、runtime.listModels 首个可用模型。
   */
  resolveModel?: ((workspaceRoot: string) => Promise<string | ModelRef | undefined>) | undefined;
  /** 可选诊断回调（只写 stderr，绝不含密钥明文） */
  diagnostics?: ((record: AcpAgentDiagnostic) => void) | undefined;
}

export interface AcpAgentServer {
  /** 在给定的双向 ACP Stream 上提供服务，直至连接关闭或调用 close() */
  serve(stream: Stream): Promise<void>;
  /** 幂等关闭：中断全部在途 turn，关闭本连接持有的会话与 MCP 资源，关闭连接 */
  close(): Promise<void>;
}

interface ActiveToolRecord {
  callId: string;
  name: string;
  title: string;
  kind: ToolKind;
  locations: ToolCallLocation[];
  rawInput: unknown;
  progressText: string;
}

interface PlannedToolCall {
  name: string;
  input: unknown;
}

interface ManagedSession {
  id: string;
  cwd: string;
  realCwd: string;
  session: RuntimeSession;
  unsubscribe: () => void;
  credentialsMap: Map<string, string>;
  client: AgentContext;
  busy: boolean;
  closing: boolean;
  closePromise: Promise<void> | undefined;
  cancelRequested: boolean;
  turnAbort: AbortController | undefined;
  turnPromise: Promise<void> | undefined;
  turnError: { code: string; message: string } | undefined;
  notifyQueue: Promise<void>;
  plannedTools: Map<string, PlannedToolCall>;
  activeTools: Map<string, ActiveToolRecord>;
  streamedTextMessages: Set<string>;
  streamedReasoningMessages: Set<string>;
  pendingPermissions: Map<string, AbortController>;
  pendingSubagentPermissions: Map<string, AbortController>;
  enqueueUpdate: (update: SessionUpdate) => void;
  flushUpdates: () => Promise<void>;
}

/**
 * 将 Node 的 stdin/stdout 适配为官方 SDK 的 ndJsonStream。
 * stdout 触发 EPIPE 等写入错误时视为连接断开，不抛未捕获异常。
 */
export function createAcpStdioStream(
  input: Readable,
  output: Writable,
  onOutputError?: (error: Error) => void,
): Stream {
  let inputClosed = false;
  let outputBroken = false;
  let cleanupInput: (() => void) | undefined;

  const handleOutputError = (err: Error): void => {
    outputBroken = true;
    onOutputError?.(err);
  };
  output.on("error", handleOutputError);

  const webInput = new ReadableStream<Uint8Array>({
    start(controller) {
      const finish = () => {
        if (inputClosed) return;
        inputClosed = true;
        cleanup();
        try {
          controller.close();
        } catch {
          // 已关闭时忽略
        }
      };
      const onData = (chunk: Buffer | Uint8Array | string) => {
        if (inputClosed) return;
        const bytes =
          typeof chunk === "string"
            ? Buffer.from(chunk, "utf8")
            : chunk instanceof Uint8Array
              ? chunk
              : Buffer.from(chunk);
        if (bytes.byteLength > 0) controller.enqueue(bytes);
      };
      const onEnd = () => {
        finish();
      };
      const onClose = () => {
        finish();
      };
      const onError = (err: Error) => {
        if (inputClosed) return;
        inputClosed = true;
        cleanup();
        try {
          controller.error(err);
        } catch {
          // 已关闭时忽略
        }
      };
      const cleanup = () => {
        input.off("data", onData);
        input.off("end", onEnd);
        input.off("close", onClose);
        input.off("error", onError);
      };
      cleanupInput = cleanup;
      input.on("data", onData);
      input.on("end", onEnd);
      input.on("close", onClose);
      input.on("error", onError);
      if (input.readableEnded || input.destroyed) finish();
    },
    cancel() {
      inputClosed = true;
      cleanupInput?.();
    },
  });

  const webOutput = new WritableStream<Uint8Array>({
    write(chunk) {
      if (outputBroken || output.destroyed || output.writableEnded) {
        return Promise.reject(new Error("ACP 输出流已关闭"));
      }
      return new Promise<void>((resolve, reject) => {
        const ok = output.write(chunk, (err) => {
          if (err) {
            outputBroken = true;
            reject(err);
          } else if (ok) {
            resolve();
          }
        });
        if (!ok) {
          const onDrain = () => {
            output.off("error", onErr);
            output.off("close", onClose);
            resolve();
          };
          const onErr = (err: Error) => {
            output.off("drain", onDrain);
            output.off("close", onClose);
            outputBroken = true;
            reject(err);
          };
          const onClose = () => {
            output.off("drain", onDrain);
            output.off("error", onErr);
            outputBroken = true;
            reject(new Error("ACP 输出流已关闭"));
          };
          output.once("drain", onDrain);
          output.once("error", onErr);
          output.once("close", onClose);
        }
      });
    },
    close() {
      output.off("error", handleOutputError);
    },
    abort() {
      output.off("error", handleOutputError);
    },
  });

  return ndJsonStream(webOutput, webInput);
}

function isAllowedHttpMcpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.username || url.password || url.hash) return false;
    if (url.protocol === "https:") return true;
    if (url.protocol !== "http:") return false;
    return (
      url.hostname === "localhost" ||
      url.hostname === "[::1]" ||
      /^127(?:\.\d{1,3}){3}$/.test(url.hostname)
    );
  } catch {
    return false;
  }
}

function translateHostMcpServers(
  mcpServers: readonly AcpMcpServer[],
): { injection: SessionMcpInjection; credentialsMap: Map<string, string> } | undefined {
  if (mcpServers.length === 0) return undefined;
  const servers: McpServerConfig[] = [];
  const credentialsMap = new Map<string, string>();
  const seenNames = new Set<string>();

  for (const entry of mcpServers) {
    const name = entry.name.trim();
    if (name.length === 0) {
      throw RequestError.invalidParams(undefined, "宿主 MCP 服务器名称不能为空");
    }
    const lowerName = name.toLowerCase();
    if (seenNames.has(lowerName)) {
      throw RequestError.invalidParams({ server: name }, `宿主 MCP 服务器名称重复：${name}`);
    }
    seenNames.add(lowerName);

    if ("type" in entry) {
      if (entry.type === "http") {
        if (!isAllowedHttpMcpUrl(entry.url)) {
          throw RequestError.invalidParams(
            { server: name },
            `宿主 MCP 服务器 ${name} 的 URL 无效或不受支持（仅支持 HTTPS 或回环 HTTP，且不能含凭据）`,
          );
        }
        const headers: Record<string, McpValue> = {};
        for (const header of entry.headers) {
          const headerName = header.name.trim();
          if (headerName.length === 0) continue;
          const normalizedKey = headerName.toLowerCase();
          headers[normalizedKey] = { stored: true };
          credentialsMap.set(`mcp/${name}/${normalizedKey}`, header.value);
        }
        servers.push({
          name,
          origin: "host",
          type: "http",
          url: entry.url,
          ...(Object.keys(headers).length > 0 ? { headers } : {}),
        });
        continue;
      }
      throw RequestError.invalidParams(
        { server: name, type: entry.type },
        `不支持的宿主 MCP 传输类型 "${entry.type}"（当前支持 stdio 与 Streamable HTTP）`,
      );
    }

    const command = entry.command.trim();
    if (command.length === 0) {
      throw RequestError.invalidParams(
        { server: name },
        `宿主 stdio MCP 服务器 ${name} 缺少可执行命令`,
      );
    }
    const env: Record<string, McpValue> = {};
    for (const variable of entry.env) {
      const varName = variable.name.trim();
      if (varName.length === 0) continue;
      env[varName] = { stored: true };
      credentialsMap.set(`mcp/${name}/${varName}`, variable.value);
    }
    servers.push({
      name,
      origin: "host",
      type: "stdio",
      command,
      ...(entry.args.length > 0 ? { args: [...entry.args] } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
    });
  }

  return {
    credentialsMap,
    injection: {
      servers,
      strict: true,
      credentials: {
        get: (id) => Promise.resolve(credentialsMap.get(id)),
      },
    },
  };
}

function extractPromptText(blocks: readonly AcpContentBlock[]): string {
  if (blocks.length === 0) {
    throw RequestError.invalidParams(undefined, "prompt 内容不能为空");
  }
  const parts: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        parts.push(block.text);
        break;
      case "resource_link": {
        const label = block.title ?? block.name;
        parts.push(label ? `[${label}](${block.uri})` : block.uri);
        break;
      }
      default:
        throw RequestError.invalidParams(
          { unsupportedContentType: block.type },
          `当前仅支持文本输入，不支持 ${block.type} 内容块`,
        );
    }
  }
  const joined = parts.join("\n");
  if (joined.trim().length === 0) {
    throw RequestError.invalidParams(undefined, "prompt 文本不能为空");
  }
  return joined;
}

function isAbsolutePath(platform: Platform, raw: string): boolean {
  if (raw.trim().length === 0) return false;
  if (!platform.paths.isAbsolute(raw)) return false;
  // Windows 上 "/foo" 在 path.isAbsolute 下为 true，但不是带盘符或 UNC 的完整绝对路径
  if (process.platform === "win32") {
    return /^[a-zA-Z]:[\\/]/.test(raw) || /^\\\\[^\\]+[\\/][^\\]+/.test(raw);
  }
  return true;
}

function deriveToolKind(name: string, subjects: readonly PermissionSubject[]): ToolKind {
  if (subjects.some((s) => s.kind === "shell")) return "execute";
  if (subjects.some((s) => s.kind === "edit")) return "edit";
  if (subjects.some((s) => s.kind === "network")) return "fetch";
  if (subjects.some((s) => s.kind === "read")) {
    if (name === "grep" || name === "glob") return "search";
    return "read";
  }
  if (subjects.length > 0 && subjects.every((s) => s.kind === "mcp" && s.readOnly === true)) {
    return "read";
  }
  return "other";
}

function extractLocations(
  platform: Platform,
  cwd: string,
  subjects: readonly PermissionSubject[],
  input: unknown,
): ToolCallLocation[] {
  const seen = new Set<string>();
  const locations: ToolCallLocation[] = [];
  const line =
    typeof input === "object" &&
    input !== null &&
    "offset" in input &&
    typeof (input as { offset?: unknown }).offset === "number" &&
    Number.isInteger((input as { offset: number }).offset) &&
    (input as { offset: number }).offset > 0
      ? (input as { offset: number }).offset
      : undefined;

  for (const subject of subjects) {
    if (subject.kind !== "read" && subject.kind !== "edit") continue;
    const rawTarget = subject.target.trim();
    if (rawTarget.length === 0 || rawTarget === "*") continue;
    const resolvedPath = platform.paths.isAbsolute(rawTarget)
      ? rawTarget
      : platform.paths.resolve(cwd, rawTarget);
    if (seen.has(resolvedPath)) continue;
    seen.add(resolvedPath);
    locations.push({
      path: resolvedPath,
      ...(line !== undefined && locations.length === 0 ? { line } : {}),
    });
  }
  return locations;
}

function truncateText(text: string, maxChars: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars - 1)}…`;
}

function buildToolTitle(
  platform: Platform,
  cwd: string,
  name: string,
  subjects: readonly PermissionSubject[],
  locations: readonly ToolCallLocation[],
  realCwd?: string,
): string {
  const shellSubject = subjects.find((s) => s.kind === "shell" && s.target.trim().length > 0);
  if (shellSubject !== undefined) {
    return `${name}: ${truncateText(shellSubject.target, MAX_TITLE_TARGET_CHARS)}`;
  }
  const firstLocation = locations[0];
  if (firstLocation !== undefined) {
    const displayPath = platform.paths.isWithin(cwd, firstLocation.path)
      ? platform.paths.relative(cwd, firstLocation.path) || "."
      : realCwd !== undefined && platform.paths.isWithin(realCwd, firstLocation.path)
        ? platform.paths.relative(realCwd, firstLocation.path) || "."
        : firstLocation.path;
    return `${name} ${truncateText(displayPath, MAX_TITLE_TARGET_CHARS)}`;
  }
  const networkSubject = subjects.find((s) => s.kind === "network" && s.target.trim().length > 0);
  if (networkSubject !== undefined) {
    return `${name} ${truncateText(networkSubject.target, MAX_TITLE_TARGET_CHARS)}`;
  }
  return name;
}

function resolvePlannedTool(
  planned: PlannedToolCall | undefined,
  subjects: readonly PermissionSubject[],
): PlannedToolCall {
  const mcpTarget = subjects.find((s) => s.kind === "mcp" && s.target.trim().length > 0)?.target;
  if (mcpTarget !== undefined) {
    const mcpName = `mcp__${mcpTarget.replace("/", "__")}`;
    if (
      planned !== undefined &&
      planned.name !== mcpName &&
      typeof planned.input === "object" &&
      planned.input !== null &&
      "arguments" in planned.input
    ) {
      return { name: mcpName, input: (planned.input as { arguments?: unknown }).arguments };
    }
    return { name: mcpName, input: planned?.input };
  }
  if (planned !== undefined) return planned;
  return { name: "tool", input: undefined };
}

function mapToolCompletedStatus(status: string): AcpToolCallStatus {
  return status === "ok" ? "completed" : "failed";
}

function mapTurnEndReason(
  reason: TurnEndReason,
  cancelRequested: boolean,
  turnError: { code: string; message: string } | undefined,
): StopReason {
  switch (reason) {
    case "done":
      return "end_turn";
    case "truncated":
      return "max_tokens";
    case "max_steps":
      return "max_turn_requests";
    case "refused":
      return "refusal";
    case "aborted":
      return "cancelled";
    case "error":
      if (cancelRequested) return "cancelled";
      throw RequestError.internalError(
        { code: turnError?.code ?? "turn_error" },
        turnError?.message ?? "本轮执行失败",
      );
  }
}

function buildAcpPermissionOptions(
  coreOptions: readonly PermissionOption[],
): AcpPermissionOption[] {
  const result: AcpPermissionOption[] = [];
  if (coreOptions.includes("allow_once")) {
    result.push({
      optionId: "allow_once",
      name: "Allow once",
      kind: "allow_once",
    });
  }
  result.push({
    optionId: "reject_once",
    name: "Reject",
    kind: "reject_once",
  });
  return result;
}

function toPermissionReply(
  outcome: { outcome: "cancelled" } | { outcome: "selected"; optionId: string },
  allowOptionAvailable: boolean,
): PermissionReply {
  if (outcome.outcome === "selected" && allowOptionAvailable && outcome.optionId === "allow_once") {
    return { decision: "allow" };
  }
  return { decision: "deny" };
}

function isUnknownRequestError(error: unknown): boolean {
  return error instanceof RuntimeCommandError && error.code === "unknown_request";
}

function formatModelConfigError(message?: string): RequestError {
  const detail =
    message !== undefined && message.trim().length > 0
      ? `${message}。请运行 nctrn setup 配置服务商、默认模型与凭据`
      : "未配置可用模型，请先运行 nctrn setup 配置服务商与默认模型";
  return RequestError.internalError({ code: "model_not_configured" }, detail);
}

function unknownConfigOptionError(configId: string): RequestError {
  return RequestError.invalidParams(
    { code: "unknown_config_option", configId },
    `未知的会话配置项：${configId}（当前支持 model 与 thought_level）`,
  );
}

/**
 * setModel 失败映射（ADR-0127：非法值或忙时失败必须保留原配置——
 * Core 在写入任何状态前先行校验并拒绝，这里只负责把拒绝原因如实交给宿主）。
 */
function mapSetModelError(err: unknown, value: string): RequestError {
  if (err instanceof RuntimeCommandError) {
    if (err.code === "session_busy") {
      return RequestError.invalidRequest(
        { code: "session_busy" },
        "会话正忙，不能切换模型；配置保持不变",
      );
    }
    if (err.code === "invalid_model") {
      return RequestError.invalidParams(
        { code: "invalid_model", value },
        `无效的模型选择：${err.message}；配置保持不变`,
      );
    }
    return RequestError.internalError({ code: err.code }, err.message);
  }
  return RequestError.internalError(undefined, err instanceof Error ? err.message : String(err));
}

function mapSetEffortError(err: unknown, value: string): RequestError {
  if (err instanceof RuntimeCommandError) {
    if (err.code === "invalid_command") {
      return RequestError.invalidParams(
        { code: "invalid_thought_level", value },
        `无效的思考档位：${err.message}；配置保持不变`,
      );
    }
    return RequestError.internalError({ code: err.code }, err.message);
  }
  return RequestError.internalError(undefined, err instanceof Error ? err.message : String(err));
}

function formatModelRefId(ref: ModelRef): string {
  return `${ref.provider}/${ref.model}`;
}

function parseModelRefId(raw: string): ModelRef {
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) {
    throw RequestError.invalidParams(
      { value: raw },
      `模型引用必须是 "provider/model" 形式：${raw}`,
    );
  }
  return { provider: raw.slice(0, slash), model: raw.slice(slash + 1) };
}

/**
 * 模型条目的展示标签（ADR-0127 第一阶段）：沿用桌面与 TUI 模型选择页的
 * 习惯——有上游显示名时用 `provider/显示名`，否则用完整 `provider/model` ID。
 */
function modelOptionLabel(info: ModelInfo): string {
  const display = info.displayName?.trim();
  if (display !== undefined && display.length > 0 && display !== info.ref.model) {
    return `${info.ref.provider}/${display}`;
  }
  return formatModelRefId(info.ref);
}

/**
 * 构建 ACP 会话配置项（ADR-0127 第一阶段）。
 *
 * - `model`（category "model"）：完整 `provider/model` ID 为值，保留含多段
 *   斜杠的模型 ID；可选项来自该工作区已配置的可用模型（停用与不可用模型
 *   不列出，与 /model 选择页口径一致）；当前模型不在清单中（例如经
 *   --model / NOCTURNE_MODEL 显式指定的清单外模型）时追加一项，保证
 *   currentValue 始终命中可选项。
 * - `thought_level`（category "thought_level"）：off 恒可用并列为首项，
 *   其余档位取当前模型已解析的可用集合；模型无可用档位时不出该配置项
 *   （无可调档位即无选择器，与 Paseo per-model 档位探测口径一致）。
 */
export function buildAcpSessionConfigOptions(input: {
  models: readonly ModelInfo[];
  currentModel: ModelRef;
  currentModelInfo: ModelInfo | undefined;
  currentEffort: string;
}): SessionConfigOption[] {
  const { models, currentModel, currentModelInfo, currentEffort } = input;
  const currentId = formatModelRefId(currentModel);
  const selectOptions: SessionConfigSelectOption[] = [];
  const seen = new Set<string>();

  for (const info of models) {
    if (info.unavailable !== undefined) continue;
    const id = formatModelRefId(info.ref);
    if (seen.has(id)) continue;
    seen.add(id);
    selectOptions.push({ value: id, name: modelOptionLabel(info) });
  }
  if (!seen.has(currentId)) {
    selectOptions.push({
      value: currentId,
      name: currentModelInfo !== undefined ? modelOptionLabel(currentModelInfo) : currentId,
    });
  }

  const options: SessionConfigOption[] = [
    {
      type: "select",
      id: "model",
      name: "Model",
      category: "model",
      currentValue: currentId,
      options: selectOptions,
    },
  ];

  const available = currentModelInfo?.capabilities.reasoningEffort ?? [];
  if (available.length > 0) {
    const effortOptions: SessionConfigSelectOption[] = [{ value: "off", name: "off" }];
    for (const level of available) {
      effortOptions.push({ value: level, name: level });
    }
    const validValues = new Set(effortOptions.map((o) => o.value));
    options.push({
      type: "select",
      id: "thought_level",
      name: "Thinking",
      category: "thought_level",
      currentValue: validValues.has(currentEffort) ? currentEffort : "off",
      options: effortOptions,
    });
  }

  return options;
}

export function createAcpAgentServer(options: AcpAgentOptions): AcpAgentServer {
  const { runtime, platform, version, diagnostics } = options;
  const sessions = new Map<string, ManagedSession>();
  const inFlightCreations = new Set<Promise<void>>();
  const inFlightCloses = new Set<Promise<void>>();
  let activeConnection: AgentConnection | undefined;
  let closing = false;
  let closePromise: Promise<void> | undefined;

  const recordDiag = (record: AcpAgentDiagnostic): void => {
    diagnostics?.(record);
  };

  const abortEntryPermissions = (entry: ManagedSession): void => {
    for (const controller of entry.pendingPermissions.values()) {
      controller.abort();
    }
    entry.pendingPermissions.clear();
    for (const controller of entry.pendingSubagentPermissions.values()) {
      controller.abort();
    }
    entry.pendingSubagentPermissions.clear();
  };

  const cancelEntry = (entry: ManagedSession): void => {
    if (!entry.busy) return;
    entry.cancelRequested = true;
    entry.turnAbort?.abort();
    abortEntryPermissions(entry);
    entry.session.interrupt();
  };

  const closeEntry = (entry: ManagedSession): Promise<void> => {
    if (entry.closePromise !== undefined) return entry.closePromise;
    entry.closing = true;
    sessions.delete(entry.id);
    const promise = (async () => {
      if (entry.busy) {
        cancelEntry(entry);
        await entry.turnPromise?.catch(() => undefined);
      } else {
        abortEntryPermissions(entry);
      }
      entry.unsubscribe();
      try {
        await entry.session.close();
      } finally {
        entry.credentialsMap.clear();
      }
    })();
    const tracked = promise.then(
      () => undefined,
      () => undefined,
    );
    inFlightCloses.add(tracked);
    void tracked.finally(() => {
      inFlightCloses.delete(tracked);
    });
    entry.closePromise = promise;
    return promise;
  };

  const closeAll = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    closing = true;
    closePromise = (async () => {
      while (sessions.size > 0 || inFlightCreations.size > 0 || inFlightCloses.size > 0) {
        const open = [...sessions.values()];
        for (const entry of open) {
          if (entry.busy) cancelEntry(entry);
        }
        const tasks: Promise<unknown>[] = [
          ...open.map((entry) => closeEntry(entry).catch(() => undefined)),
          ...inFlightCreations,
          ...inFlightCloses,
        ];
        await Promise.allSettled(tasks);
      }
      activeConnection?.close();
    })();
    return closePromise;
  };

  const resolveSessionModel = async (
    workspaceRoot: string,
  ): Promise<string | ModelRef | undefined> => {
    if (options.resolveModel !== undefined) {
      return await options.resolveModel(workspaceRoot);
    }
    if (options.model !== undefined) return options.model;
    const configured = runtime.defaultModel({ workspaceRoot });
    if (configured !== undefined) return configured;
    return runtime.listModels({ workspaceRoot }).find((m) => m.unavailable === undefined)?.ref;
  };

  const isServerClosing = (): boolean => closing || Boolean(activeConnection?.signal.aborted);
  const isCreationAborted = (signal?: AbortSignal): boolean =>
    isServerClosing() || Boolean(signal?.aborted);
  const isEntryStopped = (entry: ManagedSession, controller?: AbortController): boolean =>
    Boolean(controller?.signal.aborted) ||
    entry.closing ||
    isServerClosing() ||
    entry.cancelRequested;

  /**
   * 会话当前配置项快照（ADR-0127 第一阶段）。
   *
   * 工作区模型清单与工作区根按创建会话时的 realCwd 解析（与 CLI 分层
   * 配置、NOCTURNE_MODEL/--model 覆盖及默认模型解析同一入口）；当前值
   * 与可用档位直接取 Core 会话状态与 reasoningEffortInfo()——后者已按
   * 当前模型就近降档，current 即下一轮的持久化意图。
   */
  const buildSessionConfigOptions = (entry: ManagedSession): SessionConfigOption[] => {
    const currentRef = entry.session.state().config.model;
    const models = runtime.listModels({ workspaceRoot: entry.realCwd });
    const currentModelInfo =
      models.find(
        (m) => m.ref.provider === currentRef.provider && m.ref.model === currentRef.model,
      ) ?? undefined;
    const effort = entry.session.reasoningEffortInfo();
    return buildAcpSessionConfigOptions({
      models,
      currentModel: currentRef,
      currentModelInfo,
      currentEffort: effort.current,
    });
  };

  const handleSetConfigOption = async (
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> => {
    const entry = sessions.get(params.sessionId);
    if (entry === undefined) {
      throw RequestError.resourceNotFound(params.sessionId);
    }
    if (entry.closing || isServerClosing()) {
      throw RequestError.invalidRequest({ sessionId: params.sessionId }, "会话已关闭");
    }
    // 布尔型配置项当前不存在：布尔请求一律按未知配置项拒绝（fail-closed，
    // 避免旧宿主误写尚未实现的开关）。
    const rawValue = typeof params.value === "boolean" ? undefined : params.value;

    if (params.configId === "model") {
      if (rawValue === undefined) {
        throw unknownConfigOptionError(params.configId);
      }
      const ref = parseModelRefId(rawValue);
      try {
        await entry.session.setModel(ref);
      } catch (err) {
        throw mapSetModelError(err, rawValue);
      }
    } else if (params.configId === "thought_level") {
      if (rawValue === undefined) {
        throw unknownConfigOptionError(params.configId);
      }
      try {
        await entry.session.setReasoningEffort(rawValue);
      } catch (err) {
        throw mapSetEffortError(err, rawValue);
      }
    } else {
      throw unknownConfigOptionError(params.configId);
    }

    // 返回更新后的完整配置（ADR-0127：换模型后档位集合随之刷新）
    const configOptions = buildSessionConfigOptions(entry);
    // 同步回报 config_option_update，宿主（Paseo 0.17.5）据此更新会话快照
    entry.enqueueUpdate({
      sessionUpdate: "config_option_update",
      configOptions,
    });
    recordDiag({
      event: "session_set_config_option",
      sessionId: entry.id,
      detail: params.configId,
    });
    return { configOptions };
  };

  const forwardPermission = (
    entry: ManagedSession,
    requestId: string,
    callId: string,
    subjects: readonly PermissionSubject[],
    reason: string,
    coreOptions: readonly PermissionOption[],
  ): void => {
    if (isEntryStopped(entry)) {
      void entry.session.respondPermission(requestId, { decision: "deny" }).catch(() => undefined);
      return;
    }
    const controller = new AbortController();
    entry.pendingPermissions.set(requestId, controller);
    const acpOptions = buildAcpPermissionOptions(coreOptions);
    const allowOptionAvailable = acpOptions.some((o) => o.optionId === "allow_once");

    void (async () => {
      try {
        // 先确保 tool_call 通知已经写出，再请求宿主审批
        await entry.flushUpdates();
        if (isEntryStopped(entry, controller)) {
          return;
        }
        const record = entry.activeTools.get(callId);
        const locations =
          record?.locations ?? extractLocations(platform, entry.cwd, subjects, undefined);
        const kind = record?.kind ?? deriveToolKind("", subjects);
        const title =
          record?.title ??
          buildToolTitle(platform, entry.cwd, "tool", subjects, locations, entry.realCwd);

        const response = await entry.client.request(
          methods.client.session.requestPermission,
          {
            sessionId: entry.id,
            toolCall: {
              toolCallId: callId,
              ...(record?.name !== undefined ? { name: record.name } : {}),
              title,
              kind,
              status: "pending",
              ...(locations.length > 0 ? { locations } : {}),
              ...(record?.rawInput !== undefined ? { rawInput: record.rawInput } : {}),
              ...(reason.length > 0
                ? { content: [{ type: "content", content: { type: "text", text: reason } }] }
                : {}),
            },
            options: acpOptions,
          },
          { cancellationSignal: controller.signal },
        );

        if (isEntryStopped(entry, controller)) {
          await entry.session
            .respondPermission(requestId, { decision: "deny" })
            .catch(() => undefined);
          return;
        }
        const reply = toPermissionReply(response.outcome, allowOptionAvailable);
        await entry.session.respondPermission(requestId, reply).catch((err: unknown) => {
          if (!isUnknownRequestError(err)) {
            recordDiag({
              event: "permission_reply_failed",
              sessionId: entry.id,
              detail: err instanceof Error ? err.message : String(err),
            });
          }
        });
      } catch {
        // 宿主断线、取消或拒绝处理请求时失败关闭，绝不执行待审操作
        if (!controller.signal.aborted) {
          await entry.session
            .respondPermission(requestId, { decision: "deny" })
            .catch(() => undefined);
        }
      } finally {
        if (entry.pendingPermissions.get(requestId) === controller) {
          entry.pendingPermissions.delete(requestId);
        }
      }
    })();
  };

  const syncSubagentPermissions = (
    entry: ManagedSession,
    pending: readonly SubagentPendingPermission[],
  ): void => {
    const activeKeys = new Set<string>();
    for (const item of pending) {
      const key = `${item.childSessionId}:${item.requestId}`;
      activeKeys.add(key);
      if (entry.pendingSubagentPermissions.has(key)) continue;

      if (isEntryStopped(entry)) {
        void entry.session
          .respondSubagentPermission(item.childSessionId, item.requestId, { decision: "deny" })
          .catch(() => undefined);
        continue;
      }

      const controller = new AbortController();
      entry.pendingSubagentPermissions.set(key, controller);
      const acpOptions = buildAcpPermissionOptions(item.options);
      const allowOptionAvailable = acpOptions.some((o) => o.optionId === "allow_once");

      void (async () => {
        try {
          await entry.flushUpdates();
          if (isEntryStopped(entry, controller)) {
            return;
          }
          const locations = extractLocations(platform, entry.cwd, item.subjects, undefined);
          const toolName = item.toolName ?? "subagent";
          const kind = deriveToolKind(toolName, item.subjects);
          const title = buildToolTitle(
            platform,
            entry.cwd,
            toolName,
            item.subjects,
            locations,
            entry.realCwd,
          );

          const response = await entry.client.request(
            methods.client.session.requestPermission,
            {
              sessionId: entry.id,
              toolCall: {
                toolCallId: item.parentCallId,
                name: toolName,
                title,
                kind,
                status: "pending",
                ...(locations.length > 0 ? { locations } : {}),
                ...(item.reason.length > 0
                  ? {
                      content: [{ type: "content", content: { type: "text", text: item.reason } }],
                    }
                  : {}),
              },
              options: acpOptions,
            },
            { cancellationSignal: controller.signal },
          );

          if (isEntryStopped(entry, controller)) {
            await entry.session
              .respondSubagentPermission(item.childSessionId, item.requestId, { decision: "deny" })
              .catch(() => undefined);
            return;
          }
          const reply = toPermissionReply(response.outcome, allowOptionAvailable);
          await entry.session
            .respondSubagentPermission(item.childSessionId, item.requestId, reply)
            .catch(() => undefined);
        } catch {
          if (!controller.signal.aborted) {
            await entry.session
              .respondSubagentPermission(item.childSessionId, item.requestId, { decision: "deny" })
              .catch(() => undefined);
          }
        } finally {
          if (entry.pendingSubagentPermissions.get(key) === controller) {
            entry.pendingSubagentPermissions.delete(key);
          }
        }
      })();
    }

    for (const [key, controller] of [...entry.pendingSubagentPermissions.entries()]) {
      if (!activeKeys.has(key)) {
        controller.abort();
        entry.pendingSubagentPermissions.delete(key);
      }
    }
  };

  const handleSessionEvent = (entry: ManagedSession, event: RuntimeEvent): void => {
    if (entry.closing || isServerClosing()) return;

    switch (event.type) {
      case "message.assistant.delta": {
        if (event.payload.delta.length === 0) return;
        if (event.payload.kind === "text") {
          entry.streamedTextMessages.add(event.payload.messageId);
          entry.enqueueUpdate({
            sessionUpdate: "agent_message_chunk",
            messageId: event.payload.messageId,
            content: { type: "text", text: event.payload.delta },
          });
        } else {
          entry.streamedReasoningMessages.add(event.payload.messageId);
          entry.enqueueUpdate({
            sessionUpdate: "agent_thought_chunk",
            messageId: event.payload.messageId,
            content: { type: "text", text: event.payload.delta },
          });
        }
        return;
      }

      case "message.assistant": {
        const messageId = event.payload.messageId;
        for (const tc of event.payload.toolCalls) {
          entry.plannedTools.set(tc.callId, { name: tc.name, input: tc.input });
        }
        const hadText = entry.streamedTextMessages.has(messageId);
        const hadReasoning = entry.streamedReasoningMessages.has(messageId);
        for (const block of event.payload.content) {
          if (block.text.length === 0) continue;
          if (block.type === "text" && !hadText) {
            entry.enqueueUpdate({
              sessionUpdate: "agent_message_chunk",
              messageId,
              content: { type: "text", text: block.text },
            });
          } else if (block.type === "reasoning" && !hadReasoning) {
            entry.enqueueUpdate({
              sessionUpdate: "agent_thought_chunk",
              messageId,
              content: { type: "text", text: block.text },
            });
          }
        }
        return;
      }

      case "tool.started": {
        const { callId, name, input, target, subjects, permission } = event.payload;
        const effectiveName = target?.name ?? name;
        const effectiveInput = target?.input ?? input;
        const kind = deriveToolKind(effectiveName, subjects);
        const locations = extractLocations(platform, entry.cwd, subjects, effectiveInput);
        const title = buildToolTitle(
          platform,
          entry.cwd,
          effectiveName,
          subjects,
          locations,
          entry.realCwd,
        );
        const status: AcpToolCallStatus = permission.action === "allow" ? "in_progress" : "pending";
        const existing = entry.activeTools.get(callId);

        entry.activeTools.set(callId, {
          callId,
          name: effectiveName,
          title,
          kind,
          locations,
          rawInput: effectiveInput,
          progressText: existing?.progressText ?? "",
        });
        if (existing !== undefined) {
          entry.enqueueUpdate({
            sessionUpdate: "tool_call_update",
            toolCallId: callId,
            title,
            kind,
            status,
            ...(locations.length > 0 ? { locations } : {}),
            rawInput: effectiveInput,
          });
        } else {
          entry.enqueueUpdate({
            sessionUpdate: "tool_call",
            toolCallId: callId,
            name: effectiveName,
            title,
            kind,
            status,
            ...(locations.length > 0 ? { locations } : {}),
            rawInput: effectiveInput,
          });
        }
        return;
      }

      case "permission.requested": {
        const { requestId, callId, subjects, reason, options: permOptions } = event.payload;
        if (!entry.activeTools.has(callId)) {
          const planned = entry.plannedTools.get(callId);
          const { name: effectiveName, input: effectiveInput } = resolvePlannedTool(
            planned,
            subjects,
          );
          const kind = deriveToolKind(effectiveName, subjects);
          const locations = extractLocations(platform, entry.cwd, subjects, effectiveInput);
          const title = buildToolTitle(
            platform,
            entry.cwd,
            effectiveName,
            subjects,
            locations,
            entry.realCwd,
          );
          entry.activeTools.set(callId, {
            callId,
            name: effectiveName,
            title,
            kind,
            locations,
            rawInput: effectiveInput,
            progressText: "",
          });
          entry.enqueueUpdate({
            sessionUpdate: "tool_call",
            toolCallId: callId,
            name: effectiveName,
            title,
            kind,
            status: "pending",
            ...(locations.length > 0 ? { locations } : {}),
            ...(effectiveInput !== undefined ? { rawInput: effectiveInput } : {}),
          });
        }
        forwardPermission(entry, requestId, callId, subjects, reason, permOptions);
        return;
      }

      case "permission.resolved": {
        const { requestId, callId, action } = event.payload;
        if (requestId !== undefined) {
          const controller = entry.pendingPermissions.get(requestId);
          if (controller !== undefined) {
            controller.abort();
            entry.pendingPermissions.delete(requestId);
          }
        }
        if (action === "allow" && entry.activeTools.has(callId)) {
          entry.enqueueUpdate({
            sessionUpdate: "tool_call_update",
            toolCallId: callId,
            status: "in_progress",
          });
        }
        return;
      }

      case "subagent.permissions": {
        syncSubagentPermissions(entry, event.payload.pending);
        return;
      }

      case "question.requested": {
        // ACP 首版未接问答交互；立即以 declined 结算，避免模型调用 ask_user 时无限挂起
        void entry.session
          .respondQuestion(event.payload.requestId, {
            answers: event.payload.questions.map(() => ({ declined: true })),
          })
          .catch(() => undefined);
        return;
      }

      case "tool.progress": {
        const { callId, chunk } = event.payload;
        if (chunk.length === 0) return;
        const record = entry.activeTools.get(callId);
        if (record === undefined) return;
        const combined = record.progressText + chunk;
        record.progressText =
          combined.length > MAX_TOOL_PROGRESS_CHARS
            ? combined.slice(-MAX_TOOL_PROGRESS_CHARS)
            : combined;
        entry.enqueueUpdate({
          sessionUpdate: "tool_call_update",
          toolCallId: callId,
          status: "in_progress",
          content: [{ type: "content", content: { type: "text", text: record.progressText } }],
        });
        return;
      }

      case "tool.completed": {
        const { callId, name, status, modelContent, output, error } = event.payload;
        const acpStatus = mapToolCompletedStatus(status);
        const text = modelContent.length > 0 ? modelContent : (error?.message ?? "");
        const content: ToolCallContent[] | undefined =
          text.length > 0 ? [{ type: "content", content: { type: "text", text } }] : undefined;
        const rawOutput = output ?? error ?? modelContent;
        const hadStarted = entry.activeTools.delete(callId);
        entry.plannedTools.delete(callId);

        if (!hadStarted) {
          entry.enqueueUpdate({
            sessionUpdate: "tool_call",
            toolCallId: callId,
            name,
            title: name,
            kind: "other",
            status: acpStatus,
            ...(content !== undefined ? { content } : {}),
            rawOutput,
          });
        } else {
          entry.enqueueUpdate({
            sessionUpdate: "tool_call_update",
            toolCallId: callId,
            status: acpStatus,
            ...(content !== undefined ? { content } : {}),
            rawOutput,
          });
        }
        return;
      }

      case "turn.completed": {
        if (event.payload.error !== undefined) {
          entry.turnError = event.payload.error;
        }
        return;
      }

      case "runtime.error": {
        entry.turnError ??= { code: event.payload.code, message: event.payload.message };
        return;
      }

      default:
        return;
    }
  };

  const handleInitialize = (_params: InitializeRequest): InitializeResponse => {
    recordDiag({ event: "initialize", method: methods.agent.initialize });
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: {
        name: "nocturne",
        title: "Nocturne",
        version,
      },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          image: false,
          audio: false,
          embeddedContext: false,
        },
        mcpCapabilities: {
          http: true,
          sse: false,
          acp: false,
        },
        sessionCapabilities: {
          close: {},
        },
      },
    };
  };

  /**
   * 登记一个已打开的 Core 会话为本连接的受管会话（session/new 与 session/load 共用）。
   * 订阅事件、建立 MCP 凭据归属、注册到会话表。
   */
  const adoptSession = (
    session: RuntimeSession,
    cwd: string,
    realCwd: string,
    credentialsMap: Map<string, string>,
    client: AgentContext,
  ): ManagedSession => {
    const entry: ManagedSession = {
      id: session.id,
      cwd,
      realCwd,
      session,
      unsubscribe: () => undefined,
      credentialsMap,
      client,
      busy: false,
      closing: false,
      closePromise: undefined,
      cancelRequested: false,
      turnAbort: undefined,
      turnPromise: undefined,
      turnError: undefined,
      notifyQueue: Promise.resolve(),
      plannedTools: new Map(),
      activeTools: new Map(),
      streamedTextMessages: new Set(),
      streamedReasoningMessages: new Set(),
      pendingPermissions: new Map(),
      pendingSubagentPermissions: new Map(),
      enqueueUpdate: (update) => {
        if (entry.closing || isServerClosing()) return;
        entry.notifyQueue = entry.notifyQueue
          .then(() =>
            entry.client.notify(methods.client.session.update, {
              sessionId: entry.id,
              update,
            }),
          )
          .catch(() => undefined);
      },
      flushUpdates: () => entry.notifyQueue,
    };
    entry.unsubscribe = session.subscribe((event) => {
      handleSessionEvent(entry, event);
    });
    sessions.set(session.id, entry);
    return entry;
  };

  const handleNewSession = async (
    params: NewSessionRequest,
    client: AgentContext,
    signal: AbortSignal,
  ): Promise<NewSessionResponse> => {
    if (isCreationAborted(signal)) {
      throw RequestError.invalidRequest(undefined, "ACP 连接正在关闭");
    }
    if (!isAbsolutePath(platform, params.cwd)) {
      throw RequestError.invalidParams({ cwd: params.cwd }, `cwd 必须是绝对路径：${params.cwd}`);
    }
    if (params.additionalDirectories !== undefined && params.additionalDirectories.length > 0) {
      throw RequestError.invalidParams(
        { additionalDirectories: params.additionalDirectories },
        "首版 ACP 不支持 additionalDirectories",
      );
    }

    const stat = await platform.fs.stat(params.cwd).catch(() => undefined);
    if (isCreationAborted(signal)) {
      throw RequestError.invalidRequest(undefined, "ACP 连接已关闭");
    }
    if (stat?.type !== "directory") {
      throw RequestError.invalidParams(
        { cwd: params.cwd },
        `工作目录不存在或不是目录：${params.cwd}`,
      );
    }

    let realCwd: string;
    try {
      realCwd = await platform.resolveReal(params.cwd);
    } catch (err) {
      if (isCreationAborted(signal)) {
        throw RequestError.invalidRequest(undefined, "ACP 连接已关闭");
      }
      throw RequestError.invalidParams(
        { cwd: params.cwd },
        `无法解析工作目录：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (isCreationAborted(signal)) {
      throw RequestError.invalidRequest(undefined, "ACP 连接已关闭");
    }

    const translatedMcp = translateHostMcpServers(params.mcpServers);
    const credentialsMap = translatedMcp?.credentialsMap ?? new Map<string, string>();

    const onPreCreateAbort = (): void => {
      credentialsMap.clear();
    };
    signal.addEventListener("abort", onPreCreateAbort, { once: true });

    let resolvedModel: string | ModelRef | undefined;
    try {
      resolvedModel = await resolveSessionModel(realCwd);
    } catch (err) {
      credentialsMap.clear();
      if (isCreationAborted(signal)) {
        throw RequestError.invalidRequest(undefined, "ACP 连接已关闭");
      }
      if (err instanceof RequestError) throw err;
      if (err instanceof RuntimeCommandError) {
        if (err.code === "invalid_model") {
          throw formatModelConfigError(err.message);
        }
        if (err.code === "invalid_command") {
          throw RequestError.invalidParams({ code: err.code }, err.message);
        }
        throw RequestError.internalError({ code: err.code }, err.message);
      }
      throw RequestError.internalError(undefined, err instanceof Error ? err.message : String(err));
    } finally {
      signal.removeEventListener("abort", onPreCreateAbort);
    }
    if (isCreationAborted(signal)) {
      credentialsMap.clear();
      throw RequestError.invalidRequest(undefined, "ACP 连接已关闭");
    }
    if (resolvedModel === undefined) {
      credentialsMap.clear();
      throw formatModelConfigError();
    }

    // 同步登记到 inFlightCreations，确保在进入 runtime.createSession 后 closeAll 必等其释放完毕
    const { promise: tracked, resolve: finishTracked } = Promise.withResolvers<undefined>();
    inFlightCreations.add(tracked);
    let createdSession: RuntimeSession | undefined;
    try {
      try {
        createdSession = await runtime.createSession({
          model: resolvedModel,
          cwd: params.cwd,
          workspaceRoot: realCwd,
          interactive: true,
          ...(options.permissionPreset !== undefined
            ? { permissionPreset: options.permissionPreset }
            : {}),
          ...(translatedMcp !== undefined ? { sessionMcp: translatedMcp.injection } : {}),
          // ADR-0127 第二阶段：ACP 会话归属标记——session/load 只接受带此标记的会话，
          // 避免恢复接口成为打开任意本地会话的入口
          client: { kind: "agent", name: "acp", deviceId: "acp" },
        });
      } catch (err) {
        credentialsMap.clear();
        if (err instanceof RuntimeCommandError) {
          if (err.code === "invalid_model") {
            throw formatModelConfigError(err.message);
          }
          if (err.code === "invalid_command") {
            throw RequestError.invalidParams({ code: err.code }, err.message);
          }
          throw RequestError.internalError({ code: err.code }, err.message);
        }
        throw RequestError.internalError(
          undefined,
          err instanceof Error ? err.message : String(err),
        );
      }

      if (isCreationAborted(signal)) {
        await createdSession.close().catch(() => undefined);
        credentialsMap.clear();
        throw RequestError.invalidRequest(undefined, "ACP 连接已关闭");
      }

      const session = createdSession;
      const entry = adoptSession(session, params.cwd, realCwd, credentialsMap, client);
      recordDiag({ event: "session_new", sessionId: session.id });
      const configOptions = buildSessionConfigOptions(entry);
      return { sessionId: session.id, configOptions };
    } finally {
      inFlightCreations.delete(tracked);
      finishTracked(undefined);
    }
  };

  /**
   * ADR-0127 第二阶段：把已持久化的会话历史投影为 ACP 更新流。
   *
   * 规则：
   * - 只投影有效事件（effectiveEvents——回退后的历史，与 SessionView 同一口径）；
   * - 用户消息按 userEntryText 去快照块后发 user_message_chunk（整文一块）；
   * - 助手消息按 content 顺序发 agent_message_chunk / agent_thought_chunk；
   * - 工具调用按最终持久状态发单个 tool_call（终态+内容），不重放审批、不重复执行；
   * - turn/config/权限事件不投影——它们是执行痕迹，不是对话内容；
   * - 全部更新在 loadSession 响应之前发出（协议：历史在响应前流完）。
   */
  const replayHistory = (entry: ManagedSession): void => {
    const events = effectiveEvents(entry.session.durableEvents());
    const toolStarted = new Map<string, { name: string; input: unknown }>();
    const pendingTools = new Map<string, { name: string; input: unknown }>();

    const flushTool = (callId: string, ev: RuntimeEvent & { type: "tool.completed" }): void => {
      const started = toolStarted.get(callId);
      const name = started?.name ?? ev.payload.name;
      const input = started?.input;
      const status = mapToolCompletedStatus(ev.payload.status);
      const text =
        ev.payload.modelContent.length > 0
          ? ev.payload.modelContent
          : (ev.payload.error?.message ?? "");
      const content: ToolCallContent[] | undefined =
        text.length > 0 ? [{ type: "content", content: { type: "text", text } }] : undefined;
      entry.enqueueUpdate({
        sessionUpdate: "tool_call",
        toolCallId: callId,
        name,
        title: name,
        kind: "other",
        status,
        ...(content !== undefined ? { content } : {}),
        ...(input !== undefined ? { rawInput: input } : {}),
        rawOutput: ev.payload.output ?? ev.payload.error ?? ev.payload.modelContent,
      });
      toolStarted.delete(callId);
    };

    for (const ev of events) {
      switch (ev.type) {
        case "message.user": {
          const p = ev.payload;
          // 后台子代理结果、合奏/组曲投递、运行时工作模式消息不是用户对话——跳过投递类
          if (p.subagent !== undefined || p.ensemble !== undefined || p.suiteReport !== undefined)
            break;
          if (p.ensembleQuietReminder === true) break;
          const text = userEntryText({
            content: p.content,
            quotes: p.quotes,
            fileRefs: p.fileRefs,
            skill: p.skill,
            delegate: p.delegate,
            files: p.files,
            workMode: p.workMode,
            pageComments: p.pageComments,
          });
          if (text.trim().length === 0) break;
          entry.enqueueUpdate({
            sessionUpdate: "user_message_chunk",
            messageId: p.messageId,
            content: { type: "text", text },
          });
          break;
        }
        case "message.assistant": {
          const p = ev.payload;
          for (const tc of p.toolCalls) {
            pendingTools.set(tc.callId, { name: tc.name, input: tc.input });
          }
          for (const block of p.content) {
            if (block.text.length === 0) continue;
            entry.enqueueUpdate({
              sessionUpdate:
                block.type === "reasoning" ? "agent_thought_chunk" : "agent_message_chunk",
              messageId: p.messageId,
              content: { type: "text", text: block.text },
            });
          }
          break;
        }
        case "tool.started": {
          const planned = pendingTools.get(ev.payload.callId);
          toolStarted.set(ev.payload.callId, {
            name: ev.payload.target?.name ?? ev.payload.name,
            input: ev.payload.target?.input ?? ev.payload.input ?? planned?.input,
          });
          break;
        }
        case "tool.completed": {
          flushTool(ev.payload.callId, ev);
          pendingTools.delete(ev.payload.callId);
          break;
        }
        default:
          break;
      }
    }
  };

  /**
   * ADR-0127 第二阶段：session/load——按已知 ID 恢复此前通过 ACP 创建的会话。
   *
   * 校验链（任一失败即拒绝，不碰锁）：
   * 1. 会话已在本连接受管 → invalid_request（重复 load）；
   * 2. cwd 必须是绝对路径、存在且为目录（与 session/new 同一校验）；
   * 3. 会话日志必须存在且归属 ACP（session.created.client.name === "acp"）——
   *    不是 ACP 创建的会话一律 resourceNotFound，恢复接口不成为任意本地会话入口；
   * 4. 请求 cwd 必须匹配会话当前执行目录（考虑 worktree 切换后的 current）；
   * 5. 锁被占用（别的进程持有）→ 明确拒绝，不 force。
   * 恢复后回放历史（响应之前），新轮使用本连接的宿主 MCP 与审批桥。
   */
  const handleLoadSession = async (
    params: LoadSessionRequest,
    client: AgentContext,
    signal: AbortSignal,
  ): Promise<LoadSessionResponse> => {
    if (isCreationAborted(signal)) {
      throw RequestError.invalidRequest(undefined, "ACP 连接正在关闭");
    }
    const sessionId = params.sessionId;
    if (typeof sessionId !== "string" || !/^[A-Za-z0-9_-]+$/.test(sessionId)) {
      throw RequestError.invalidParams({ sessionId }, "无效的会话 ID");
    }
    if (sessions.has(sessionId)) {
      throw RequestError.invalidRequest(
        { code: "session_already_loaded", sessionId },
        "会话已在当前连接中打开",
      );
    }
    if (!isAbsolutePath(platform, params.cwd)) {
      throw RequestError.invalidParams({ cwd: params.cwd }, `cwd 必须是绝对路径：${params.cwd}`);
    }
    if (params.additionalDirectories !== undefined && params.additionalDirectories.length > 0) {
      throw RequestError.invalidParams(
        { additionalDirectories: params.additionalDirectories },
        "当前 ACP 不支持 additionalDirectories",
      );
    }

    const stat = await platform.fs.stat(params.cwd).catch(() => undefined);
    if (stat?.type !== "directory") {
      throw RequestError.invalidParams(
        { cwd: params.cwd },
        `工作目录不存在或不是目录：${params.cwd}`,
      );
    }
    let realCwd: string;
    try {
      realCwd = await platform.resolveReal(params.cwd);
    } catch (err) {
      throw RequestError.invalidParams(
        { cwd: params.cwd },
        `无法解析工作目录：${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const translatedMcp = translateHostMcpServers(params.mcpServers);
    const credentialsMap = translatedMcp?.credentialsMap ?? new Map<string, string>();

    const { promise: tracked, resolve: finishTracked } = Promise.withResolvers<undefined>();
    inFlightCreations.add(tracked);
    let resumed: RuntimeSession | undefined;
    try {
      // 资格校验放进 Core 的锁内回调（ResumeSessionOptions.validate）：在装配宿主 MCP、
      // 绑定工具或投递历史之前执行，且与最终恢复读取的是同一份会话状态（无读改竞态）。
      // 校验抛错时 Core 关闭会话、释放锁，宿主工具从未绑定。
      // 校验失败用带 acpLoadRejection 标记的错误把拒绝原因传出锁外，再映射为协议错误。
      const validate = async (state: ReturnType<RuntimeSession["state"]>): Promise<void> => {
        const reject = (kind: "foreign" | "workspace_mismatch", detail?: string): never => {
          const err = new Error(kind) as Error & { acpLoadRejection?: string; detail?: string };
          err.acpLoadRejection = kind;
          if (detail !== undefined) err.detail = detail;
          throw err;
        };
        const meta = state.meta;
        // 归属校验：只接受 ACP 创建的会话（session/new 写入的 client 标记）
        if (meta.client?.kind !== "agent" || meta.client.name !== "acp") {
          reject("foreign");
        }
        // 子会话（subagent）不是可交互会话，拒绝
        if (meta.parent !== undefined) {
          reject("foreign");
        }
        // 工作区校验：请求 cwd 必须匹配会话当前执行目录（worktree 切换后取 current）。
        // 用平台真实路径语义比较（paths.equals 按平台大小写规则 canonicalize），
        // 不做跨平台一律小写化/反斜杠替换——POSIX 上大小写或反斜杠不同的是独立目录。
        const currentExec = state.config.worktree?.current ?? meta.cwd;
        // realpath 失败（目标已被删除/不可读）时拒绝恢复，不靠未验证的字符串匹配继续。
        const realExec = await platform.resolveReal(currentExec).catch((err: unknown): never => {
          return reject(
            "workspace_mismatch",
            `无法解析会话工作目录：${err instanceof Error ? err.message : String(err)}`,
          );
        });
        if (!platform.paths.equals(realCwd, realExec)) {
          reject("workspace_mismatch", `工作区不匹配：会话属于 ${currentExec}`);
        }
      };
      try {
        resumed = await runtime.resumeSession(sessionId, {
          ...(translatedMcp !== undefined ? { sessionMcp: translatedMcp.injection } : {}),
          validate,
        });
      } catch (err) {
        credentialsMap.clear();
        const rejection = (err as { acpLoadRejection?: string } | undefined)?.acpLoadRejection;
        if (rejection === "foreign") {
          recordDiag({ event: "session_load_rejected_foreign", sessionId });
          throw RequestError.resourceNotFound(sessionId);
        }
        if (rejection === "workspace_mismatch") {
          const detail = (err as { detail?: string } | undefined)?.detail;
          recordDiag({ event: "session_load_rejected_cwd", sessionId, detail });
          throw RequestError.invalidParams(
            { code: "workspace_mismatch", sessionId },
            detail ?? "工作区不匹配",
          );
        }
        if (err instanceof RuntimeCommandError) {
          throw RequestError.internalError({ code: err.code }, err.message);
        }
        const code = (err as { code?: string } | undefined)?.code;
        if (code === "session_locked") {
          throw RequestError.invalidRequest(
            { code: "session_locked", sessionId },
            "会话被另一个进程占用",
          );
        }
        if (code === "invalid_model") {
          throw RequestError.internalError(
            { code: "invalid_model", sessionId },
            "会话记录的模型在当前配置中不可用，无法恢复",
          );
        }
        throw RequestError.resourceNotFound(sessionId);
      }

      if (isCreationAborted(signal)) {
        await resumed.close().catch(() => undefined);
        credentialsMap.clear();
        throw RequestError.invalidRequest(undefined, "ACP 连接已关闭");
      }

      const entry = adoptSession(resumed, params.cwd, realCwd, credentialsMap, client);
      recordDiag({ event: "session_load", sessionId: resumed.id });

      // 历史回放在响应之前全部发出（协议时序）——不重新执行工具、不重放审批
      replayHistory(entry);
      await entry.flushUpdates();

      const configOptions = buildSessionConfigOptions(entry);
      return { configOptions };
    } finally {
      inFlightCreations.delete(tracked);
      finishTracked(undefined);
    }
  };

  const handlePrompt = async (
    params: PromptRequest,
    signal: AbortSignal,
  ): Promise<PromptResponse> => {
    const entry = sessions.get(params.sessionId);
    if (entry === undefined) {
      throw RequestError.resourceNotFound(params.sessionId);
    }
    if (entry.closing || isServerClosing()) {
      throw RequestError.invalidRequest({ sessionId: params.sessionId }, "会话已关闭");
    }
    if (entry.busy) {
      throw RequestError.invalidRequest(
        { code: "session_busy", sessionId: params.sessionId },
        "当前会话仍在处理上一轮请求，请等待完成或先发送 session/cancel",
      );
    }

    const promptText = extractPromptText(params.prompt);
    entry.busy = true;
    entry.cancelRequested = false;
    entry.turnError = undefined;
    entry.plannedTools.clear();
    entry.activeTools.clear();
    entry.streamedTextMessages.clear();
    entry.streamedReasoningMessages.clear();
    entry.turnAbort = new AbortController();

    const onRequestAbort = () => {
      cancelEntry(entry);
    };
    signal.addEventListener("abort", onRequestAbort, { once: true });
    if (signal.aborted) cancelEntry(entry);

    const { promise: turnDone, resolve: resolveTurnDone } = Promise.withResolvers<undefined>();
    entry.turnPromise = turnDone.then(() => undefined);

    try {
      recordDiag({ event: "prompt_start", sessionId: entry.id });
      const endReason = await entry.session.submit({ text: promptText });
      // 保证最终 prompt 响应一定跟在本轮最后一次 session/update 之后（ADR-0120 §2）
      await entry.flushUpdates();
      const stopReason = mapTurnEndReason(endReason, entry.cancelRequested, entry.turnError);
      recordDiag({ event: "prompt_end", sessionId: entry.id, detail: stopReason });
      return { stopReason };
    } catch (err) {
      await entry.flushUpdates();
      if (err instanceof RequestError) throw err;
      if (isEntryStopped(entry) || signal.aborted) {
        return { stopReason: "cancelled" };
      }
      if (err instanceof RuntimeCommandError) {
        if (err.code === "session_busy") {
          throw RequestError.invalidRequest({ code: err.code }, err.message);
        }
        if (err.code === "invalid_model") {
          throw formatModelConfigError(err.message);
        }
        throw RequestError.internalError({ code: err.code }, err.message);
      }
      throw RequestError.internalError(undefined, err instanceof Error ? err.message : String(err));
    } finally {
      signal.removeEventListener("abort", onRequestAbort);
      entry.turnAbort.abort();
      entry.turnAbort = undefined;
      abortEntryPermissions(entry);
      entry.plannedTools.clear();
      entry.activeTools.clear();
      entry.streamedTextMessages.clear();
      entry.streamedReasoningMessages.clear();
      entry.busy = false;
      entry.turnPromise = undefined;
      resolveTurnDone(undefined);
    }
  };

  const handleCancel = (sessionId: string): void => {
    const entry = sessions.get(sessionId);
    if (entry === undefined) return;
    recordDiag({ event: "session_cancel", sessionId });
    cancelEntry(entry);
  };

  const handleCloseSession = async (sessionId: string): Promise<Record<string, never>> => {
    const entry = sessions.get(sessionId);
    if (entry === undefined) {
      throw RequestError.resourceNotFound(sessionId);
    }
    recordDiag({ event: "session_close", sessionId });
    await closeEntry(entry);
    return {};
  };

  const app = agent({ name: "nocturne" })
    .onRequest(methods.agent.initialize, (ctx) => handleInitialize(ctx.params))
    .onRequest(methods.agent.session.new, (ctx) =>
      handleNewSession(ctx.params, ctx.client, ctx.signal),
    )
    .onRequest(methods.agent.session.load, (ctx) =>
      handleLoadSession(ctx.params, ctx.client, ctx.signal),
    )
    .onRequest(methods.agent.session.prompt, (ctx) => handlePrompt(ctx.params, ctx.signal))
    .onRequest(methods.agent.session.setConfigOption, (ctx) => handleSetConfigOption(ctx.params))
    .onRequest(methods.agent.session.close, (ctx) => handleCloseSession(ctx.params.sessionId))
    .onNotification(methods.agent.session.cancel, (ctx) => {
      handleCancel(ctx.params.sessionId);
    });

  return {
    async serve(stream: Stream): Promise<void> {
      if (closing) return;
      const connection = app.connect(stream);
      activeConnection = connection;
      try {
        await connection.closed;
      } finally {
        await closeAll();
        if (activeConnection === connection) {
          activeConnection = undefined;
        }
      }
    },
    close: closeAll,
  };
}
