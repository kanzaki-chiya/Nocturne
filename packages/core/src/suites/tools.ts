/**
 * 组曲（Suite）指挥工具定义（ADR-0097 §3.3）：
 * `thread_start`、`thread_send`、`thread_list`、`thread_read`、`thread_resolve`。
 * 所有给模型看的描述、参数说明与返回文本均为英文。
 */
import {
  ensembleEnabledModelsTable,
  REASONING_EFFORT_ORDER,
  subagentSelectionTable,
  type ModelPricing,
  type ReasoningEffort,
  type SubagentProfileConfig,
  type SuiteThreadGroup,
  type SuiteThreadStatus,
  type SuiteWorktreeRef,
} from "../protocol/index.js";
import type { ToolDefinition, ToolResult } from "../tools/index.js";

export interface SuiteToolOutcome<T = unknown> {
  ok: true;
  text: string;
  output?: T;
}

export interface SuiteToolFailure {
  ok: false;
  code: "invalid_input" | "suite_error";
  message: string;
  userMessage?: string | undefined;
}

export type SuiteToolActionResult<T = unknown> = SuiteToolOutcome<T> | SuiteToolFailure;

function toToolResult<T>(res: SuiteToolActionResult<T>): ToolResult<T> {
  if (!res.ok) {
    return {
      status: "error",
      modelContent: res.message,
      error: { code: res.code, message: res.message },
    };
  }
  return {
    status: "ok",
    modelContent: res.text,
    ...(res.output !== undefined ? { output: res.output } : {}),
  };
}

export interface SuiteModelCatalogSnapshot {
  defaultModel?: string | undefined;
  profiles: readonly (SubagentProfileConfig & {
    name: string;
    pricing?: ModelPricing | undefined;
  })[];
  enabledModels: readonly { provider: string; model: string; name?: string | undefined }[];
  pricing?: ((modelKey: string | undefined) => ModelPricing | undefined) | undefined;
  workspaces: readonly string[];
}

function buildSelectionAppendix(catalog: SuiteModelCatalogSnapshot): string {
  const profilesTable = subagentSelectionTable(
    catalog.profiles,
    [],
    catalog.defaultModel,
    catalog.pricing,
  );
  const modelsTable = ensembleEnabledModelsTable(catalog.enabledModels, catalog.pricing);
  return `${profilesTable}\n\n${modelsTable}`;
}

export interface SuiteThreadListItem {
  threadId: string;
  childSessionId: string;
  title: string;
  status: SuiteThreadStatus;
  group: SuiteThreadGroup;
  resolved: boolean;
  workspace: string;
  model: string;
  isolated: boolean;
  worktree?: SuiteWorktreeRef | undefined;
  hasUnmergedWorktree: boolean;
  lastReportLine?: string | undefined;
  pendingPermissionCount: number;
  hasPendingQuestion: boolean;
  pauseError?: { code: string; message: string } | undefined;
}

export interface SuiteThreadReportRecord {
  seq: number;
  time: string;
  turnId: string;
  status: "idle" | "paused";
  report: string;
  error?: { code: string; message: string } | undefined;
}

export interface SuiteThreadReadOutput {
  threadId: string;
  title: string;
  status: SuiteThreadStatus;
  group: SuiteThreadGroup;
  workspace: string;
  isolated: boolean;
  reports: SuiteThreadReportRecord[];
  hasMore: boolean;
}

export const SUITE_THREAD_READ_DEFAULT_LIMIT = 5;
export const SUITE_THREAD_READ_MAX_LIMIT = 50;

export const SUITE_COORDINATOR_TOOL_NAMES = [
  "thread_start",
  "thread_send",
  "thread_list",
  "thread_read",
  "thread_resolve",
] as const;

export interface SuiteCoordinatorToolHandlers {
  catalog(): SuiteModelCatalogSnapshot;
  startThread(input: {
    title: string;
    task: string;
    model?: string | undefined;
    profile?: string | undefined;
    effort?: ReasoningEffort | undefined;
    preset?: "general" | "explore" | undefined;
    isolated?: boolean | undefined;
    workspace?: string | undefined;
  }): Promise<SuiteToolActionResult>;
  sendToThread(input: { thread: string; text: string }): Promise<SuiteToolActionResult>;
  listThreads(): Promise<SuiteToolActionResult<{ threads: SuiteThreadListItem[] }>>;
  readThread(input: {
    thread: string;
    limit?: number | undefined;
  }): Promise<SuiteToolActionResult<SuiteThreadReadOutput>>;
  resolveThread(input: {
    thread: string;
    reopen?: boolean | undefined;
  }): Promise<SuiteToolActionResult>;
}

const SUITE_MUTATING_TRAITS = {
  mutates: false,
  fileEffects: "none" as const,
  concurrencySafe: false,
  timeoutMs: 60_000,
};

const SUITE_READ_TRAITS = {
  mutates: false,
  concurrencySafe: true,
  timeoutMs: 10_000,
};

