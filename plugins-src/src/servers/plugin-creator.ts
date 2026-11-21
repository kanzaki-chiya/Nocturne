import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  checkLocalPluginDirectory,
  createPlatform,
  type LocalPluginCheckResult,
} from "@nocturne/core/plugin-check";
import type { PluginMcpSkipReason, PluginUnsupportedReason } from "@nocturne/core/protocol";

import { PLUGIN_SERVER_VERSION, type PluginServerSpec } from "../shared/mcp.js";
import { assertAbsolutePath } from "../shared/paths.js";

export interface PluginCreatorServerOptions {
  /** 可选；仅测试或显式指定时传入，用于校验源目录不得位于 `<nocturneHome>/plugins/` 内 */
  nocturneHome?: string | undefined;
  /** 覆写 `${NOCTURNE_NODE}`（缺省 `process.execPath`） */
  nodePath?: string | undefined;
}

const MCP_SKIP_REASON_LABEL: Readonly<Record<PluginMcpSkipReason, string>> = {
  http: "不支持 HTTP",
  stored: "不支持凭据库",
  conflict: "与配置同名",
  invalid: "配置无效",
};

const UNSUPPORTED_REASON_LABEL: Readonly<Record<PluginUnsupportedReason, string>> = {
  point: "不支持的点位",
  type: "不支持的类型",
  async: "异步",
  user_config: "需要用户配置",
};

export interface CheckPluginSkippedEntry {
  kind: "hook" | "mcp";
  target: string;
  reason: string;
  reasonLabel: string;
}

export interface CheckPluginOutput {
  installable: boolean;
  errors: string[];
  warnings: string[];
  installTimeChecks: string[];
  pluginId?: string | undefined;
  name?: string | undefined;
  version?: string | undefined;
  manifestKind?: string | undefined;
  sourceRoot?: string | undefined;
  displayName?: string | undefined;
  description?: string | undefined;
  skills: string[];
  hooks: LocalPluginCheckResult["hooks"];
  mcpServers: (LocalPluginCheckResult["mcpServers"][number] & {
    skipReasonLabel?: string | undefined;
  })[];
  surfaces: LocalPluginCheckResult["surfaces"];
  agents: LocalPluginCheckResult["agents"];
  skipped: CheckPluginSkippedEntry[];
}

export const PLUGIN_CREATOR_TOOLS: readonly Tool[] = [
  {
    name: "check_plugin",
    description:
      "Read-only check of a local Nocturne plugin root directory using the exact same pre-install validation rules as Nocturne installation. Does not copy or modify any files.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path to the plugin root directory.",
        },
      },
      required: ["path"],
    },
  },
];

function formatCheckOutput(result: LocalPluginCheckResult): CheckPluginOutput {
  const mcpServers = result.mcpServers.map((srv) => ({
    ...srv,
    ...(srv.skipReason !== undefined
      ? { skipReasonLabel: MCP_SKIP_REASON_LABEL[srv.skipReason] }
      : {}),
  }));

  const skipped: CheckPluginSkippedEntry[] = [];
  const seenMcpTargets = new Set<string>();
  for (const srv of result.mcpServers) {
    if (srv.skipped !== true) continue;
    const target = `mcp:${srv.id}`;
    seenMcpTargets.add(target);
    const reason = srv.skipReason ?? "invalid";
    skipped.push({
      kind: "mcp",
      target,
      reason,
      reasonLabel: MCP_SKIP_REASON_LABEL[reason],
    });
  }
  for (const item of result.unsupported) {
    if (item.point.startsWith("mcp:") && seenMcpTargets.has(item.point)) continue;
    skipped.push({
      kind: item.point.startsWith("mcp:") ? "mcp" : "hook",
      target: item.point,
      reason: item.reason,
      reasonLabel: UNSUPPORTED_REASON_LABEL[item.reason],
    });
  }

  return {
    installable: result.installable,
    errors: result.errors,
    warnings: result.warnings,
    installTimeChecks: result.installTimeChecks,
    ...(result.pluginId !== undefined ? { pluginId: result.pluginId } : {}),
    ...(result.name !== undefined ? { name: result.name } : {}),
    ...(result.version !== undefined ? { version: result.version } : {}),
    ...(result.manifestKind !== undefined ? { manifestKind: result.manifestKind } : {}),
    ...(result.sourceRoot !== undefined ? { sourceRoot: result.sourceRoot } : {}),
    ...(result.displayName !== undefined ? { displayName: result.displayName } : {}),
    ...(result.description !== undefined ? { description: result.description } : {}),
    skills: result.skills,
    hooks: result.hooks,
    mcpServers,
    surfaces: result.surfaces,
    agents: result.agents,
    skipped,
  };
}

export function createPluginCreatorServer(options?: PluginCreatorServerOptions): PluginServerSpec {
  const platform = createPlatform();

  return {
    name: "nocturne-plugin-creator",
    version: PLUGIN_SERVER_VERSION,
    tools: PLUGIN_CREATOR_TOOLS,
    handlers: {
      async check_plugin(args) {
        const pluginPath = assertAbsolutePath(args.path, "path");
        const checked = await checkLocalPluginDirectory(platform, {
          path: pluginPath,
          nocturneHome: options?.nocturneHome,
          nodePath: options?.nodePath,
        });
        const output = formatCheckOutput(checked);
        return {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
          structuredContent: { ...output },
        };
      },
    },
    close: () => Promise.resolve(),
  };
}
