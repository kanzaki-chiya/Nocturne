/**
 * @nocturne/core 公开入口（modules.md 第 3 节"core/index（公开 API）"）。
 * 客户端看到的全部能力都经由这里；进程内与将来的 RPC 客户端共用同一份语义（ADR-0002）。
 */
import { DEFAULT_TURN_CONFIG, runTurn, type TurnConfig, type TurnDeps } from "./agent/index.js";
import {
  buildContext,
  buildSummaryRequest,
  chooseSummaryBoundary,
  type BuiltContext,
  type EnvironmentInfo,
  type InstructionFile,
  type InstructionSet,
} from "./context/index.js";
import { createDefaultPolicy, type PermissionPolicy } from "./permission/index.js";
import { createPlatform, type Platform } from "./platform/index.js";
import {
  createAnthropicProvider,
  createOpenAICompatibleProvider,
  createProviderRegistry,
  UnknownModelError,
  type ModelInfo,
  type ModelOverride,
  type Provider,
  type ProviderConfig,
  type ProviderRegistry,
  type ResolvedModel,
} from "./provider/index.js";
import type {
  CommandRejectCode,
  ContentBlock,
  ModelRef,
  PermissionReply,
  RuntimeEvent,
  TurnEndReason,
} from "./protocol/index.js";
import {
  createSessionStore,
  SessionError,
  type Session,
  type SessionState,
  type SessionStore,
  type SessionSummary,
} from "./session/index.js";
import {
  createBuiltinRegistry,
  createPolicyGate,
  createReadStateStore,
  createToolExecutor,
  type ExecutionEnvironment,
  type PermissionGate,
  type ToolRegistry,
} from "./tools/index.js";

/** 命令被拒绝时抛出的错误；code 即 events.md 第 7 节的拒绝原因码 */
export class RuntimeCommandError extends Error {
  readonly code: CommandRejectCode;
  constructor(code: CommandRejectCode, message: string) {
    super(message);
    this.name = "RuntimeCommandError";
    this.code = code;
  }
}

/** 指令文件大小上限（context.md 6.2：每项注入内容都有上限） */
const INSTRUCTION_FILE_LIMIT = 64 * 1024;
const NOCTURNE_VERSION = "0.0.0";
const DEFAULT_PERMISSION_PRESET = "default";

export interface RuntimeOptions {
  /** 工作区 cwd（会话内工具执行的默认目录） */
  cwd: string;
  /** 工作区根；默认与 cwd 相同（取 realpath） */
  workspaceRoot?: string | undefined;
  /** 会话日志目录；默认 <NOCTURNE_HOME>/sessions */
  sessionsDir?: string | undefined;
  /** 直接注入的 Provider 实例（如 FakeProvider） */
  providers?: Provider[] | undefined;
  /** 声明式 Provider 配置（openai-compatible 与 anthropic） */
  providerConfigs?: ProviderConfig[] | undefined;
  /** 模型能力覆盖（providers.md 第 3 节配置形态） */
  modelOverrides?: Record<string, Record<string, ModelOverride>> | undefined;
  /**
   * 权限策略；默认 Phase 2 的 default 预设（permissions.md 第 6 节：
   * 工作区内读允许，其余 ask）
   */
  policy?: PermissionPolicy | undefined;
  /**
   * 是否有能回复权限请求的客户端（permissions.md 第 7 节）。
   * false/缺省：ask 一律结算为 deny（source: "non_interactive"）。
   */
  interactive?: boolean | undefined;
  /** 权限层选项（Phase 2 最小形态，不含可配置规则） */
  permissions?: RuntimePermissionsOptions | undefined;
  /** 指令集；默认自动收集 <NOCTURNE_HOME>/AGENTS.md 与项目各级 AGENTS.md */
  instructions?: InstructionSet | undefined;
  /** Turn 配置覆盖（maxSteps / retryLimit / retryBaseDelayMs） */
  turn?: Partial<TurnConfig> | undefined;
  /** 写入 session.created 的 Runtime 版本 */
  version?: string | undefined;
}

export interface RuntimePermissionsOptions {
  /**
   * 命令行允许（permissions.md 第 7 节）：最终判定为 ask 的调用自动批准。
   * 只提升 ask；不覆盖 deny，不绕过输入校验与路径限制，由权限层完成。
   * CLI 的 --yes 注入这里。
   */
  autoApproveAsk?: boolean | undefined;
}

