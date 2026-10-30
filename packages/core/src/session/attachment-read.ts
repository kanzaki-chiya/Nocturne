/**
 * 读取会话持久事件登记的附件（rpc.md 3.2 readAttachment）：
 * RuntimeSession.readAttachment 与只读子会话观察共用同一套校验。
 */
import { createHash } from "node:crypto";

import type { DurableEvent, ImageAttachment, FileAttachment } from "../protocol/index.js";
import { fsErrorCode, type Platform } from "../platform/index.js";
import { SessionError } from "./errors.js";

/** 已登记并通过磁盘完整性校验的附件 */
export interface ReadAttachmentResult {
  data: Uint8Array;
  mimeType: string;
  bytes: number;
}

/**
 * 只授权 `events` 里 message.user / tool.completed 登记过的文件名；读取
 * `<sessionsDir>/attachments/<sessionId>/` 下的实际文件，拒绝链接与逃逸，
 * 每次校验字节数与 sha256，不通过任何上级目录兜底。
 */
export async function readSessionAttachment(
  platform: Pick<Platform, "fs" | "paths">,
  sessionsDir: string,
  sessionId: string,
  events: Iterable<DurableEvent>,
  file: unknown,
): Promise<ReadAttachmentResult> {
  const { fs, paths } = platform;
  if (
    typeof file !== "string" ||
    file.length === 0 ||
    file.includes("..") ||
    /[<>:"/\\|?*\u0000-\u001f]/.test(file) ||
    /[. ]$/.test(file) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(file)
  ) {
    throw new SessionError("invalid_attachment_file", "附件必须是单个安全文件名");
  }
  // 原始持久日志是授权来源，包含已被回退或压缩隐藏的图片；不沿 parent 回溯。
  let attachment: ImageAttachment | FileAttachment | undefined;
  for (const event of events) {
    if (event.type !== "message.user" && event.type !== "tool.completed") continue;
    attachment = [...(event.payload.attachments ?? []), ...(event.payload.files ?? [])].find(
      (ref) => ref.file === file,
    );
    if (attachment !== undefined) break;
  }
  if (attachment === undefined) {
    throw new SessionError("attachment_not_found", "本会话未登记该附件");
  }
  const root = paths.join(sessionsDir, "attachments");
  const dir = paths.join(root, sessionId);
  const target = paths.join(dir, file);
  try {
    // 拒绝文件链接、会话目录 junction 与附件根链接；realpath 再检查实际归属。
    if ((await fs.lstat(root)).type !== "directory" || (await fs.lstat(dir)).type !== "directory") {
      throw new SessionError("invalid_attachment_file", "附件目录不能是链接");
    }
    const stat = await fs.lstat(target);
    if (stat.type !== "file") {
      throw new SessionError("invalid_attachment_file", "附件必须是普通文件");
    }
    const realRoot = await fs.realpath(root);
    const realDir = await fs.realpath(dir);
    const realTarget = await fs.realpath(target);
    if (
      !paths.equals(realDir, paths.join(realRoot, sessionId)) ||
      !paths.equals(realTarget, paths.join(realDir, file))
    ) {
      throw new SessionError("invalid_attachment_file", "附件路径超出本会话目录");
    }
    if (stat.size !== attachment.bytes) {
      throw new SessionError("attachment_corrupt", "附件大小与记录不符");
    }
    // 不走 AttachmentStore.load 的 sha 缓存：落盘文件可能在上次读取后被改动。
    const data = await fs.readFile(realTarget);
    if (
      data.byteLength !== attachment.bytes ||
      createHash("sha256").update(data).digest("hex") !== attachment.sha256
    ) {
      throw new SessionError("attachment_corrupt", "附件内容与记录不符");
    }
    return {
      data,
      mimeType: attachment.mimeType ?? "application/octet-stream",
      bytes: data.byteLength,
    };
  } catch (error) {
    if (error instanceof SessionError) throw error;
    const code = fsErrorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new SessionError("attachment_missing", "附件文件缺失", { cause: error });
    }
    throw new SessionError("attachment_read_failed", "附件读取失败", { cause: error });
  }
}
