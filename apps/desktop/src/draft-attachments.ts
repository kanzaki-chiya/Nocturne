import { IMAGE_MAX_BYTES, type ImageAttachment, type ImageMimeType } from "@nocturne/core/protocol";
import type { RpcSession } from "@nocturne/rpc/client";

import type { AttachmentImageSource } from "./attachment-images";
import { IMAGE_TYPES, mimeTypeForImageName } from "./picked-images";

/** 提交载荷里的单个附件（ComposerSubmit["attachments"][number] 与 resubmit 共用） */
export interface SubmitAttachment {
  data: Uint8Array;
  mimeType: string;
  label: string;
  source?: "paste" | "upload";
}

/** 界面待发/编辑态里的附件条目（带本地 object URL 预览） */
export interface DraftAttachment {
  name: string;
  data: Uint8Array;
  mimeType: string;
  url: string;
  source?: "paste" | "upload";
}

export interface NewAttachmentFile {
  name: string;
  data: Uint8Array;
  mimeType?: string | undefined;
  source?: "paste" | "upload" | undefined;
}

const ATTACHMENT_MAX_COUNT = 10;
const FILE_MAX_BYTES = 20 * 1024 * 1024;
const LONG_PASTE_BYTES = 32768;

export function materializeAttachment(attachment: SubmitAttachment): DraftAttachment {
  return {
    name: attachment.label,
    data: attachment.data,
    mimeType: attachment.mimeType,
    url: URL.createObjectURL(
      new Blob([attachment.data as BlobPart], { type: attachment.mimeType }),
    ),
    ...(attachment.source ? { source: attachment.source } : {}),
  };
}

export function createDraftAttachments(files: readonly NewAttachmentFile[]): DraftAttachment[] {
  const added: DraftAttachment[] = [];
  for (const file of files) {
    const mimeType =
      (file.mimeType === "" ? undefined : file.mimeType) ??
      mimeTypeForImageName(file.name) ??
      "application/octet-stream";
    added.push({
      name: file.name,
      ...(file.source ? { source: file.source } : {}),
      data: file.data,
      mimeType,
      url: URL.createObjectURL(new Blob([file.data as BlobPart], { type: mimeType })),
    });
  }
  return added;
}

export function toSubmitAttachments(attachments: readonly DraftAttachment[]): SubmitAttachment[] {
  return attachments.map((attachment) => ({
    data: attachment.data,
    mimeType: attachment.mimeType,
    label: attachment.name,
    ...(attachment.source ? { source: attachment.source } : {}),
  }));
}

export function revokeDraftAttachments(attachments: readonly DraftAttachment[]): void {
  for (const attachment of attachments) URL.revokeObjectURL(attachment.url);
}

/** 与 Core validateAttachmentInputs 口径一致的前置校验（避免 rewind 后再被附件上限拒收） */
export function validateDraftAttachments(
  attachments: readonly SubmitAttachment[],
): string | undefined {
  if (attachments.length > ATTACHMENT_MAX_COUNT) return "每条消息最多 10 个附件";
  for (const attachment of attachments) {
    const isImage = (IMAGE_TYPES as readonly string[]).includes(attachment.mimeType);
    if (isImage) {
      if (attachment.data.byteLength > IMAGE_MAX_BYTES) return "单个图片附件不能超过 50 MB";
    } else if (attachment.data.byteLength > FILE_MAX_BYTES) {
      return "单个附件不能超过 20 MB";
    }
  }
  return undefined;
}

export function readFileListAttachments(
  files: readonly File[],
  options?: {
    defaultName?: string | undefined;
    inferImageMime?: boolean | undefined;
    source?: "paste" | "upload" | undefined;
  },
): Promise<NewAttachmentFile[]> {
  return Promise.all(
    files.map(async (file) => {
      const name = file.name || (options?.defaultName ?? "attachment");
      const mimeType = options?.inferImageMime
        ? (IMAGE_TYPES as readonly string[]).includes(file.type)
          ? file.type
          : mimeTypeForImageName(name)
        : (file.type as ImageMimeType);
      return {
        name,
        data: new Uint8Array(await file.arrayBuffer()),
        ...(mimeType ? { mimeType } : {}),
        ...(options?.source ? { source: options.source } : {}),
      };
    }),
  );
}

/**
 * 解析剪贴板中的文件或超长文本（>=32 KB 转为文本附件）。
 * 返回 handled=true 表示调用方应 preventDefault 并消费 files（长文本为同步数组，文件为 Promise）。
 */
export function readClipboardAttachments(
  clipboardData: DataTransfer,
  options?: {
    literalPaste?: boolean | undefined;
    nextPasteNumber?: (() => number) | undefined;
  },
):
  | { handled: false }
  | { handled: true; files: NewAttachmentFile[] | Promise<NewAttachmentFile[]> } {
  const items = Array.from(clipboardData.items);
  const files = items.flatMap((item) => {
    if (item.kind !== "file") return [];
    const file = item.getAsFile();
    return file === null ? [] : [file];
  });
  if (files.length === 0) {
    const text = clipboardData.getData("text/plain");
    const encoded = new TextEncoder().encode(text);
    if (!options?.literalPaste && encoded.byteLength >= LONG_PASTE_BYTES) {
      const index = options?.nextPasteNumber?.() ?? 1;
      return {
        handled: true,
        files: [
          {
            name: `pasted-${index}.txt`,
            data: encoded,
            mimeType: "text/plain",
            source: "paste",
          },
        ],
      };
    }
    return { handled: false };
  }
  return {
    handled: true,
    files: readFileListAttachments(files, { defaultName: "粘贴图片" }),
  };
}

export function readDroppedAttachments(
  dataTransfer: DataTransfer,
): Promise<NewAttachmentFile[]> | null {
  const files = Array.from(dataTransfer.files);
  if (files.length === 0) return null;
  return readFileListAttachments(files, { inferImageMime: true });
}

/**
 * 从会话已存附件中取回原图字节：优先复用窗口级缓存的 Blob，未命中时经 session.readAttachment 回读。
 * 单张失败不静默丢弃，返回 errors 供编辑框或重发报错。
 */
export async function loadStoredImageAttachments(
  attachments: readonly ImageAttachment[],
  images: AttachmentImageSource,
  session: Pick<RpcSession, "readAttachment">,
): Promise<{ loaded: NewAttachmentFile[]; errors: string[] }> {
  if (attachments.length === 0) return { loaded: [], errors: [] };
  const results = await Promise.all(
    attachments.map(async (attachment) => {
      const name = attachment.label ?? attachment.file;
      try {
        const cached = images.blob?.(attachment);
        if (cached !== undefined) {
          return {
            ok: true as const,
            file: {
              name,
              data: new Uint8Array(await cached.arrayBuffer()),
              mimeType: cached.type || attachment.mimeType,
              source: "paste" as const,
            },
          };
        }
        const read = await session.readAttachment(attachment.file);
        return {
          ok: true as const,
          file: {
            name,
            data: read.data,
            mimeType: read.mimeType || attachment.mimeType,
            source: "paste" as const,
          },
        };
      } catch (reason: unknown) {
        const message = reason instanceof Error ? reason.message : String(reason);
        return { ok: false as const, error: `${name}：${message}` };
      }
    }),
  );
  const loaded: NewAttachmentFile[] = [];
  const errors: string[] = [];
  for (const item of results) {
    if (item.ok) loaded.push(item.file);
    else errors.push(item.error);
  }
  return { loaded, errors };
}
