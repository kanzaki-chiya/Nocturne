/**
 * Ensemble 内置工具定义（ADR-0089 §2、§3、§4）。
 * 所有给模型看的描述、参数说明与返回文本均为英文。
 */
import {
  REASONING_EFFORT_ORDER,
  subagentSelectionTable,
  ensembleEnabledModelsTable,
  type EnsembleAuthorKind,
  type EnsembleMemberStatus,
  type EnsembleOverview,
  type ModelPricing,
  type ReasoningEffort,
  type SubagentProfileConfig,
  type EnsembleCharter,
  type EnsembleUnmergedWorktree,
} from "../protocol/index.js";
import type { ToolDefinition, ToolResult } from "../tools/index.js";

export interface EnsembleToolOutcome<T = unknown> {
  ok: true;
  text: string;
  output?: T;
}

export interface EnsembleToolFailure {
  ok: false;
  /** `invalid_input` 输入校验失败；`ensemble_error` 合奏状态不满足；`write_failed` 持久写入失败（未落盘、可安全重试） */
  code: "invalid_input" | "ensemble_error" | "write_failed";
  message: string;
  userMessage?: string | undefined;
}

export type EnsembleToolActionResult<T = unknown> = EnsembleToolOutcome<T> | EnsembleToolFailure;

function toToolResult<T>(res: EnsembleToolActionResult<T>): ToolResult<T> {
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

export interface EnsembleModelCatalogSnapshot {
  defaultModel?: string | undefined;
  profiles: readonly (SubagentProfileConfig & {
    name: string;
    pricing?: ModelPricing | undefined;
  })[];
  enabledModels: readonly { provider: string; model: string; name?: string | undefined }[];
  pricing?: ((modelKey: string | undefined) => ModelPricing | undefined) | undefined;
}

function buildSelectionAppendix(catalog: EnsembleModelCatalogSnapshot): string {
  const profilesTable = subagentSelectionTable(
    catalog.profiles,
    [],
    catalog.defaultModel,
    catalog.pricing,
  );
  const modelsTable = ensembleEnabledModelsTable(catalog.enabledModels, catalog.pricing);
  return `${profilesTable}\n\n${modelsTable}`;
}

export interface EnsembleReadInput {
  from?: string | undefined;
  mention?: string | undefined;
  query?: string | undefined;
  before?: number | undefined;
  limit?: number | undefined;
}

export interface EnsembleReadPostItem {
  number: number;
  from: string;
  fromKind: EnsembleAuthorKind;
  text: string;
  mentions: string[];
}

export interface EnsembleReadMemberItem {
  name: string;
  status: EnsembleMemberStatus;
  isolated: boolean;
  charter: EnsembleCharter;
}

export interface EnsembleReadOutput {
  posts: EnsembleReadPostItem[];
  hasMore: boolean;
  members: EnsembleReadMemberItem[];
  /**
   * 指挥维护的合奏概览快照（ADR-0131）：完整结构与当前 revision。
   * 旧合奏从未写入概览时缺省。
   */
  overview?: EnsembleOverview | undefined;
}

/** `ensemble_overview` 更新成功后的返回值 */
export interface EnsembleOverviewWriteOutput {
  revision: number;
  /** true 表示输入与最后一次成功更新完全相同，按幂等重试处理（未新增 revision） */
  deduplicated: boolean;
}

export const ENSEMBLE_READ_DEFAULT_LIMIT = 20;
export const ENSEMBLE_READ_MAX_LIMIT = 50;

export interface EnsembleMaestroToolHandlers {
  catalog(): EnsembleModelCatalogSnapshot;
  init(input: { title: string }): Promise<EnsembleToolActionResult<{ title: string }>>;
  addMember(input: {
    name: string;
    charter?: Partial<EnsembleCharter> | undefined;
    model?: string | undefined;
    profile?: string | undefined;
    effort?: ReasoningEffort | undefined;
    preset?: "general" | "explore" | undefined;
    isolated?: boolean | undefined;
  }): Promise<EnsembleToolActionResult>;
  post(input: {
    text: string;
  }): Promise<EnsembleToolActionResult<{ number: number; recipients: string[] }>>;
  read(input: EnsembleReadInput): Promise<EnsembleToolActionResult<EnsembleReadOutput>>;
  overview(input: unknown): Promise<EnsembleToolActionResult<EnsembleOverviewWriteOutput>>;
  changeModel(input: {
    name: string;
    model?: string | undefined;
    profile?: string | undefined;
    effort?: ReasoningEffort | undefined;
  }): Promise<EnsembleToolActionResult>;
  removeMember(input: {
    name: string;
    reason?: string | undefined;
  }): Promise<EnsembleToolActionResult>;
  end(input: {
    summary?: string | undefined;
  }): Promise<EnsembleToolActionResult<{ unmerged: EnsembleUnmergedWorktree[] }>>;
}

const ENSEMBLE_TOOL_TRAITS = {
  mutates: false,
  fileEffects: "none" as const,
  concurrencySafe: false,
  timeoutMs: 60_000,
};

const ENSEMBLE_READ_TOOL_TRAITS = {
  mutates: false,
  concurrencySafe: true,
  timeoutMs: 10_000,
  // ADR-0095 §2：工具自身以 limit（最大 50）约束帖子条数并完整返回当前成员名单；
  // 帖子正文、charter 三段与成员人数均无固定上限，无法推导固定字符上界，故不设预算截断
  maxModelChars: Number.MAX_SAFE_INTEGER,
  maxOutputChars: Number.MAX_SAFE_INTEGER,
};

export const ENSEMBLE_MAESTRO_TOOL_NAMES = [
  "ensemble_init",
  "ensemble_add_member",
  "ensemble_post",
  "ensemble_read",
  "ensemble_overview",
  "ensemble_change_model",
  "ensemble_remove_member",
  "ensemble_end",
] as const;

export function createEnsembleMaestroTools(
  handlers: EnsembleMaestroToolHandlers,
): ToolDefinition[] {
  const cat = handlers.catalog();
  const selectionAppendix = buildSelectionAppendix(cat);

  const initTool: ToolDefinition<{ title: string }> = {
    name: "ensemble_init",
    description:
      "Initialize the ensemble message board for this session with a short descriptive title. Call this once before adding members.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short title describing the ensemble objective.",
        },
      },
      required: ["title"],
      additionalProperties: false,
    },
    traits: ENSEMBLE_TOOL_TRAITS,
    permissionSubjects: () => [],
    async execute(input) {
      return toToolResult(await handlers.init(input));
    },
  };

  const addMemberTool: ToolDefinition<{
    name: string;
    charter?: Partial<EnsembleCharter>;
    model?: string;
    profile?: string;
    effort?: ReasoningEffort;
    preset?: "general" | "explore";
    isolated?: boolean;
  }> = {
    name: "ensemble_add_member",
    description: [
      "Add a persistent named member to the active ensemble and publish its public charter on the message board.",
      "- `name` must match `[a-z0-9-]+` and be unique in this ensemble (`maestro`, `all`, `user`, `runtime` are reserved). Use `<group>-1`, `<group>-2`, ... for peer groups addressable via `@<group>`.",
      "- `charter` requires all three non-empty sections: `owns`, `handsOff`, and `doneWhen`.",
      "- `model` and `profile` are mutually exclusive; omit both to use Maestro's current model. External ACP agents cannot be ensemble members.",
      '- `preset`: `"explore"` for read-only investigation, `"general"` (default) for implementation or test-running verification.',
      "- `isolated`: `false` (default) shares the main workspace; `true` creates an isolated git worktree.",
      "",
      selectionAppendix,
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Unique member name matching [a-z0-9-]+.",
        },
        charter: {
          type: "object",
          description: "Public charter with owns, handsOff, and doneWhen.",
          properties: {
            owns: { type: "string", description: "Files, modules, or scope this member owns." },
            handsOff: { type: "string", description: "Files or areas this member must not touch." },
            doneWhen: {
              type: "string",
              description: "Concrete completion criteria and required verification items.",
            },
          },
          additionalProperties: false,
        },
        model: {
          type: "string",
          description:
            "Optional enabled model (`provider/model` or model id); mutually exclusive with `profile`.",
        },
        profile: {
          type: "string",
          description: "Optional subagent profile name; mutually exclusive with `model`.",
        },
        effort: {
          type: "string",
          enum: [...REASONING_EFFORT_ORDER],
          description: "Optional reasoning effort level.",
        },
        preset: {
          type: "string",
          enum: ["general", "explore"],
          description: "Tool preset (`explore` for read-only investigation, `general` otherwise).",
        },
        isolated: {
          type: "boolean",
          description: "Set true to give this member an isolated git worktree.",
        },
      },
      required: ["name", "charter"],
      additionalProperties: false,
    },
    traits: ENSEMBLE_TOOL_TRAITS,
    permissionSubjects: () => [],
    async execute(input) {
      return toToolResult(await handlers.addMember(input));
    },
  };

  const postTool = createEnsemblePostTool((input) => handlers.post(input));
  const readTool = createEnsembleReadTool((input) => handlers.read(input));

  const overviewTool = createEnsembleOverviewTool((input) => handlers.overview(input));

  const changeModelTool: ToolDefinition<{
    name: string;
    model?: string;
    profile?: string;
    effort?: ReasoningEffort;
  }> = {
    name: "ensemble_change_model",
    description: [
      "Switch an existing ensemble member's model or profile while preserving its conversation history. If the member was paused due to a previous turn error, switching its model resumes it.",
      "`model` and `profile` are mutually exclusive; specify exactly one.",
      "",
      selectionAppendix,
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Target member name." },
        model: {
          type: "string",
          description:
            "Enabled model (`provider/model` or model id); mutually exclusive with `profile`.",
        },
        profile: {
          type: "string",
          description: "Subagent profile name; mutually exclusive with `model`.",
        },
        effort: {
          type: "string",
          enum: [...REASONING_EFFORT_ORDER],
          description: "Optional reasoning effort level.",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
    traits: ENSEMBLE_TOOL_TRAITS,
    permissionSubjects: () => [],
    async execute(input) {
      return toToolResult(await handlers.changeModel(input));
    },
  };

  const removeMemberTool: ToolDefinition<{ name: string; reason?: string }> = {
    name: "ensemble_remove_member",
    description:
      "Remove a member from the ensemble and stop its session. Removing an isolated-worktree member deletes its worktree, so it is rejected if the member has unapplied commits—call `apply_subagent_changes` first.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Member name to remove." },
        reason: { type: "string", description: "Optional short reason." },
      },
      required: ["name"],
      additionalProperties: false,
    },
    traits: ENSEMBLE_TOOL_TRAITS,
    permissionSubjects: () => [],
    async execute(input) {
      return toToolResult(await handlers.removeMember(input));
    },
  };

  const endTool: ToolDefinition<{ summary?: string }> = {
    name: "ensemble_end",
    description:
      "End the active ensemble, stop all members, clean up merged worktrees, retain any unmerged worktrees/branches, and restore normal Maestro editing tools.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Optional closing summary." },
      },
      additionalProperties: false,
    },
    traits: ENSEMBLE_TOOL_TRAITS,
    permissionSubjects: () => [],
    async execute(input) {
      return toToolResult(await handlers.end(input));
    },
  };

  return [
    initTool,
    addMemberTool,
    postTool,
    readTool,
    overviewTool,
    changeModelTool,
    removeMemberTool,
    endTool,
  ];
}

