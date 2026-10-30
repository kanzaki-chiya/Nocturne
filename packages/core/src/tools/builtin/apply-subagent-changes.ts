import type { SubagentChanges } from "../../protocol/index.js";
import type { ToolDefinition } from "../types.js";

export function createApplySubagentChangesTool(deps: {
  lookup(
    id: string,
  ): { changes: SubagentChanges; repository: string; applied: boolean } | undefined;
  apply(id: string, mode: "clean" | "3way"): Promise<{ conflicts: string[] }>;
}): ToolDefinition<{ id: string; mode?: "clean" | "3way" }> {
  return {
    name: "apply_subagent_changes",
    description:
      "Apply a background subagent's isolated changes to the main workspace with checkpoint/rewind support. clean checks first; 3way may leave conflict markers for you to resolve.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" }, mode: { type: "string", enum: ["clean", "3way"] } },
      additionalProperties: false,
    },
    traits: { mutates: true, concurrencySafe: false, timeoutMs: 120_000 },
    validateInput(input) {
      const result = deps.lookup(input.id);
      if (!result) return "No isolated changes found for this subagent";
      if (result.applied)
        return "This subagent's changes have already been applied; rewind that application before applying again";
      if (
        result.changes.files.some(
          (file) =>
            /^(?:[\\/]|[A-Za-z]:)/.test(file.path) || file.path.split(/[\\/]/).includes(".."),
        )
      )
        return "Unsafe change path";
      return undefined;
    },
    permissionSubjects(input, scope) {
      const result = deps.lookup(input.id);
      return (
        result?.changes.files.map((file) => ({
          kind: "edit" as const,
          target: scope.paths.resolve(result.repository, file.path),
        })) ?? []
      );
    },
    async execute(input) {
      const result = deps.lookup(input.id);
      if (!result || result.applied)
        return {
          status: "error",
          modelContent: "No unapplied isolated changes found",
          error: { code: "invalid_input", message: "No unapplied isolated changes found" },
        };
      try {
        const { conflicts } = await deps.apply(input.id, input.mode ?? "clean");
        return {
          status: "ok",
          modelContent: conflicts.length
            ? `Applied with conflict markers: ${conflicts.join(", ")}`
            : `Applied ${result.changes.files.length} files.`,
          output: { id: input.id, files: result.changes.files, conflicts },
        };
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        return { status: "error", modelContent: message, error: { code: "tool_failed", message } };
      }
    },
  };
}
