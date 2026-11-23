/**
 * 项目键计算与默认工作区判定（ADR-0098 §1、ADR-0114 §2）。
 * 长期记忆与项目页面库共用，避免复制实现。
 */
import { createHash } from "node:crypto";

import type { Platform } from "./platform.js";
import { gitMainRepository } from "./workspace-branches.js";

/** 默认工作区（普通对话）在页面库里的项目键与展示名 */
export const DEFAULT_WORKSPACE_PROJECT_KEY = "default";
export const DEFAULT_WORKSPACE_PROJECT_NAME = "对话";

export interface ResolvedProjectKey {
  key: string;
  repoRoot: string;
}

export interface WorkspaceProjectIdentity {
  key: string;
  name: string;
  isDefault: boolean;
  repoRoot?: string | undefined;
}

/**
 * 判断工作区是否为默认普通对话目录 `<NOCTURNE_HOME>/workspace`。
 */
export async function isDefaultWorkspace(
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
 * 计算工作区对应的项目键与主路径：
 * 在 git 仓库（含工作树）里取主仓库根目录，否则取工作区真实根目录；
 * 规范化真实路径后取 SHA-256 前 8 位拼接目录名。
 */
export async function computeProjectKey(
  platform: Platform,
  workspaceRoot: string,
): Promise<ResolvedProjectKey> {
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

/**
 * 解析工作区的项目归属：默认工作区归入「对话」，其余按共用项目键计算。
 */
export async function resolveWorkspaceProject(
  platform: Platform,
  nocturneHome: string,
  workspaceRoot: string,
): Promise<WorkspaceProjectIdentity> {
  if (await isDefaultWorkspace(platform, nocturneHome, workspaceRoot)) {
    return {
      key: DEFAULT_WORKSPACE_PROJECT_KEY,
      name: DEFAULT_WORKSPACE_PROJECT_NAME,
      isDefault: true,
    };
  }
  const { key, repoRoot } = await computeProjectKey(platform, workspaceRoot);
  const name = platform.paths.basename(repoRoot) || repoRoot;
  return { key, name, isDefault: false, repoRoot };
}
