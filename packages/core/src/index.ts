/**
 * @nocturne/core 公开入口（modules.md 第 3 节"core/index（公开 API）"）。
 * 客户端看到的全部能力都经由这里；进程内与将来的 RPC 客户端共用同一份语义（ADR-0002）。
 */
import { DEFAULT_TURN_CONFIG, runTurn, type TurnConfig, type TurnDeps } from "./agent/index.js";
import {
  buildContext,
  buildSummaryRequest,
  chooseSummaryBoundary,
  runSummaryCall,
  type BuiltContext,
  type EnvironmentInfo,
  type InstructionFile,
  type InstructionSet,
} from "./context/index.js";
import type { ProviderEntryConfig, RuntimeConfig } from "./config/index.js";
import {
  createRulePolicy,
  isPermissionPresetName,
  type PermissionPolicy,
} from "./permission/index.js";
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
  Grant,
  ModelRef,
  PermissionReply,
  RuntimeEvent,
  TurnEndReason,
} from "./protocol/index.js";
import {
  createSessionStore,
  SessionError,
  type Session,
  type SessionRecovery,
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
  /**
   * 分层配置（config.md）：loadConfig 的产物；缺省时 Runtime 行为与 Phase 2 相同
   * （无用户/项目配置、无 trust、无持久化 Grant）
   */
  config?: RuntimeConfig | undefined;
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
   * 没有匹配的等待中请求时以 unknown_request 拒绝；reply.remember 生成
   * 对应范围的 Grant（permissions.md 5.4）。
   */
  respondPermission(requestId: string, reply: PermissionReply): Promise<void>;
  /**
   * 切换模型（events.md 第 7 节）：会话空闲时生效，写入
   * session.config_changed；未知 provider/model 拒绝 invalid_model。
   */
  setModel(model: string | ModelRef): Promise<void>;
  /**
   * 切换权限预设（events.md 第 7 节）：会话空闲时生效，写入
   * session.config_changed；未知预设名拒绝 invalid_command。
   */
  setPermissionPreset(name: string): Promise<void>;
  /**
   * 手动压缩（context.md 6.2/6.6）：一次模型调用生成 L2 摘要，
   * 写入 context.compacted(kind="summary")。Turn 进行中拒绝 session_busy，
   * 已有压缩进行中拒绝 compaction_in_progress，被中断拒绝
   * compaction_interrupted；失败不写任何事件、历史不变。
   */
  compact(): Promise<void>;
  /** 当前上下文构建结果与报告（cli.md /context 命令的数据来源） */
  describeContext(): BuiltContext;
  /** 打开会话时聚合的警告（配置降级、未信任项目配置等），供客户端展示 */
  readonly warnings: readonly string[];
  /** 打开时执行的恢复修复汇总（sessions.md 第 6 节）；无修复则 undefined */
  readonly recovery?: SessionRecovery | undefined;
  close(): Promise<void>;
}

export interface ResumeSessionOptions {
  /** 会话记录的模型无法解析时，以该模型替代（写入 session.config_changed） */
  model?: string | ModelRef | undefined;
  /** --force-unlock：先删除锁文件再走正常打开流程（ADR-0009） */
  force?: boolean | undefined;
}