/**
 * 指挥专用的概览维护工具（ADR-0131 §3）。输入为非平凡的增量结构，
 * 深层规范化与校验在控制器内完成并一次性返回全部错误，保证失败时零写入。
 */
export function createEnsembleOverviewTool(
  update: (input: unknown) => Promise<EnsembleToolActionResult<EnsembleOverviewWriteOutput>>,
): ToolDefinition {
  const lineUpdateSchema = {
    type: "object",
    properties: {
      id: { type: "string", description: "Stable line id; reused ids update in place." },
      title: { type: "string", description: "Line title (required for new lines)." },
      owner: {
        type: "string",
        description: 'Owner: a member name or "maestro" (required for new lines).',
      },
      post: {
        type: ["integer", "null"],
        description: "Optional source post number; null clears it.",
      },
      progress: {
        type: ["object", "null"],
        description: "Current progress snapshot; null clears it.",
        properties: {
          text: { type: "string", description: "Progress summary in the ensemble's working language." },
          post: { type: "integer", description: "Optional source post number for this progress." },
          wait: { type: "boolean", description: "True when the line is blocked or waiting on someone." },
        },
        additionalProperties: false,
      },
      before: {
        type: "string",
        description:
          "Insert or move this line before the given line id. The target must already exist or appear earlier in this update's lines array. Omit to keep position (existing) or append (new).",
      },
    },
    required: ["id"],
    additionalProperties: false,
  };
  const taskUpdateSchema = {
    type: "object",
    properties: {
      id: { type: "string", description: "Stable task id; reused ids update in place (idempotent retries never duplicate)." },
      line: { type: "string", description: "Id of the line this task belongs to." },
      title: { type: "string", description: "Task title (required for new tasks)." },
      status: {
        type: "string",
        enum: ["todo", "work", "wait", "done"],
        description: "Task status (required for new tasks).",
      },
      owner: {
        type: "string",
        description: 'Owner: a member name or "maestro" (required for new tasks).',
      },
      post: {
        type: ["integer", "null"],
        description: "Optional source post number; null clears it.",
      },
    },
    required: ["id", "line"],
    additionalProperties: false,
  };
  return {
    name: "ensemble_overview",
    description: [
      "Update the ensemble overview board (goal, checkpoints, ordered work lines, and tasks) that the user sees in real time.",
      "You own this board: write the initial plan right after decomposing, and update it whenever tasks are dispatched, make progress, get blocked, or finish — including member posts you receive.",
      "- `base` is required: pass the `revision` from your latest overview read (via `ensemble_read`); use `base: 0` for the very first update. A mismatched `base` is rejected so stale updates never overwrite newer progress — read again and reapply.",
      "- Lines and tasks are upserts keyed by stable `id`: the same `id` updates in place and retries never duplicate entries. `removeLines`/`removeTasks` delete by id (removing a line also removes its tasks).",
      "- Everything validates atomically before writing: all errors are reported together and failed updates write nothing.",
      "- `post` references must point to posts that already exist on the board.",
      "- Keep it concise and current; do not cap the number of lines or tasks artificially.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        base: {
          type: "integer",
          minimum: 0,
          description:
            "The `revision` from your latest overview read; 0 before the first update. Guards against overwriting newer progress.",
        },
        goal: {
          type: ["string", "null"],
          description: "Full replacement of the ensemble goal; null clears it.",
        },
        checkpoints: {
          type: "array",
          items: { type: "string" },
          description: "Full replacement of the checkpoint list.",
        },
        lines: {
          type: "array",
          items: lineUpdateSchema,
          description: "Line upserts applied in array order.",
        },
        tasks: {
          type: "array",
          items: taskUpdateSchema,
          description: "Task upserts applied in array order.",
        },
        removeLines: {
          type: "array",
          items: { type: "string" },
          description: "Line ids to remove (their tasks are removed too).",
        },
        removeTasks: {
          type: "array",
          items: { type: "string" },
          description: "Task ids to remove.",
        },
      },
      required: ["base"],
      additionalProperties: false,
    },
    traits: ENSEMBLE_TOOL_TRAITS,
    permissionSubjects: () => [],
    async execute(input) {
      return toToolResult(await update(input));
    },
  };
}

