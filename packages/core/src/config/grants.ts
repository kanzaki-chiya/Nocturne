/**
 * 项目 Grant 的持久化（config.md 第 4 节、ADR-0008）。
 * 位置：<NOCTURNE_HOME>/grants/<workspaceKey>.json，内容
 * { version, workspaceRoot, grants: Grant[] }，整文件原子替换。
 * 单条坏条目逐条跳过并警告一次；只有 JSON 解析失败、版本不符或
 * workspaceRoot 不符时才按空处理，且首次 add 前先备份原文件。
 */
import { createHash } from "node:crypto";

import { z } from "zod";

import { subjectKindSchema, type Grant } from "../protocol/index.js";
import type { Platform } from "../platform/index.js";
import { writeJsonAtomic } from "./files.js";
import type { GrantStore } from "./types.js";

const grantSchema = z.object({
  kind: subjectKindSchema,
  target: z.string().min(1),
  createdAt: z.string(),
});

const grantsFileSchema = z.object({
  version: z.literal(1),
  workspaceRoot: z.string(),
  grants: z.array(z.unknown()),
});

/**
 * 工作区授权文件名（config.md 第 4 节）：规范化路径经非字母数字字符
 * 替换为 "_" 后截取，前缀带短散列防冲突。输入必须是 canonical 路径。
 */
export function workspaceKey(canonicalRoot: string): string {
  const hash = createHash("sha256").update(canonicalRoot).digest("hex").slice(0, 8);
  const slug = canonicalRoot
    .replaceAll(/[^a-zA-Z0-9]+/g, "_")
    .replaceAll(/^_+|_+$/g, "")
    .slice(0, 40);
  return `${hash}-${slug !== "" ? slug : "root"}`;
}

export interface LoadedGrantStore {
  store: GrantStore;
  /** 文件损坏/版本不符或含坏条目时的警告（按空集合或跳过后集合处理） */
  warning?: string | undefined;
}

function corruptBackupPath(filePath: string): string {
  const stamp = Date.now();
  if (filePath.endsWith(".json")) {
    return `${filePath.slice(0, -".json".length)}.corrupt-${stamp}.json`;
  }
  return `${filePath}.corrupt-${stamp}.json`;
}

/**
 * 打开某工作区的 Grant 文件。workspaceRoot 必须是已解析的真实路径；
 * canonical 化与文件读写都由本模块完成。
 */
export async function loadGrantStore(
  platform: Platform,
  grantsDir: string,
  workspaceRoot: string,
): Promise<LoadedGrantStore> {
  const { fs, paths } = platform;
  const canonical = paths.canonicalize(workspaceRoot);
  const filePath = paths.join(grantsDir, `${workspaceKey(canonical)}.json`);

  const grants: Grant[] = [];
  let warning: string | undefined;
  let corrupt = false;
  if (await fs.exists(filePath)) {
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readTextFile(filePath));
    } catch {
      corrupt = true;
    }
    if (!corrupt) {
      const parsed = grantsFileSchema.safeParse(raw);
      if (!parsed.success) {
        corrupt = true;
      } else if (!paths.equals(parsed.data.workspaceRoot, workspaceRoot)) {
        corrupt = true;
      } else {
        let skipped = 0;
        for (const entry of parsed.data.grants) {
          const item = grantSchema.safeParse(entry);
          if (item.success) grants.push(item.data);
          else skipped += 1;
        }
        if (skipped > 0) {
          warning = `项目授权文件 ${filePath} 中 ${skipped} 条无效条目已跳过（其余授权照常生效）`;
        }
      }
    }
    if (corrupt) {
      warning = `项目授权文件 ${filePath} 损坏或版本不符，已忽略（授权丢失只意味着重新询问）`;
    }
  }

  let backedUp = false;
  return {
    store: {
      list: () => [...grants],
      async add(grant) {
        if (grants.some((g) => g.kind === grant.kind && g.target === grant.target)) return;
        grants.push(grant);
        if (corrupt && !backedUp) {
          backedUp = true;
          if (await fs.exists(filePath)) {
            await fs.rename(filePath, corruptBackupPath(filePath));
          }
          corrupt = false;
        }
        await writeJsonAtomic(fs, paths, filePath, {
          version: 1,
          workspaceRoot,
          grants,
        });
      },
    },
    warning,
  };
}
