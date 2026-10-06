export * from "./types.js";
export { createSkillTool } from "./builtin/skill.js";
export { createToolRegistry } from "./registry.js";
export { createToolExecutor, resolveSubjects } from "./executor.js";
export { createExecutionScope } from "./scope.js";
export { createAttachmentStore, type AttachmentStore } from "./attachments.js";
export {
  IMAGE_MAX_BYTES,
  IMAGE_MAX_EDGE,
  SUPPORTED_IMAGE_FORMATS,
  parseImageSize,
  sniffImageMime,
} from "./image.js";
export { createPolicyGate } from "./gate.js";
export { createQuestionBroker, type QuestionBrokerOptions } from "./question.js";
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
export { writeTool } from "./builtin/write.js";
export { editTool } from "./builtin/edit.js";
export { applyPatchTool, parsePatch } from "./builtin/apply-patch.js";
export { shellTool } from "./builtin/shell.js";
export { todoWriteTool } from "./builtin/todo-write.js";
export { askUserTool } from "./builtin/ask-user.js";
export { webFetchTool } from "./builtin/web-fetch.js";
export { diffLines } from "./builtin/diff.js";
export { createTaskTool } from "./builtin/task.js";
export type { GateGrantSink } from "./gate.js";

import type { ToolDefinition, ToolRegistry } from "./types.js";
import { createToolRegistry } from "./registry.js";
import { readTool } from "./builtin/read.js";
import { grepTool } from "./builtin/grep.js";
import { globTool } from "./builtin/glob.js";
import { writeTool } from "./builtin/write.js";
import { editTool } from "./builtin/edit.js";
import { applyPatchTool } from "./builtin/apply-patch.js";
import { shellTool } from "./builtin/shell.js";
import { todoWriteTool } from "./builtin/todo-write.js";
import { askUserTool } from "./builtin/ask-user.js";
import { webFetchTool } from "./builtin/web-fetch.js";

/** 内置工具集：Phase 2 起含写入与 shell（权限层决定是否放行） */
export function builtinTools(): ToolDefinition[] {
  return [
    readTool,
    grepTool,
    globTool,
    writeTool,
    editTool,
    // ADR-0035 §5：apply_patch 与 edit/write 互斥，靠 traits.editTool 按
    // 模型能力筛选；三套编辑工具都注册，暴露谁由 specs/get 决定
    applyPatchTool,
    shellTool,
    todoWriteTool,
    askUserTool,
    webFetchTool,
  ];
}

export function createBuiltinRegistry(): ToolRegistry {
  const registry = createToolRegistry();
  for (const tool of builtinTools()) registry.register(tool);
  return registry;
}
