/**
 * Agent Loop 的依赖与配置（agent-loop.md）。
 * Agent 是 Core 内唯一的编排者：不感知工具名、Provider 名、权限规则与 UI。
 */
import type { EnvironmentInfo, InstructionSet } from "../context/index.js";
import type { ResolvedModel } from "../provider/index.js";
import type { Session } from "../session/index.js";
import type { ExecutionEnvironment, ToolExecutor, ToolRegistry } from "../tools/index.js";

export interface TurnConfig {
  /** 单 Turn 步数上限（agent-loop.md 3.8，默认 100） */
  maxSteps: number;
  /** Provider 重试次数上限（3.5，默认 4） */
  retryLimit: number;
  /** 重试退避基数（ms），指数退避并优先遵守 retryAfterMs */
  retryBaseDelayMs: number;
}

export const DEFAULT_TURN_CONFIG: TurnConfig = {
  maxSteps: 100,
  retryLimit: 4,
  retryBaseDelayMs: 250,
};

/** id 工厂：生产环境用随机 id；测试可注入确定性序列 */
export type IdFactory = (kind: "turn" | "message" | "call") => string;

export interface TurnDeps {
  session: Session;
  model: ResolvedModel;
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
}
