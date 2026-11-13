/**
 * 手机附件图片：相册或拍照得到的 File 在发送前只检查是否超过 Core 硬上限与远程报文上限。
 * 类型受支持且不超限时原样发送，其余交给 Core 后台自动缩小或切段；
 * 必须处理时先保持尺寸转成 JPEG，仍然太大再缩尺寸。
 */
import { IMAGE_MAX_BYTES, IMAGE_MAX_PIXELS, type ImageMimeType } from "@nocturne/core/protocol";
import { MAX_MESSAGE } from "@nocturne/remote";

import { IMAGE_TYPES } from "../picked-images";

export { IMAGE_MAX_BYTES, IMAGE_MAX_PIXELS };

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

const base64Length = (bytes: number) => 4 * Math.ceil(bytes / 3);

function estimateSingleAttachmentSubmitBytes(byteLength: number, label: string): number {
  const encoder = new TextEncoder();
  return (
    4096 +
    encoder.encode(JSON.stringify("")).length +
    256 +
    base64Length(byteLength) +
    encoder.encode(JSON.stringify(label)).length
  );
}

function fitWithinPixels(width: number, height: number, maxPixels: number) {
  if (width * height <= maxPixels) return { width, height };
  const scale = Math.sqrt(maxPixels / (width * height));
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}

function fitHalf(width: number, height: number) {
  return {
    width: Math.max(1, Math.round(width / 2)),
    height: Math.max(1, Math.round(height / 2)),
  };
}

function rename(name: string, mimeType: ImageMimeType): string {
  const base = name.replace(/\.[^./\\]*$/, "") || "image";
  return `${base}.${mimeType === "image/png" ? "png" : "jpg"}`;
}

/**
 * 处理一张图片：类型受支持、不超 Core 硬上限（50 MB / 64,000,000 像素）且
 * 单条消息不超 SUBMIT_MESSAGE_LIMIT 时原样发送（保留原尺寸与 GIF 动画，缩小/切段
 * 由 Core 统一完成）；必须处理时先保持尺寸转成 JPEG，仍然太大再逐步缩小尺寸。
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
    decoded.width * decoded.height <= IMAGE_MAX_PIXELS &&
    estimateSingleAttachmentSubmitBytes(file.size, name) <= SUBMIT_MESSAGE_LIMIT
  ) {
    return {
      name,
      data: new Uint8Array(await file.arrayBuffer()),
      mimeType: file.type,
      width: decoded.width,
      height: decoded.height,
    };
  }
  const qualities = [0.9, 0.8, 0.65, 0.5] as const;
  const jpegName = rename(name, "image/jpeg");
  let target = fitWithinPixels(decoded.width, decoded.height, IMAGE_MAX_PIXELS);
  for (let round = 0; round < 5; round++) {
    for (const quality of qualities) {
      const blob = await codec.encode(
        decoded.source,
        target.width,
        target.height,
        "image/jpeg",
        quality,
      );
      if (
        blob.size <= IMAGE_MAX_BYTES &&
        estimateSingleAttachmentSubmitBytes(blob.size, jpegName) <= SUBMIT_MESSAGE_LIMIT
      ) {
        return {
          name: jpegName,
          data: new Uint8Array(await blob.arrayBuffer()),
          mimeType: "image/jpeg",
          width: target.width,
          height: target.height,
        };
      }
    }
    const next = fitHalf(target.width, target.height);
    if (next.width === target.width && next.height === target.height) break;
    target = next;
  }
  throw new Error(`图片过大，无法压缩到传输上限以内：${name}`);
}

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
