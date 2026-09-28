import type { ImageAttachment } from "@nocturne/core/protocol";

import { boxSafe } from "./format.js";

/**
 * img-n 的 n 是会话附件的保存顺序，与输入框占位编号无关。
 * 分隔符用 •、尺寸用 x：· 与 × 在维护者的终端里按 2 列显示（format.ts
 * BOX_AMBIG_MAP 的实测结论），按 1 列计宽会让全屏行截断与折行错位。
 */
export function attachmentLine(att: ImageAttachment, index: number, ascii: boolean): string {
  const number = /^img-(\d+)\./.exec(att.file)?.[1] ?? String(index + 1);
  const name = boxSafe(att.label ?? att.file);
  const size = att.bytes < 1024 ? `${att.bytes} B` : `${Math.ceil(att.bytes / 1024)} KB`;
  const dimensions = `${att.width ?? "?"}x${att.height ?? "?"}`;
  return ascii
    ? `[Image #${number} | ${name} | ${dimensions} | ${size}]`
    : `[图片 #${number} • ${name} • ${dimensions} • ${size}]`;
}
