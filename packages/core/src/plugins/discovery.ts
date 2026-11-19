/**
 * 只读发现 Codex / Claude Code 已安装插件（ADR-0096 第二期）。
 * 绝不修改 `~/.codex` 或 `~/.claude` 下任何文件；解析失败降级为 warning。
 */
import { parse as parseToml } from "smol-toml";
import { MCP_ID, mcpEntrySchema } from "../config/schema.js";
import type { Platform } from "../platform/index.js";
import {
  HOOK_POINTS,
  type HookPoint,
  type McpServerEntry,
  type PluginHookOverview,
  type PluginHost,
  type PluginMcpServerOverview,
  type PluginUnsupportedHook,
} from "../protocol/index.js";
import { parseSkill } from "../skills/index.js";
import { selectActivePluginVersion } from "./semver.js";
import {
  SUPPORTED_PLUGIN_HOOK_POINTS,
  type DiscoveredPlugin,
  type PluginDiscoveryOptions,
  type PluginHookEntry,
  type PluginManifestKind,
  type PluginMcpServerSpec,
  type PluginSkillDir,
} from "./types.js";

const EXACT_MATCHER_RE = /^[A-Za-z0-9_\- ,|]+$/;
const NATIVE_PLUGIN_NAME_RE = /^[a-z0-9-]+$/;
const MCP_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MCP_PLACEHOLDER_RE = /\$\{(PLUGIN_ROOT|PLUGIN_DATA|NOCTURNE_NODE)\}/g;
const ALL_HOOK_POINTS: ReadonlySet<string> = new Set<string>(HOOK_POINTS);
const NATIVE_DEFAULT_HOOK_TIMEOUT_MS = 5_000;
const DEFAULT_HOOK_TIMEOUT_MS = 60_000;
const MAX_HOOK_TIMEOUT_MS = 60_000;
const SESSION_END_DEFAULT_TIMEOUT_MS = 1_000;
const SESSION_END_MAX_TIMEOUT_MS = 3_000;
const MAX_PLUGIN_ICON_BYTES = 64 * 1024;
/** Codex 自带系统市场：包含 Codex 专用运行时/界面能力，发现阶段跳过 */
const CODEX_SYSTEM_MARKETPLACES: ReadonlySet<string> = new Set([
  "openai-bundled",
  "openai-primary-runtime",
]);
const PLUGIN_ICON_MIME: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};
const SVG_START_RE =
  /^\s*(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[\s\S]*?>\s*)*<svg[\s>]/i;

function iconExtension(filePath: string): string {
  const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  const dot = filePath.lastIndexOf(".");
  if (dot <= slash) return "";
  return filePath.slice(dot).toLowerCase();
}

function matchesIconMagic(mime: string, bytes: Uint8Array): boolean {
  if (mime === "image/png") {
    return (
      bytes.byteLength >= 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    );
  }
  if (mime === "image/jpeg") {
    return bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mime === "image/webp") {
    return (
      bytes.byteLength >= 12 &&
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    );
  }
  if (mime === "image/svg+xml") {
    const text = Buffer.from(bytes)
      .toString("utf8")
      .replace(/^\uFEFF/, "");
    return SVG_START_RE.test(text);
  }
  return false;
}

async function tryReadPluginIcon(
  platform: Platform,
  pluginRoot: string,
  pluginRootReal: string,
  rawPath: unknown,
): Promise<string | undefined> {
  const rel = nonEmptyString(rawPath);
  if (rel === undefined || rel.includes("\0")) return undefined;
  const { fs, paths } = platform;
  if (
    paths.isAbsolute(rel) ||
    /^[A-Za-z]:/.test(rel) ||
    rel.startsWith("/") ||
    rel.startsWith("\\")
  ) {
    return undefined;
  }
  const candidate = paths.resolve(pluginRoot, rel);
  if (!paths.isWithin(pluginRoot, candidate) || paths.equals(pluginRoot, candidate)) {
    return undefined;
  }
  const mime = PLUGIN_ICON_MIME[iconExtension(candidate)];
  if (mime === undefined) return undefined;
  try {
    if (!(await fs.exists(candidate))) return undefined;
    const real = await platform.resolveReal(candidate);
    if (!paths.isWithin(pluginRootReal, real) || paths.equals(pluginRootReal, real)) {
      return undefined;
    }
    const stat = await fs.stat(real);
    if (stat.type !== "file" || stat.size <= 0 || stat.size > MAX_PLUGIN_ICON_BYTES) {
      return undefined;
    }
    const bytes = await fs.readFile(real);
    if (bytes.byteLength <= 0 || bytes.byteLength > MAX_PLUGIN_ICON_BYTES) {
      return undefined;
    }
    if (!matchesIconMagic(mime, bytes)) return undefined;
    return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
  } catch {
    return undefined;
  }
}

