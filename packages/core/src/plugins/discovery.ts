/**
 * 只读发现 Codex / Claude Code 已安装插件（ADR-0096 第二期）。
 * 绝不修改 `~/.codex` 或 `~/.claude` 下任何文件；解析失败降级为 warning。
 */
import { parse as parseToml } from "smol-toml";
import type { Platform } from "../platform/index.js";
import type {
  HookPoint,
  PluginHookOverview,
  PluginHost,
  PluginUnsupportedHook,
} from "../protocol/index.js";
import { parseSkill } from "../skills/index.js";
import { selectActivePluginVersion } from "./semver.js";
import {
  SUPPORTED_PLUGIN_HOOK_POINTS,
  type DiscoveredPlugin,
  type PluginDiscoveryOptions,
  type PluginHookEntry,
  type PluginSkillDir,
} from "./types.js";

const EXACT_MATCHER_RE = /^[A-Za-z0-9_\- ,|]+$/;
const DEFAULT_HOOK_TIMEOUT_MS = 60_000;
const MAX_HOOK_TIMEOUT_MS = 60_000;
const SESSION_END_DEFAULT_TIMEOUT_MS = 1_000;
const SESSION_END_MAX_TIMEOUT_MS = 3_000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function isSafeSegment(seg: string): boolean {
  return seg.length > 0 && seg !== "." && seg !== ".." && !/[\\/\0]/.test(seg);
}

function parsePluginSlug(raw: string): { name: string; marketplace: string } | undefined {
  const parts = raw.split("@");
  if (parts.length !== 2) return undefined;
  const [name, marketplace] = parts;
  if (!name || !marketplace || !isSafeSegment(name) || !isSafeSegment(marketplace)) {
    return undefined;
  }
  return { name, marketplace };
}

function normalizeTimeoutMs(point: HookPoint, rawTimeout: unknown): number {
  const defaultMs =
    point === "SessionEnd" ? SESSION_END_DEFAULT_TIMEOUT_MS : DEFAULT_HOOK_TIMEOUT_MS;
  const maxMs = point === "SessionEnd" ? SESSION_END_MAX_TIMEOUT_MS : MAX_HOOK_TIMEOUT_MS;
  if (typeof rawTimeout !== "number" || !Number.isFinite(rawTimeout) || rawTimeout <= 0) {
    return defaultMs;
  }
  return Math.min(Math.max(1, Math.round(rawTimeout * 1000)), maxMs);
}

/** 解析插件清单内相对路径：必须以 `./` 开头且不可越出插件根目录 */
async function resolvePluginRelativePath(
  platform: Platform,
  pluginRoot: string,
  pluginRootReal: string,
  rawPath: string,
): Promise<{ path?: string; error?: string }> {
  if (!rawPath.startsWith("./")) {
    return { error: `路径必须以 "./" 开头：${rawPath}` };
  }
  const { fs, paths } = platform;
  const candidate = paths.resolve(pluginRoot, rawPath);
  if (!paths.isWithin(pluginRoot, candidate)) {
    return { error: `路径越出插件目录：${rawPath}` };
  }
  if (await fs.exists(candidate)) {
    try {
      const real = await platform.resolveReal(candidate);
      if (!paths.isWithin(pluginRootReal, real)) {
        return { error: `真实路径越出插件目录：${rawPath}` };
      }
      return { path: real };
    } catch (e) {
      return { error: `路径解析失败（${rawPath}）：${e instanceof Error ? e.message : String(e)}` };
    }
  }
  return { path: candidate };
}

interface ParsedPluginHooks {
  hooks: Partial<Record<HookPoint, PluginHookEntry[]>>;
  overviewHooks: PluginHookOverview[];
  unsupported: PluginUnsupportedHook[];
}

