/**
 * 本地目录插件安装与卸载（ADR-0100 第 3 节、第三期）。
 * 复用 discovery.ts 的清单读取与路径校验逻辑，不另写一套规则。
 */
import { randomUUID } from "node:crypto";
import { fsErrorCode, type Platform } from "../platform/index.js";
import type { PluginOverview } from "../protocol/index.js";
import { checkLocalPluginDirectory } from "./check.js";
import {
  buildDiscoveredPlugin,
  hasUsablePluginCapabilities,
  isPlainObject,
  isSafeSegment,
  nonEmptyString,
  readLocalPluginManifest,
} from "./discovery.js";
import { createPluginStore } from "./store.js";
import type { PluginDiscoveryOptions } from "./types.js";

const LOCAL_PLUGIN_ID_RE = /^nocturne:([^@]+)@local$/;

function cacheSlug(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 40) || "item";
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
  const check = await checkLocalPluginDirectory(platform, {
    path: options.path,
    nocturneHome: options.nocturneHome,
    nodePath: options.nodePath,
  });
  if (
    !check.installable ||
    check.sourceRoot === undefined ||
    check.name === undefined ||
    check.version === undefined
  ) {
    throw new Error(check.errors[0] ?? "清单无效：插件校验未通过");
  }

  const sourceReal = check.sourceRoot;
  const name = check.name;
  const versionDir = check.version;

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
      throw new Error("清单无效：插件不包含可用的技能、Hook、MCP 服务器或子代理");
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
