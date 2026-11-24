import { isGoalCheckBackend, type GoalCheckBackend } from "@nocturne/core/protocol";
import type { SettingItem, SettingsPatch } from "@nocturne/core";

export {
  GOAL_CHECK_DISCLOSURE_PREF,
  goalCheckFailedItems,
  goalCheckFromEntry,
  goalCheckUnavailableReason,
  isGoalUnverified,
  parseGoalCheckAccepted,
  type GoalCheckBackend,
} from "@nocturne/core/protocol";

export function readGoalCheckBackend(item: SettingItem | undefined): GoalCheckBackend {
  return isGoalCheckBackend(item?.effective) ? item.effective : "off";
}

export function goalCheckSettingPatch(backend: GoalCheckBackend): SettingsPatch {
  return { goalCheck: { backend } };
}
