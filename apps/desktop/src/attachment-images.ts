import type { ImageAttachment, ImageMimeType } from "@nocturne/core/protocol";

/**
 * 消息流里图片附件的可显示来源：本窗口内按 sha256 缓存的 object URL。
 * 发送成功后用原始字节登记；历史会话只有 sha256 元数据，
 * 命中不了缓存时界面退回占位 chip（附件字节回读需要 RPC 能力，见 desktop.md）。
 */
export interface AttachmentImageSource {
  url: (attachment: ImageAttachment) => string | undefined;
  /** sha256（小写 hex）→ object URL，重复登记返回同一 URL */
  register: (data: Uint8Array, mimeType: ImageMimeType) => Promise<string>;
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function createAttachmentImageSource(): AttachmentImageSource {
  const urls = new Map<string, string>();
  return {
    url: (attachment) => urls.get(attachment.sha256),
    async register(data, mimeType) {
      const key = hex(await crypto.subtle.digest("SHA-256", data as BufferSource));
      let url = urls.get(key);
      if (url === undefined) {
        url = URL.createObjectURL(new Blob([data as BlobPart], { type: mimeType }));
        urls.set(key, url);
      }
      return url;
    },
  };
}
