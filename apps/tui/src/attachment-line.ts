import type { ImageAttachment } from "@nocturne/core/protocol";

/** img-n 的 n 是会话附件的保存顺序，与输入框占位编号无关。 */
export function attachmentLine(att: ImageAttachment, index: number, ascii: boolean): string {
  const number = /^img-(\d+)\./.exec(att.file)?.[1] ?? String(index + 1);
  const name = att.label ?? att.file;
  const size = att.bytes < 1024 ? `${att.bytes} B` : `${Math.ceil(att.bytes / 1024)} KB`;
  const dimensions = `${att.width ?? "?"}${ascii ? "x" : "×"}${att.height ?? "?"}`;
  return ascii
    ? `[Image #${number} | ${name} | ${dimensions} | ${size}]`
    : `[图片 #${number} · ${name} · ${dimensions} · ${size}]`;
}
