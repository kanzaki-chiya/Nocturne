/**
 * 长期记忆范围目录解析与项目键计算（ADR-0098 §1）。
 * 只依赖 protocol 与 platform，不依赖 agent / tools / session。
 */
import { createHash } from "node:crypto";

import { gitMainRepository, type Platform } from "../platform/index.js";
import type { MemoryScope } from "../protocol/index.js";

const SAFE_SCOPE_KEY_RE = /^[a-zA-Z0-9._-]+$(?![\s\S])/;

export function isValidMemoryScopeKey(key: unknown): key is string {
  return typeof key === "string" && SAFE_SCOPE_KEY_RE.test(key) && key !== "." && key !== "..";
}

export function memoryBaseDir(platform: Pick<Platform, "paths">, nocturneHome: string): string {
  return platform.paths.join(nocturneHome, "memory");
}

export function globalMemoryDir(platform: Pick<Platform, "paths">, nocturneHome: string): string {
  return platform.paths.join(memoryBaseDir(platform, nocturneHome), "global");
}

export function projectsMemoryRoot(
  platform: Pick<Platform, "paths">,
  nocturneHome: string,
): string {
  return platform.paths.join(memoryBaseDir(platform, nocturneHome), "projects");
}

export function suitesMemoryRoot(platform: Pick<Platform, "paths">, nocturneHome: string): string {
  return platform.paths.join(memoryBaseDir(platform, nocturneHome), "suites");
}

/**
 * 判断工作区是否为默认普通对话目录 `<NOCTURNE_HOME>/workspace`。
 * 默认工作区没有项目记忆范围，只有全局（ADR-0098 §1）。
 */
export async function isDefaultMemoryWorkspace(
  platform: Platform,
  nocturneHome: string,
  workspaceRoot: string,
): Promise<boolean> {
  const defaultWs = platform.paths.join(nocturneHome, "workspace");
  if (
    platform.paths.equals(
      platform.paths.resolve(".", workspaceRoot),
      platform.paths.resolve(".", defaultWs),
    )
  ) {
    return true;
  }
  const [realWs, realDefault] = await Promise.all([
    platform.resolveReal(workspaceRoot),
    platform.resolveReal(defaultWs),
  ]);
  return platform.paths.equals(realWs, realDefault);
}

/**
 * 计算工作区对应的项目记忆键与用于记入 workspace.json 的主路径：
 * 在 git 仓库（含工作树）里取主仓库根目录，否则取工作区真实根目录；
 * 规范化真实路径后取 SHA-256 前 8 位拼接目录名。
 */
export async function projectMemoryKey(
  platform: Platform,
  workspaceRoot: string,
): Promise<{ key: string; repoRoot: string }> {
  const realWs = await platform.resolveReal(workspaceRoot);
  const mainRepo = await gitMainRepository(realWs);
  const repoRoot = mainRepo !== null ? await platform.resolveReal(mainRepo) : realWs;
  const canonical = platform.paths.canonicalize(repoRoot);
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 8);
  const base = platform.paths.basename(repoRoot);
  const slug = base
    .replaceAll(/[^a-zA-Z0-9._-]+/g, "_")
    .replaceAll(/^_+|_+$/g, "")
    .slice(0, 40);
  const prefix = slug && slug !== "." && slug !== ".." ? slug : "root";
  return { key: `${prefix}-${hash}`, repoRoot };
}

export interface ResolvedMemoryDir {
  scope: MemoryScope;
  dir: string;
  key?: string | undefined;
  projectPath?: string | undefined;
}

/**
 * 解析范围对应的目录；默认工作区解析 project 范围时返回 undefined。
 * key 非法或缺少必需参数时抛出 Error。
 */
export async function resolveMemoryScopeDir(
  platform: Platform,
  nocturneHome: string,
  target: {
    scope: MemoryScope;
    key?: string | undefined;
    workspaceRoot?: string | undefined;
  },
): Promise<ResolvedMemoryDir | undefined> {
  if (target.scope === "global") {
    if (target.key !== undefined) {
      throw new Error("global 范围不接受 key 参数");
    }
    return { scope: "global", dir: globalMemoryDir(platform, nocturneHome) };
  }
  if (target.scope === "suite") {
    if (!isValidMemoryScopeKey(target.key)) {
      throw new Error("suite 范围需要有效的 key（suiteId）");
    }
    return {
      scope: "suite",
      key: target.key,
      dir: platform.paths.join(suitesMemoryRoot(platform, nocturneHome), target.key),
    };
  }
  if (target.key !== undefined) {
    if (!isValidMemoryScopeKey(target.key)) {
      throw new Error(`无效的项目记忆键：${target.key}`);
    }
    return {
      scope: "project",
      key: target.key,
      dir: platform.paths.join(projectsMemoryRoot(platform, nocturneHome), target.key),
    };
  }
  if (target.workspaceRoot === undefined) {
    throw new Error("project 范围缺少 key 或 workspaceRoot");
  }
  if (await isDefaultMemoryWorkspace(platform, nocturneHome, target.workspaceRoot)) {
    return undefined;
  }
  const { key, repoRoot } = await projectMemoryKey(platform, target.workspaceRoot);
  return {
    scope: "project",
    key,
    projectPath: repoRoot,
    dir: platform.paths.join(projectsMemoryRoot(platform, nocturneHome), key),
  };
}
