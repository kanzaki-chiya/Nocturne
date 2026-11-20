/**
 * 本地目录插件安装与卸载（ADR-0100 第 3 节、第三期）。
 * 复用 discovery.ts 的清单读取与路径校验逻辑，不另写一套规则。
 */
import { randomUUID } from "node:crypto";
import { fsErrorCode, type Platform } from "../platform/index.js";
import type { PluginOverview } from "../protocol/index.js";
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
import { createPluginStore } from "./store.js";
import type { PluginDiscoveryOptions, PluginManifestKind } from "./types.js";

const LOCAL_PLUGIN_ID_RE = /^nocturne:([^@]+)@local$/;

function cacheSlug(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 40) || "item";
}

async function validateManifestPaths(
  platform: Platform,
  rawRoot: string,
  pluginRootReal: string,
  manifest: Record<string, unknown>,
): Promise<void> {
  if (manifest.skills !== undefined) {
    if (typeof manifest.skills !== "string" && !Array.isArray(manifest.skills)) {
      throw new Error("清单无效：skills 字段必须是字符串或字符串数组");
    }
    const items = Array.isArray(manifest.skills) ? manifest.skills : [manifest.skills];
    for (const item of items) {
      if (typeof item !== "string") {
        throw new Error("清单无效：skills 路径必须是字符串");
      }
      const res = await resolvePluginRelativePath(platform, rawRoot, pluginRootReal, item);
      if (res.error !== undefined) {
        throw new Error(`清单无效：${res.error}`);
      }
    }
  }

  if (manifest.hooks !== undefined) {
    const items = Array.isArray(manifest.hooks) ? manifest.hooks : [manifest.hooks];
    for (const item of items) {
      if (typeof item === "string") {
        const res = await resolvePluginRelativePath(platform, rawRoot, pluginRootReal, item);
        if (res.error !== undefined) {
          throw new Error(`清单无效：${res.error}`);
        }
      } else if (!isPlainObject(item)) {
        throw new Error("清单无效：hooks 字段元素必须是相对路径或对象");
      }
    }
  }

  if (manifest.mcpServers !== undefined) {
    const items = Array.isArray(manifest.mcpServers) ? manifest.mcpServers : [manifest.mcpServers];
    for (const item of items) {
      if (typeof item === "string") {
        const res = await resolvePluginRelativePath(platform, rawRoot, pluginRootReal, item);
        if (res.error !== undefined) {
          throw new Error(`清单无效：${res.error}`);
        }
      } else if (!isPlainObject(item)) {
        throw new Error("清单无效：mcpServers 字段元素必须是相对路径或对象");
      }
    }
  }
}

function resolvePluginName(
  manifestKind: PluginManifestKind,
  manifest: Record<string, unknown>,
  fallbackName: string,
): string {
  let name: string;
  if (manifest.name !== undefined) {
    const declared = nonEmptyString(manifest.name);
    if (declared === undefined) {
      throw new Error("清单无效：name 必须是非空字符串");
    }
    name = declared;
  } else {
    name = fallbackName;
  }

  if (manifestKind === "nocturne") {
    if (!NATIVE_PLUGIN_NAME_RE.test(name)) {
      throw new Error(`清单无效：插件名称 "${name}" 只允许小写字母、数字和连字符`);
    }
  } else if (!isSafeSegment(name) || name.includes("@")) {
    throw new Error(`清单无效：插件名称 "${name}" 非法`);
  }
  return name;
}

/** 递归复制插件目录：跳过 `.git` 与符号链接（不跟随、不复制）。 */
async function copyPluginTree(platform: Platform, from: string, to: string): Promise<void> {
  const { fs, paths } = platform;
  await fs.mkdir(to);
  const stack: { from: string; to: string }[] = [{ from, to }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    for (const entry of await fs.readdir(current.from)) {
      if (entry.name === ".git") continue;
      const srcFull = entry.path;
      const dstFull = paths.join(current.to, entry.name);
      const stat = await fs.lstat(srcFull);
      if (stat.type === "symlink") continue;
      if (stat.type === "directory") {
        await fs.mkdir(dstFull);
        stack.push({ from: srcFull, to: dstFull });
        continue;
      }
      if (stat.type === "file") {
        await fs.writeFile(dstFull, await fs.readFile(srcFull));
      }
    }
  }
}

