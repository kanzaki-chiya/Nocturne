/**
 * 权限策略（roadmap.md Phase 1–2 / permissions.md）。
 *
 * - `createWorkspaceReadPolicy`：Phase 1 固定策略——工作区内读取 allow，其余 deny。
 * - `createDefaultPolicy`：Phase 2 的 `default` 预设——工作区内读取 allow，
 *   其余 ask；`autoApproveAsk` 把最终判定为 ask 的调用提升为 allow
 *   （permissions.md 第 7 节：命令行参数层的最小形态，不覆盖 deny）。
 *
 * 数据结构（SubjectEvaluation / PermissionDecision）与求值形状保持
 * permissions.md 的契约，Phase 3 可在同一接口下换为规则排序 + Grant 实现。
 */

import type { PermissionSubject } from "../protocol/index.js";
import { computeWhere } from "./where.js";
import type { PermissionPolicy, SubjectEvaluation } from "./types.js";

export interface WorkspaceReadPolicyOptions {
  /** 已解析为真实路径的工作区根目录 */
  workspaceRoot: string;
  /** 路径比较是否大小写敏感（来自 platform 的文件系统信息） */
  caseSensitive: boolean;
}

export function createWorkspaceReadPolicy(options: WorkspaceReadPolicyOptions): PermissionPolicy {
  const { workspaceRoot, caseSensitive } = options;

  return {
    evaluate(subjects: readonly PermissionSubject[]): SubjectEvaluation {
      const evaluated = subjects.map((s) => ({
        ...s,
        where:
          s.resolved !== undefined
            ? computeWhere(s.resolved, workspaceRoot, caseSensitive)
            : undefined,
      }));

      const denied = evaluated.filter((s) => !(s.kind === "read" && s.where === "workspace"));

      if (denied.length === 0) {
        return {
          subjects: evaluated,
          decision: {
            action: "allow",
            source: "rule",
            reason: "phase1 策略：工作区内读取允许",
          },
        };
      }

      const descriptions = denied.map((s) =>
        s.resolved === undefined
          ? `${s.kind} ${s.target}（无法解析路径）`
          : `${s.kind} ${s.resolved}（${s.where ?? "unknown"}）`,
      );
      return {
        subjects: evaluated,
        decision: {
          action: "deny",
          source: "rule",
          reason: `phase1 策略：仅允许工作区内读取；拒绝：${descriptions.join("；")}`,
        },
      };
    },
  };
}

export interface DefaultPolicyOptions extends WorkspaceReadPolicyOptions {
  /**
   * 命令行允许（permissions.md 第 7 节）：最终判定为 ask 的调用提升为 allow。
   * 只作用于本策略自身产生的 ask；不覆盖任何 deny（本策略不产生 deny），
   * 也不绕过输入校验、主体解析与工具边界。
   */
  autoApproveAsk?: boolean | undefined;
}

/** Phase 2 的 default 预设：工作区内读取 allow，其余 ask（permissions.md 第 6 节） */
export function createDefaultPolicy(options: DefaultPolicyOptions): PermissionPolicy {
  const { workspaceRoot, caseSensitive, autoApproveAsk = false } = options;

  return {
    evaluate(subjects: readonly PermissionSubject[]): SubjectEvaluation {
      const evaluated = subjects.map((s) => ({
        ...s,
        where:
          s.resolved !== undefined
            ? computeWhere(s.resolved, workspaceRoot, caseSensitive)
            : undefined,
      }));

      const allWorkspaceRead = evaluated.every((s) => s.kind === "read" && s.where === "workspace");
      // 空主体集（工具声明不触碰任何资源）同样放行
      if (allWorkspaceRead) {
        return {
          subjects: evaluated,
          decision: {
            action: "allow",
            source: "rule",
            reason: "default 预设：工作区内读取允许",
          },
        };
      }

      const descriptions = evaluated.map((s) =>
        s.resolved === undefined
          ? `${s.kind} ${s.target}（无法解析路径）`
          : `${s.kind} ${s.resolved}（${s.where ?? "unknown"}）`,
      );
      const askReason = `default 预设：需确认——${descriptions.join("；")}`;
      if (autoApproveAsk) {
        return {
          subjects: evaluated,
          decision: {
            action: "allow",
            source: "rule",
            reason: `${askReason}；命令行参数自动批准`,
          },
        };
      }
      return {
        subjects: evaluated,
        decision: { action: "ask", source: "rule", reason: askReason },
      };
    },
  };
}