export function createEnsemblePostTool(
  post: (input: {
    text: string;
  }) => Promise<EnsembleToolActionResult<{ number: number; recipients: string[] }>>,
): ToolDefinition<{ text: string }> {
  return {
    name: "ensemble_post",
    description:
      "Post a message to the shared ensemble message board. Mention `@name`, `@group`, `@maestro`, or `@all` in `text` to wake those recipients.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Message body including `@` mentions for intended recipients.",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
    traits: ENSEMBLE_TOOL_TRAITS,
    permissionSubjects: () => [],
    async execute(input) {
      return toToolResult(await post(input));
    },
  };
}

/** Create the read-only `ensemble_read` tool for querying the message board and current roster (ADR-0095 §2). */
export function createEnsembleReadTool(
  read: (input: EnsembleReadInput) => Promise<EnsembleToolActionResult<EnsembleReadOutput>>,
): ToolDefinition<EnsembleReadInput, EnsembleReadOutput> {
  return {
    name: "ensemble_read",
    description:
      "Read the current ensemble member roster (name, status, workspace isolation, and charter) and query historical posts on the shared message board. Optional filters (`from`, `mention`, `query`, `before`, `limit`) are combined with AND; returns up to `limit` (default 20, max 50) matching posts in ascending order and `hasMore` if earlier matches exist.",
    inputSchema: {
      type: "object",
      properties: {
        from: {
          type: "string",
          description:
            "Filter posts by author name (e.g. `maestro`, `user`, `Runtime`, or member name; leading `@` is optional).",
        },
        mention: {
          type: "string",
          description:
            "Filter posts mentioning this target (e.g. `maestro`, `all`, or member name; leading `@` is optional). Posts mentioning `@all` match every recipient.",
        },
        query: {
          type: "string",
          description: "Case-insensitive substring filter against post body text.",
        },
        before: {
          type: "integer",
          minimum: 1,
          description:
            "Pagination cursor: return only posts with number strictly less than `before`.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          description: "Maximum number of matching posts to return (default 20, max 50).",
        },
      },
      additionalProperties: false,
    },
    traits: ENSEMBLE_READ_TOOL_TRAITS,
    permissionSubjects: () => [],
    async execute(input) {
      return toToolResult(await read(input));
    },
  };
}

export function createEnsembleCheckoutTool(
  checkout: (input: { member: string }) => Promise<EnsembleToolActionResult<{ commit: string }>>,
): ToolDefinition<{ member: string }> {
  return {
    name: "ensemble_checkout",
    description:
      "Clean this isolated worktree and check out another isolated ensemble member's latest commit at detached HEAD for verification review.",
    inputSchema: {
      type: "object",
      properties: {
        member: {
          type: "string",
          description: "Name of the isolated ensemble member whose latest commit to inspect.",
        },
      },
      required: ["member"],
      additionalProperties: false,
    },
    traits: ENSEMBLE_TOOL_TRAITS,
    permissionSubjects: () => [],
    async execute(input) {
      return toToolResult(await checkout(input));
    },
  };
}
