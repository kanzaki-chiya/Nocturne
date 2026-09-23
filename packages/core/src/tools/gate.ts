/**
 * 权限闸门（tools.md 第 3 节步骤 5）。
 * Phase 1：固定策略直接求值，不存在 ask 等待；
 * Phase 3：同一接口内封装 permission.requested 的等待与取消。
 */
import type { SubjectRequest } from "../protocol/index.js";
import type { PermissionPolicy } from "../permission/index.js";
import type { GateOutcome, PermissionGate } from "./types.js";

export function createPolicyGate(policy: PermissionPolicy): PermissionGate {
  return {
    check(subjects): Promise<GateOutcome> {
      const evaluation = policy.evaluate(subjects);
      return Promise.resolve({
        subjects: evaluation.subjects,
        decision: evaluation.decision,
      });
    },
    checkLexical(request: SubjectRequest) {
      // permissions.md 4.4：枚举结果位于已解析根目录之下，词法路径即可判定
      const evaluation = policy.evaluate([
        { kind: request.kind, target: request.target, resolved: request.target },
      ]);
      return evaluation.decision.action;
    },
  };
}