async function removePluginMcpCaches(
  platform: Platform,
  nocturneHome: string,
  pluginId: string,
): Promise<void> {
  const { fs, paths } = platform;
  const cacheDir = paths.join(nocturneHome, "plugins", "cache", "mcp-tools");
  if (!(await fs.exists(cacheDir))) return;
  let entries;
  try {
    entries = await fs.readdir(cacheDir);
  } catch {
    return;
  }
  const prefix = `${cacheSlug(pluginId)}__`;
  for (const entry of entries) {
    if (entry.type !== "file" || !entry.name.endsWith(".json")) continue;
    if (!entry.name.startsWith(prefix)) continue;
    let shouldDelete = false;
    try {
      const raw: unknown = JSON.parse(await fs.readTextFile(entry.path));
      if (isPlainObject(raw) && typeof raw.pluginId === "string") {
        shouldDelete = raw.pluginId === pluginId;
      } else if (pluginId.length <= 40) {
        shouldDelete = true;
      }
    } catch {
      if (pluginId.length <= 40) shouldDelete = true;
    }
    if (shouldDelete) {
      await fs.unlink(entry.path).catch(() => undefined);
    }
  }
}

export async function installLocalPluginFiles(
  platform: Platform,
  options: PluginDiscoveryOptions & { path: string },
  describeAfterInstall: () => Promise<{ plugins: PluginOverview[] }>,
): Promise<PluginOverview> {
  const { fs, paths } = platform;
  const rawInput = options.path.trim();
  if (rawInput === "") {
    throw new Error("插件目录路径不能为空");
  }
  const sourceAbs = paths.isAbsolute(rawInput)
    ? paths.normalize(rawInput)
    : paths.resolve(process.cwd(), rawInput);

  let stat;
  try {
    stat = await fs.stat(sourceAbs);
  } catch (e) {
    if (fsErrorCode(e) === "ENOENT") {
      throw new Error(`插件目录不存在：${rawInput}`);
    }
    throw new Error(`无法读取插件目录：${e instanceof Error ? e.message : String(e)}`);
  }
  if (stat.type !== "directory") {
    throw new Error(`插件路径不是目录：${rawInput}`);
  }

  const sourceReal = await platform.resolveReal(sourceAbs);
  const pluginsDir = paths.join(options.nocturneHome, "plugins");
  const pluginsDirReal = await platform.resolveReal(pluginsDir);
  if (paths.isWithin(pluginsDir, sourceAbs) || paths.isWithin(pluginsDirReal, sourceReal)) {
    throw new Error(`不能从 Nocturne 插件目录内安装插件：${rawInput}`);
  }

  const fallbackName = paths.basename(sourceReal);
  const lookup = await readLocalPluginManifest(platform, sourceReal, `${fallbackName}@local`);
  if (lookup === undefined) {
    throw new Error(
      "清单无效：未找到 .nocturne-plugin/plugin.json、.codex-plugin/plugin.json 或 .claude-plugin/plugin.json",
    );
  }
  if (lookup.manifest === undefined) {
    throw new Error(lookup.warnings[0] ?? "清单无效：无法解析 plugin.json");
  }

  const name = resolvePluginName(lookup.manifestKind, lookup.manifest, fallbackName);
  await validateManifestPaths(platform, sourceReal, sourceReal, lookup.manifest);

  const manifestVersion = nonEmptyString(lookup.manifest.version);
  // 与 selectActivePluginVersion 一致：合法版本目录名沿用清单版本，缺省或不合法时用 "local"
  const versionDir =
    manifestVersion !== undefined && isValidPluginVersionDirName(manifestVersion)
      ? manifestVersion
      : "local";

  const localRoot = paths.join(options.nocturneHome, "plugins", "installed", "local");
  await fs.mkdir(localRoot, { mode: 0o700 });

  const suffix = `${process.pid}-${randomUUID().slice(0, 8)}`;
  const targetNameDir = paths.join(localRoot, name);
  const stagingNameDir = paths.join(localRoot, `.${name}.tmp-${suffix}`);
  const stagingVersionDir = paths.join(stagingNameDir, versionDir);
  const nodePath = nonEmptyString(options.nodePath) ?? process.execPath;

  try {
    await copyPluginTree(platform, sourceReal, stagingVersionDir);

    const stagedLookup = await readLocalPluginManifest(
      platform,
      stagingVersionDir,
      `${name}@local`,
    );
    if (stagedLookup?.manifest === undefined) {
      throw new Error("清单无效：插件清单未被复制到安装副本（可能为符号链接）");
    }
    const built = await buildDiscoveredPlugin(platform, {
      host: "nocturne",
      manifestKind: stagedLookup.manifestKind,
      name,
      marketplace: "local",
      version: versionDir,
      rawRoot: stagingVersionDir,
      nocturneHome: options.nocturneHome,
      nodePath,
      manifest: stagedLookup.manifest,
      manifestWarnings: stagedLookup.warnings,
    });
    if (!hasUsablePluginCapabilities(built)) {
      throw new Error("清单无效：插件不包含可用的技能、Hook 或 MCP 服务器");
    }

    if (await fs.exists(targetNameDir)) {
      const backupDir = paths.join(localRoot, `.${name}.bak-${suffix}`);
      await fs.rename(targetNameDir, backupDir);
      try {
        await fs.rename(stagingNameDir, targetNameDir);
      } catch (e) {
        await fs.rename(backupDir, targetNameDir).catch(() => undefined);
        throw e;
      }
      await fs.rm(backupDir, { recursive: true, force: true }).catch(() => undefined);
    } else {
      await fs.rename(stagingNameDir, targetNameDir);
    }
  } catch (e) {
    await fs.rm(stagingNameDir, { recursive: true, force: true }).catch(() => undefined);
    throw e;
  }

  const pluginId = `nocturne:${name}@local`;
  const described = await describeAfterInstall();
  const overview = described.plugins.find((p) => p.id === pluginId);
  if (overview === undefined) {
    throw new Error(`插件已复制但未能发现：${pluginId}`);
  }
  return overview;
}

