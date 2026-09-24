/**
 * 项目 Grant 的持久化（config.md 第 4 节、ADR-0008）。
 * 位置：<NOCTURNE_HOME>/grants/<workspaceKey>.json，内容
 * { version, workspaceRoot, grants: Grant[] }，整文件原子替换。
 * 损坏或版本不符 → 忽略并警告，不阻塞会话（丢失授权的后果只是重新询问）。
 */
import { createHash } from "node:crypto";

import { z } from "zod";

import type { Grant } from "../protocol/index.js";
import type { Platform } from "../platform/index.js";
import { writeJsonAtomic } from "./files.js";
import type { GrantStore } from "./types.js";

const grantSchema = z.object({
  kind: z.enum(["read", "edit", "shell", "network", "mcp"]),
  target: z.string().min(1),
  createdAt: z.string(),
});

const grantsFileSchema = z.object({
  version: z.literal(1),
  workspaceRoot: z.string(),
  grants: z.array(grantSchema),
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
  /** 文件损坏/版本不符时的警告（按空集合处理） */
  warning?: string | undefined;
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
  if (await fs.exists(filePath)) {
    try {
      const raw: unknown = JSON.parse(await fs.readTextFile(filePath));
      const parsed = grantsFileSchema.safeParse(raw);
      if (!parsed.success) throw new Error("schema mismatch");
      if (!paths.equals(parsed.data.workspaceRoot, workspaceRoot)) {
        throw new Error("workspaceRoot mismatch");
      }
      grants.push(...parsed.data.grants);
    } catch {
      warning = `项目授权文件 ${filePath} 损坏或版本不符，已忽略（授权丢失只意味着重新询问）`;
    }
  }

  return {
    store: {
      list: () => [...grants],
      async add(grant) {
        grants.push(grant);
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
