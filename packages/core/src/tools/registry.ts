/**
 * 工具注册表（tool-api.md 第 4 节）。
 * 名称重复时抛错，不静默覆盖。
 * get/specs 携带模型的 editTool 能力时按 ToolTraits.editTool 筛
 * 选可见性（ADR-0035 §5），筛选只比对能力值、不出现在工具名分支。
 */
import type { EditToolKind, ToolSpec } from "../protocol/index.js";
import type { ToolDefinition, ToolRegistry } from "./types.js";

const NAME_PATTERN = /^[a-z][a-z0-9_]*(?:__[a-z0-9_]+)*$/;

/** ADR-0035 §5：能力值未给出或工具未声明归属时工具可见 */
function visible(tool: ToolDefinition, editTool: EditToolKind | undefined): boolean {
  const need = tool.traits.editTool;
  return need === undefined || editTool === undefined || need === editTool;
}

export function createToolRegistry(): ToolRegistry {
  const tools = new Map<string, ToolDefinition>();

  return {
    register(tool) {
      if (!NAME_PATTERN.test(tool.name)) {
        throw new Error(`非法工具名: ${tool.name}`);
      }
      if (tools.has(tool.name)) {
        throw new Error(`工具名重复注册: ${tool.name}`);
      }
      tools.set(tool.name, tool);
    },
    unregister(name) {
      tools.delete(name);
    },
    get(name, editTool) {
      const tool = tools.get(name);
      return tool !== undefined && visible(tool, editTool) ? tool : undefined;
    },
    list() {
      return [...tools.values()];
    },
    specs(editTool): ToolSpec[] {
      return [...tools.values()]
        .filter((t) => visible(t, editTool))
        .map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        }));
    },
  };
}
