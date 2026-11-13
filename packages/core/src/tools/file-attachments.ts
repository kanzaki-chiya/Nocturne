import type { AttachmentInput, FileAttachment, ImageAttachment } from "../protocol/index.js";
import type { AttachmentStore } from "./attachments.js";
import { IMAGE_MAX_BYTES, ImageCorruptError, parseImageSize, sniffImageMime } from "./image.js";

export const FILE_MAX_BYTES = 20 * 1024 * 1024;
export const ATTACHMENT_MAX_COUNT = 10;

export function validateAttachmentInputs(inputs: AttachmentInput[]): string | undefined {
  if (!Array.isArray(inputs) || inputs.length > ATTACHMENT_MAX_COUNT)
    return "每条消息最多 10 个附件";
  for (const input of inputs) {
    const value: unknown = input;
    if (
      typeof value !== "object" ||
      value === null ||
      !(input.data instanceof Uint8Array) ||
      typeof input.mimeType !== "string" ||
      (input.label !== undefined && typeof input.label !== "string") ||
      (input.source !== undefined && !["paste", "upload", "answer"].includes(input.source))
    )
      return "附件参数无效";
    const sniffed = sniffImageMime(input.data);
    const isImage =
      sniffed !== undefined &&
      (input.mimeType === sniffed || input.mimeType === "application/octet-stream");
    if (isImage) {
      if (input.data.byteLength > IMAGE_MAX_BYTES) return "单个图片附件不能超过 50 MB";
    } else if (input.data.byteLength > FILE_MAX_BYTES) {
      return "单个附件不能超过 20 MB";
    }
  }
  return undefined;
}

export async function saveInputAttachments(
  store: AttachmentStore,
  inputs: AttachmentInput[],
  answer = false,
  signal?: AbortSignal,
): Promise<{ attachments: ImageAttachment[]; files: FileAttachment[] }> {
  const attachments: ImageAttachment[] = [];
  const files: FileAttachment[] = [];
  for (const input of inputs) {
    signal?.throwIfAborted();
    const mimeType = sniffImageMime(input.data);
    const size = mimeType ? parseImageSize(input.data, mimeType) : undefined;
    const mimeMatches =
      mimeType !== undefined &&
      (input.mimeType === mimeType || input.mimeType === "application/octet-stream");
    if (mimeMatches && size !== undefined) {
      try {
        attachments.push(await store.save({ ...input, mimeType, source: "paste", signal }));
        continue;
      } catch (err) {
        if (signal?.aborted) throw err;
        if (!(err instanceof ImageCorruptError) || input.data.byteLength > FILE_MAX_BYTES) {
          throw err;
        }
      }
    }
    if (input.data.byteLength > FILE_MAX_BYTES) {
      throw new Error("单个附件不能超过 20 MB");
    }
    files.push(
      await store.saveFile({
        data: input.data,
        mimeType: input.mimeType,
        label: input.label ?? "attachment",
        source: answer ? "answer" : (input.source ?? "upload"),
      }),
    );
  }
  return { attachments, files };
}

const escape = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r/g, "&#13;")
    .replace(/\n/g, "&#10;");
export function attachmentReferences(
  files: FileAttachment[],
  path: (file: string) => string,
): string {
  return files
    .map((file) => {
      const size =
        file.bytes >= 1024 * 1024
          ? `${Number((file.bytes / (1024 * 1024)).toFixed(1))} MB`
          : file.bytes >= 1024
            ? `${Math.ceil(file.bytes / 1024)} KB`
            : `${file.bytes} B`;
      return `<attachment name="${escape(file.label)}" path="${escape(path(file.file))}" size="${size}"${file.text ? ` lines="${file.text.lines}"` : file.mimeType ? ` type="${escape(file.mimeType)}"` : ""} />`;
    })
    .join("\n");
}
