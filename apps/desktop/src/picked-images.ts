import type { ImageMimeType } from "@nocturne/core/protocol";

/** 外壳 pick_images 命令返回的一张图片（文件名 + 原始字节）。 */
export interface PickedImage {
  name: string;
  data: Uint8Array;
}

/** 支持的图片类型：与 Core 的 ImageMimeType 一致，只此一处声明。 */
export const IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const satisfies readonly ImageMimeType[];

export const IMAGE_TYPE_ERROR = "不支持的图片类型（支持 PNG、JPEG、GIF、WebP）";

const EXTENSIONS: Record<string, ImageMimeType> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** 按扩展名取 MIME；不认识的扩展名返回 undefined。 */
export function mimeTypeForImageName(name: string): ImageMimeType | undefined {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return undefined;
  return EXTENSIONS[name.slice(dot + 1).toLowerCase()];
}

/**
 * 解析 pick_images 的二进制帧：重复记录
 * [u32 LE 文件名 UTF-8 字节数][文件名][u32 LE 数据字节数][数据]。
 */
export function decodePickedImages(buf: ArrayBuffer): PickedImage[] {
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  const decoder = new TextDecoder();
  const out: PickedImage[] = [];
  let at = 0;
  const take = (): number => {
    if (at + 4 > bytes.length) throw new Error("图片数据格式错误");
    const n = view.getUint32(at, true);
    at += 4;
    return n;
  };
  while (at < bytes.length) {
    const nameLen = take();
    if (at + nameLen > bytes.length) throw new Error("图片数据格式错误");
    const name = decoder.decode(bytes.subarray(at, at + nameLen));
    at += nameLen;
    const dataLen = take();
    if (at + dataLen > bytes.length) throw new Error("图片数据格式错误");
    const data = bytes.slice(at, at + dataLen);
    at += dataLen;
    out.push({ name, data });
  }
  return out;
}
