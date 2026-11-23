/**
 * 长期记忆范围目录解析与项目键计算（ADR-0098 §1）。
 * 只依赖 protocol 与 platform，不依赖 agent / tools / session。
 */
import { computeProjectKey, isDefaultWorkspace, type Platform } from "../platform/index.js";
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
export function isDefaultMemoryWorkspace(
  platform: Platform,
  nocturneHome: string,
  workspaceRoot: string,
): Promise<boolean> {
  return isDefaultWorkspace(platform, nocturneHome, workspaceRoot);
}

/**
 * 计算工作区对应的项目记忆键与用于记入 workspace.json 的主路径：
 * 委托共用项目键实现（ADR-0098 §1、ADR-0114 §2）。
 */
export function projectMemoryKey(
  platform: Platform,
  workspaceRoot: string,
): Promise<{ key: string; repoRoot: string }> {
  return computeProjectKey(platform, workspaceRoot);
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