function collectHookMap(
  eventMap: Record<string, unknown>,
  ctx: {
    host: PluginHost;
    pluginLabel: string;
    pluginRootReal: string;
    pluginDataDir: string;
    warnings: string[];
    out: ParsedPluginHooks;
  },
): void {
  const isWin = process.platform === "win32";
  for (const [pointRaw, rawGroups] of Object.entries(eventMap)) {
    if (!Array.isArray(rawGroups)) {
      ctx.warnings.push(`plugin ${ctx.pluginLabel} ${pointRaw}：hooks 组必须是数组，已忽略`);
      continue;
    }
    if (!SUPPORTED_PLUGIN_HOOK_POINTS.has(pointRaw)) {
      for (const group of rawGroups) {
        const handlers = isPlainObject(group) && Array.isArray(group.hooks) ? group.hooks : [];
        const count = Math.max(1, handlers.length);
        for (let i = 0; i < count; i++) {
          ctx.out.unsupported.push({ point: pointRaw, reason: "point" });
        }
      }
      continue;
    }

    const point = pointRaw as HookPoint;
    for (const group of rawGroups) {
      if (!isPlainObject(group) || !Array.isArray(group.hooks)) {
        ctx.warnings.push(`plugin ${ctx.pluginLabel} ${point}：无效的 hook 组，已忽略`);
        continue;
      }
      const matcher = typeof group.matcher === "string" ? group.matcher : undefined;
      if (
        (point === "SessionStart" || point === "SubagentStart") &&
        matcher !== undefined &&
        matcher !== "" &&
        matcher !== "*" &&
        !EXACT_MATCHER_RE.test(matcher)
      ) {
        try {
          new RegExp(matcher);
        } catch {
          ctx.warnings.push(
            `plugin ${ctx.pluginLabel} ${point}：无效正则 matcher "${matcher}"，已跳过`,
          );
          continue;
        }
      }

      for (const handler of group.hooks) {
        if (!isPlainObject(handler)) {
          ctx.warnings.push(`plugin ${ctx.pluginLabel} ${point}：无效的 handler，已忽略`);
          continue;
        }
        if (handler.type !== "command") {
          ctx.out.unsupported.push({ point, reason: "type" });
          continue;
        }
        if (handler.async === true) {
          ctx.out.unsupported.push({ point, reason: "async" });
          continue;
        }

        const baseCmd = typeof handler.command === "string" ? handler.command : undefined;
        const winCmd =
          typeof handler.commandWindows === "string"
            ? handler.commandWindows
            : typeof handler.command_windows === "string"
              ? handler.command_windows
              : undefined;
        const rawCommand = isWin && ctx.host === "codex" ? (winCmd ?? baseCmd) : baseCmd;
        if (rawCommand === undefined || rawCommand.trim() === "") {
          ctx.warnings.push(`plugin ${ctx.pluginLabel} ${point}：缺少 command，已跳过`);
          continue;
        }

        let rawArgs: string[] | undefined;
        if (ctx.host === "claude" && handler.args !== undefined) {
          if (!Array.isArray(handler.args) || !handler.args.every((a) => typeof a === "string")) {
            ctx.warnings.push(`plugin ${ctx.pluginLabel} ${point}：args 必须是字符串数组，已跳过`);
            continue;
          }
          rawArgs = [...handler.args];
        }

        if (
          rawCommand.includes("${user_config.") ||
          (rawArgs?.some((a) => a.includes("${user_config.")) ?? false)
        ) {
          ctx.out.unsupported.push({ point, reason: "user_config" });
          continue;
        }

        let shell: "bash" | "powershell" | undefined;
        if (ctx.host === "claude" && rawArgs === undefined && handler.shell !== undefined) {
          if (handler.shell === "bash" || handler.shell === "powershell") {
            shell = handler.shell;
          } else {
            ctx.warnings.push(
              `plugin ${ctx.pluginLabel} ${point}：不支持的 shell "${typeof handler.shell === "string" ? handler.shell : JSON.stringify(handler.shell)}"，已跳过`,
            );
            continue;
          }
        }

        const timeoutMs = normalizeTimeoutMs(point, handler.timeout);
        const displayCommand =
          rawArgs !== undefined && rawArgs.length > 0
            ? [rawCommand, ...rawArgs].join(" ")
            : rawCommand;

        const entry: PluginHookEntry = {
          ...(matcher !== undefined ? { matcher } : {}),
          command: rawCommand,
          timeoutMs,
          plugin: {
            pluginLabel: ctx.pluginLabel,
            host: ctx.host,
            pluginRoot: ctx.pluginRootReal,
            pluginDataDir: ctx.pluginDataDir,
            rawCommand,
            ...(rawArgs !== undefined ? { rawArgs } : {}),
            ...(shell !== undefined ? { shell } : {}),
          },
        };
        ctx.out.hooks[point] ??= [];
        ctx.out.hooks[point].push(entry);
        ctx.out.overviewHooks.push({
          point,
          ...(matcher !== undefined ? { matcher } : {}),
          command: displayCommand,
        });
      }
    }
  }
}

