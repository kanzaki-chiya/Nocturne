import type { SubagentChanges } from "../../protocol/index.js";
import type { ToolDefinition } from "../types.js";

const COMMIT_SHA_RE = /^[0-9a-f]{7,64}$/iu;

export class ExpectedHeadMismatchError extends Error {}

export function checkExpectedHead(
  id: string,
  actualHead: string,
  expectedHead: string | undefined,
): string | undefined {
  if (expectedHead === undefined) return undefined;
  const trimmed = expectedHead.trim();
  if (!COMMIT_SHA_RE.test(trimmed)) {
    return `Invalid expectedHead "${expectedHead}": must be a commit SHA (7 to 64 hex characters).`;
  }
  const actual = actualHead.trim().toLowerCase();
  const expected = trimmed.toLowerCase();
  if (!actual.startsWith(expected)) {
    return `Head mismatch for "${id}": current head is ${actualHead}, expected ${expectedHead}. Do not apply unverified commits; ask the verifier to review the changes since ${expectedHead} and issue a new verdict before applying.`;
  }
  return undefined;
}

export function createApplySubagentChangesTool(deps: {
  lookup(
    id: string,
  ): { changes: SubagentChanges; repository: string; applied: boolean } | undefined;
  apply(
    id: string,
    mode: "clean" | "3way",
    expectedHead?: string,
  ): Promise<{ conflicts: string[] }>;
}): ToolDefinition<{ id: string; mode?: "clean" | "3way"; expectedHead?: string }> {
  return {
    name: "apply_subagent_changes",
    description:
      "Apply a background subagent's or isolated member's changes to the main workspace with checkpoint/rewind support. clean checks first; 3way may leave conflict markers for you to resolve. Pass expectedHead (commit SHA or 7+ hex prefix) to require the current branch head to match the verified commit.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        mode: { type: "string", enum: ["clean", "3way"] },
        expectedHead: {
          type: "string",
          description:
            "Optional commit SHA (full or 7+ hex prefix) that the target's current head must match before applying.",
        },
      },
      additionalProperties: false,
    },
    traits: { mutates: true, concurrencySafe: false, timeoutMs: 120_000 },
    validateInput(input) {
      const result = deps.lookup(input.id);
      if (!result) return "No isolated changes found for this subagent";
      if (result.applied)
        return "This subagent's changes have already been applied; rewind that application before applying again";
      const headError = checkExpectedHead(input.id, result.changes.head, input.expectedHead);
      if (headError !== undefined) return headError;
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
      const headError = checkExpectedHead(input.id, result.changes.head, input.expectedHead);
      if (headError !== undefined)
        return {
          status: "error",
          modelContent: headError,
          error: { code: "invalid_input", message: headError },
        };
      try {
        const { conflicts } = await deps.apply(input.id, input.mode ?? "clean", input.expectedHead);
        return {
          status: "ok",
          modelContent: conflicts.length
            ? `Applied with conflict markers: ${conflicts.join(", ")}`
            : `Applied ${result.changes.files.length} files.`,
          output: { id: input.id, files: result.changes.files, conflicts },
        };
      } catch (cause) {
        if (cause instanceof ExpectedHeadMismatchError) {
          return {
            status: "error",
            modelContent: cause.message,
            error: { code: "invalid_input", message: cause.message },
          };
        }
        const message = cause instanceof Error ? cause.message : String(cause);
        return { status: "error", modelContent: message, error: { code: "tool_failed", message } };
      }
    },
  };
}
