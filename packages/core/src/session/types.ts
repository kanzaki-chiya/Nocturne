/**
 * 会话公开类型：SessionState、Session、SessionStore（sessions.md、modules.md）。
 * SessionState 只由持久化事件折叠得到，不单独存储。
 */
import type {
  DurableEvent,
  DurablePayload,
  DurableType,
  EphemeralEvent,
  EphemeralPayload,
  EphemeralType,
  HistoryEntry,
  ModelRef,
  RuntimeEvent,
  Usage,
} from "../protocol/index.js";

export type { HistoryEntry };

export interface SessionMeta {
  id: string;
  cwd: string;
  workspaceRoot: string;
  createdAt: string;
  formatVersion: number;
  nocturneVersion: string;
}

export interface SessionConfig {
  model: ModelRef;
  permissionPreset: string;
}

export interface OpenTurn {
  turnId: string;
  turnIndex: number;
}

export interface UnsettledCall {
  callId: string;
  turnId: string;
  name: string;
  /** 恢复修复时区分"可能已部分执行"与"未执行"（sessions.md 第 6 节） */
  started: boolean;
}

export interface SessionState {
  meta: SessionMeta;
  config: SessionConfig;
  history: HistoryEntry[];
  /** 累计 token 用量（由各 message.assistant.usage 累加） */
  usage: Usage;
  lastSeq: number;
  openTurn: OpenTurn | undefined;
  unsettledCalls: ReadonlyMap<string, UnsettledCall>;
}

export type SessionHealth = "ok" | "failed" | "closed";

/** 本次打开发生的修复汇总（sessions.md 第 6 节末）；无修复时缺省 */
export interface SessionRecovery {
  /** 被截断的损坏尾部另存到的文件名 */
  truncatedTail?: string | undefined;
  /** 补齐为 interrupted 的工具调用数 */
  interruptedCalls: number;
  /** 以 process_exited 收束的未完成 Turn 数 */
  recoveredTurns: number;
}

export type SessionListener = (event: RuntimeEvent) => void;

export interface EmitOptions {
  turnId?: string | undefined;
}

/**
 * 会话对象：事件日志 + 派生状态 + 订阅分发（modules.md：session 公开接口）。
 * 会话不决定下一步做什么（那是 agent），只保证先写后发。
 */
export interface Session {
  readonly id: string;
  /** 本次打开生成；临时事件的归属标识 */
  readonly runId: string;
  readonly logPath: string;
  readonly health: SessionHealth;
  /** 日志写入失败时触发——Agent Loop 把它并入 Turn 的中断信号 */
  readonly failedSignal: AbortSignal;
  /** 打开时执行的修复汇总（sessions.md 第 6 节）；无修复则 undefined */
  readonly recovery?: SessionRecovery | undefined;

  /** 由持久化事件折叠出的当前状态 */
  state(): SessionState;
  /** 已持久化事件的只读视图（恢复后包含历史事件） */
  durableEvents(): readonly DurableEvent[];

  /** 持久化事件：分配 seq → 写日志 → 成功后发布。写入失败会话进入 failed */
  emit<T extends DurableType>(
    type: T,
    payload: DurablePayload<T>,
    options?: EmitOptions,
  ): Promise<DurableEvent<T>>;
  /** 临时事件：只发布不写日志 */
  emitEphemeral<T extends EphemeralType>(
    type: T,
    payload: EphemeralPayload<T>,
    options?: EmitOptions,
  ): EphemeralEvent<T>;

  /** 订阅事件流。订阅者异常被捕获记录，不影响执行（events.md 第 6 节） */
  subscribe(listener: SessionListener): () => void;
  /** 订阅者异常记录（诊断用，环形缓冲） */
  diagnostics(): readonly { event: RuntimeEvent; error: unknown }[];

  /** 把已写数据刷到操作系统（Turn 结束时调用，sessions.md 第 5 节） */
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface SessionSummary {
  id: string;
  createdAt: string;
  cwd: string;
  workspaceRoot: string;
  model: ModelRef;
  /** 日志文件修改时间 */
  mtimeMs: number;
  /** 锁文件存在且持有者看起来存活（只读探测，不取得锁） */
  locked?: boolean | undefined;
}

export interface CreateSessionInput {
  cwd: string;
  workspaceRoot: string;
  model: ModelRef;
  permissionPreset: string;
  nocturneVersion: string;
}

export interface LoadSessionOptions {
  /** --force-unlock：先删锁再走正常流程（sessions.md 第 4 节） */
  force?: boolean | undefined;
}

export interface SessionStore {
  create(input: CreateSessionInput): Promise<Session>;
  /**
   * 打开会话：先取得排他锁，再读取日志——截断损坏尾部、校验、
   * 追加恢复修复事件（sessions.md 第 4 节顺序不可调换）
   */
  load(id: string, options?: LoadSessionOptions): Promise<Session>;
  list(filter?: { cwd?: string | undefined }): Promise<SessionSummary[]>;
}
