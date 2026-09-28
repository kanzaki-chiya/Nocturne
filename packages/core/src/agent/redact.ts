/**
 * 诊断脱敏（observability.md）：provider.request 记录完整 ModelRequest
 * 便于复现，但图片的 base64 动辄数 MB——写日志前把 images 元素替换为
 * { mimeType, bytes, sha256 } 摘要（bytes 为解码后字节数）。
 * 无图片时原样返回同一对象，零开销。
 */
import { createHash } from "node:crypto";

import type { ImageMimeType } from "../protocol/index.js";
import type { ModelRequest } from "../provider/index.js";

/** 脱敏后的图片摘要（替代 base64 data） */
export interface RedactedImage {
  mimeType: ImageMimeType;
  bytes: number;
  sha256: string;
}

/** 返回值的 images 元素是摘要而非 base64——形状刻意偏离 ModelRequest */
export type RedactedModelRequest = Omit<ModelRequest, "messages"> & {
  messages: unknown[];
};

export function redactRequestImages(request: ModelRequest): ModelRequest | RedactedModelRequest {
  const hasImages = request.messages.some(
    (m) => m.role !== "assistant" && (m.images?.length ?? 0) > 0,
  );
  if (!hasImages) return request;
  const messages = request.messages.map((m) => {
    if (m.role === "assistant" || m.images === undefined || m.images.length === 0) return m;
    return {
      ...m,
      images: m.images.map((img): RedactedImage => {
        const bytes = Buffer.from(img.data, "base64");
        return {
          mimeType: img.mimeType,
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        };
      }),
    };
  });
  return { ...request, messages };
}
