import type { Platform } from "../platform/index.js";
import type {
  HookPoint,
  PluginMcpServerOverview,
  PluginOverview,
  PluginState,
  PluginUiSurfaceOverview,
  PluginsDescription,
} from "../protocol/index.js";
import { discoverInstalledPlugins } from "./discovery.js";
import { computePluginFingerprint } from "./fingerprint.js";
import { installLocalPluginFiles, uninstallLocalPluginFiles } from "./install.js";
import { createPluginStore } from "./store.js";
import type {
  DiscoveredPlugin,
  PluginDiscoveryOptions,
  PluginHookEntry,
  PluginHookSpec,
  PluginManifestKind,
  PluginMcpServerSpec,
  PluginSkillDir,
} from "./types.js";

export type {
  DiscoveredPlugin,
  PluginDiscoveryOptions,
  PluginHookEntry,
  PluginHookSpec,
  PluginManifestKind,
  PluginMcpServerSpec,
  PluginSkillDir,
};
export {
  comparePluginVersions,
  compareSemver,
  isValidPluginVersionDirName,
  parseSemver,
  selectActivePluginVersion,
  type SemVer,
} from "./semver.js";
export { computePluginFingerprint } from "./fingerprint.js";
export { createPluginStore, type StoredPluginEntry } from "./store.js";
export { discoverInstalledPlugins } from "./discovery.js";

export interface PluginMcpConflict {
  serverId: string;
  pluginId: string;
  pluginLabel: string;
}

export interface ActivePluginsResolution {
  plugins: PluginOverview[];
  hooks: Partial<Record<HookPoint, PluginHookEntry[]>>;
  skillDirs: PluginSkillDir[];
  mcpServers: PluginMcpServerSpec[];
  mcpConflicts: PluginMcpConflict[];
  changedPlugins: { id: string; name: string; marketplace: string }[];
  warnings: string[];
}

export function isBuiltinPlugin(plugin: { host: string; marketplace: string }): boolean {
  return plugin.host === "nocturne" && plugin.marketplace === "builtin";
}

function isBuiltinPluginId(id: string): boolean {
  return /^nocturne:[^@]+@builtin$/.test(id);
}