export interface Runtime {
  createSession(options: CreateSessionOptions): Promise<RuntimeSession>;
  resumeSession(id: string, options?: ResumeSessionOptions): Promise<RuntimeSession>;
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

/** ProviderEntryConfig → ProviderConfig（字段形状一致，按 type 分发适配器） */
function instantiateProvider(entry: ProviderEntryConfig, env: (n: string) => string | undefined) {
  const common = {
    id: entry.id,
    apiKeyEnv: entry.apiKeyEnv,
    ...(entry.models !== undefined
      ? { models: entry.models as Record<string, ModelOverride> }
      : {}),
    ...(entry.allowUndeclaredModels !== undefined
      ? { allowUndeclaredModels: entry.allowUndeclaredModels }
      : {}),
    ...(entry.providerOptions !== undefined ? { providerOptions: entry.providerOptions } : {}),
    ...(entry.headers !== undefined ? { headers: entry.headers } : {}),
  };
  return entry.type === "anthropic"
    ? createAnthropicProvider(
        {
          ...common,
          type: "anthropic",
          ...(entry.baseURL !== undefined ? { baseURL: entry.baseURL } : {}),
        },
        env,
      )
    : createOpenAICompatibleProvider(
        { ...common, type: "openai-compatible", baseURL: entry.baseURL ?? "" },
        env,
      );
}

export async function createRuntime(options: RuntimeOptions): Promise<Runtime> {
  const platform = createPlatform();
  const { fs, paths } = platform;
  const config = options.config;

  const cwd = paths.resolve(options.cwd, ".");
  const workspaceRoot = await platform.resolveReal(options.workspaceRoot ?? cwd);
  const sessionsDir =
    options.sessionsDir !== undefined
      ? paths.resolve(options.sessionsDir, ".")
      : (config?.sessionsDir ?? paths.join(platform.nocturneHome(), "sessions"));
  await fs.mkdir(sessionsDir);
  const nocturneHome = config?.nocturneHome ?? platform.nocturneHome();

  /** Provider 构造：显式注入 + options.providerConfigs +（有 config 时）合并后的条目 */
  function buildRegistry(configProviders: readonly ProviderEntryConfig[]): ProviderRegistry {
    const env = (n: string) => platform.env(n);
    // 同 id 后者覆盖（options.providerConfigs < config 条目，与分层优先级一致）
    const byId = new Map<string, Provider>();
    for (const p of options.providers ?? []) byId.set(p.id, p);
    for (const c of options.providerConfigs ?? []) {
      const instance =
        c.type === "anthropic"
          ? createAnthropicProvider(c, env)
          : createOpenAICompatibleProvider(c, env);
      byId.set(instance.id, instance);
    }
    for (const e of configProviders) byId.set(e.id, instantiateProvider(e, env));
    return createProviderRegistry([...byId.values()], options.modelOverrides);
  }

  // 运行时级清单（listModels 的数据来源）：注入 + providerConfigs + config 基础层
  const registry: ProviderRegistry = buildRegistry(config?.base.providers ?? []);

  const store: SessionStore = createSessionStore({ platform, sessionsDir });
  const tools: ToolRegistry = createBuiltinRegistry();
  const executor = createToolExecutor(tools);

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

  async function wrapSession(
    session: Session,
    resume?: { modelOverride?: string | ModelRef | undefined },
  ): Promise<RuntimeSession> {
    const meta = session.state().meta;

    // 项目层按会话记录的 workspaceRoot 加载（config.md 第 6 节）
    const ws = config !== undefined ? await config.forWorkspace(meta.workspaceRoot) : undefined;
    const resolved = ws?.resolved;
    const warnings: string[] = [...(resolved?.warnings ?? [])];
    if (ws?.projectConfig.present === true && !ws.projectConfig.trusted) {
      warnings.push(
        `检测到项目配置 ${ws.projectConfig.path ?? ""}，但该工作区未信任——其中仅收紧方向的规则生效；执行 nctrn trust 信任该工作区`,
      );
    }
    for (const message of warnings) {
      session.emitEphemeral("runtime.warning", { code: "config_warning", message });
    }
    if (ws?.projectConfig.present === true && !ws.projectConfig.trusted) {
      session.emitEphemeral("runtime.warning", {
        code: "project_config_untrusted",
        message: `项目配置未信任：${ws.projectConfig.path ?? meta.workspaceRoot}`,
      });
    }

    // 会话级 ProviderRegistry：基础层 + 可信项目层的 Provider 条目
    const sessionRegistry =
      config === undefined ? registry : buildRegistry(resolved?.providers ?? []);

    // 权限策略：预设 + 分层规则 + Grant 集合；setPermissionPreset 重建
    const sessionGrants: Grant[] = [];
    const projectGrants = ws?.grants.list() ?? [];
    const autoApproveAsk = options.permissions?.autoApproveAsk === true;
    const buildPolicy = (presetName: string): PermissionPolicy =>
      options.policy ??
      createRulePolicy({
        workspaceRoot: meta.workspaceRoot,
        caseSensitive: platform.caseSensitivePaths,
        preset: isPermissionPresetName(presetName) ? presetName : "default",
        presetContext: {
          sessionsDir,
          sessionId: session.id,
          nocturneHome,
        },
        rules: resolved?.rules ?? [],
        untrustedRules: resolved?.untrustedRules ?? [],
        grants: { session: sessionGrants, project: projectGrants },
        autoApproveAsk,
      });
    let policy = buildPolicy(session.state().config.permissionPreset);
    if (!isPermissionPresetName(session.state().config.permissionPreset)) {
      warnings.push(
        `会话记录的权限预设 "${session.state().config.permissionPreset}" 未知，已回退 default`,
      );
    }
    // gate 按会话持有：等待中的权限请求与会话绑定，respondPermission 按会话路由；
    // 经委托读取当前 policy，使 setPermissionPreset 立即生效
    const gate: PermissionGate = createPolicyGate(
      { evaluate: (subjects) => policy.evaluate(subjects) },
      {
        interactive,
        caseSensitive: platform.caseSensitivePaths,
        grants: { session: sessionGrants, project: ws?.grants },
      },
    );
    const execEnv: ExecutionEnvironment = {
      platform,
      gate,
      readState: createReadStateStore(paths),
      attachmentsDir: paths.join(sessionsDir, "attachments"),
    };
    const turnConfig: TurnConfig = { ...DEFAULT_TURN_CONFIG };
    for (const src of [resolved?.turn, options.turn]) {
      if (src?.maxSteps !== undefined) turnConfig.maxSteps = src.maxSteps;
      if (src?.retryLimit !== undefined) turnConfig.retryLimit = src.retryLimit;
      if (src?.retryBaseDelayMs !== undefined) turnConfig.retryBaseDelayMs = src.retryBaseDelayMs;
    }

    const resolveSessionModel = (ref: ModelRef): ResolvedModel => sessionRegistry.resolve(ref);
    let model: ResolvedModel;
    try {
      model = resolveSessionModel(session.state().config.model);
    } catch (e) {
      // 会话记录的模型无法解析：携带替代模型时先写 config_changed 再开放（sessions.md 4.2）
      if (e instanceof UnknownModelError && resume?.modelOverride !== undefined) {
        const ref = parseModelRef(resume.modelOverride);
        let replacement: ResolvedModel;
        try {
          replacement = resolveSessionModel(ref);
        } catch (inner) {
          throw new RuntimeCommandError(
            "invalid_model",
            `替代模型同样无法解析：${inner instanceof Error ? inner.message : String(inner)}`,
          );
        }
        await session.emit("session.config_changed", { model: ref });
        model = replacement;
      } else if (e instanceof UnknownModelError) {
        throw new RuntimeCommandError(
          "invalid_model",
          resume !== undefined
            ? `${e.message}；可携带替代模型恢复（resumeSession 的 model 选项 / CLI --model）`
            : e.message,
        );
      } else {
        throw e;
      }
    }

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
      async respondPermission(requestId, reply) {
        if ((await gate.respond?.(requestId, reply)) === true) {
          return;
        }
        throw new RuntimeCommandError("unknown_request", "没有等待中的权限请求");
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
          resolved = resolveSessionModel(ref);
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
      async setPermissionPreset(name) {
        assertUsable();
        if (busy() || compactController !== undefined) {
          throw new RuntimeCommandError("session_busy", "会话正忙，不能切换权限预设");
        }
        if (!isPermissionPresetName(name)) {
          throw new RuntimeCommandError(
            "invalid_command",
            `未知权限预设：${name}（可选：read-only | default | auto-edit | full-access）`,
          );
        }
        await session.emit("session.config_changed", { permissionPreset: name });
        policy = buildPolicy(name);
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
          const summary = await runSummaryCall(model, request, ac.signal);
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
      warnings,
      recovery: session.recovery,
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
      const preset =
        opts.permissionPreset ?? config?.base.permissionPreset ?? DEFAULT_PERMISSION_PRESET;
      if (!isPermissionPresetName(preset)) {
        throw new RuntimeCommandError(
          "invalid_command",
          `未知权限预设：${preset}（可选：read-only | default | auto-edit | full-access）`,
        );
      }
      // 模型解析在 wrapSession 内进行（会话级注册表含项目层条目）；
      // 失败时关闭已创建的会话，避免遗留打开的日志
      const session = await store.create({
        cwd,
        workspaceRoot,
        model: parseModelRef(opts.model),
        permissionPreset: preset,
        nocturneVersion: options.version ?? NOCTURNE_VERSION,
      });
      try {
        return await wrapSession(session);
      } catch (e) {
        await session.close().catch(() => undefined);
        throw e;
      }
    },
    async resumeSession(id, resumeOpts) {
      const session = await store.load(id, { force: resumeOpts?.force });
      try {
        return await wrapSession(session, { modelOverride: resumeOpts?.model });
      } catch (e) {
        await session.close().catch(() => undefined);
        throw e;
      }
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
export * from "./config/index.js";
export type { SessionState, SessionSummary } from "./session/index.js";
export {
  FakeProvider,
  normalizeModelRef,
  type FakeScript,
  type FakeHandler,
} from "./provider/index.js";
export { SessionError } from "./session/index.js";
export { createPlatform, type Platform } from "./platform/index.js";
