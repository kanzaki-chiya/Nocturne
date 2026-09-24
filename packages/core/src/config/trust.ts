/**
 * 工作区信任列表（config.md 第 3 节、ADR-0008）。
 * 机器维护的 <NOCTURNE_HOME>/trust.json：{ version, workspaces: string[] }，
 * 记录工作区真实路径的 canonical 形式。它是唯一能授予信任的来源——
 * 项目配置里没有这个字段，仓库不能自我授权。
 * 文件损坏或版本不符时按"无信任"处理并给出警告（fail closed）。
 */
import { z } from "zod";

import type { Platform } from "../platform/index.js";
import { writeJsonAtomic } from "./files.js";

const trustFileSchema = z.object({
  version: z.literal(1),
  workspaces: z.array(z.string()),
});

export interface TrustList {
  /** 已信任工作区的 canonical 路径集合 */
  workspaces: ReadonlySet<string>;
  /** 文件损坏/版本不符时的警告（按空集合处理） */
  warning?: string | undefined;
}

export async function readTrustList(platform: Platform, path: string): Promise<TrustList> {
  const { fs } = platform;
  if (!(await fs.exists(path))) return { workspaces: new Set() };
  try {
    const raw: unknown = JSON.parse(await fs.readTextFile(path));
    const parsed = trustFileSchema.safeParse(raw);
    if (!parsed.success) throw new Error("schema mismatch");
    return { workspaces: new Set(parsed.data.workspaces) };
  } catch {
    return {
      workspaces: new Set(),
      warning: `信任列表 ${path} 损坏或版本不符，已按"无信任工作区"处理`,
    };
  }
}

/** 原子重写 trust.json（nctrn trust / untrust 的唯一写入路径） */
export async function writeTrustList(
  platform: Platform,
  path: string,
  workspaces: ReadonlySet<string>,
): Promise<void> {
  await writeJsonAtomic(platform.fs, platform.paths, path, {
    version: 1,
    workspaces: [...workspaces].sort(),
  });
}
