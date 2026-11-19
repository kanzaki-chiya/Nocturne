import type { Platform } from "../platform/index.js";
import type {
  HookPoint,
  PluginMcpServerOverview,
  PluginOverview,
  PluginState,
  PluginsDescription,
} from "../protocol/index.js";
import { discoverInstalledPlugins } from "./discovery.js";
import { computePluginFingerprint } from "./fingerprint.js";
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
        cacheKey = {
          pluginId: item.overview.id,
          keyKind: "version",
          keyValue: item.overview.version,
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