export interface CreateSessionOptions {
  /** "provider/model" 或 ModelRef */
  model: string | ModelRef;
  permissionPreset?: string | undefined;
}

export interface SubmitInput {
  text?: string | undefined;
  content?: ContentBlock[] | undefined;
}

export interface RuntimeSession {
  readonly id: string;
  readonly session: Session;
  state(): SessionState;
  /** 订阅会话事件（durable + ephemeral），返回退订函数 */
  subscribe(listener: (event: RuntimeEvent) => void): () => void;
  /** 提交一个 Turn；Turn 结束时 resolve（events.md 第 7 节） */
  submit(input: SubmitInput): Promise<TurnEndReason>;
  /** 中断运行中的 Turn；无运行中 Turn 时无操作 */
  interrupt(): void;
  /**
   * 回复 permission.requested（events.md 第 7 节）。
   * 没有匹配的等待中请求时以 unknown_request 拒绝；reply.remember 在
   * Phase 2 被忽略（不产生持久授权）。
   */
  respondPermission(requestId: string, reply: PermissionReply): Promise<void>;
  /**
   * 切换模型（events.md 第 7 节）：会话空闲时生效，写入
   * session.config_changed；未知 provider/model 拒绝 invalid_model。
   */
  setModel(model: string | ModelRef): Promise<void>;
  /**
   * 手动压缩（context.md 6.2/6.6）：一次模型调用生成 L2 摘要，
   * 写入 context.compacted(kind="summary")。Turn 进行中拒绝 session_busy，
   * 已有压缩进行中拒绝 compaction_in_progress，被中断拒绝
   * compaction_interrupted；失败不写任何事件、历史不变。
   */
  compact(): Promise<void>;
  /** 当前上下文构建结果与报告（cli.md /context 命令的数据来源） */
  describeContext(): BuiltContext;
  close(): Promise<void>;
}

export interface Runtime {
  createSession(options: CreateSessionOptions): Promise<RuntimeSession>;
  resumeSession(id: string): Promise<RuntimeSession>;
  listSessions(filter?: { cwd?: string | undefined }): Promise<SessionSummary[]>;
  /** 全部已配置 Provider 声明的模型清单（cli.md /model 的数据来源） */
  listModels(): ModelInfo[];
}

function parseModelRef(model: string | ModelRef): ModelRef {
  if (typeof model !== "string") return model;
  const i = model.indexOf("/");
  if (i <= 0 || i === model.length - 1) {
    throw new RuntimeCommandError(
      "invalid_command",
      `model 必须是 "provider/model" 形式，收到: ${model}`,
    );
  }
  return { provider: model.slice(0, i), model: model.slice(i + 1) };
}

