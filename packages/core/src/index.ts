/**
 * @nocturne/core 公开入口（modules.md 第 3 节"core/index（公开 API）"）。
 * 客户端看到的全部能力都经由这里；进程内与将来的 RPC 客户端共用同一份语义（ADR-0002）。
 */
import {
  DEFAULT_TURN_CONFIG,
  runTurn,
  type TurnConfig,
  type TurnDeps,
} from "./agent/index.js";
import type { EnvironmentInfo, InstructionFile, InstructionSet } from "./context/index.js";
import { createWorkspaceReadPolicy, type PermissionPolicy } from "./permission/index.js";
import { createPlatform, type Platform } from "./platform/index.js";
import {
  createOpenAICompatibleProvider,
  createProviderRegistry,
  type ModelOverride,
  type OpenAICompatibleConfig,
  type Provider,
  type ProviderRegistry,
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
const DEFAULT_PERMISSION_PRESET = "phase1";

export interface RuntimeOptions {
  /** 工作区 cwd（会话内工具执行的默认目录） */
  cwd: string;
  /** 工作区根；默认与 cwd 相同（取 realpath） */
  workspaceRoot?: string | undefined;
  /** 会话日志目录；默认 <NOCTURNE_HOME>/sessions */
  sessionsDir?: string | undefined;
  /** 直接注入的 Provider 实例（如 FakeProvider） */
  providers?: Provider[] | undefined;
  /** 声明式 Provider 配置；Phase 1 支持 openai-compatible */
  providerConfigs?: OpenAICompatibleConfig[] | undefined;
  /** 模型能力覆盖（providers.md 第 3 节配置形态） */
  modelOverrides?: Record<string, Record<string, ModelOverride>> | undefined;
  /** 权限策略；默认 Phase 1 固定策略（工作区内读允许、其余拒绝） */
  policy?: PermissionPolicy | undefined;
  /** 指令集；默认自动收集 <NOCTURNE_HOME>/AGENTS.md 与项目各级 AGENTS.md */
  instructions?: InstructionSet | undefined;
  /** Turn 配置覆盖（maxSteps / retryLimit / retryBaseDelayMs） */
  turn?: Partial<TurnConfig> | undefined;
  /** 写入 session.created 的 Runtime 版本 */
  version?: string | undefined;
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
  /** Phase 1 固定策略不产生等待中的请求：恒 unknown_request */
  respondPermission(requestId: string, reply: PermissionReply): Promise<void>;
  close(): Promise<void>;
}

export interface Runtime {
  createSession(options: CreateSessionOptions): Promise<RuntimeSession>;
  resumeSession(id: string): Promise<RuntimeSession>;
  listSessions(filter?: { cwd?: string | undefined }): Promise<SessionSummary[]>;
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
  const workspaceRoot = await platform.resolveReal(
    options.workspaceRoot ?? cwd,
  );
  const sessionsDir =
    options.sessionsDir !== undefined
      ? paths.resolve(options.sessionsDir, ".")
      : paths.join(platform.nocturneHome(), "sessions");
  await fs.mkdir(sessionsDir);

  // ProviderRegistry：显式注入 + 声明式 openai-compatible 配置
  const providers: Provider[] = [...(options.providers ?? [])];
  for (const config of options.providerConfigs ?? []) {
    providers.push(createOpenAICompatibleProvider(config, (n) => platform.env(n)));
  }
  const registry: ProviderRegistry = createProviderRegistry(
    providers,
    options.modelOverrides,
  );

  const store: SessionStore = createSessionStore({ fs, paths, sessionsDir });
  const tools: ToolRegistry = createBuiltinRegistry();
  const executor = createToolExecutor(tools);

  const policy =
    options.policy ??
    createWorkspaceReadPolicy({
      workspaceRoot,
      caseSensitive: platform.caseSensitivePaths,
    });
  const gate: PermissionGate = createPolicyGate(policy);

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
    const model = registry.resolve(modelRef);
    const execEnv: ExecutionEnvironment = {
      platform,
      gate,
      readState: createReadStateStore(paths),
    };
    let controller: AbortController | undefined;

    const assertUsable = () => {
      if (session.health !== "ok") {
        throw new RuntimeCommandError("session_failed", "会话已处于 failed 状态");
      }
    };

    return {
      id: session.id,
      session,
      state: () => session.state(),
      subscribe: (listener) => session.subscribe(listener),
      interrupt() {
        controller?.abort();
      },
      respondPermission(_requestId, _reply) {
        // Phase 1 固定策略不产生 permission.requested；Phase 3 经 gate 路由
        return Promise.reject(
          new RuntimeCommandError("unknown_request", "没有等待中的权限请求"),
        );
      },
      async submit(input) {
        assertUsable();
        if (controller !== undefined && !controller.signal.aborted) {
          throw new RuntimeCommandError("session_busy", "已有运行中的 Turn");
        }
        const content: ContentBlock[] =
          input.content ?? [{ type: "text", text: input.text ?? "" }];
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
      close: () => session.close(),
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
  ModelInfo,
  ModelRequest,
  OpenAICompatibleConfig,
  Provider,
  ResolvedModel,
} from "./provider/index.js";
export type { InstructionSet, EnvironmentInfo, BuiltContext } from "./context/index.js";
export type { SessionState, SessionSummary } from "./session/index.js";
export { FakeProvider, type FakeScript, type FakeHandler } from "./provider/index.js";
export { SessionError } from "./session/index.js";
