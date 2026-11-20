/**
 * 本地目录插件安装前校验（与 installLocalPluginFiles 共用同一套规则，ADR-0100）。
 * 完全只读：不复制、不创建、不修改任何文件。
 */
import { createPlatform, fsErrorCode, type Platform } from "../platform/index.js";
import type {
  PluginHookOverview,
  PluginMcpServerOverview,
  PluginUiSurfaceOverview,
  PluginUnsupportedHook,
} from "../protocol/index.js";
import {
  NATIVE_PLUGIN_NAME_RE,
  buildDiscoveredPlugin,
  hasUsablePluginCapabilities,
  isPlainObject,
  isSafeSegment,
  nonEmptyString,
  readLocalPluginManifest,
  resolvePluginRelativePath,
} from "./discovery.js";
import { isValidPluginVersionDirName } from "./semver.js";
import type { PluginManifestKind } from "./types.js";

export { createPlatform };

export interface LocalPluginCheckOptions {
  path: string;
  /** 可选；传入时会检查源目录不得位于 `<nocturneHome>/plugins/` 内 */
  nocturneHome?: string | undefined;
  /** 覆写 `${NOCTURNE_NODE}`（缺省 `process.execPath`） */
  nodePath?: string | undefined;
}

export interface LocalPluginCheckResult {
  installable: boolean;
  errors: string[];
  warnings: string[];
  /** 只读检查无法覆盖、安装或启用时才会检查的项目 */
  installTimeChecks: string[];
  sourceRoot?: string | undefined;
  manifestKind?: PluginManifestKind | undefined;
  pluginId?: string | undefined;
  name?: string | undefined;
  version?: string | undefined;
  displayName?: string | undefined;
  description?: string | undefined;
  skills: string[];
  hooks: PluginHookOverview[];
  mcpServers: PluginMcpServerOverview[];
  surfaces: PluginUiSurfaceOverview[];
  unsupported: PluginUnsupportedHook[];
}

const BASE_INSTALL_TIME_CHECKS: readonly string[] = [
  "安装时才会检查：复制到安装副本时会跳过 .git 与符号链接，若清单或能力文件本身为符号链接导致复制后清单丢失或无可用能力，安装会被拒绝。",
  "安装时才会检查：目标目录写入与原子替换、安装后的插件重新发现，以及启用时的整目录 SHA-256 指纹校验（含符号链接与非普通文件检查）。",
  "安装时才会检查：与用户或项目配置文件中 MCP 服务器同名时的冲突（plugin_mcp_conflict）。",
];

function buildInstallTimeChecks(hasNocturneHome: boolean): string[] {
  return hasNocturneHome
    ? [...BASE_INSTALL_TIME_CHECKS]
    : [
        "安装时才会检查：源目录是否位于 <NOCTURNE_HOME>/plugins/ 目录内（本次只读检查未传入 nocturneHome）。",
        ...BASE_INSTALL_TIME_CHECKS,
      ];
}

async function collectManifestPathErrors(
  platform: Platform,
  rawRoot: string,
  pluginRootReal: string,
  manifest: Record<string, unknown>,
  errors: string[],
): Promise<void> {
  if (manifest.skills !== undefined) {
    if (typeof manifest.skills !== "string" && !Array.isArray(manifest.skills)) {
      errors.push("清单无效：skills 字段必须是字符串或字符串数组");
    } else {
      const items = Array.isArray(manifest.skills) ? manifest.skills : [manifest.skills];
      for (const item of items) {
        if (typeof item !== "string") {
          errors.push("清单无效：skills 路径必须是字符串");
          continue;
        }
        const res = await resolvePluginRelativePath(platform, rawRoot, pluginRootReal, item);
        if (res.error !== undefined) {
          errors.push(`清单无效：${res.error}`);
        }
      }
    }
  }

  if (manifest.hooks !== undefined) {
    const items = Array.isArray(manifest.hooks) ? manifest.hooks : [manifest.hooks];
    for (const item of items) {
      if (typeof item === "string") {
        const res = await resolvePluginRelativePath(platform, rawRoot, pluginRootReal, item);
        if (res.error !== undefined) {
          errors.push(`清单无效：${res.error}`);
        }
      } else if (!isPlainObject(item)) {
        errors.push("清单无效：hooks 字段元素必须是相对路径或对象");
      }
    }
  }

  if (manifest.mcpServers !== undefined) {
    const items = Array.isArray(manifest.mcpServers) ? manifest.mcpServers : [manifest.mcpServers];
    for (const item of items) {
      if (typeof item === "string") {
        const res = await resolvePluginRelativePath(platform, rawRoot, pluginRootReal, item);
        if (res.error !== undefined) {
          errors.push(`清单无效：${res.error}`);
        }
      } else if (!isPlainObject(item)) {
        errors.push("清单无效：mcpServers 字段元素必须是相对路径或对象");
      }
    }
  }
}

function validatePluginName(
  manifestKind: PluginManifestKind,
  manifest: Record<string, unknown>,
  fallbackName: string,
  errors: string[],
): string | undefined {
  let name: string;
  if (manifest.name !== undefined) {
    const declared = nonEmptyString(manifest.name);
    if (declared === undefined) {
      errors.push("清单无效：name 必须是非空字符串");
      return undefined;
    }
    name = declared;
  } else {
    name = fallbackName;
  }

  if (manifestKind === "nocturne") {
    if (!NATIVE_PLUGIN_NAME_RE.test(name)) {
      errors.push(`清单无效：插件名称 "${name}" 只允许小写字母、数字和连字符`);
      return undefined;
    }
  } else if (!isSafeSegment(name) || name.includes("@")) {
    errors.push(`清单无效：插件名称 "${name}" 非法`);
    return undefined;
  }
  return name;
}

