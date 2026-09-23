export * from "./types.js";
export { createToolRegistry } from "./registry.js";
export { createToolExecutor } from "./executor.js";
export { createExecutionScope } from "./scope.js";
export { createPolicyGate } from "./gate.js";
export { createReadStateStore } from "./readstate.js";
export {
  applyBudget,
  capOutput,
  truncateModelContent,
  DEFAULT_MAX_MODEL_CHARS,
  MAX_OUTPUT_CHARS,
} from "./budget.js";
export { readTool } from "./builtin/read.js";
export { grepTool } from "./builtin/grep.js";
export { globTool } from "./builtin/glob.js";

import type { ToolDefinition, ToolRegistry } from "./types.js";
import { createToolRegistry } from "./registry.js";
import { readTool } from "./builtin/read.js";
import { grepTool } from "./builtin/grep.js";
import { globTool } from "./builtin/glob.js";

/** Phase 1 内置只读工具集 */
export function builtinTools(): ToolDefinition[] {
  return [readTool, grepTool, globTool];
}

export function createBuiltinRegistry(): ToolRegistry {
  const registry = createToolRegistry();
  for (const tool of builtinTools()) registry.register(tool);
  return registry;
}
