/**
 * 常驻子会话共享层（ADR-0097）：
 * 为合奏成员与组曲线程提供中性的会话句柄、打开规格、工作树操作接口与 callId 前缀判定。
 * 只依赖 protocol 与 tools 的 ToolDefinition 类型，不依赖 ensemble 或 suites。
 */
import type {
  ModelRef,
  PreparedInput,
  ReasoningEffort,
  RuntimeEvent,
  SubagentChanges,
  TurnEndReason,
} from "../protocol/index.js";
import type { ToolDefinition } from "../tools/index.js";

/** 常驻子会话归属类型 */
export type ResidentKind = "ensemble" | "suite";

const RESIDENT_PREFIXES: Record<ResidentKind, string> = {
  ensemble: "ensemble:",
  suite: "suite:",
};

/** 生成常驻子会话 `session.created.parent.callId` */
export function residentCallId(kind: ResidentKind, name: string): string {
  return `${RESIDENT_PREFIXES[kind]}${name}`;
}

/** 按 `session.created.parent.callId` 判定常驻子会话类型；非已知前缀返回 undefined */
export function residentKindOf(callId: string | undefined): ResidentKind | undefined {
  if (callId === undefined) return undefined;
  if (callId.startsWith(RESIDENT_PREFIXES.ensemble)) return "ensemble";
  if (callId.startsWith(RESIDENT_PREFIXES.suite)) return "suite";
  return undefined;
}

/** 常驻子会话的独立工作树句柄 */
export interface ResidentWorktreeHandle {
  childSessionId: string;
  parentSessionId: string;
  repository: string;
  worktree: string;
  branch: string;
  base: string;
  snapshot: boolean;
  cwd: string;
  workspaceRoot: string;
  task: string;
  includeSkipped: boolean;
  skippedSymlinks?: string[] | undefined;
  applied?: boolean | undefined;
  changes?: SubagentChanges | undefined;
}

/** 受Runtime托管的常驻子会话句柄 */
export interface ResidentChildSession {
  readonly id: string;
  isBusy(): boolean;
  hasActivePendingInputs(): boolean;
  deliverInput(input: PreparedInput, forcePaused?: boolean): Promise<void>;
  resumeFromModelChange(modelKey: string): Promise<void>;
  setModelAndEffort(model: ModelRef, effort?: ReasoningEffort): Promise<void>;
  interruptAndWait(): Promise<void>;
  clearPendingInputs(): void;
  subscribe(listener: (event: RuntimeEvent) => void): () => void;
  closeUnderlying(): Promise<void>;
}

/** 打开或恢复常驻子会话的规格 */
export interface ResidentChildOpenSpec {
  kind: ResidentKind;
  childSessionId: string;
  name: string;
  create: boolean;
  cwd: string;
  workspaceRoot: string;
  model: ModelRef;
  reasoningEffort?: ReasoningEffort | undefined;
  preset: "general" | "explore";
  worktreePath?: string | undefined;
  extraTools: ToolDefinition[];
  basePrompt(): string;
  onTurnLifecycle: {
    onSlotWaitStart(): void;
    onTurnCompleted(
      reason: TurnEndReason,
      error?: { code: string; message: string },
    ): Promise<void>;
  };
}

/** 常驻子会话的工作树操作接口（由 core/index 注入） */
export interface ResidentWorktreeOps {
  inspectRepository(cwd: string): Promise<string>;
  create(input: {
    childSessionId: string;
    repository: string;
    cwd: string;
    workspaceRoot: string;
    task: string;
  }): Promise<ResidentWorktreeHandle>;
  loadRecord(childSessionId: string): Promise<ResidentWorktreeHandle | undefined>;
  listParentRecords(): Promise<ResidentWorktreeHandle[]>;
  checkpoint(
    record: ResidentWorktreeHandle,
    commitMessage?: string,
  ): Promise<SubagentChanges | undefined>;
  currentHead(worktreePath: string): Promise<string>;
  isOnBranch(record: ResidentWorktreeHandle): Promise<boolean>;
  resetToCommit(worktreePath: string, commitSha: string): Promise<string>;
  markApplied(record: ResidentWorktreeHandle, appliedHead: string): Promise<void>;
  remove(record: ResidentWorktreeHandle, removeBranch: boolean): Promise<void>;
  cleanupMerged(): Promise<void>;
}
