/**
 * 图片文件头识别（ADR-0023 第 2 节）：纯函数、无依赖。
 * 只看魔数与头部固定字段，不解码图像数据；截断/损坏一律返回
 * undefined，由调用方决定降级文案。
 */
import type { ImageMimeType } from "../protocol/index.js";

/** 单张图片原始文件上限：5 MB（read 工具拒绝超限） */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
/** 图片单边像素上限 */
export const IMAGE_MAX_EDGE = 8000;
/** 人读的支持格式列表（错误说明共用口径） */
export const SUPPORTED_IMAGE_FORMATS = "PNG、JPEG、GIF、WebP";

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