async function readPluginIcon(
  platform: Platform,
  pluginRoot: string,
  pluginRootReal: string,
  iface: Record<string, unknown> | undefined,
): Promise<string | undefined> {
  if (!iface) return undefined;
  for (const raw of [iface.composerIcon, iface.logo]) {
    const uri = await tryReadPluginIcon(platform, pluginRoot, pluginRootReal, raw);
    if (uri !== undefined) return uri;
  }
  return undefined;
}

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

function normalizeNativeTimeoutMs(rawTimeoutMs: unknown, rawTimeoutSec: unknown): number {
  if (typeof rawTimeoutMs === "number" && Number.isFinite(rawTimeoutMs) && rawTimeoutMs > 0) {
    return Math.min(Math.max(1, Math.round(rawTimeoutMs)), MAX_HOOK_TIMEOUT_MS);
  }
  if (typeof rawTimeoutSec === "number" && Number.isFinite(rawTimeoutSec) && rawTimeoutSec > 0) {
    return Math.min(Math.max(1, Math.round(rawTimeoutSec * 1000)), MAX_HOOK_TIMEOUT_MS);
  }
  return NATIVE_DEFAULT_HOOK_TIMEOUT_MS;
}

function expandMcpPlaceholders(
  raw: string,
  vars: { pluginRoot: string; pluginDataDir: string; nodePath: string },
): string {
  return raw.replace(MCP_PLACEHOLDER_RE, (match, key: string) => {
    switch (key) {
      case "PLUGIN_ROOT":
        return vars.pluginRoot;
      case "PLUGIN_DATA":
        return vars.pluginDataDir;
      case "NOCTURNE_NODE":
        return vars.nodePath;
      default:
        return match;
    }
  });
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

interface ParsedPluginMcp {
  servers: PluginMcpServerSpec[];
  overviewServers: PluginMcpServerOverview[];
  seenIds: Set<string>;
}

function collectHookMap(
  eventMap: Record<string, unknown>,
  ctx: {
    host: PluginHost;
    manifestKind: PluginManifestKind;
    pluginLabel: string;
    pluginRootReal: string;
    pluginDataDir: string;
    warnings: string[];
    out: ParsedPluginHooks;
  },
): void {
  const isWin = process.platform === "win32";
  const isNative = ctx.manifestKind === "nocturne";
  const allowedPoints = isNative ? ALL_HOOK_POINTS : SUPPORTED_PLUGIN_HOOK_POINTS;
  const compatHost: "codex" | "claude" | undefined =
    ctx.manifestKind === "nocturne" ? undefined : ctx.manifestKind;

  for (const [pointRaw, rawGroups] of Object.entries(eventMap)) {
    if (!Array.isArray(rawGroups)) {
      ctx.warnings.push(`plugin ${ctx.pluginLabel} ${pointRaw}：hooks 组必须是数组，已忽略`);
      continue;
    }
    if (!allowedPoints.has(pointRaw)) {
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
      if (!isPlainObject(group)) {
        ctx.warnings.push(`plugin ${ctx.pluginLabel} ${point}：无效的 hook 组，已忽略`);
        continue;
      }

      // 自有清单同时支持 Nocturne 直接条目 `{ command, args?, matcher?, timeoutMs? }`
      // 与 Claude 分组形式 `{ matcher?, hooks: [...] }`
      let matcher: string | undefined;
      let handlers: unknown[];
      if (Array.isArray(group.hooks)) {
        matcher = typeof group.matcher === "string" ? group.matcher : undefined;
        handlers = group.hooks;
      } else if (isNative && typeof group.command === "string") {
        matcher = typeof group.matcher === "string" ? group.matcher : undefined;
        handlers = [group];
      } else {
        ctx.warnings.push(`plugin ${ctx.pluginLabel} ${point}：无效的 hook 组，已忽略`);
        continue;
      }

      if (
        !isNative &&
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

      for (const handler of handlers) {
        if (!isPlainObject(handler)) {
          ctx.warnings.push(`plugin ${ctx.pluginLabel} ${point}：无效的 handler，已忽略`);
          continue;
        }
        if (isNative) {
          if (handler.type !== undefined && handler.type !== "command") {
            ctx.out.unsupported.push({ point, reason: "type" });
            continue;
          }
        } else if (handler.type !== "command") {
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
        const rawCommand = isWin && compatHost === "codex" ? (winCmd ?? baseCmd) : baseCmd;
        if (rawCommand === undefined || rawCommand.trim() === "") {
          ctx.warnings.push(`plugin ${ctx.pluginLabel} ${point}：缺少 command，已跳过`);
          continue;
        }

        let rawArgs: string[] | undefined;
        if ((isNative || compatHost === "claude") && handler.args !== undefined) {
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
        if (compatHost === "claude" && rawArgs === undefined && handler.shell !== undefined) {
          if (handler.shell === "bash" || handler.shell === "powershell") {
            shell = handler.shell;
          } else {
            ctx.warnings.push(
              `plugin ${ctx.pluginLabel} ${point}：不支持的 shell "${typeof handler.shell === "string" ? handler.shell : JSON.stringify(handler.shell)}"，已跳过`,
            );
            continue;
          }
        }

        const timeoutMs = isNative
          ? normalizeNativeTimeoutMs(handler.timeoutMs, handler.timeout)
          : normalizeTimeoutMs(point, handler.timeout);
        const displayCommand =
          rawArgs !== undefined && rawArgs.length > 0
            ? [rawCommand, ...rawArgs].join(" ")
            : rawCommand;

        const entry: PluginHookEntry = {
          ...(matcher !== undefined ? { matcher } : {}),
          command: rawCommand,
          ...(isNative && rawArgs !== undefined ? { args: rawArgs } : {}),
          timeoutMs,
          plugin: {
            pluginLabel: ctx.pluginLabel,
            host: ctx.host,
            mode: isNative ? "native" : "compat",
            ...(compatHost !== undefined ? { compatHost } : {}),
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
  if (Object.hasOwn(raw, "hooks") && raw.hooks !== undefined) {
    if (!isPlainObject(raw.hooks)) {
      ctx.warnings.push(`plugin ${ctx.pluginLabel}：hooks 字段必须是对象`);
      return;
    }
    collectHookMap(raw.hooks, ctx);
    return;
  }
  // 自有清单的 hooks 文件也允许顶层直接以事件点为键；无事件点键（如 claude-band.json）静默跳过
  if (ctx.manifestKind === "nocturne" && Object.keys(raw).some((k) => ALL_HOOK_POINTS.has(k))) {
    collectHookMap(raw, ctx);
  }
}

function collectMcpMap(
  serversMap: Record<string, unknown>,
  ctx: {
    pluginId: string;
    pluginLabel: string;
    pluginRootReal: string;
    pluginDataDir: string;
    nodePath: string;
    warnings: string[];
    unsupported: PluginUnsupportedHook[];
    out: ParsedPluginMcp;
  },
): void {
  const vars = {
    pluginRoot: ctx.pluginRootReal,
    pluginDataDir: ctx.pluginDataDir,
    nodePath: ctx.nodePath,
  };
  for (const [serverId, rawEntry] of Object.entries(serversMap)) {
    if (ctx.out.seenIds.has(serverId)) continue;
    ctx.out.seenIds.add(serverId);

    if (!MCP_ID.test(serverId)) {
      ctx.warnings.push(`plugin ${ctx.pluginLabel} MCP ${serverId}：服务器名称无效，已跳过`);
      ctx.out.overviewServers.push({ id: serverId, skipped: true, skipReason: "invalid" });
      continue;
    }
    if (!isPlainObject(rawEntry)) {
      ctx.warnings.push(`plugin ${ctx.pluginLabel} MCP ${serverId}：服务器配置必须是对象，已跳过`);
      ctx.out.overviewServers.push({ id: serverId, skipped: true, skipReason: "invalid" });
      continue;
    }

    if (rawEntry.type === "http") {
      ctx.unsupported.push({ point: `mcp:${serverId}`, reason: "type" });
      const urlSummary = nonEmptyString(rawEntry.url);
      ctx.out.overviewServers.push({
        id: serverId,
        ...(urlSummary !== undefined ? { command: urlSummary } : {}),
        skipped: true,
        skipReason: "http",
      });
      continue;
    }
    if (rawEntry.type !== undefined && rawEntry.type !== "stdio") {
      ctx.unsupported.push({ point: `mcp:${serverId}`, reason: "type" });
      ctx.out.overviewServers.push({ id: serverId, skipped: true, skipReason: "invalid" });
      continue;
    }

    const rawCmd = nonEmptyString(rawEntry.command);
    const rawArgs =
      Array.isArray(rawEntry.args) && rawEntry.args.every((a) => typeof a === "string")
        ? rawEntry.args
        : undefined;
    const commandSummary =
      rawCmd !== undefined
        ? rawArgs !== undefined && rawArgs.length > 0
          ? [rawCmd, ...rawArgs].join(" ")
          : rawCmd
        : undefined;

    if (
      isPlainObject(rawEntry.env) &&
      Object.values(rawEntry.env).some((v) => isPlainObject(v) && Object.hasOwn(v, "stored"))
    ) {
      ctx.warnings.push(
        `plugin ${ctx.pluginLabel} MCP ${serverId}：插件不能声明 { stored: true } 凭据，已跳过`,
      );
      ctx.out.overviewServers.push({
        id: serverId,
        ...(commandSummary !== undefined ? { command: commandSummary } : {}),
        skipped: true,
        skipReason: "stored",
      });
      continue;
    }

    const parsed = mcpEntrySchema(false).safeParse(rawEntry);
    if (!parsed.success || parsed.data.type === "http") {
      ctx.warnings.push(`plugin ${ctx.pluginLabel} MCP ${serverId}：服务器配置无效，已跳过`);
      ctx.out.overviewServers.push({
        id: serverId,
        ...(commandSummary !== undefined ? { command: commandSummary } : {}),
        skipped: true,
        skipReason: "invalid",
      });
      continue;
    }

    const envEntries = parsed.data.env;
    if (envEntries !== undefined) {
      const badEnvKey = Object.keys(envEntries).find((k) => !MCP_ENV_NAME_RE.test(k));
      if (badEnvKey !== undefined) {
        ctx.warnings.push(
          `plugin ${ctx.pluginLabel} MCP ${serverId}：环境变量名 "${badEnvKey}" 无效，已跳过`,
        );
        ctx.out.overviewServers.push({
          id: serverId,
          ...(commandSummary !== undefined ? { command: commandSummary } : {}),
          skipped: true,
          skipReason: "invalid",
        });
        continue;
      }
    }

    const expandedCommand = expandMcpPlaceholders(parsed.data.command, vars);
    const expandedArgs = parsed.data.args?.map((arg) => expandMcpPlaceholders(arg, vars));
    const expandedEnv =
      envEntries !== undefined
        ? Object.fromEntries(
            Object.entries(envEntries).map(([k, v]) => [
              k,
              typeof v === "string" ? expandMcpPlaceholders(v, vars) : v,
            ]),
          )
        : undefined;
    const expandedCwd =
      parsed.data.cwd !== undefined ? expandMcpPlaceholders(parsed.data.cwd, vars) : undefined;

    const entry: McpServerEntry = {
      ...parsed.data,
      command: expandedCommand,
      ...(expandedArgs !== undefined ? { args: expandedArgs } : {}),
      ...(expandedEnv !== undefined ? { env: expandedEnv } : {}),
      ...(expandedCwd !== undefined ? { cwd: expandedCwd } : {}),
    };

    ctx.out.servers.push({
      id: serverId,
      pluginId: ctx.pluginId,
      pluginLabel: ctx.pluginLabel,
      pluginRoot: ctx.pluginRootReal,
      pluginDataDir: ctx.pluginDataDir,
      entry,
    });
    ctx.out.overviewServers.push({
      id: serverId,
      ...(commandSummary !== undefined ? { command: commandSummary } : {}),
    });
  }
}

async function loadMcpFile(
  platform: Platform,
  filePath: string,
  required: boolean,
  seenPaths: Set<string>,
  ctx: Parameters<typeof collectMcpMap>[1],
): Promise<void> {
  const { fs, paths } = platform;
  const key = paths.canonicalize(filePath);
  if (seenPaths.has(key)) return;
  seenPaths.add(key);

  if (!(await fs.exists(filePath))) {
    if (required) {
      ctx.warnings.push(
        `plugin ${ctx.pluginLabel}：mcpServers 文件不存在（${paths.basename(filePath)}）`,
      );
    }
    return;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readTextFile(filePath));
  } catch {
    ctx.warnings.push(
      `plugin ${ctx.pluginLabel}：mcpServers 文件不是合法 JSON（${paths.basename(filePath)}）`,
    );
    return;
  }
  if (!isPlainObject(raw)) {
    ctx.warnings.push(`plugin ${ctx.pluginLabel}：mcpServers 文件顶层必须是对象`);
    return;
  }
  if (Object.hasOwn(raw, "mcpServers") && raw.mcpServers !== undefined) {
    if (!isPlainObject(raw.mcpServers)) {
      ctx.warnings.push(`plugin ${ctx.pluginLabel}：mcpServers 字段必须是对象`);
      return;
    }
    collectMcpMap(raw.mcpServers, ctx);
    return;
  }
  if (Object.keys(raw).length === 0) return;
  const looksLikeServerMap = Object.values(raw).some(
    (v) => isPlainObject(v) && ("command" in v || "url" in v || "type" in v),
  );
  if (looksLikeServerMap) {
    collectMcpMap(raw, ctx);
  } else if (required) {
    ctx.warnings.push(`plugin ${ctx.pluginLabel}：mcpServers 文件缺少 mcpServers 对象`);
  }
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
    manifestKind: PluginManifestKind;
    name: string;
    marketplace: string;
    version: string;
    rawRoot: string;
    nocturneHome: string;
    nodePath: string;
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
  const icon = await readPluginIcon(platform, input.rawRoot, pluginRootReal, iface);

  // ── Hooks 解析 ─────────────────────────────────────────
  const parsedHooks: ParsedPluginHooks = {
    hooks: {},
    overviewHooks: [],
    unsupported: [],
  };
  const hookCtx = {
    host: input.host,
    manifestKind: input.manifestKind,
    pluginLabel,
    pluginRootReal,
    pluginDataDir,
    warnings,
    out: parsedHooks,
  };
  const seenHookFiles = new Set<string>();
  const defaultHooksPath = paths.join(pluginRootReal, "hooks", "hooks.json");

  if (input.manifestKind === "claude") {
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
  } else if (input.manifestKind === "codex" || input.manifestKind === "nocturne") {
    await loadHooksFile(platform, defaultHooksPath, false, seenHookFiles, hookCtx);
  }

  // ── MCP 服务器解析（ADR-0100 第 2 节） ──────────────────
  const parsedMcp: ParsedPluginMcp = {
    servers: [],
    overviewServers: [],
    seenIds: new Set<string>(),
  };
  const mcpCtx = {
    pluginId: id,
    pluginLabel,
    pluginRootReal,
    pluginDataDir,
    nodePath: input.nodePath,
    warnings,
    unsupported: parsedHooks.unsupported,
    out: parsedMcp,
  };
  const seenMcpFiles = new Set<string>();
  const manifestMcp = manifest.mcpServers;
  if (manifestMcp !== undefined) {
    const items = Array.isArray(manifestMcp) ? manifestMcp : [manifestMcp];
    for (const item of items) {
      if (typeof item === "string") {
        const resolved = await resolvePluginRelativePath(
          platform,
          input.rawRoot,
          pluginRootReal,
          item,
        );
        if (resolved.error !== undefined || resolved.path === undefined) {
          warnings.push(`plugin ${pluginLabel}：${resolved.error ?? "无效 mcpServers 路径"}`);
          continue;
        }
        await loadMcpFile(platform, resolved.path, true, seenMcpFiles, mcpCtx);
      } else if (isPlainObject(item)) {
        collectMcpMap(item, mcpCtx);
      } else {
        warnings.push(`plugin ${pluginLabel}：mcpServers 字段必须是相对路径或对象`);
      }
    }
  } else {
    const defaultMcpPath = paths.join(pluginRootReal, ".mcp.json");
    if (await fs.exists(defaultMcpPath)) {
      const realMcp = await platform.resolveReal(defaultMcpPath);
      if (paths.isWithin(pluginRootReal, realMcp)) {
        await loadMcpFile(platform, realMcp, false, seenMcpFiles, mcpCtx);
      } else {
        warnings.push(`plugin ${pluginLabel}：默认 .mcp.json 越出插件根目录`);
      }
    }
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
    mcpServers: parsedMcp.servers,
    overview: {
      id,
      host: input.host,
      name: input.name,
      marketplace: input.marketplace,
      version,
      root: pluginRootReal,
      ...(displayName !== undefined ? { displayName } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(icon !== undefined ? { icon } : {}),
      hooks: parsedHooks.overviewHooks,
      unsupported: parsedHooks.unsupported,
      skills: skillNames,
      mcpServers: parsedMcp.overviewServers,
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

async function discoverBuiltinPlugins(
  platform: Platform,
  builtinPluginsDir: string | undefined,
  nocturneHome: string,
  nodePath: string,
  warnings: string[],
): Promise<DiscoveredPlugin[]> {
  if (builtinPluginsDir === undefined || builtinPluginsDir.trim() === "") return [];
  const { fs, paths } = platform;
  if (!(await fs.exists(builtinPluginsDir))) return [];

  let entries;
  try {
    entries = await fs.readdir(builtinPluginsDir);
  } catch {
    return [];
  }

  const results: DiscoveredPlugin[] = [];
  const seenNames = new Set<string>();
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.type !== "directory" && entry.type !== "symlink") continue;
    const rawRoot = entry.path;
    const manifestPath = paths.join(rawRoot, ".nocturne-plugin", "plugin.json");
    if (!(await fs.exists(manifestPath))) continue;

    const manifestWarnings: string[] = [];
    const manifest = await readManifestFile(
      platform,
      manifestPath,
      manifestWarnings,
      `${entry.name}@builtin`,
    );
    if (manifest === undefined) {
      warnings.push(...manifestWarnings);
      continue;
    }
    const name = nonEmptyString(manifest.name) ?? entry.name;
    if (!NATIVE_PLUGIN_NAME_RE.test(name)) {
      warnings.push(`nocturne_plugin_invalid：内置插件名称 "${name}" 非法，已跳过`);
      continue;
    }
    if (seenNames.has(name)) {
      warnings.push(`nocturne_plugin_duplicate：内置插件 "${name}" 重复，已跳过`);
      continue;
    }
    seenNames.add(name);

    results.push(
      await buildDiscoveredPlugin(platform, {
        host: "nocturne",
        manifestKind: "nocturne",
        name,
        marketplace: "builtin",
        version: nonEmptyString(manifest.version) ?? "",
        rawRoot,
        nocturneHome,
        nodePath,
        manifest,
        manifestWarnings,
      }),
    );
  }
  return results;
}

async function discoverLocalNocturnePlugins(
  platform: Platform,
  nocturneHome: string,
  nodePath: string,
  warnings: string[],
): Promise<DiscoveredPlugin[]> {
  const { fs, paths } = platform;
  const localRoot = paths.join(nocturneHome, "plugins", "installed", "local");
  if (!(await fs.exists(localRoot))) return [];

  let nameEntries;
  try {
    nameEntries = await fs.readdir(localRoot);
  } catch {
    return [];
  }

  const results: DiscoveredPlugin[] = [];
  for (const entry of nameEntries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.type !== "directory" && entry.type !== "symlink") continue;
    if (!isSafeSegment(entry.name)) {
      warnings.push(`nocturne_plugin_invalid：本地插件目录名 "${entry.name}" 非法，已跳过`);
      continue;
    }

    let versionEntries;
    try {
      versionEntries = await fs.readdir(entry.path);
    } catch {
      continue;
    }
    const version = selectActivePluginVersion(versionEntries);
    if (version === undefined) continue;

    const rawRoot = paths.join(entry.path, version);
    const label = `${entry.name}@local`;
    const manifestWarnings: string[] = [];
    const nocturneManifestPath = paths.join(rawRoot, ".nocturne-plugin", "plugin.json");
    const codexManifestPath = paths.join(rawRoot, ".codex-plugin", "plugin.json");
    const claudeManifestPath = paths.join(rawRoot, ".claude-plugin", "plugin.json");

    let manifestKind: PluginManifestKind;
    let manifest: Record<string, unknown> | undefined;
    if (await fs.exists(nocturneManifestPath)) {
      manifestKind = "nocturne";
      manifest = await readManifestFile(platform, nocturneManifestPath, manifestWarnings, label);
      if (manifest === undefined) {
        warnings.push(...manifestWarnings);
        continue;
      }
      const declaredName = nonEmptyString(manifest.name);
      if (
        !NATIVE_PLUGIN_NAME_RE.test(entry.name) ||
        (declaredName !== undefined && !NATIVE_PLUGIN_NAME_RE.test(declaredName))
      ) {
        warnings.push(
          `nocturne_plugin_invalid：本地插件名称 "${declaredName ?? entry.name}" 非法，已跳过`,
        );
        continue;
      }
    } else if (await fs.exists(codexManifestPath)) {
      manifestKind = "codex";
      manifest = await readManifestFile(platform, codexManifestPath, manifestWarnings, label);
    } else if (await fs.exists(claudeManifestPath)) {
      manifestKind = "claude";
      manifest = await readManifestFile(platform, claudeManifestPath, manifestWarnings, label);
    } else {
      continue;
    }

    results.push(
      await buildDiscoveredPlugin(platform, {
        host: "nocturne",
        manifestKind,
        name: entry.name,
        marketplace: "local",
        version,
        rawRoot,
        nocturneHome,
        nodePath,
        manifest,
        manifestWarnings,
      }),
    );
  }
  return results;
}

async function discoverCodexPlugins(
  platform: Platform,
  codexHome: string,
  nocturneHome: string,
  nodePath: string,
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
    if (CODEX_SYSTEM_MARKETPLACES.has(slug.marketplace)) continue;
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
        manifestKind: "codex",
        name: slug.name,
        marketplace: slug.marketplace,
        version,
        rawRoot,
        nocturneHome,
        nodePath,
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
  nodePath: string,
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
        manifestKind: "claude",
        name: slug.name,
        marketplace: slug.marketplace,
        version: "",
        rawRoot: installPath,
        nocturneHome,
        nodePath,
        manifest,
        manifestWarnings,
      }),
    );
  }

  return results;
}

function hasUsablePluginCapabilities(plugin: DiscoveredPlugin): boolean {
  return (
    plugin.overview.hooks.length > 0 ||
    plugin.overview.skills.length > 0 ||
    plugin.mcpServers.length > 0
  );
}

export async function discoverInstalledPlugins(
  platform: Platform,
  options: PluginDiscoveryOptions,
): Promise<{ plugins: DiscoveredPlugin[]; warnings: string[] }> {
  const { paths } = platform;
  const nodePath = nonEmptyString(options.nodePath) ?? process.execPath;
  const codexHome =
    nonEmptyString(options.codexHome) ??
    nonEmptyString(platform.env("CODEX_HOME")) ??
    paths.join(platform.homeDir(), ".codex");
  const claudeHome =
    nonEmptyString(options.claudeHome) ??
    nonEmptyString(platform.env("CLAUDE_CONFIG_DIR")) ??
    paths.join(platform.homeDir(), ".claude");

  const warnings: string[] = [];
  const [builtin, local, codex, claude] = await Promise.all([
    discoverBuiltinPlugins(
      platform,
      options.builtinPluginsDir,
      options.nocturneHome,
      nodePath,
      warnings,
    ),
    discoverLocalNocturnePlugins(platform, options.nocturneHome, nodePath, warnings),
    discoverCodexPlugins(platform, codexHome, options.nocturneHome, nodePath, warnings),
    discoverClaudePlugins(platform, claudeHome, options.nocturneHome, nodePath, warnings),
  ]);

  const plugins = [...builtin, ...local, ...codex, ...claude]
    .filter(hasUsablePluginCapabilities)
    .sort((a, b) => (a.overview.id < b.overview.id ? -1 : a.overview.id > b.overview.id ? 1 : 0));
  return { plugins, warnings };
}
