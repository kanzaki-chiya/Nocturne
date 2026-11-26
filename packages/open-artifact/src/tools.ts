import {
  actionKindOf,
  TOOL_DESCRIPTIONS,
  TOOL_SCHEMAS,
  type ToolCallResult,
  type ToolName,
} from "@open-artifact/protocol";
import type {
  JsonSchema,
  SubjectRequest,
  ToolContext,
  ToolDefinition,
  ToolResult,
  ToolScope,
} from "@nocturne/core";
import {
  extractCompletedArtifact,
  sanitizeToolOutput,
  type KnownArtifactMeta,
} from "./sanitize.js";

export interface OpenArtifactToolBackend {
  callTool(
    name: ToolName,
    args: Record<string, unknown>,
    caller: { sessionId: string; workspace: string },
  ): Promise<ToolCallResult>;
  knownArtifacts: Map<string, KnownArtifactMeta>;
}

const TOOL_NAMES: readonly ToolName[] = ["Artifact", "ArtifactData", "ArtifactComments"];

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function collectSubjects(
  toolName: ToolName,
  rawInput: unknown,
  scope: ToolScope,
): SubjectRequest[] {
  const input =
    rawInput && typeof rawInput === "object" ? (rawInput as Record<string, unknown>) : {};
  const action = nonEmptyString(input.action);
  const kind = actionKindOf(toolName, action);
  const subjects: SubjectRequest[] = [];

  if (kind === "read") {
    if (toolName === "ArtifactData") {
      const outFile = nonEmptyString(input.out_file);
      if (outFile) {
        subjects.push({ kind: "edit", target: scope.paths.resolve(scope.cwd, outFile) });
      }
    }
    return subjects;
  }

  if (kind === "ui") {
    return subjects;
  }

  if (kind === "person") {
    subjects.push({
      kind: "mcp",
      target: `open-artifact/${toolName}/${action ?? "share"}`,
      readOnly: false,
    });
    return subjects;
  }

  if (kind === "remove") {
    subjects.push({ kind: "edit", target: scope.workspaceRoot });
    subjects.push({
      kind: "mcp",
      target: `open-artifact/${toolName}/${action ?? "delete"}`,
      readOnly: false,
    });
    return subjects;
  }

  // write / call / 未知动作均归入写权限检查，保证 read-only 预设拒绝、default 预设确认、auto-edit 放行
  if (toolName === "Artifact") {
    const folder = nonEmptyString(input.folder);
    subjects.push({
      kind: "edit",
      target: folder ? scope.paths.resolve(scope.cwd, folder) : scope.workspaceRoot,
    });
  } else {
    subjects.push({ kind: "edit", target: scope.workspaceRoot });
  }

  if (toolName === "ArtifactData") {
    const filePath = nonEmptyString(input.file_path);
    if (filePath) {
      subjects.push({ kind: "read", target: scope.paths.resolve(scope.cwd, filePath) });
    }
    const writes = input.writes;
    if (Array.isArray(writes)) {
      for (const item of writes) {
        if (item && typeof item === "object") {
          const itemPath = nonEmptyString((item as Record<string, unknown>).file_path);
          if (itemPath) {
            subjects.push({ kind: "read", target: scope.paths.resolve(scope.cwd, itemPath) });
          }
        }
      }
    }
  }

  return subjects;
}

function buildToolDescription(name: ToolName): string {
  const base = TOOL_DESCRIPTIONS[name];
  if (name === "Artifact") {
    return `${base} Use Artifact (not render_html) for standalone editable artifacts such as Design canvases, HTML Pages, Slides, Dashboards, Docs, Sheets, and Whiteboards; render_html is only for inline charts inside a chat reply.`;
  }
  return base;
}

export function createOpenArtifactTools(
  backend: OpenArtifactToolBackend,
  _scope: { mainSession: boolean },
): ToolDefinition[] {
  return TOOL_NAMES.map((name): ToolDefinition => ({
    name,
    description: buildToolDescription(name),
    inputSchema: TOOL_SCHEMAS[name] as unknown as JsonSchema,
    traits: {
      mutates: true,
      concurrencySafe: false,
      timeoutMs: 120_000,
      suppressFilesWrittenNotify: true,
    },
    permissionSubjects(input: unknown, scope: ToolScope): SubjectRequest[] {
      return collectSubjects(name, input, scope);
    },
    async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const args =
        input && typeof input === "object" ? { ...(input as Record<string, unknown>) } : {};
      let rawResult: ToolCallResult;
      try {
        rawResult = await backend.callTool(name, args, {
          sessionId: ctx.sessionId,
          workspace: ctx.cwd,
        });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        return {
          status: "error",
          modelContent: `Open Artifact ${name} failed: ${message}`,
          error: {
            code: "open_artifact_error",
            message,
          },
        };
      }

      const sanitized = sanitizeToolOutput(rawResult) as Record<string, unknown>;
      const errObj =
        rawResult.error && typeof rawResult.error === "object" ? rawResult.error : undefined;
      if (errObj !== undefined) {
        const code = nonEmptyString(errObj.code) ?? "open_artifact_error";
        const message = nonEmptyString(errObj.message) ?? "Open Artifact tool call failed";
        return {
          status: "error",
          modelContent: JSON.stringify(sanitized, null, 2),
          output: sanitized,
          error: { code, message },
        };
      }

      const artifact = extractCompletedArtifact(name, args, rawResult, backend.knownArtifacts);
      return {
        status: "ok",
        modelContent: JSON.stringify(sanitized, null, 2),
        output: sanitized,
        ...(artifact !== undefined ? { artifact } : {}),
      };
    },
  }));
}