export async function createRuntime(options: RuntimeOptions): Promise<Runtime> {
  const platform = createPlatform();
  const { fs, paths } = platform;

  const cwd = paths.resolve(options.cwd, ".");
  const workspaceRoot = await platform.resolveReal(options.workspaceRoot ?? cwd);
  const sessionsDir =
    options.sessionsDir !== undefined
      ? paths.resolve(options.sessionsDir, ".")
      : paths.join(platform.nocturneHome(), "sessions");
  await fs.mkdir(sessionsDir);

  // ProviderRegistry：显式注入 + 声明式配置（openai-compatible / anthropic）
  const providers: Provider[] = [...(options.providers ?? [])];
  for (const config of options.providerConfigs ?? []) {
    providers.push(
      config.type === "anthropic"
        ? createAnthropicProvider(config, (n) => platform.env(n))
        : createOpenAICompatibleProvider(config, (n) => platform.env(n)),
    );
  }
  const registry: ProviderRegistry = createProviderRegistry(providers, options.modelOverrides);

  const store: SessionStore = createSessionStore({ fs, paths, sessionsDir });
  const tools: ToolRegistry = createBuiltinRegistry();
  const executor = createToolExecutor(tools);

  const policy =
    options.policy ??
    createDefaultPolicy({
      workspaceRoot,
      caseSensitive: platform.caseSensitivePaths,
      autoApproveAsk: options.permissions?.autoApproveAsk === true,
    });
  const interactive = options.interactive === true;

  const instructions =
    options.instructions ?? (await loadInstructions(platform, workspaceRoot, cwd));
  const environment: EnvironmentInfo = {
    os: process.platform,
    shell: platform.env("COMSPEC") ?? platform.env("SHELL"),
    cwd,
    workspaceRoot,
    sessionDate: new Date().toISOString(),
  };
  const turnConfig = { ...DEFAULT_TURN_CONFIG, ...options.turn };

  function wrapSession(session: Session): RuntimeSession {
    const modelRef = session.state().config.model;
    // setModel 会替换该引用；submit 读取的是调用时刻的值
    let model: ResolvedModel = registry.resolve(modelRef);
    // gate 按会话持有：等待中的权限请求与会话绑定，respondPermission 按会话路由
    const gate: PermissionGate = createPolicyGate(policy, { interactive });
    const execEnv: ExecutionEnvironment = {
      platform,
      gate,
      readState: createReadStateStore(paths),
    };
    let controller: AbortController | undefined;
    let compactController: AbortController | undefined;

    const assertUsable = () => {
      if (session.health !== "ok") {
        throw new RuntimeCommandError("session_failed", "会话已处于 failed 状态");
      }
    };
    const busy = () => controller !== undefined && !controller.signal.aborted;

    return {
      id: session.id,
      session,
      state: () => session.state(),
      subscribe: (listener) => session.subscribe(listener),
      interrupt() {
        controller?.abort();
        // 压缩是 Turn 之外的会话级活动，interrupt 同样中止它
        compactController?.abort();
      },
      respondPermission(requestId, reply) {
        if (gate.respond?.(requestId, reply) === true) {
          return Promise.resolve();
        }
        return Promise.reject(new RuntimeCommandError("unknown_request", "没有等待中的权限请求"));
      },
      async submit(input) {
        assertUsable();
        if (busy() || compactController !== undefined) {
          throw new RuntimeCommandError("session_busy", "会话正忙（Turn 或压缩进行中）");
        }
        const content: ContentBlock[] = input.content ?? [{ type: "text", text: input.text ?? "" }];
        const ac = new AbortController();
        controller = ac;
        const deps: TurnDeps = {
          session,
          model,
          tools,
          executor,
          execEnv,
          instructions,
          environment,
          config: turnConfig,
          signal: ac.signal,
        };
        try {
          const reason = await runTurn(deps, content);
          if (reason === "failed") {
            throw new RuntimeCommandError("session_failed", "会话持久化失败");
          }
          return reason;
        } finally {
          if (controller === ac) controller = undefined;
        }
      },
      async setModel(input) {
        assertUsable();
        if (busy() || compactController !== undefined) {
          throw new RuntimeCommandError("session_busy", "会话正忙，不能切换模型");
        }
        const ref = parseModelRef(input);
        let resolved: ResolvedModel;
        try {
          resolved = registry.resolve(ref);
        } catch (e) {
          if (e instanceof UnknownModelError) {
            throw new RuntimeCommandError("invalid_model", e.message);
          }
          throw e;
        }
        // Provider 声明了模型清单且启用严格校验时，模型名必须在清单内
        // （events.md：未知 model → invalid_model）
        const declared = resolved.provider.models();
        if (
          resolved.provider.strictModels !== false &&
          declared.length > 0 &&
          !declared.some((m) => m.ref.model === ref.model)
        ) {
          throw new RuntimeCommandError(
            "invalid_model",
            `Provider ${ref.provider} 未声明模型 ${ref.model}`,
          );
        }
        await session.emit("session.config_changed", { model: ref });
        model = resolved;
      },
      async compact() {
        assertUsable();
        if (busy()) {
          throw new RuntimeCommandError("session_busy", "Turn 运行中，不能压缩");
        }
        if (compactController !== undefined) {
          throw new RuntimeCommandError("compaction_in_progress", "已有压缩在进行中");
        }
        const ac = new AbortController();
        compactController = ac;
        session.emitEphemeral("runtime.status", { status: "compacting" });
        try {
          const events = session.durableEvents();
          const history = session.state().history;
          const boundary = chooseSummaryBoundary(events, history, model.model);
          if (boundary === undefined) {
            throw new RuntimeCommandError(
              "compaction_failed",
              "没有可行的压缩边界（历史为空、最新摘要之后没有新内容，或摘要请求在任何边界下都装不进窗口）",
            );
          }
          const request = buildSummaryRequest({
            history,
            model: model.model,
            throughSeq: boundary,
          });
          // context.md 6.6：摘要请求只尝试一轮，不嵌套压缩
          let summary = "";
          for await (const ev of model.provider.stream(request, ac.signal)) {
            if (ev.type === "text_delta") summary += ev.text;
            if (ev.type === "finish") break;
          }
          if (summary.trim().length === 0) {
            throw new RuntimeCommandError("compaction_failed", "摘要结果为空");
          }
          await session.emit(
            "context.compacted",
            { kind: "summary", throughSeq: boundary, summary },
            {},
          );
        } catch (e) {
          if (ac.signal.aborted) {
            // 中断：不写任何事件，历史不变（context.md 6.6）
            throw new RuntimeCommandError("compaction_interrupted", "压缩被中断");
          }
          if (e instanceof RuntimeCommandError) throw e;
          if (e instanceof SessionError) {
            throw new RuntimeCommandError("session_failed", e.message);
          }
          throw new RuntimeCommandError(
            "compaction_failed",
            e instanceof Error ? e.message : String(e),
          );
        } finally {
          compactController = undefined;
          session.emitEphemeral("runtime.status", { status: "idle" });
        }
      },
      describeContext() {
        const state = session.state();
        return buildContext({
          history: state.history,
          model: model.model,
          tools: tools.specs(),
          instructions,
          environment,
          events: session.durableEvents(),
        });
      },
      async close() {
        // 先结算等待中的权限请求为 cancelled，避免其挂住 Turn
        gate.cancelAll?.();
        compactController?.abort();
        await session.close();
      },
    };
  }

  return {
    async createSession(opts) {
      const ref = parseModelRef(opts.model);
      registry.resolve(ref); // 提前校验模型存在
      const session = await store.create({
        cwd,
        workspaceRoot,
        model: ref,
        permissionPreset: opts.permissionPreset ?? DEFAULT_PERMISSION_PRESET,
        nocturneVersion: options.version ?? NOCTURNE_VERSION,
      });
      return wrapSession(session);
    },
    async resumeSession(id) {
      const session = await store.load(id);
      return wrapSession(session);
    },
    listSessions: (filter) => store.list(filter),
    listModels: () => registry.providers().flatMap((p) => p.models()),
  };
}

