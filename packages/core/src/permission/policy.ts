/**
 * Phase 1 固定权限策略（roadmap.md Phase 1 / permissions.md）：
 *   工作区内读取 → allow
 *   其余一切     → deny（工作区外读取、edit/shell/network/mcp、无法解析的主体）
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
