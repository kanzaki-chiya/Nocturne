export {
  createEnsembleController,
  type ManagedMemberSession,
  type EnsembleController,
  type EnsembleControllerDeps,
  type EnsembleMemberOpenSpec,
  type EnsembleWorktreeHandle,
  type EnsembleWorktreeOps,
} from "./controller.js";
export { buildEnsembleMemberPrompt } from "./prompts.js";
export {
  createEnsembleCheckoutTool,
  createEnsembleMaestroTools,
  createEnsemblePostTool,
  ENSEMBLE_MAESTRO_TOOL_NAMES,
} from "./tools.js";
