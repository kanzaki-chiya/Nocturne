import { isGoalCheckBackend, type GoalCheckBackend } from "@nocturne/core/protocol";
import type { SettingItem, SettingsPatch } from "./rpc-types";

export {
  GOAL_CHECK_DISCLOSURE_PREF,
  goalCheckFailedItems,
  goalCheckUnavailableReason,
  isGoalUnverified,
  parseGoalCheckAccepted,
  type GoalCheckBackend,
} from "@nocturne/core/protocol";

export const GOAL_CHECK_OPTIONS: readonly { value: GoalCheckBackend; label: string }[] = [
  { value: "off", label: "关闭" },
  { value: "decision", label: "决策模型" },
  { value: "smol", label: "小模型" },
];

export function readGoalCheckBackend(item: SettingItem | undefined): GoalCheckBackend {
  return isGoalCheckBackend(item?.effective) ? item.effective : "off";
}

export function goalCheckSettingPatch(backend: GoalCheckBackend): SettingsPatch {
  return { goalCheck: { backend } };
}
