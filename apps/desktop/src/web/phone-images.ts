/**
 * 手机附件图片：相册或拍照得到的 File 在发送前就地处理成 Core 接受的图片。
 * 类型与桌面 picked-images.ts 的 IMAGE_TYPES 一致；尺寸上限照抄 Core
 * （packages/core/src/tools/image.ts 的 IMAGE_MAX_BYTES、IMAGE_MAX_EDGE，
 * protocol 不导出，这里硬编码）。超限或类型不支持时用 canvas 缩放转码。
 */
import type { ImageMimeType } from "@nocturne/core/protocol";
import { MAX_MESSAGE } from "@nocturne/remote";

import { IMAGE_TYPES } from "../picked-images";

/** Core 单张图片字节上限（packages/core/src/tools/image.ts） */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
/** Core 单边像素上限（同上） */
export const IMAGE_MAX_EDGE = 8000;
/** 转码时的长边上限：兼顾手机 canvas 内存与清晰度 */
export const REENCODE_MAX_EDGE = 4096;
/**
 * 一次 session.submit 报文的上限：与后台 REMOTE_MESSAGE_LIMIT 相同口径，
 * 给加密与 JSON 包装留 64 KiB。超过 MAX_MESSAGE 整条加密通道会断开。
 */
export const SUBMIT_MESSAGE_LIMIT = MAX_MESSAGE - 64 * 1024;

export interface PhoneImage {
  name: string;
  data: Uint8Array;
  mimeType: ImageMimeType;
  width: number;
  height: number;
}

/** 解码与编码的浏览器能力，测试里替换 */
export interface ImageCodec {
  decode: (file: Blob) => Promise<{ width: number; height: number; source: CanvasImageSource }>;
  encode: (
    source: CanvasImageSource,
    width: number,
    height: number,
    mimeType: "image/jpeg" | "image/png",
    quality: number,
  ) => Promise<Blob>;
}

export const browserCodec: ImageCodec = {
  async decode(file) {
    if (typeof createImageBitmap === "function") {
      const bitmap = await createImageBitmap(file);
      return { width: bitmap.width, height: bitmap.height, source: bitmap };
    }
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      return { width: image.naturalWidth, height: image.naturalHeight, source: image };
    } finally {
      URL.revokeObjectURL(url);
    }
  },
  encode(source, width, height, mimeType, quality) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (context === null) return Promise.reject(new Error("无法处理图片"));
    if (mimeType === "image/jpeg") {
      // JPEG 没有透明通道，透明处填白
      context.fillStyle = "#fff";
      context.fillRect(0, 0, width, height);
    }
    context.drawImage(source, 0, 0, width, height);
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob === null) reject(new Error("无法处理图片"));
          else resolve(blob);
        },
        mimeType,
        quality,
      );
    });
  },
};

const supported = (type: string): type is ImageMimeType =>
  (IMAGE_TYPES as readonly string[]).includes(type);

function fitWithin(width: number, height: number, edge: number) {
  const scale = Math.min(1, edge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function rename(name: string, mimeType: ImageMimeType): string {
  const base = name.replace(/\.[^./\\]*$/, "") || "image";
  return `${base}.${mimeType === "image/png" ? "png" : "jpg"}`;
}

/**
 * 处理一张图片：类型受支持、不超字节与边长上限时原样发送（保留 GIF 动画与
 * 原始画质）；否则长边缩到 REENCODE_MAX_EDGE 以内，PNG 源先试 PNG，仍超限
 * 或其他类型转 JPEG，并逐级降低质量直到不超过 IMAGE_MAX_BYTES。
 */
export async function preparePhoneImage(
  file: File,
  codec: ImageCodec = browserCodec,
): Promise<PhoneImage> {
  const decoded = await codec.decode(file).catch(() => {
    throw new Error(`无法读取图片：${file.name || "未命名"}（支持 PNG、JPEG、GIF、WebP）`);
  });
  const name = file.name || "image";
  if (
    supported(file.type) &&
    file.size <= IMAGE_MAX_BYTES &&
    Math.max(decoded.width, decoded.height) <= IMAGE_MAX_EDGE
  ) {
    return {
      name,
      data: new Uint8Array(await file.arrayBuffer()),
      mimeType: file.type,
      width: decoded.width,
      height: decoded.height,
    };
  }
  const size = fitWithin(decoded.width, decoded.height, REENCODE_MAX_EDGE);
  const attempts: ["image/jpeg" | "image/png", number][] = [
    ...(file.type === "image/png" ? [["image/png", 1] as ["image/png", number]] : []),
    ["image/jpeg", 0.9],
    ["image/jpeg", 0.8],
    ["image/jpeg", 0.65],
    ["image/jpeg", 0.5],
  ];
  let shrink = size;
  for (let round = 0; round < 3; round++) {
    for (const [mimeType, quality] of attempts) {
      const blob = await codec.encode(
        decoded.source,
        shrink.width,
        shrink.height,
        mimeType,
        quality,
      );
      if (blob.size <= IMAGE_MAX_BYTES)
        return {
          name: rename(name, mimeType),
          data: new Uint8Array(await blob.arrayBuffer()),
          mimeType,
          width: shrink.width,
          height: shrink.height,
        };
    }
    shrink = fitWithin(shrink.width, shrink.height, Math.max(shrink.width, shrink.height) / 2);
  }
  throw new Error(`图片过大，无法压缩到 5 MB 以内：${name}`);
}

const base64Length = (bytes: number) => 4 * Math.ceil(bytes / 3);

/**
 * 估算一次 session.submit 的报文字节数：附件按 base64 计，文字与标签按 JSON
 * 转义后的 UTF-8 计，外加固定余量（方法名、会话 id、技能/委派字段与加密包装）。
 */
export function estimateSubmitBytes(
  text: string,
  attachments: readonly { data: Uint8Array; label: string }[],
): number {
  const encoder = new TextEncoder();
  let total = 4096 + encoder.encode(JSON.stringify(text)).length;
  for (const attachment of attachments)
    total +=
      256 +
      base64Length(attachment.data.length) +
      encoder.encode(JSON.stringify(attachment.label)).length;
  return total;
}

/** 文件卡片的类型标记：扩展名前 4 位大写，没有扩展名时为 FILE。 */
export function fileIconText(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).replace(/[^a-z0-9]/gi, "") : "";
  return ext === "" ? "FILE" : ext.slice(0, 4).toUpperCase();
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
