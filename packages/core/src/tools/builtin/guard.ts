/**
 * write/edit 共享的"先读后写"守卫（tools.md 第 6 节）。
 * 判定顺序：重新解析路径（resource_changed）→ 存在性与类型
 * → 已读记录（not_read）→ mtime/size 一致性（stale_file）。
 */
import { resolveRealPath } from "../../platform/index.js";
import type { ToolContext } from "../types.js";

export interface GuardOk {
  stat: { mtimeMs: number; size: number };
  oldText: string;
}

export interface GuardError {
  status: "error";
  modelContent: string;
  error: { code: string; message: string };
}

export function toolError(code: string, message: string): GuardError {
  return { status: "error", modelContent: message, error: { code, message } };
}

export function isGuardError(v: GuardOk | GuardError | undefined): v is GuardError {
  return v !== undefined && "status" in v;
}

/**
 * 返回 undefined：目标尚不存在（write 新建允许，竞态由调用方写入前复检）；
 * 返回 GuardOk：可写；返回 GuardError：拒绝。
 */
export async function guardWritable(
  target: string,
  resolved: string,
  ctx: ToolContext,
  requireExisting: boolean,
): Promise<GuardOk | GuardError | undefined> {
  // 重新解析：批准时与实际写入之间路径可能发生变化（符号链接、junction）
  const now = await resolveRealPath(ctx.fs, ctx.paths, target);
  if (!ctx.paths.equals(now, resolved)) {
    return toolError(
      "resource_changed",
      `批准的路径与当前解析结果不一致（批准：${resolved}，当前：${now}）。请重新确认后再写入`,
    );
  }
  const stat = await ctx.fs.stat(resolved).catch(() => undefined);
  if (stat === undefined) {
    if (requireExisting) {
      return toolError("file_not_found", `文件不存在：${resolved}`);
    }
    return undefined;
  }
  if (stat.type === "directory") {
    return toolError("is_directory", `${resolved} 是目录，不是文件`);
  }
  const record = ctx.readState.get(resolved);
  if (record === undefined) {
    return toolError("not_read", `拒绝覆盖未读取的文件：${resolved}。请先用 read 读取该文件`);
  }
  if (record.mtimeMs !== stat.mtimeMs || record.size !== stat.size) {
    return toolError(
      "stale_file",
      `文件自上次读取后已被外部修改：${resolved}。请重新 read 后再写入`,
    );
  }
  const oldText = await ctx.fs.readTextFile(resolved).catch(() => undefined);
  if (oldText === undefined) {
    return toolError("read_failed", `无法读取文件：${resolved}`);
  }
  return { stat, oldText };
}

export function countLines(text: string): number {
  const lines = text.split("\n");
  if (lines.length > 0 && lines.at(-1) === "") lines.pop();
  return lines.length;
}
