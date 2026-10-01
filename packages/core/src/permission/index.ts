export { computeWhere } from "./where.js";
export {
  findRiskySegment,
  isCompositeShell,
  isOpaquePowerShellCommand,
  isRiskyShellCommand,
  lexShellCommand,
  matchPattern,
  nestedShellPayloads,
  normalizePathText,
  shellDialect,
  shellSegments,
  shellTailExecutables,
  shellTailStages,
  stageExecutable,
  type ShellDialect,
  type ShellToken,
} from "./pattern.js";
export { grantFromSubject, grantKey, matchGrant } from "./grants.js";
export { isPermissionPresetName, presetRules, PERMISSION_PRESET_NAMES } from "./presets.js";
export type { PresetContext } from "./presets.js";
export {
  createDefaultPolicy,
  createRulePolicy,
  createWorkspaceReadPolicy,
  type DefaultPolicyOptions,
  type RulePolicyOptions,
  type WorkspaceReadPolicyOptions,
} from "./policy.js";
export * from "./types.js";

export * from "./gate.js";
export * from "./reviewer.js";
