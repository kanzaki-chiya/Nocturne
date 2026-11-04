import type { ToolDefinition } from "../types.js";

export function createSwitchWorktreeTool(deps: {
  switchWorktree(target: string): Promise<{ current: string; branch?: string }>;
}): ToolDefinition<{ path: string }> {
  return {
    name: "switch_worktree",
    description:
      "Switch the session's current working directory to an existing git worktree of the project repository.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: { path: { type: "string" } },
      additionalProperties: false,
    },
    traits: { mutates: true, concurrencySafe: false, fileEffects: "none", timeoutMs: 15_000 },
    permissionSubjects(input, scope) {
      return [{ kind: "read", target: scope.paths.resolve(scope.cwd, input.path) }];
    },
    async execute(input) {
      try {
        const res = await deps.switchWorktree(input.path);
        return {
          status: "ok",
          modelContent: `Switched working directory to ${res.current}${res.branch ? ` (branch ${res.branch})` : ""}.`,
          output: res,
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return {
          status: "error",
          modelContent: message,
          error: { code: "invalid_input", message },
        };
      }
    },
  };
}
