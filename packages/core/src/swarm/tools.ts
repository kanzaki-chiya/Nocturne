/**
 * Swarm 内置工具定义（ADR-0089 §2、§3、§4）。
 * 所有给模型看的描述、参数说明与返回文本均为英文。
 */
import {
  REASONING_EFFORT_ORDER,
  subagentSelectionTable,
  swarmEnabledModelsTable,
  type ModelPricing,
  type ReasoningEffort,
  type SubagentProfileConfig,
  type SwarmCharter,
  type SwarmUnmergedWorktree,
} from "../protocol/index.js";
import type { ToolDefinition, ToolResult } from "../tools/index.js";

export interface SwarmToolOutcome<T = unknown> {
  ok: true;
  text: string;
  output?: T;
}

export interface SwarmToolFailure {
  ok: false;
  code: "invalid_input" | "swarm_error";
  message: string;
  userMessage?: string | undefined;
}

export type SwarmToolActionResult<T = unknown> = SwarmToolOutcome<T> | SwarmToolFailure;

function toToolResult<T>(res: SwarmToolActionResult<T>): ToolResult {
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

export interface SwarmModelCatalogSnapshot {
  defaultModel?: string | undefined;
  profiles: readonly (SubagentProfileConfig & {
    name: string;
    pricing?: ModelPricing | undefined;
  })[];
  enabledModels: readonly { provider: string; model: string; name?: string | undefined }[];
  pricing?: ((modelKey: string | undefined) => ModelPricing | undefined) | undefined;
}

function buildSelectionAppendix(catalog: SwarmModelCatalogSnapshot): string {
  const profilesTable = subagentSelectionTable(
    catalog.profiles,
    [],
    catalog.defaultModel,
    catalog.pricing,
  );
  const modelsTable = swarmEnabledModelsTable(catalog.enabledModels, catalog.pricing);
  return `${profilesTable}\n\n${modelsTable}`;
}

export interface SwarmCoordinatorToolHandlers {
  catalog(): SwarmModelCatalogSnapshot;
  init(input: { title: string }): Promise<SwarmToolActionResult<{ title: string }>>;
  addMember(input: {
    name: string;
    charter?: Partial<SwarmCharter> | undefined;
    model?: string | undefined;
    profile?: string | undefined;
    effort?: ReasoningEffort | undefined;
    preset?: "general" | "explore" | undefined;
    isolated?: boolean | undefined;
    agent?: string | undefined;
  }): Promise<SwarmToolActionResult>;
  post(input: {
    text: string;
  }): Promise<SwarmToolActionResult<{ number: number; recipients: string[] }>>;
  changeModel(input: {
    name: string;
    model?: string | undefined;
    profile?: string | undefined;
    effort?: ReasoningEffort | undefined;
    agent?: string | undefined;
  }): Promise<SwarmToolActionResult>;
  removeMember(input: {
    name: string;
    reason?: string | undefined;
  }): Promise<SwarmToolActionResult>;
  end(input: {
    summary?: string | undefined;
  }): Promise<SwarmToolActionResult<{ unmerged: SwarmUnmergedWorktree[] }>>;
}

const SWARM_TOOL_TRAITS = {
  mutates: false,
  fileEffects: "none" as const,
  concurrencySafe: false,
  timeoutMs: 60_000,
};

export const SWARM_COORDINATOR_TOOL_NAMES = [
  "swarm_init",
  "swarm_add_member",
  "swarm_post",
  "swarm_change_model",
  "swarm_remove_member",
  "swarm_end",
] as const;

export function createSwarmCoordinatorTools(
  handlers: SwarmCoordinatorToolHandlers,
): ToolDefinition[] {
  const cat = handlers.catalog();
  const selectionAppendix = buildSelectionAppendix(cat);

  const initTool: ToolDefinition<{ title: string }> = {
    name: "swarm_init",
    description:
      "Initialize the swarm message board for this session with a short descriptive title. Call this once before adding members.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short title describing the swarm objective.",
        },
      },
      required: ["title"],
      additionalProperties: false,
    },
    traits: SWARM_TOOL_TRAITS,
    permissionSubjects: () => [],
    async execute(input) {
      return toToolResult(await handlers.init(input));
    },
  };

  const addMemberTool: ToolDefinition<{
    name: string;
    charter?: Partial<SwarmCharter>;
    model?: string;
    profile?: string;
    effort?: ReasoningEffort;
    preset?: "general" | "explore";
    isolated?: boolean;
    agent?: string;
  }> = {
    name: "swarm_add_member",
    description: [
      "Add a persistent named member to the active swarm and publish its public charter on the message board.",
      "- `name` must match `[a-z0-9-]+` and be unique in this swarm (`coordinator`, `all`, `user`, `runtime` are reserved). Use `<group>-1`, `<group>-2`, ... for peer groups addressable via `@<group>`.",
      "- `charter` requires all three non-empty sections: `owns`, `handsOff`, and `doneWhen`.",
      "- `model` and `profile` are mutually exclusive; omit both to use the coordinator's current model. External ACP agents cannot be swarm members.",
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
            doneWhen: { type: "string", description: "Concrete completion criteria." },
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
        agent: {
          type: "string",
          description: "Unsupported: external ACP agents cannot be swarm members.",
        },
      },
      required: ["name", "charter"],
      additionalProperties: false,
    },
    traits: SWARM_TOOL_TRAITS,
    permissionSubjects: () => [],
    async execute(input) {
      return toToolResult(await handlers.addMember(input));
    },
  };

  const postTool = createSwarmPostTool((input) => handlers.post(input));

  const changeModelTool: ToolDefinition<{
    name: string;
    model?: string;
    profile?: string;
    effort?: ReasoningEffort;
    agent?: string;
  }> = {
    name: "swarm_change_model",
    description: [
      "Switch an existing swarm member's model or profile while preserving its conversation history. If the member was paused due to a previous turn error, switching its model resumes it.",
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
        agent: {
          type: "string",
          description: "Unsupported: external ACP agents cannot be swarm members.",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
    traits: SWARM_TOOL_TRAITS,
    permissionSubjects: () => [],
    async execute(input) {
      return toToolResult(await handlers.changeModel(input));
    },
  };

  const removeMemberTool: ToolDefinition<{ name: string; reason?: string }> = {
    name: "swarm_remove_member",
    description:
      "Remove a member from the swarm and stop its session. Removing an isolated-worktree member deletes its worktree, so it is rejected if the member has unapplied commits—call `apply_subagent_changes` first.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Member name to remove." },
        reason: { type: "string", description: "Optional short reason." },
      },
      required: ["name"],
      additionalProperties: false,
    },
    traits: SWARM_TOOL_TRAITS,
    permissionSubjects: () => [],
    async execute(input) {
      return toToolResult(await handlers.removeMember(input));
    },
  };

  const endTool: ToolDefinition<{ summary?: string }> = {
    name: "swarm_end",
    description:
      "End the active swarm, stop all members, clean up merged worktrees, retain any unmerged worktrees/branches, and restore normal coordinator editing tools.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Optional closing summary." },
      },
      additionalProperties: false,
    },
    traits: SWARM_TOOL_TRAITS,
    permissionSubjects: () => [],
    async execute(input) {
      return toToolResult(await handlers.end(input));
    },
  };

  return [initTool, addMemberTool, postTool, changeModelTool, removeMemberTool, endTool];
}

