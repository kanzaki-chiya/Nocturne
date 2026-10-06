/**
 * Agent Loop 的依赖与配置（agent-loop.md）。
 * Agent 是 Core 内唯一的编排者：不感知工具名、Provider 名、权限规则与 UI。
 */
import type { EnvironmentInfo, InstructionSet } from "../context/index.js";
import type { ResolvedModel } from "../provider/index.js";
import type { Session, SessionState } from "../session/index.js";
import type { ExecutionEnvironment, ToolExecutor, ToolRegistry } from "../tools/index.js";

export interface TurnConfig {
  /**
   * 单 Turn 步数上限（agent-loop.md 3.8）：仅显式设置时生效；
   * undefined 即不限制，主对话默认如此（子会话有独立上限，subagent.md）
   */
  maxSteps?: number | undefined;
  /** Provider 重试次数上限（3.5，默认 4） */
  retryLimit: number;
  /** 重试退避基数（ms），指数退避并优先遵守 retryAfterMs */
  retryBaseDelayMs: number;
  /** 请求发出后等待首个流式事件的上限（ms） */
  firstEventTimeoutMs: number;
  /** 两个流式事件之间的上限（ms） */
  idleTimeoutMs: number;
}

export const DEFAULT_TURN_CONFIG: TurnConfig = {
  retryLimit: 4,
  retryBaseDelayMs: 250,
  firstEventTimeoutMs: 30_000,
  idleTimeoutMs: 300_000,
};

/** id 工厂：生产环境用随机 id；测试可注入确定性序列 */
export type IdFactory = (kind: "turn" | "message" | "call") => string;

export interface TurnDeps {
  skills?: { text: string; truncated: boolean } | undefined;
  compactionThreshold?: string | number | undefined;
  session: Session;
  model: ResolvedModel;
  visionModel?: (() => ResolvedModel | undefined) | undefined;
  tools: ToolRegistry;
  executor: ToolExecutor;
  /** 会话级执行环境（tools 的类型；Agent 不接触 Platform） */
  execEnv: ExecutionEnvironment;
  instructions: InstructionSet;
  environment: EnvironmentInfo;
  config: TurnConfig;
  /** Turn 级中断信号（客户端 interrupt → abort） */
  signal: AbortSignal;
  newId?: IdFactory | undefined;
  /**
   * Phase 6 注入点（agent-loop.md 3.9，subagent.md 第 9 节）；缺省时行为不变：
   * - basePrompt：覆盖基础系统提示段
   * - shouldFinish：每个工具调用结算后检查，返回 true 即 finish("done")
   * - toolChoice：进入本 Turn 每个 ModelRequest（强制调用指定工具）
   */
  basePrompt?: string | undefined;
  shouldFinish?: ((state: SessionState) => boolean) | undefined;
  toolChoice?: { name: string } | undefined;
  /**
   * 写入本 Turn 所有 ModelRequest.sessionId 的会话标识（ADR-0031 §3）：
   * 缺省取 session.id；子代理填根会话 ID（沿 parent 链到顶），保证
   * 「一个对话一个 ID」。Agent Loop 不解释其内容，原样放进请求。
   */
  rootSessionId?: string | undefined;
}
