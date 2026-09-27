/**
 * 分层合并（config.md 第 2 节）。
 * 输入按层序排列（低层在前）；输出 ResolvedConfig。
 * - model / preset / turn.*：高层覆盖低层
 * - providers：按 id 合并，同 id 浅合并，其中 models 按模型 id 逐条合并
 * - permissions.rules：追加（高层规则排在低层之后，权限"后写优先"）
 */
import { inferShellKindFromPath } from "../platform/index.js";
import type { HookPoint, RuleOrigin } from "../protocol/index.js";
import type {
  ConfigFile,
  McpServerEntry,
  ProviderEntryConfig,
  ResolvedConfig,
  TurnOverrides,
} from "./types.js";

export interface MergeLayer {
  /**
   * 该层规则命中时的来源标注。"setup"（向导层 providers.json）不携带
   * 权限规则——其 schema 不含 permissions 段，类型上仍收窄到 RuleOrigin。
   */
  origin: Extract<RuleOrigin, "user" | "project" | "cli"> | "setup";
  file: ConfigFile;
}

function mergeProviders(
  into: Map<string, ProviderEntryConfig>,
  entries: readonly ProviderEntryConfig[],
): void {
  for (const entry of entries) {
    const existing = into.get(entry.id);
    if (existing === undefined) {
      into.set(entry.id, {
        ...entry,
        models: entry.models !== undefined ? { ...entry.models } : undefined,
      });
      continue;
    }
    into.set(entry.id, {
      ...existing,
      ...entry,
      models: { ...existing.models, ...entry.models },
      providerOptions: { ...existing.providerOptions, ...entry.providerOptions },
      headers: { ...existing.headers, ...entry.headers },
    });
  }
}

export function mergeLayers(layers: readonly MergeLayer[]): ResolvedConfig {
  const out: ResolvedConfig = {
    rules: [],
    untrustedRules: [],
    providers: [],
    turn: {},
    hooks: {},
    mcpServers: [],
    warnings: [],
  };
  const providers = new Map<string, ProviderEntryConfig>();
  const mcpServers = new Map<string, { origin: "user" | "project"; entry: McpServerEntry }>();

  for (const { origin, file } of layers) {
    if (file.model !== undefined) out.model = file.model;
    if (file.reasoningEffort !== undefined) out.reasoningEffort = file.reasoningEffort;
    // ADR-0022：config.json 的 shell/shellPath 与 model 同款后写优先；
    // 与 NOCTURNE_SHELL / settings.json 的合成优先级在装配层完成
    if (file.shell !== undefined) out.shell = file.shell;
    if (file.shellPath !== undefined) out.shellPath = file.shellPath;
    if (file.permissions?.preset !== undefined) out.permissionPreset = file.permissions.preset;
    for (const rule of file.permissions?.rules ?? []) {
      // setup 层 schema 不含 permissions 段，origin==="setup" 实际到不了这里
      out.rules.push({ rule, origin: origin === "setup" ? "user" : origin });
    }
    if (file.providers !== undefined) mergeProviders(providers, file.providers);
    // hooks：按点位追加（高层条目排在其后，hooks.md 第 2 节）
    for (const [point, entries] of Object.entries(file.hooks ?? {})) {
      const key = point as HookPoint;
      out.hooks[key] = [...(out.hooks[key] ?? []), ...entries.map((e) => ({ ...e }))];
    }
    // mcp.servers：按名字合并，同名字段浅覆盖；origin 记录定义它的层
    // （cli/env 层不产生 mcp 配置，落到 "user" 仅为类型收敛）
    for (const [name, entry] of Object.entries(file.mcp?.servers ?? {})) {
      const existing = mcpServers.get(name);
      mcpServers.set(name, {
        origin: origin === "project" ? "project" : "user",
        entry: existing === undefined ? { ...entry } : { ...existing.entry, ...entry },
      });
    }
    const t = file.turn;
    if (t !== undefined) {
      const merged: TurnOverrides = { ...out.turn };
      if (t.maxSteps !== undefined) merged.maxSteps = t.maxSteps;
      if (t.retryLimit !== undefined) merged.retryLimit = t.retryLimit;
      if (t.retryBaseDelayMs !== undefined) merged.retryBaseDelayMs = t.retryBaseDelayMs;
      if (t.firstEventTimeoutMs !== undefined) merged.firstEventTimeoutMs = t.firstEventTimeoutMs;
      if (t.idleTimeoutMs !== undefined) merged.idleTimeoutMs = t.idleTimeoutMs;
      out.turn = merged;
    }
  }
  // ADR-0022：shellPath 是给指定种类换可执行文件用的；单独存在且
  // 文件名识别不出种类时不是有效声明——忽略并警告（不静默回退自动，
  // 由下一层/自动选择接管）
  if (
    out.shellPath !== undefined &&
    out.shell === undefined &&
    inferShellKindFromPath(out.shellPath) === undefined
  ) {
    out.warnings.push(
      `配置的 shellPath="${out.shellPath}" 无法识别为支持的 shell 可执行文件，已忽略（请同时设置 shell）`,
    );
  }
  out.providers = [...providers.values()];
  out.mcpServers = [...mcpServers.entries()].map(([name, v]) => ({
    name,
    origin: v.origin,
    entry: v.entry,
  }));
  return out;
}
