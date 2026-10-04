import type { ImageAttachment, ImageMimeType } from "@nocturne/core/protocol";
import type { RpcSession } from "@nocturne/rpc/client";

/** 消息流的窗口级图片缓存：按 sha256 复用 blob URL，未命中时回读当前会话附件。 */
export interface AttachmentImageSource {
  url: (attachment: ImageAttachment) => string | undefined;
  /** sha256（小写 hex）→ object URL，重复登记返回同一 URL */
  register: (data: Uint8Array, mimeType: ImageMimeType) => Promise<string>;
  load: (
    attachment: ImageAttachment,
    session: Pick<RpcSession, "readAttachment">,
  ) => Promise<string>;
  /** 窗口卸载时回收 URL，并丢弃仍在途的读取/哈希结果。 */
  dispose: () => void;
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function createAttachmentImageSource(): AttachmentImageSource {
  const urls = new Map<string, string>();
  const pending = new Map<string, Promise<string>>();
  let generation = 0;
  const register = async (data: Uint8Array, mimeType: ImageMimeType): Promise<string> => {
    const current = generation;
    const key = hex(await crypto.subtle.digest("SHA-256", data as BufferSource));
    if (current !== generation) throw new Error("图片缓存已释放");
    let url = urls.get(key);
    if (url === undefined) {
      url = URL.createObjectURL(new Blob([data as BlobPart], { type: mimeType }));
      urls.set(key, url);
    }
    return url;
  };
  return {
    url: (attachment) => urls.get(attachment.sha256),
    register,
    load(attachment, session) {
      const cached = urls.get(attachment.sha256);
      if (cached !== undefined) return Promise.resolve(cached);
      const existing = pending.get(attachment.sha256);
      if (existing !== undefined) return existing;
      const current = generation;
      const loading = (async () => {
        const result = await session.readAttachment(attachment.file);
        if (current !== generation) throw new Error("图片缓存已释放");
        return register(result.data, result.mimeType);
      })().finally(() => {
        if (pending.get(attachment.sha256) === loading) pending.delete(attachment.sha256);
      });
      pending.set(attachment.sha256, loading);
      return loading;
    },
    dispose() {
      generation++;
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
      pending.clear();
    },
  };
}
