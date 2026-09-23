/**
 * 工具注册表（tool-api.md 第 4 节）。
 * 名称重复时抛错，不静默覆盖。
 */
import type { ToolSpec } from "../protocol/index.js";
import type { ToolDefinition, ToolRegistry } from "./types.js";

const NAME_PATTERN = /^[a-z][a-z0-9_]*(?:__[a-z0-9_]+)*$/;

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
    get(name) {
      return tools.get(name);
    },
    list() {
      return [...tools.values()];
    },
    specs(): ToolSpec[] {
      return [...tools.values()].map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
    },
  };
}
