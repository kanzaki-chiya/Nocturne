/**
 * 图片文件头识别与自动缩小/切段规划（ADR-0023 第 2 节、ADR-0090）：纯函数、无依赖。
 * 魔数与头部解析不解码图像数据；截断/损坏一律返回 undefined，由调用方决定降级文案。
 */
import {
  IMAGE_MAX_BYTES,
  IMAGE_MAX_PIXELS,
  type ImageMimeType,
  type ImageRegion,
} from "../protocol/index.js";

export { IMAGE_MAX_BYTES, IMAGE_MAX_PIXELS };

/** 触发自动压缩的单张体积阈值及处理后单张目标上限：3.5 MB（base64 后约 4.7 MB） */
export const IMAGE_TARGET_MAX_BYTES = 3.5 * 1024 * 1024;
/** 触发自动压缩的单边像素阈值（满足任一处理条件时整张或分段控制） */
export const IMAGE_PROCESS_MAX_EDGE = 8000;
/** 处理后单张（或单段）长边上限：2576 px */
export const IMAGE_TARGET_MAX_EDGE = 2576;
/** 切段触发的短边基准：长边缩到 2576 px 后短边小于 768 px 则切段 */
export const IMAGE_TILE_MIN_SHORT_EDGE = 768;
/** 相邻两段重叠像素：64 px */
export const IMAGE_TILE_OVERLAP = 64;
/** 单张图片最多切段数：8 段 */
export const IMAGE_MAX_TILES = 8;
/** 8 段（长边 ≤ 2576、重叠 64）可覆盖的最大长边：20160 px */
export const IMAGE_MAX_TILED_LONG_EDGE =
  IMAGE_MAX_TILES * IMAGE_TARGET_MAX_EDGE - (IMAGE_MAX_TILES - 1) * IMAGE_TILE_OVERLAP;
/** 编码 JPEG 时的逐级降质档位 */
export const IMAGE_JPEG_QUALITIES = [85, 75, 60] as const;

/** 人读的支持格式列表（错误说明共用口径） */
export const SUPPORTED_IMAGE_FORMATS = "PNG、JPEG、GIF、WebP";

/** 统一硬上限说明文案 */
export const IMAGE_LIMIT_TEXT =
  "单张图片原始文件不超过 50 MB（50×1024×1024 字节）、总像素不超过 64,000,000";

/** GIF 不支持自动压缩/切段时的说明文案 */
export const IMAGE_GIF_LIMIT_TEXT =
  "GIF 图片不支持自动缩小或切段（单张不超过 3.5 MB、每边不超过 8000 px、长宽比符合单张范围）";

export class ImageTooLargeError extends Error {
  readonly code = "image_too_large" as const;
  constructor(message: string) {
    super(message);
    this.name = "ImageTooLargeError";
  }
}

export class ImageCorruptError extends Error {
  readonly code = "image_corrupt" as const;
  constructor(message: string) {
    super(message);
    this.name = "ImageCorruptError";
  }
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, offset: number, magic: readonly number[]): boolean {
  if (bytes.length < offset + magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (bytes[offset + i] !== magic[i]) return false;
  }
  return true;
}

function asciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
  if (bytes.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

const u16be = (b: Uint8Array, o: number) => ((b[o] ?? 0) << 8) | (b[o + 1] ?? 0);
const u16le = (b: Uint8Array, o: number) => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, o: number) =>
  (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16);
const u32be = (b: Uint8Array, o: number) =>
  ((b[o] ?? 0) << 24) | ((b[o + 1] ?? 0) << 16) | ((b[o + 2] ?? 0) << 8) | (b[o + 3] ?? 0);