async function loadHooksFile(
  platform: Platform,
  filePath: string,
  required: boolean,
  seenPaths: Set<string>,
  ctx: Parameters<typeof collectHookMap>[1],
): Promise<void> {
  const { fs, paths } = platform;
  const key = paths.canonicalize(filePath);
  if (seenPaths.has(key)) return;
  seenPaths.add(key);

  if (!(await fs.exists(filePath))) {
    if (required) {
      ctx.warnings.push(
        `plugin ${ctx.pluginLabel}：hooks 文件不存在（${paths.basename(filePath)}）`,
      );
    }
    return;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readTextFile(filePath));
  } catch {
    ctx.warnings.push(
      `plugin ${ctx.pluginLabel}：hooks 文件不是合法 JSON（${paths.basename(filePath)}）`,
    );
    return;
  }
  if (!isPlainObject(raw)) {
    ctx.warnings.push(`plugin ${ctx.pluginLabel}：hooks 文件顶层必须是对象`);
    return;
  }
  // 没有 `hooks` 键的文件（如 claude-band.json）静默跳过，不报警告
  if (!Object.hasOwn(raw, "hooks") || raw.hooks === undefined) {
    return;
  }
  if (!isPlainObject(raw.hooks)) {
    ctx.warnings.push(`plugin ${ctx.pluginLabel}：hooks 字段必须是对象`);
    return;
  }
  collectHookMap(raw.hooks, ctx);
}