/** 收集用户级与项目级 AGENTS.md（context.md 第 3 节第 3 项） */
async function loadInstructions(
  platform: Platform,
  workspaceRoot: string,
  cwd: string,
): Promise<InstructionSet> {
  const { fs, paths } = platform;

  const readFile = async (source: string): Promise<InstructionFile | undefined> => {
    const stat = await fs.stat(source).catch(() => undefined);
    if (stat?.type !== "file") return undefined;
    const text = await fs.readTextFile(source);
    if (text.length <= INSTRUCTION_FILE_LIMIT) {
      return { source, content: text };
    }
    return { source, content: text.slice(0, INSTRUCTION_FILE_LIMIT), truncated: true };
  };

  const user = await readFile(paths.join(platform.nocturneHome(), "AGENTS.md"));

  // workspaceRoot → cwd 路径上的各级目录（自顶向下）
  const dirs: string[] = [workspaceRoot];
  if (paths.isWithin(cwd, workspaceRoot) && !paths.equals(cwd, workspaceRoot)) {
    const rel = paths.relative(workspaceRoot, cwd);
    let cur = workspaceRoot;
    for (const seg of rel.split(/[\\/]+/).filter((s) => s.length > 0)) {
      cur = paths.join(cur, seg);
      dirs.push(cur);
    }
  } else if (!paths.equals(cwd, workspaceRoot)) {
    dirs.push(cwd);
  }

  const project: InstructionFile[] = [];
  for (const dir of dirs) {
    const file = await readFile(paths.join(dir, "AGENTS.md"));
    if (file !== undefined) project.push(file);
  }
  return { ...(user !== undefined ? { user } : {}), project };
}

// 公共契约类型与工具再导出：客户端只需要 @nocturne/core 与 @nocturne/core/protocol
export * from "./protocol/index.js";
export type {
  AnthropicConfig,
  ModelInfo,
  ModelRequest,
  OpenAICompatibleConfig,
  Provider,
  ProviderConfig,
  ResolvedModel,
} from "./provider/index.js";
export type { InstructionSet, EnvironmentInfo, BuiltContext } from "./context/index.js";
export type { SessionState, SessionSummary } from "./session/index.js";
export { FakeProvider, type FakeScript, type FakeHandler } from "./provider/index.js";
export { SessionError } from "./session/index.js";