async function readBuiltinBuildId(platform: Platform, root: string): Promise<string | undefined> {
  try {
    const raw = await platform.fs.readTextFile(
      platform.paths.join(root, ".nocturne-plugin", "build-id"),
    );
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

export async function resolvePlugins(
  platform: Platform,
  options: PluginDiscoveryOptions,
): Promise<ActivePluginsResolution> {
  const store = createPluginStore(platform, options.nocturneHome);
  const [discovery, storeState] = await Promise.all([
    discoverInstalledPlugins(platform, options),
    store.readState(),
  ]);

  const overviews: PluginOverview[] = [];
  const hooks: Partial<Record<HookPoint, PluginHookEntry[]>> = {};
  const skillDirs: PluginSkillDir[] = [];
  const mcpServers: PluginMcpServerSpec[] = [];
  const mcpConflicts: PluginMcpConflict[] = [];
  const changedPlugins: { id: string; name: string; marketplace: string }[] = [];
  const warnings: string[] = [...discovery.warnings, ...storeState.warnings];

  const reservedLower = new Set<string>();
  for (const id of options.reservedMcpIds ?? []) {
    reservedLower.add(id.toLowerCase());
  }
  const activePluginMcpLower = new Set<string>();

  for (const item of discovery.plugins) {
    const stored = storeState.entries.get(item.overview.id);
    const pluginWarnings = [...item.overview.warnings];
    const builtin = isBuiltinPlugin(item.overview);
    let state: PluginState = "off";
    let cacheKey: PluginMcpServerSpec["cache"];

    if (builtin) {
      // 内置插件不做指纹确认，默认开启；用户关闭时在 plugins.json 记 enabled: false
      state = stored?.enabled === false ? "off" : "on";
      if (state === "on") {
        const buildId = await readBuiltinBuildId(platform, item.overview.root);
        cacheKey = {
          pluginId: item.overview.id,
          keyKind: "version",
          keyValue:
            buildId !== undefined ? `${item.overview.version}+${buildId}` : item.overview.version,
        };
      }
    } else {
      // 非内置插件：每次会话打开与每次 describePlugins 都重新计算目录指纹
      let currentHash: string | undefined;
      let hashError: string | undefined;
      try {
        currentHash = await computePluginFingerprint(
          platform.fs,
          platform.paths,
          item.overview.root,
          item.rawRoot,
        );
      } catch (e) {
        hashError = e instanceof Error ? e.message : String(e);
      }

      if (stored?.enabled === true) {
        if (currentHash !== undefined && currentHash === stored.hash) {
          state = "on";
          cacheKey = {
            pluginId: item.overview.id,
            keyKind: "fingerprint",
            keyValue: currentHash,
          };
        } else {
          state = "changed";
          if (hashError !== undefined) {
            pluginWarnings.push(`指纹校验失败：${hashError}`);
          }
          changedPlugins.push({
            id: item.overview.id,
            name: item.overview.name,
            marketplace: item.overview.marketplace,
          });
        }
      } else if (hashError !== undefined) {
        pluginWarnings.push(`无法启用（${hashError}）`);
      }
    }

    const pluginLabel = `${item.overview.name}@${item.overview.marketplace}`;
    const conflictedIds = new Set<string>();
    const overviewMcpServers: PluginMcpServerOverview[] = item.overview.mcpServers.map((m) => {
      if (m.skipped === true) return m;
      const lower = m.id.toLowerCase();
      if (reservedLower.has(lower) || (state === "on" && activePluginMcpLower.has(lower))) {
        conflictedIds.add(m.id);
        return { ...m, skipped: true, skipReason: "conflict" };
      }
      return m;
    });

    overviews.push({
      ...item.overview,
      state,
      mcpServers: overviewMcpServers,
      warnings: pluginWarnings,
    });

    if (state === "on") {
      for (const [point, entries] of Object.entries(item.hooks)) {
        const key = point as HookPoint;
        hooks[key] = [...(hooks[key] ?? []), ...entries];
      }
      skillDirs.push(...item.skillDirs);
      for (const server of item.mcpServers) {
        if (conflictedIds.has(server.id)) {
          mcpConflicts.push({
            serverId: server.id,
            pluginId: item.overview.id,
            pluginLabel,
          });
          continue;
        }
        activePluginMcpLower.add(server.id.toLowerCase());
        mcpServers.push(cacheKey !== undefined ? { ...server, cache: cacheKey } : server);
      }
    }
  }

  return {
    plugins: overviews,
    hooks,
    skillDirs,
    mcpServers,
    mcpConflicts,
    changedPlugins,
    warnings,
  };
}

export interface PluginSurfaceToolInfo {
  readonly name: string;
  readonly readOnly: boolean;
  readonly visibility: readonly ("model" | "app")[];
}

/**
 * 校验 surface.open.tool 是否指向本服务器上可被页面调用的只读工具（ADR-0101 第 4 节）。
 * 工具列表不可得时保持原样；可得但不满足时移除 open 并记录 warning。
 */
export function applyToolMetaToPluginSurfaces(
  pluginLabel: string,
  surfaces: readonly PluginUiSurfaceOverview[],
  toolsByServer: ReadonlyMap<string, readonly PluginSurfaceToolInfo[]>,
  warnings: string[],
): PluginUiSurfaceOverview[] {
  return surfaces.map((surface) => {
    if (surface.open === undefined) return surface;
    const tools = toolsByServer.get(surface.server);
    if (tools === undefined) return surface;
    const target = tools.find((t) => t.name === surface.open?.tool);
    if (target?.readOnly === true && target.visibility.includes("app")) {
      return surface;
    }
    warnings.push(
      `plugin ${pluginLabel}：ui.surfaces[${surface.id}].open.tool（${surface.open.tool}）不是可供页面调用的只读工具，已忽略文件打开配置`,
    );
    const { open: _ignored, ...rest } = surface;
    return rest;
  });
}

export async function describePlugins(
  platform: Platform,
  options: PluginDiscoveryOptions,
): Promise<PluginsDescription> {
  const res = await resolvePlugins(platform, options);
  return { plugins: res.plugins, warnings: res.warnings };
}

export async function resolveActivePluginSkillDirs(
  platform: Platform,
  options: PluginDiscoveryOptions,
): Promise<PluginSkillDir[]> {
  const store = createPluginStore(platform, options.nocturneHome);
  const storeState = await store.readState();
  if (storeState.entries.size === 0 && options.builtinPluginsDir === undefined) return [];
  const res = await resolvePlugins(platform, options);
  return res.skillDirs;
}

export async function setPluginEnabled(
  platform: Platform,
  options: PluginDiscoveryOptions & { id: string; enabled: boolean },
): Promise<void> {
  const store = createPluginStore(platform, options.nocturneHome);
  if (isBuiltinPluginId(options.id)) {
    if (!options.enabled) {
      await store.setEnabled(options.id, false, undefined, { builtin: true });
      return;
    }
    const discovery = await discoverInstalledPlugins(platform, options);
    const target = discovery.plugins.find((p) => p.overview.id === options.id);
    if (!target) {
      throw new Error(`未找到插件：${options.id}`);
    }
    await store.setEnabled(options.id, true, undefined, { builtin: true });
    return;
  }

  if (!options.enabled) {
    await store.setEnabled(options.id, false);
    return;
  }

  const discovery = await discoverInstalledPlugins(platform, options);
  const target = discovery.plugins.find((p) => p.overview.id === options.id);
  if (!target) {
    throw new Error(`未找到插件：${options.id}`);
  }
  await store.setEnabled(options.id, true, () =>
    computePluginFingerprint(platform.fs, platform.paths, target.overview.root, target.rawRoot),
  );
}

export async function installLocalPlugin(
  platform: Platform,
  options: PluginDiscoveryOptions & { path: string },
): Promise<PluginOverview> {
  return installLocalPluginFiles(platform, options, () => describePlugins(platform, options));
}

export async function uninstallPlugin(
  platform: Platform,
  options: PluginDiscoveryOptions & {
    id: string;
    onDeactivate?: () => Promise<number>;
  },
): Promise<{ affectedSessions: number }> {
  return uninstallLocalPluginFiles(platform, options);
}
