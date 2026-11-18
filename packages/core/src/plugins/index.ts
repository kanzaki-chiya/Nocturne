import type { Platform } from "../platform/index.js";
import type {
  HookPoint,
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
  PluginSkillDir,
} from "./types.js";

export type {
  DiscoveredPlugin,
  PluginDiscoveryOptions,
  PluginHookEntry,
  PluginHookSpec,
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

export interface ActivePluginsResolution {
  plugins: PluginOverview[];
  hooks: Partial<Record<HookPoint, PluginHookEntry[]>>;
  skillDirs: PluginSkillDir[];
  changedPlugins: { id: string; name: string; marketplace: string }[];
  warnings: string[];
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
  const changedPlugins: { id: string; name: string; marketplace: string }[] = [];
  const warnings: string[] = [...discovery.warnings, ...storeState.warnings];

  for (const item of discovery.plugins) {
    const stored = storeState.entries.get(item.overview.id);
    const pluginWarnings = [...item.overview.warnings];
    let state: PluginState = "off";

    // 每次会话打开与每次 describePlugins 都重新计算目录指纹
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

    if (stored !== undefined) {
      if (currentHash !== undefined && currentHash === stored.hash) {
        state = "on";
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

    overviews.push({
      ...item.overview,
      state,
      warnings: pluginWarnings,
    });

    if (state === "on") {
      for (const [point, entries] of Object.entries(item.hooks)) {
        const key = point as HookPoint;
        hooks[key] = [...(hooks[key] ?? []), ...entries];
      }
      skillDirs.push(...item.skillDirs);
    }
  }

  return { plugins: overviews, hooks, skillDirs, changedPlugins, warnings };
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
  if (storeState.entries.size === 0) return [];
  const res = await resolvePlugins(platform, options);
  return res.skillDirs;
}

export async function setPluginEnabled(
  platform: Platform,
  options: PluginDiscoveryOptions & { id: string; enabled: boolean },
): Promise<void> {
  const store = createPluginStore(platform, options.nocturneHome);
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