export function createSuiteCoordinatorTools(
  handlers: SuiteCoordinatorToolHandlers,
): ToolDefinition[] {
  const cat = handlers.catalog();
  const selectionAppendix = buildSelectionAppendix(cat);
  const workspaceHint =
    cat.workspaces.length > 0 ? ` Available workspaces: ${cat.workspaces.join(", ")}.` : "";

  const startTool: ToolDefinition<{
    title: string;
    task: string;
    model?: string;
    profile?: string;
    effort?: ReasoningEffort;
    preset?: "general" | "explore";
    isolated?: boolean;
    workspace?: string;
  }> = {
    name: "thread_start",
    description:
      "Start a new persistent Suite thread for a task. Unspecified model/effort/preset/isolated fields fall back to suite threadDefaults, then the coordinator's current model/effort.\n\n" +
      selectionAppendix,
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short descriptive title for the thread.",
        },
        task: {
          type: "string",
          description: "Initial task instructions for the thread.",
        },
        model: {
          type: "string",
          description:
            "Enabled model (`provider/model` or unique `model` id). Mutually exclusive with `profile`.",
        },
        profile: {
          type: "string",
          description:
            "Configured subagent profile name (`default` or custom). Mutually exclusive with `model`.",
        },
        effort: {
          type: "string",
          enum: [...REASONING_EFFORT_ORDER],
          description: "Optional reasoning effort level, clamped to model capabilities.",
        },
        preset: {
          type: "string",
          enum: ["general", "explore"],
          description: "Tool preset: `general` (default) or `explore` (read-only).",
        },
        isolated: {
          type: "boolean",
          description:
            "If true, create an isolated git worktree for this thread with incremental commits per turn.",
        },
        workspace: {
          type: "string",
          description: `Target workspace root from the suite's workspaces (defaults to primary workspace).${workspaceHint}`,
        },
      },
      required: ["title", "task"],
      additionalProperties: false,
    },
    traits: SUITE_MUTATING_TRAITS,
    permissionSubjects: () => [],
    async execute(input) {
      return toToolResult(await handlers.startThread(input));
    },
  };

  const sendTool: ToolDefinition<{ thread: string; text: string }> = {
    name: "thread_send",
    description:
      "Send follow-up instructions or feedback to an existing Suite thread. Steers the thread if busy, or starts a new turn if idle.",
    inputSchema: {
      type: "object",
      properties: {
        thread: {
          type: "string",
          description: "Target thread ID (e.g. `t1`).",
        },
        text: {
          type: "string",
          description: "Message text to deliver to the thread.",
        },
      },
      required: ["thread", "text"],
      additionalProperties: false,
    },
    traits: SUITE_MUTATING_TRAITS,
    permissionSubjects: () => [],
    async execute(input) {
      return toToolResult(await handlers.sendToThread(input));
    },
  };

  const listTool: ToolDefinition<Record<string, never>> = {
    name: "thread_list",
    description:
      "List all threads in this Suite with their status, overview group, workspace, model, and latest report line.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    traits: SUITE_READ_TRAITS,
    permissionSubjects: () => [],
    async execute() {
      return toToolResult(await handlers.listThreads());
    },
  };

  const readTool: ToolDefinition<{ thread: string; limit?: number }> = {
    name: "thread_read",
    description: "Read the full text of the most recent reports emitted by a Suite thread.",
    inputSchema: {
      type: "object",
      properties: {
        thread: {
          type: "string",
          description: "Target thread ID (e.g. `t1`).",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: SUITE_THREAD_READ_MAX_LIMIT,
          description: `Maximum number of recent reports to return (default ${SUITE_THREAD_READ_DEFAULT_LIMIT}, max ${SUITE_THREAD_READ_MAX_LIMIT}).`,
        },
      },
      required: ["thread"],
      additionalProperties: false,
    },
    traits: {
      ...SUITE_READ_TRAITS,
      maxModelChars: Number.MAX_SAFE_INTEGER,
      maxOutputChars: Number.MAX_SAFE_INTEGER,
    },
    permissionSubjects: () => [],
    async execute(input) {
      return toToolResult(await handlers.readThread(input));
    },
  };

  const resolveTool: ToolDefinition<{ thread: string; reopen?: boolean }> = {
    name: "thread_resolve",
    description: "Mark a Suite thread as resolved, or reopen a resolved thread (`reopen: true`).",
    inputSchema: {
      type: "object",
      properties: {
        thread: {
          type: "string",
          description: "Target thread ID (e.g. `t1`).",
        },
        reopen: {
          type: "boolean",
          description: "Set to true to reopen a resolved thread.",
        },
      },
      required: ["thread"],
      additionalProperties: false,
    },
    traits: {
      ...SUITE_MUTATING_TRAITS,
      timeoutMs: 10_000,
    },
    permissionSubjects: () => [],
    async execute(input) {
      return toToolResult(await handlers.resolveThread(input));
    },
  };

  return [startTool, sendTool, listTool, readTool, resolveTool];
}