async function scanSkillNamesInDir(
  platform: Platform,
  dirPath: string,
  warnings: string[],
  pluginLabel: string,
): Promise<string[]> {
  const { fs, paths } = platform;
  if (!(await fs.exists(dirPath))) return [];
  const names: string[] = [];
  const directSkill = paths.join(dirPath, "SKILL.md");
  if (await fs.exists(directSkill)) {
    try {
      const { fields } = parseSkill(await fs.readTextFile(directSkill), paths.basename(dirPath));
      names.push(String(fields.name));
    } catch (e) {
      warnings.push(
        `plugin ${pluginLabel} 技能解析失败：${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return names;
  }

  let entries;
  try {
    entries = await fs.readdir(dirPath);
  } catch {
    return [];
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.type !== "directory" && entry.type !== "symlink") continue;
    const skillFile = paths.join(entry.path, "SKILL.md");
    if (!(await fs.exists(skillFile))) continue;
    try {
      const { fields } = parseSkill(await fs.readTextFile(skillFile), entry.name);
      names.push(String(fields.name));
    } catch (e) {
      warnings.push(
        `plugin ${pluginLabel} 技能 ${entry.name} 解析失败：${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return names;
}

async function buildDiscoveredPlugin(
  platform: Platform,
  input: {
    host: PluginHost;
    name: string;
    marketplace: string;
    version: string;
    rawRoot: string;
    nocturneHome: string;
    manifest?: Record<string, unknown> | undefined;
    manifestWarnings?: string[] | undefined;
  },
): Promise<DiscoveredPlugin> {
  const { fs, paths } = platform;
  const pluginRootReal = await platform.resolveReal(input.rawRoot);
  const pluginLabel = `${input.name}@${input.marketplace}`;
  const id = `${input.host}:${pluginLabel}`;
  const pluginDataDir = paths.join(
    input.nocturneHome,
    "plugins",
    "data",
    `${input.name}-${input.marketplace}`,
  );
  const warnings: string[] = [...(input.manifestWarnings ?? [])];
  const manifest = input.manifest ?? {};

  const iface = isPlainObject(manifest.interface) ? manifest.interface : undefined;
  const displayName = nonEmptyString(iface?.displayName) ?? nonEmptyString(manifest.displayName);
  const description =
    nonEmptyString(manifest.description) ??
    nonEmptyString(iface?.shortDescription) ??
    nonEmptyString(iface?.longDescription);
  const version = input.version !== "" ? input.version : (nonEmptyString(manifest.version) ?? "");

  // ── Hooks 解析 ─────────────────────────────────────────
  const parsedHooks: ParsedPluginHooks = {
    hooks: {},
    overviewHooks: [],
    unsupported: [],
  };
  const hookCtx = {
    host: input.host,
    pluginLabel,
    pluginRootReal,
    pluginDataDir,
    warnings,
    out: parsedHooks,
  };
  const seenHookFiles = new Set<string>();
  const defaultHooksPath = paths.join(pluginRootReal, "hooks", "hooks.json");

  if (input.host === "claude") {
    // Claude Code 官方文档：hooks/hooks.json 与清单 hooks 字段合并加载
    await loadHooksFile(platform, defaultHooksPath, false, seenHookFiles, hookCtx);
  }

  const manifestHooks = manifest.hooks;
  if (manifestHooks !== undefined) {
    const items = Array.isArray(manifestHooks) ? manifestHooks : [manifestHooks];
    for (const item of items) {
      if (typeof item === "string") {
        const resolved = await resolvePluginRelativePath(
          platform,
          input.rawRoot,
          pluginRootReal,
          item,
        );
        if (resolved.error !== undefined || resolved.path === undefined) {
          warnings.push(`plugin ${pluginLabel}：${resolved.error ?? "无效 hooks 路径"}`);
          continue;
        }
        await loadHooksFile(platform, resolved.path, true, seenHookFiles, hookCtx);
      } else if (isPlainObject(item)) {
        collectHookMap(item, hookCtx);
      } else {
        warnings.push(`plugin ${pluginLabel}：hooks 字段元素必须是相对路径或对象`);
      }
    }
  } else if (input.host === "codex") {
    await loadHooksFile(platform, defaultHooksPath, false, seenHookFiles, hookCtx);
  }

  // ── Skills 目录解析 ────────────────────────────────────
  const skillDirs: PluginSkillDir[] = [];
  const skillNames: string[] = [];
  const seenSkillDirs = new Set<string>();

  const addSkillDir = async (dirPath: string) => {
    const canonical = paths.canonicalize(dirPath);
    if (seenSkillDirs.has(canonical)) return;
    seenSkillDirs.add(canonical);
    if (!(await fs.exists(dirPath))) return;
    skillDirs.push({ path: dirPath, plugin: pluginLabel });
    const names = await scanSkillNamesInDir(platform, dirPath, warnings, pluginLabel);
    for (const n of names) {
      if (!skillNames.includes(n)) skillNames.push(n);
    }
  };

  if (manifest.skills !== undefined) {
    const rawSkillPaths = Array.isArray(manifest.skills)
      ? manifest.skills
      : typeof manifest.skills === "string"
        ? [manifest.skills]
        : [];
    if (!Array.isArray(manifest.skills) && typeof manifest.skills !== "string") {
      warnings.push(`plugin ${pluginLabel}：skills 字段必须是字符串或字符串数组`);
    }
    for (const rawSkillPath of rawSkillPaths) {
      if (typeof rawSkillPath !== "string") {
        warnings.push(`plugin ${pluginLabel}：skills 路径必须是字符串`);
        continue;
      }
      const resolved = await resolvePluginRelativePath(
        platform,
        input.rawRoot,
        pluginRootReal,
        rawSkillPath,
      );
      if (resolved.error !== undefined || resolved.path === undefined) {
        warnings.push(`plugin ${pluginLabel}：${resolved.error ?? "无效 skills 路径"}`);
        continue;
      }
      await addSkillDir(resolved.path);
    }
  } else {
    const defaultSkillsDir = paths.join(pluginRootReal, "skills");
    if (await fs.exists(defaultSkillsDir)) {
      const realSkills = await platform.resolveReal(defaultSkillsDir);
      if (paths.isWithin(pluginRootReal, realSkills)) {
        await addSkillDir(realSkills);
      } else {
        warnings.push(`plugin ${pluginLabel}：默认 skills/ 目录越出插件根目录`);
      }
    }
  }

  return {
    rawRoot: input.rawRoot,
    hooks: parsedHooks.hooks,
    skillDirs,
    overview: {
      id,
      host: input.host,
      name: input.name,
      marketplace: input.marketplace,
      version,
      root: pluginRootReal,
      ...(displayName !== undefined ? { displayName } : {}),
      ...(description !== undefined ? { description } : {}),
      hooks: parsedHooks.overviewHooks,
      unsupported: parsedHooks.unsupported,
      skills: skillNames,
      warnings,
    },
  };
}

async function readManifestFile(
  platform: Platform,
  manifestPath: string,
  warnings: string[],
  pluginLabel: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await platform.fs.readTextFile(manifestPath));
    if (!isPlainObject(parsed)) {
      warnings.push(`plugin ${pluginLabel}：清单不是 JSON 对象`);
      return undefined;
    }
    return parsed;
  } catch {
    warnings.push(`plugin ${pluginLabel}：清单不是合法 JSON`);
    return undefined;
  }
}

async function discoverCodexPlugins(
  platform: Platform,
  codexHome: string,
  nocturneHome: string,
  warnings: string[],
): Promise<DiscoveredPlugin[]> {
  const { fs, paths } = platform;
  const configPath = paths.join(codexHome, "config.toml");
  if (!(await fs.exists(configPath))) return [];

  let parsed: Record<string, unknown>;
  try {
    const text = await fs.readTextFile(configPath);
    const result: unknown = parseToml(text);
    if (!isPlainObject(result)) {
      warnings.push(`codex_config_invalid：${configPath} 顶层不是 TOML 表，已忽略`);
      return [];
    }
    parsed = result;
  } catch {
    warnings.push(`codex_config_invalid：${configPath} 解析失败，已忽略`);
    return [];
  }

  if (!isPlainObject(parsed.plugins)) return [];
  const results: DiscoveredPlugin[] = [];

  for (const [rawId, value] of Object.entries(parsed.plugins)) {
    if (!isPlainObject(value) || value.enabled !== true) continue;
    const slug = parsePluginSlug(rawId);
    if (!slug) {
      warnings.push(`codex_plugin_invalid：插件标识 "${rawId}" 非法，已跳过`);
      continue;
    }
    const cacheParent = paths.join(codexHome, "plugins", "cache", slug.marketplace, slug.name);
    if (!(await fs.exists(cacheParent))) continue;

    let entries;
    try {
      entries = await fs.readdir(cacheParent);
    } catch {
      continue;
    }
    const version = selectActivePluginVersion(entries);
    if (version === undefined) continue;

    const rawRoot = paths.join(cacheParent, version);
    const manifestWarnings: string[] = [];
    const codexManifestPath = paths.join(rawRoot, ".codex-plugin", "plugin.json");
    const claudeManifestPath = paths.join(rawRoot, ".claude-plugin", "plugin.json");
    let manifest: Record<string, unknown> | undefined;
    if (await fs.exists(codexManifestPath)) {
      manifest = await readManifestFile(platform, codexManifestPath, manifestWarnings, rawId);
    } else if (await fs.exists(claudeManifestPath)) {
      manifest = await readManifestFile(platform, claudeManifestPath, manifestWarnings, rawId);
    } else {
      // 既无 .codex-plugin/plugin.json 也无 .claude-plugin/plugin.json；根目录 plugin.json 不算清单
      continue;
    }

    results.push(
      await buildDiscoveredPlugin(platform, {
        host: "codex",
        name: slug.name,
        marketplace: slug.marketplace,
        version,
        rawRoot,
        nocturneHome,
        manifest,
        manifestWarnings,
      }),
    );
  }

  return results;
}

async function discoverClaudePlugins(
  platform: Platform,
  claudeHome: string,
  nocturneHome: string,
  warnings: string[],
): Promise<DiscoveredPlugin[]> {
  const { fs, paths } = platform;
  const installedPath = paths.join(claudeHome, "plugins", "installed_plugins.json");
  const settingsPath = paths.join(claudeHome, "settings.json");

  if (!(await fs.exists(installedPath)) || !(await fs.exists(settingsPath))) {
    return [];
  }

  // 只摘取 installed_plugins.json 中 scope === "user" 的 installPath，其余字段不留存内存或日志
  const installedPaths = new Map<string, string>();
  try {
    const raw: unknown = JSON.parse(await fs.readTextFile(installedPath));
    if (!isPlainObject(raw) || !isPlainObject(raw.plugins)) {
      warnings.push(`claude_plugins_invalid：${installedPath} 格式无效，已忽略`);
      return [];
    }
    for (const [id, list] of Object.entries(raw.plugins)) {
      if (!Array.isArray(list)) continue;
      for (const entry of list) {
        if (
          isPlainObject(entry) &&
          entry.scope === "user" &&
          typeof entry.installPath === "string" &&
          entry.installPath.trim() !== ""
        ) {
          installedPaths.set(id, entry.installPath);
          break;
        }
      }
    }
  } catch {
    warnings.push(`claude_plugins_invalid：${installedPath} 解析失败，已忽略`);
    return [];
  }

  // 只摘取 settings.json 的 enabledPlugins[id] === true，其余字段不留存内存或日志
  const enabledIds = new Set<string>();
  try {
    const raw: unknown = JSON.parse(await fs.readTextFile(settingsPath));
    if (!isPlainObject(raw)) {
      warnings.push(`claude_settings_invalid：${settingsPath} 格式无效，已忽略`);
      return [];
    }
    if (isPlainObject(raw.enabledPlugins)) {
      for (const [id, flag] of Object.entries(raw.enabledPlugins)) {
        if (flag === true) enabledIds.add(id);
      }
    }
  } catch {
    warnings.push(`claude_settings_invalid：${settingsPath} 解析失败，已忽略`);
    return [];
  }

  const results: DiscoveredPlugin[] = [];
  for (const rawId of enabledIds) {
    const slug = parsePluginSlug(rawId);
    if (!slug) {
      warnings.push(`claude_plugin_invalid：插件标识 "${rawId}" 非法，已跳过`);
      continue;
    }
    const installPath = installedPaths.get(rawId);
    if (installPath === undefined) continue;
    if (!(await fs.exists(installPath))) {
      warnings.push(`claude_plugin_missing：插件 ${rawId} 安装目录不存在，已跳过`);
      continue;
    }

    const manifestWarnings: string[] = [];
    const manifestPath = paths.join(installPath, ".claude-plugin", "plugin.json");
    const manifest = (await fs.exists(manifestPath))
      ? await readManifestFile(platform, manifestPath, manifestWarnings, rawId)
      : undefined;

    results.push(
      await buildDiscoveredPlugin(platform, {
        host: "claude",
        name: slug.name,
        marketplace: slug.marketplace,
        version: "",
        rawRoot: installPath,
        nocturneHome,
        manifest,
        manifestWarnings,
      }),
    );
  }

  return results;
}

export async function discoverInstalledPlugins(
  platform: Platform,
  options: PluginDiscoveryOptions,
): Promise<{ plugins: DiscoveredPlugin[]; warnings: string[] }> {
  const { paths } = platform;
  const codexHome =
    nonEmptyString(options.codexHome) ??
    nonEmptyString(platform.env("CODEX_HOME")) ??
    paths.join(platform.homeDir(), ".codex");
  const claudeHome =
    nonEmptyString(options.claudeHome) ??
    nonEmptyString(platform.env("CLAUDE_CONFIG_DIR")) ??
    paths.join(platform.homeDir(), ".claude");

  const warnings: string[] = [];
  const [codex, claude] = await Promise.all([
    discoverCodexPlugins(platform, codexHome, options.nocturneHome, warnings),
    discoverClaudePlugins(platform, claudeHome, options.nocturneHome, warnings),
  ]);

  const plugins = [...codex, ...claude].sort((a, b) =>
    a.overview.id < b.overview.id ? -1 : a.overview.id > b.overview.id ? 1 : 0,
  );
  return { plugins, warnings };
}