function emptyFailure(errors: string[], installTimeChecks: string[]): LocalPluginCheckResult {
  return {
    installable: false,
    errors,
    warnings: [],
    installTimeChecks,
    skills: [],
    hooks: [],
    mcpServers: [],
    surfaces: [],
    unsupported: [],
  };
}

/**
 * 检查本地插件目录是否满足 Nocturne 安装前全部校验规则。
 * 与 `installLocalPluginFiles` 共用同一套清单读取、名称、相对路径与能力解析逻辑。
 */
export async function checkLocalPluginDirectory(
  platform: Platform,
  options: LocalPluginCheckOptions,
): Promise<LocalPluginCheckResult> {
  const { fs, paths } = platform;
  const hasNocturneHome = options.nocturneHome !== undefined && options.nocturneHome.trim() !== "";
  const installTimeChecks = buildInstallTimeChecks(hasNocturneHome);

  const rawInput = options.path.trim();
  if (rawInput === "") {
    return emptyFailure(["插件目录路径不能为空"], installTimeChecks);
  }
  const sourceAbs = paths.isAbsolute(rawInput)
    ? paths.normalize(rawInput)
    : paths.resolve(process.cwd(), rawInput);

  let stat;
  try {
    stat = await fs.stat(sourceAbs);
  } catch (e) {
    if (fsErrorCode(e) === "ENOENT") {
      return emptyFailure([`插件目录不存在：${rawInput}`], installTimeChecks);
    }
    return emptyFailure(
      [`无法读取插件目录：${e instanceof Error ? e.message : String(e)}`],
      installTimeChecks,
    );
  }
  if (stat.type !== "directory") {
    return emptyFailure([`插件路径不是目录：${rawInput}`], installTimeChecks);
  }

  const sourceReal = await platform.resolveReal(sourceAbs);
  if (hasNocturneHome && options.nocturneHome !== undefined) {
    const pluginsDir = paths.join(options.nocturneHome, "plugins");
    const pluginsDirReal = await platform.resolveReal(pluginsDir);
    if (paths.isWithin(pluginsDir, sourceAbs) || paths.isWithin(pluginsDirReal, sourceReal)) {
      return emptyFailure([`不能从 Nocturne 插件目录内安装插件：${rawInput}`], installTimeChecks);
    }
  }

  const fallbackName = paths.basename(sourceReal);
  const lookup = await readLocalPluginManifest(platform, sourceReal, `${fallbackName}@local`);
  if (lookup === undefined) {
    return {
      ...emptyFailure(
        [
          "清单无效：未找到 .nocturne-plugin/plugin.json、.codex-plugin/plugin.json 或 .claude-plugin/plugin.json",
        ],
        installTimeChecks,
      ),
      sourceRoot: sourceReal,
    };
  }
  if (lookup.manifest === undefined) {
    return {
      ...emptyFailure([lookup.warnings[0] ?? "清单无效：无法解析 plugin.json"], installTimeChecks),
      sourceRoot: sourceReal,
      manifestKind: lookup.manifestKind,
    };
  }

  const errors: string[] = [];
  const validName = validatePluginName(lookup.manifestKind, lookup.manifest, fallbackName, errors);
  await collectManifestPathErrors(platform, sourceReal, sourceReal, lookup.manifest, errors);

  const manifestVersion = nonEmptyString(lookup.manifest.version);
  // 与 selectActivePluginVersion 一致：合法版本目录名沿用清单版本，缺省或不合法时用 "local"
  const versionDir =
    manifestVersion !== undefined && isValidPluginVersionDirName(manifestVersion)
      ? manifestVersion
      : "local";

  const nodePath = nonEmptyString(options.nodePath) ?? process.execPath;
  const nocturneHomeForBuild =
    hasNocturneHome && options.nocturneHome !== undefined
      ? options.nocturneHome
      : paths.join(platform.homeDir(), ".nocturne");

  const built = await buildDiscoveredPlugin(platform, {
    host: "nocturne",
    manifestKind: lookup.manifestKind,
    name: validName ?? fallbackName,
    marketplace: "local",
    version: versionDir,
    rawRoot: sourceReal,
    nocturneHome: nocturneHomeForBuild,
    nodePath,
    manifest: lookup.manifest,
    manifestWarnings: lookup.warnings,
  });

  if (!hasUsablePluginCapabilities(built)) {
    errors.push("清单无效：插件不包含可用的技能、Hook 或 MCP 服务器");
  }

  return {
    installable: errors.length === 0,
    errors,
    warnings: built.overview.warnings,
    installTimeChecks,
    sourceRoot: sourceReal,
    manifestKind: lookup.manifestKind,
    ...(validName !== undefined
      ? { name: validName, pluginId: `nocturne:${validName}@local` }
      : {}),
    version: versionDir,
    ...(built.overview.displayName !== undefined
      ? { displayName: built.overview.displayName }
      : {}),
    ...(built.overview.description !== undefined
      ? { description: built.overview.description }
      : {}),
    skills: built.overview.skills,
    hooks: built.overview.hooks,
    mcpServers: built.overview.mcpServers,
    surfaces: built.overview.surfaces ?? [],
    unsupported: built.overview.unsupported,
  };
}
