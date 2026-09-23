/**
 * 权限层类型（docs/architecture/permissions.md 第 2 节）。
 * 本模块只做纯策略判断：不访问文件系统、不执行工具、无副作用。
 * 主体解析（platform.resolve）由 Tool Executor 完成；
 * `where` 由本层在求值时计算（permissions.md 4.1）。
 */

import type { PermissionAction, PermissionSource, PermissionSubject } from "../protocol/index.js";

/** 一次求值的结论（events.md：tool.started.permission / permission.resolved） */
export interface PermissionDecision {
  action: PermissionAction;
  source: PermissionSource;
  /** 可解释的原因说明，写入事件与诊断 */
  reason: string;
}

/** 求值结果：填好 `where` 的主体列表 + 统一决定 */
export interface SubjectEvaluation {
  subjects: PermissionSubject[];
  decision: PermissionDecision;
}

/**
 * 权限策略接口。Phase 3 将由规则排序 + Grant 实现；
 * Phase 1 为固定策略实现（workspace-read-only）。
 */
export interface PermissionPolicy {
  /**
   * 对已解析主体求值。
   * 输入主体的 `resolved` 由 Executor 经 platform 预先解析；
   * 本函数计算 `where` 并返回统一决定（permissions.md 5.3：
   * 任一主体 deny 则整体 deny）。
   */
  evaluate(subjects: readonly PermissionSubject[]): SubjectEvaluation;
}