export async function uninstallLocalPluginFiles(
  platform: Platform,
  options: PluginDiscoveryOptions & {
    id: string;
    onDeactivate?: () => Promise<number>;
  },
): Promise<{ affectedSessions: number }> {
  const { fs, paths } = platform;
  const match = LOCAL_PLUGIN_ID_RE.exec(options.id);
  const name = match?.[1];
  if (name === undefined || !isSafeSegment(name)) {
    throw new Error(`只能卸载本地安装的 Nocturne 插件：${options.id}`);
  }

  const localRoot = paths.join(options.nocturneHome, "plugins", "installed", "local");
  const targetNameDir = paths.join(localRoot, name);
  if (!(await fs.exists(targetNameDir))) {
    throw new Error(`未找到本地安装的插件：${options.id}`);
  }

  const store = createPluginStore(platform, options.nocturneHome);
  const prevEntry = (await store.readState()).entries.get(options.id);

  // 1. 若原为启用/已更改，先走停用路径让已打开会话在边界生效（释放 MCP 子进程句柄）
  let affectedSessions = 0;
  if (prevEntry !== undefined) {
    await store.setEnabled(options.id, false);
    if (options.onDeactivate) {
      affectedSessions = await options.onDeactivate();
    }
  }

  // 2. 先重命名再删除，保证 Windows 占用时整目录原子失败且不留半删状态
  const trashDir = paths.join(localRoot, `.${name}.del-${process.pid}-${randomUUID().slice(0, 8)}`);
  let renamed = false;
  try {
    await fs.rename(targetNameDir, trashDir);
    renamed = true;
    await fs.rm(trashDir, { recursive: true, force: false });
  } catch (e) {
    if (renamed) {
      await fs.rename(trashDir, targetNameDir).catch(() => undefined);
    }
    if (prevEntry !== undefined) {
      await store.restoreEntry(options.id, prevEntry).catch(() => undefined);
      if (options.onDeactivate) {
        await options.onDeactivate().catch(() => undefined);
      }
    }
    const code = fsErrorCode(e);
    const reason = e instanceof Error ? e.message : String(e);
    const hint =
      code === "EBUSY" || code === "EPERM" || code === "EACCES" || code === "ENOTEMPTY"
        ? "目录可能正被占用"
        : reason;
    throw new Error(`无法卸载插件 ${options.id}（${hint}）：${reason}`);
  }

  if (prevEntry === undefined && options.onDeactivate) {
    affectedSessions = await options.onDeactivate();
  }

  // 3. 删除该插件的 MCP 工具缓存（不动 PLUGIN_DATA）
  await removePluginMcpCaches(platform, options.nocturneHome, options.id);

  return { affectedSessions };
}
