/**
 * write/edit 共享的"先读后写"守卫（tools.md 第 6 节）。
 * 判定顺序：重新解析路径（resource_changed）→ 存在性与类型
 * → 已读记录（not_read）→ mtime/size 一致（放行）→ 内容哈希一致
 * （放行并刷新 stat）→ 哈希不一致（stale_file；有旧文本且 diff 不超过
 * 上限时附 diff 并用当前内容刷新记录，否则要求重新 read、不刷新）。
 * edit、write、apply_patch 共用同一判定，不各写一份。
 */
import { resolveRealPath } from "../../platform/index.js";
import type { ToolContext } from "../types.js";
import { hashText, isSmallText, STALE_DIFF_MAX_CHARS, stripBom } from "../readstate.js";
import { diffLines } from "./diff.js";

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
  if (record.mtimeMs === stat.mtimeMs && record.size === stat.size) {
    const oldText = await ctx.fs.readTextFile(resolved).catch(() => undefined);
    if (oldText === undefined) {
      return toolError("read_failed", `无法读取文件：${resolved}`);
    }
    return { stat, oldText };
  }
  // mtime/size 不一致：比较内容哈希（prettier --write、eslint --fix、
  // git checkout 等只改 mtime 的情况直接放行）
  const currentText = await ctx.fs.readTextFile(resolved).catch(() => undefined);
  if (currentText === undefined) {
    return toolError("read_failed", `无法读取文件：${resolved}`);
  }
  const currentHash = hashText(currentText);
  if (currentHash === record.hash) {
    ctx.readState.record(resolved, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      hash: currentHash,
      ...(record.text !== undefined ? { text: record.text } : {}),
    });
    return { stat, oldText: currentText };
  }
  const diff =
    record.text !== undefined
      ? diffLines(stripBom(record.text), stripBom(currentText), resolved)
      : undefined;
  // 差异过长（或只差行尾、diff 为空）时不附 diff、不刷新记录：
  // 模型没看到的改动不能被当作已读而覆盖
  if (diff !== undefined && diff !== "" && diff.length <= STALE_DIFF_MAX_CHARS) {
    const message = `文件自上次读取后已被外部修改：${resolved}`;
    ctx.readState.record(resolved, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      hash: currentHash,
      ...(isSmallText(currentText) ? { text: currentText } : {}),
    });
    const modelContent = `${message}。已附上读取时到当前的差异，可据此直接重试\n${diff}`;
    return { status: "error", modelContent, error: { code: "stale_file", message } };
  }
  return toolError("stale_file", `文件自上次读取后已被外部修改：${resolved}。请重新 read 后再写入`);
}

export function countLines(text: string): number {
  const lines = text.split("\n");
  if (lines.length > 0 && lines.at(-1) === "") lines.pop();
  return lines.length;
}