export function createSwarmPostTool(
  post: (input: {
    text: string;
  }) => Promise<SwarmToolActionResult<{ number: number; recipients: string[] }>>,
): ToolDefinition<{ text: string }> {
  return {
    name: "swarm_post",
    description:
      "Post a message to the shared swarm message board. Mention `@name`, `@group`, `@coordinator`, or `@all` in `text` to wake those recipients.",
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
    traits: SWARM_TOOL_TRAITS,
    permissionSubjects: () => [],
    async execute(input) {
      return toToolResult(await post(input));
    },
  };
}

export function createSwarmCheckoutTool(
  checkout: (input: { member: string }) => Promise<SwarmToolActionResult<{ commit: string }>>,
): ToolDefinition<{ member: string }> {
  return {
    name: "swarm_checkout",
    description:
      "Clean this isolated worktree and check out another isolated swarm member's latest commit at detached HEAD for verification review.",
    inputSchema: {
      type: "object",
      properties: {
        member: {
          type: "string",
          description: "Name of the isolated swarm member whose latest commit to inspect.",
        },
      },
      required: ["member"],
      additionalProperties: false,
    },
    traits: SWARM_TOOL_TRAITS,
    permissionSubjects: () => [],
    async execute(input) {
      return toToolResult(await checkout(input));
    },
  };
}