/** 只看魔数判断图片格式；不认识或过短返回 undefined */
export function sniffImageMime(bytes: Uint8Array): ImageMimeType | undefined {
  if (startsWith(bytes, 0, PNG_MAGIC)) return "image/png";
  if (startsWith(bytes, 0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (asciiAt(bytes, 0, "GIF87a") || asciiAt(bytes, 0, "GIF89a")) return "image/gif";
  if (asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WEBP")) return "image/webp";
  return undefined;
}

function parsePng(bytes: Uint8Array): { width: number; height: number } | undefined {
  // PNG 签名(8) + IHDR 长度(4) + "IHDR"(4) + 宽/高 各 u32 大端
  if (bytes.length < 24 || !asciiAt(bytes, 12, "IHDR")) return undefined;
  const width = u32be(bytes, 16);
  const height = u32be(bytes, 20);
  return { width, height };
}

function parseJpeg(bytes: Uint8Array): { width: number; height: number } | undefined {
  // 段流：FF [填充FF]* <marker> [u16 长度 + 数据]。无长度标记：
  // SOI(D8)/EOI(D9)/TEM(01)/RSTn(D0–D7)；SOF0–SOF15（排除 C4/C8/CC）
  // 的段内第 1 字节是精度，随后高/宽 u16 大端。
  let i = 2; // 跳过 SOI
  while (i + 1 < bytes.length) {
    if (bytes[i] !== 0xff) return undefined; // 段对齐失败
    while (i < bytes.length && bytes[i] === 0xff) i++; // 填充字节
    if (i >= bytes.length) return undefined;
    const marker = bytes[i] ?? 0;
    i++;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9 || marker === 0xda) return undefined; // EOI / SOS：到图像数据仍未见 SOF
    if (i + 2 > bytes.length) return undefined;
    const len = u16be(bytes, i);
    if (len < 2) return undefined;
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (i + 7 > bytes.length || len < 7) return undefined;
      return { width: u16be(bytes, i + 5), height: u16be(bytes, i + 3) };
    }
    i += len;
  }
  return undefined;
}

function parseGif(bytes: Uint8Array): { width: number; height: number } | undefined {
  // 逻辑屏幕描述符：偏移 6/8 的 u16 小端宽高
  if (bytes.length < 10) return undefined;
  return { width: u16le(bytes, 6), height: u16le(bytes, 8) };
}

function parseWebp(bytes: Uint8Array): { width: number; height: number } | undefined {
  // RIFF(4) + size(4) + "WEBP" + chunk FourCC(4) + chunkSize(4)，数据从 20 起
  if (bytes.length < 20) return undefined;
  if (asciiAt(bytes, 12, "VP8X")) {
    // 扩展头：flags(1)+保留(3)，其后宽/高各 24 位小端存 值-1
    if (bytes.length < 30) return undefined;
    return { width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 };
  }
  if (asciiAt(bytes, 12, "VP8L")) {
    // 无损：签名 0x2F，随后 32 位小端中 bits0-13=宽-1、bits14-27=高-1
    if (bytes.length < 25 || bytes[20] !== 0x2f) return undefined;
    const bits =
      (bytes[21] ?? 0) |
      ((bytes[22] ?? 0) << 8) |
      ((bytes[23] ?? 0) << 16) |
      ((bytes[24] ?? 0) << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (asciiAt(bytes, 12, "VP8 ")) {
    // 有损：帧头 3 字节 + 起始码 9D 01 2A，随后宽/高 u16 小端低 14 位
    if (bytes.length < 30 || !startsWith(bytes, 23, [0x9d, 0x01, 0x2a])) return undefined;
    return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
  }
  return undefined;
}

/** 从文件头解析宽高；截断/损坏/宽高为 0 返回 undefined */
export function parseImageSize(
  bytes: Uint8Array,
  mime: ImageMimeType,
): { width: number; height: number } | undefined {
  const size =
    mime === "image/png"
      ? parsePng(bytes)
      : mime === "image/jpeg"
        ? parseJpeg(bytes)
        : mime === "image/gif"
          ? parseGif(bytes)
          : parseWebp(bytes);
  if (size === undefined || size.width === 0 || size.height === 0) return undefined;
  return size;
}

/** 判断是否超出输入硬上限（50 MB 或 64,000,000 像素） */
export function exceedsImageHardLimit(input: {
  width?: number | undefined;
  height?: number | undefined;
  bytes: number;
}): "bytes" | "pixels" | undefined {
  if (input.bytes > IMAGE_MAX_BYTES) return "bytes";
  if (
    input.width !== undefined &&
    input.height !== undefined &&
    input.width * input.height > IMAGE_MAX_PIXELS
  )
    return "pixels";
  return undefined;
}

/** 条件 (c)：长边 > 2576 且长宽比 > 2576/768（整张缩到 2576 后短边会小于 768） */
export function shouldTileImage(width: number, height: number): boolean {
  const longEdge = Math.max(width, height);
  const shortEdge = Math.min(width, height);
  return (
    longEdge > IMAGE_TARGET_MAX_EDGE &&
    longEdge * IMAGE_TILE_MIN_SHORT_EDGE > shortEdge * IMAGE_TARGET_MAX_EDGE
  );
}

/** 是否满足处理条件 (a)/(b)/(c) 之一 */
export function needsImageProcessing(input: {
  width: number;
  height: number;
  bytes: number;
}): boolean {
  if (input.bytes > IMAGE_TARGET_MAX_BYTES) return true;
  if (Math.max(input.width, input.height) > IMAGE_PROCESS_MAX_EDGE) return true;
  return shouldTileImage(input.width, input.height);
}

export interface PlannedTile {
  x: number;
  y: number;
  width: number;
  height: number;
  region: ImageRegion;
}

export type ImageProcessingPlan =
  | { kind: "none" }
  | { kind: "downscale"; targetWidth: number; targetHeight: number; region: ImageRegion }
  | { kind: "tile"; scaledWidth: number; scaledHeight: number; tiles: PlannedTile[] };

/** 计算整张缩小或长图切段规划（纯计算，ADR-0090） */
export function planImageProcessing(input: {
  width: number;
  height: number;
  bytes: number;
}): ImageProcessingPlan {
  const { width, height, bytes } = input;
  if (!needsImageProcessing({ width, height, bytes })) return { kind: "none" };

  if (!shouldTileImage(width, height)) {
    const longEdge = Math.max(width, height);
    if (longEdge <= IMAGE_TARGET_MAX_EDGE) {
      return {
        kind: "downscale",
        targetWidth: width,
        targetHeight: height,
        region: { x: 0, y: 0, width, height },
      };
    }
    const scale = IMAGE_TARGET_MAX_EDGE / longEdge;
    const targetWidth =
      width >= height ? IMAGE_TARGET_MAX_EDGE : Math.max(1, Math.round(width * scale));
    const targetHeight =
      height > width ? IMAGE_TARGET_MAX_EDGE : Math.max(1, Math.round(height * scale));
    return {
      kind: "downscale",
      targetWidth,
      targetHeight,
      region: { x: 0, y: 0, width, height },
    };
  }

  const isVertical = height >= width;
  const shortEdge = isVertical ? width : height;
  const longEdge = isVertical ? height : width;

  let scale = 1;
  if (shortEdge > IMAGE_TARGET_MAX_EDGE) {
    scale = IMAGE_TARGET_MAX_EDGE / shortEdge;
  }
  if (Math.round(longEdge * scale) > IMAGE_MAX_TILED_LONG_EDGE) {
    scale = IMAGE_MAX_TILED_LONG_EDGE / longEdge;
  }

  const scaledShort =
    scale < 1
      ? Math.min(IMAGE_TARGET_MAX_EDGE, Math.max(1, Math.round(shortEdge * scale)))
      : shortEdge;
  const scaledLong =
    scale < 1
      ? Math.min(IMAGE_MAX_TILED_LONG_EDGE, Math.max(1, Math.round(longEdge * scale)))
      : longEdge;
  const scaledWidth = isVertical ? scaledShort : scaledLong;
  const scaledHeight = isVertical ? scaledLong : scaledShort;

  const stride = IMAGE_TARGET_MAX_EDGE - IMAGE_TILE_OVERLAP;
  const tiles: PlannedTile[] = [];
  let offset = 0;
  while (offset < scaledLong) {
    const len = Math.min(IMAGE_TARGET_MAX_EDGE, scaledLong - offset);
    const tx = isVertical ? 0 : offset;
    const ty = isVertical ? offset : 0;
    const tw = isVertical ? scaledWidth : len;
    const th = isVertical ? len : scaledHeight;
    let region: ImageRegion;
    if (scaledWidth === width && scaledHeight === height) {
      region = { x: tx, y: ty, width: tw, height: th };
    } else {
      const rx = Math.min(width - 1, Math.floor((tx / scaledWidth) * width));
      const ry = Math.min(height - 1, Math.floor((ty / scaledHeight) * height));
      const rx2 = Math.min(width, Math.round(((tx + tw) / scaledWidth) * width));
      const ry2 = Math.min(height, Math.round(((ty + th) / scaledHeight) * height));
      region = {
        x: rx,
        y: ry,
        width: Math.max(1, rx2 - rx),
        height: Math.max(1, ry2 - ry),
      };
    }
    tiles.push({ x: tx, y: ty, width: tw, height: th, region });
    if (offset + len >= scaledLong) break;
    offset += stride;
  }

  return { kind: "tile", scaledWidth, scaledHeight, tiles };
}

/** 降质到 q60 后仍超 3.5 MB 时计算下一次等比缩小的目标尺寸 */
export function nextShrinkDimensions(
  width: number,
  height: number,
  encodedBytes: number,
  targetMaxBytes = IMAGE_TARGET_MAX_BYTES,
): { width: number; height: number } {
  const ratio = Math.min(0.85, Math.max(0.25, Math.sqrt(targetMaxBytes / encodedBytes) * 0.9));
  return {
    width: width === 1 ? 1 : Math.max(1, Math.min(width - 1, Math.round(width * ratio))),
    height: height === 1 ? 1 : Math.max(1, Math.min(height - 1, Math.round(height * ratio))),
  };
}
