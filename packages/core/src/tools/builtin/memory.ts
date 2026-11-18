import {
  isMemoryType,
  isValidMemoryName,
  MEMORY_TYPES,
  MEMORY_WRITE_GUIDANCE,
  type MemoryEntry,
  type MemoryScope,
  type MemoryType,
} from "../../protocol/index.js";
import type { ToolDefinition } from "../types.js";

export interface MemoryReadInput {
  scope: MemoryScope;
  name: string;
}

export interface MemoryWriteInput {
  scope: MemoryScope;
  name: string;
  description: string;
  type: MemoryType;
  content: string;
}

export interface MemoryDeleteInput {
  scope: MemoryScope;
  name: string;
}

export interface MemoryToolDeps {
  availableScopes: readonly MemoryScope[];
  readMemory(
    scope: MemoryScope,
    name: string,
  ): Promise<
    | { ok: true; entry: MemoryEntry }
    | { ok: false; code: "memory_not_found" | "invalid_memory"; message: string }
  >;
  writeMemory(input: MemoryWriteInput): Promise<MemoryEntry>;
  deleteMemory(scope: MemoryScope, name: string): Promise<boolean>;
}

/**
 * 创建长期记忆工具组（ADR-0098 §4）：
 * - memory_read / memory_write / memory_delete
 * - 不接收路径参数，不弹权限确认（permissionSubjects 为空）
 * - scope 仅接受当前会话可用且开关打开的范围，否则 validateInput 报 invalid_input 并列出可用范围
 */
export function createMemoryTools(deps: MemoryToolDeps): {
  read: ToolDefinition<MemoryReadInput>;
  write: ToolDefinition<MemoryWriteInput>;
  delete: ToolDefinition<MemoryDeleteInput>;
} {
  const available = [...deps.availableScopes];
  const availableSet = new Set<string>(available);
  const availableText =
    available.length > 0 ? available.join(", ") : "(none; all memory scopes are disabled)";

  const validateScope = (scope: unknown): string | undefined => {
    if (typeof scope !== "string" || !availableSet.has(scope)) {
      return available.length > 0
        ? `Invalid memory scope "${String(scope)}". Available scopes: ${available.join(", ")}.`
        : "No memory scopes are available or enabled in this session.";
    }
    return undefined;
  };

  const validateName = (name: unknown): string | undefined => {
    if (!isValidMemoryName(name)) {
      return `Invalid memory name "${String(name)}". Name must match ^[a-z0-9][a-z0-9-]*$.`;
    }
    return undefined;
  };

  const read: ToolDefinition<MemoryReadInput> = {
    name: "memory_read",
    description:
      "Read the full content (including YAML frontmatter) of a long-term memory entry by scope and name.",
    inputSchema: {
      type: "object",
      required: ["scope", "name"],
      properties: {
        scope: {
          type: "string",
          description: `Memory scope. Available scopes: ${availableText}.`,
        },
        name: {
          type: "string",
          description: "Memory entry name (^[a-z0-9][a-z0-9-]*$).",
        },
      },
      additionalProperties: false,
    },
    traits: {
      mutates: false,
      concurrencySafe: true,
      timeoutMs: 10_000,
    },
    validateInput(input) {
      return validateScope(input.scope) ?? validateName(input.name);
    },
    permissionSubjects: () => [],
    async execute(input) {
      const res = await deps.readMemory(input.scope, input.name);
      if (!res.ok) {
        return {
          status: "error",
          modelContent: res.message,
          error: { code: res.code, message: res.message },
        };
      }
      return {
        status: "ok",
        modelContent: res.entry.raw,
        output: {
          scope: res.entry.scope,
          name: res.entry.name,
          type: res.entry.type,
          description: res.entry.description,
          updatedAt: res.entry.updatedAt,
          raw: res.entry.raw,
        },
      };
    },
  };

  const write: ToolDefinition<MemoryWriteInput> = {
    name: "memory_write",
    description:
      "Create or overwrite a long-term memory entry (<name>.md) in the selected scope. " +
      MEMORY_WRITE_GUIDANCE,
    inputSchema: {
      type: "object",
      required: ["scope", "name", "description", "type", "content"],
      properties: {
        scope: {
          type: "string",
          description: `Memory scope. Available scopes: ${availableText}.`,
        },
        name: {
          type: "string",
          description: "Unique entry name within the scope (^[a-z0-9][a-z0-9-]*$).",
        },
        description: {
          type: "string",
          description: "Concise one-line summary shown in the memory index.",
        },
        type: {
          type: "string",
          enum: [...MEMORY_TYPES],
          description: "Memory category: user, feedback, project, or reference.",
        },
        content: {
          type: "string",
          description: "Markdown body of the memory.",
        },
      },
      additionalProperties: false,
    },
    traits: {
      mutates: true,
      fileEffects: "none",
      concurrencySafe: false,
      timeoutMs: 10_000,
    },
    validateInput(input) {
      const base = validateScope(input.scope) ?? validateName(input.name);
      if (base !== undefined) return base;
      if (!isMemoryType(input.type)) {
        return `Invalid memory type "${String(input.type)}". Type must be one of: ${MEMORY_TYPES.join(", ")}.`;
      }
      if (typeof input.description !== "string" || input.description.trim() === "") {
        return "Memory description must be a non-empty string.";
      }
      if (typeof input.content !== "string" || input.content.trim() === "") {
        return "Memory content must be a non-empty string.";
      }
      return undefined;
    },
    permissionSubjects: () => [],
    async execute(input) {
      try {
        const entry = await deps.writeMemory(input);
        return {
          status: "ok",
          modelContent: `Saved memory "${entry.name}" in ${entry.scope} scope.`,
          output: {
            scope: entry.scope,
            name: entry.name,
            type: entry.type,
            description: entry.description,
            updatedAt: entry.updatedAt,
          },
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return {
          status: "error",
          modelContent: message,
          error: { code: "tool_failed", message },
        };
      }
    },
  };

  const del: ToolDefinition<MemoryDeleteInput> = {
    name: "memory_delete",
    description: "Delete a long-term memory entry file by scope and name.",
    inputSchema: {
      type: "object",
      required: ["scope", "name"],
      properties: {
        scope: {
          type: "string",
          description: `Memory scope. Available scopes: ${availableText}.`,
        },
        name: {
          type: "string",
          description: "Memory entry name to delete (^[a-z0-9][a-z0-9-]*$).",
        },
      },
      additionalProperties: false,
    },
    traits: {
      mutates: true,
      fileEffects: "none",
      concurrencySafe: false,
      timeoutMs: 10_000,
    },
    validateInput(input) {
      return validateScope(input.scope) ?? validateName(input.name);
    },
    permissionSubjects: () => [],
    async execute(input) {
      const deleted = await deps.deleteMemory(input.scope, input.name);
      if (!deleted) {
        const message = `Memory "${input.name}" was not found in ${input.scope} scope.`;
        return {
          status: "error",
          modelContent: message,
          error: { code: "memory_not_found", message },
        };
      }
      return {
        status: "ok",
        modelContent: `Deleted memory "${input.name}" from ${input.scope} scope.`,
        output: {
          scope: input.scope,
          name: input.name,
          deleted: true,
        },
      };
    },
  };

  return { read, write, delete: del };
}
