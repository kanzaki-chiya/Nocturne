import { describe, expect, it } from "vitest";

import { parseImageSize, sniffImageMime } from "./image.js";

const u8 = (arr: number[]): Uint8Array => new Uint8Array(arr);
const u16be = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const u16le = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const u32be = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** 合法 PNG 头：签名 + IHDR 长度 + "IHDR" + 宽/高 u32 大端 */
function pngBytes(width: number, height: number): Uint8Array {
  return u8([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...u32be(13),
    ...ascii("IHDR"),
    ...u32be(width),
    ...u32be(height),
    8,
    6,
    0,
    0,
    0,
  ]);
}

/** JPEG：SOI + APP0 + SOF0(precision, h, w) */
function jpegBytes(width: number, height: number): Uint8Array {
  return u8([
    0xff,
    0xd8, // SOI
    0xff,
    0xe0,
    ...u16be(16),
    ...ascii("JFIF"),
    0,
    ...new Array(16 - 2 - 5).fill(0), // APP0
    0xff,
    0xff, // 填充
    0xff,
    0xc0,
    ...u16be(17),
    8,
    ...u16be(height),
    ...u16be(width),
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
  ]);
}

function gifBytes(width: number, height: number): Uint8Array {
  return u8([...ascii("GIF89a"), ...u16le(width), ...u16le(height), 0xf0, 0, 0]);
}

function webpHeader(chunk: string, data: number[]): Uint8Array {
  return u8([
    ...ascii("RIFF"),
    ...u32be(data.length + 4), // size 字段值不重要
    ...ascii("WEBP"),
    ...ascii(chunk),
    ...u32be(data.length),
    ...data,
  ]);
}

/** VP8（有损）：3 字节帧头 + 起始码 9D 01 2A + 宽/高 u16 小端（低 14 位） */
function webpVp8(width: number, height: number): Uint8Array {
  return webpHeader("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, ...u16le(width), ...u16le(height)]);
}

/** VP8L（无损）：签名 0x2F + 32 位小端（bits0-13=宽-1、bits14-27=高-1） */
function webpVp8l(width: number, height: number): Uint8Array {
  const bits = (width - 1) | ((height - 1) << 14);
  return webpHeader("VP8L", [
    0x2f,
    bits & 0xff,
    (bits >> 8) & 0xff,
    (bits >> 16) & 0xff,
    (bits >> 24) & 0xff,
  ]);
}

/** VP8X（扩展）：flags(1)+保留(3) + 宽-1/高-1 各 24 位小端 */
function webpVp8x(width: number, height: number): Uint8Array {
  const w = width - 1;
  const h = height - 1;
  return webpHeader("VP8X", [
    0,
    0,
    0,
    0,
    w & 0xff,
    (w >> 8) & 0xff,
    (w >> 16) & 0xff,
    h & 0xff,
    (h >> 8) & 0xff,
    (h >> 16) & 0xff,
  ]);
}

describe("sniffImageMime", () => {
  it("四种格式的魔数识别", () => {
    expect(sniffImageMime(pngBytes(1, 1))).toBe("image/png");
    expect(sniffImageMime(jpegBytes(1, 1))).toBe("image/jpeg");
    expect(sniffImageMime(gifBytes(1, 1))).toBe("image/gif");
    expect(sniffImageMime(u8([...ascii("GIF87a"), 1, 0, 1, 0]))).toBe("image/gif");
    expect(sniffImageMime(webpVp8(1, 1))).toBe("image/webp");
  });

  it("不认识或过短 → undefined", () => {
    expect(sniffImageMime(u8([]))).toBeUndefined();
    expect(sniffImageMime(u8([0x89, 0x50]))).toBeUndefined();
    expect(sniffImageMime(u8([...ascii("BM"), 0, 0]))).toBeUndefined();
    expect(sniffImageMime(u8(ascii("<svg x")))).toBeUndefined();
    // RIFF 但非 WEBP（如 WAV）
    expect(sniffImageMime(u8([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WAVE")]))).toBeUndefined();
  });
});

describe("parseImageSize", () => {
  it("PNG：IHDR 宽高", () => {
    expect(parseImageSize(pngBytes(640, 480), "image/png")).toEqual({ width: 640, height: 480 });
  });

  it("PNG：截断头 / 非 IHDR 首块 → undefined", () => {
    expect(parseImageSize(pngBytes(1, 1).subarray(0, 12), "image/png")).toBeUndefined();
    const bad = pngBytes(1, 1);
    bad[12] = 0x58; // IHDR → XHDR
    expect(parseImageSize(bad, "image/png")).toBeUndefined();
    expect(parseImageSize(pngBytes(0, 10), "image/png")).toBeUndefined();
  });

  it("JPEG：SOF0 宽高；截断/无 SOF → undefined", () => {
    expect(parseImageSize(jpegBytes(1920, 1080), "image/jpeg")).toEqual({
      width: 1920,
      height: 1080,
    });
    expect(parseImageSize(jpegBytes(1, 1).subarray(0, 10), "image/jpeg")).toBeUndefined();
    // SOI 后直接 SOS：到图像数据仍未见 SOF
    expect(parseImageSize(u8([0xff, 0xd8, 0xff, 0xda, 0, 8, 1]), "image/jpeg")).toBeUndefined();
    expect(parseImageSize(jpegBytes(0, 5), "image/jpeg")).toBeUndefined();
  });

  it("GIF：逻辑屏幕宽高", () => {
    expect(parseImageSize(gifBytes(320, 240), "image/gif")).toEqual({ width: 320, height: 240 });
    expect(parseImageSize(gifBytes(1, 1).subarray(0, 8), "image/gif")).toBeUndefined();
    expect(parseImageSize(gifBytes(0, 2), "image/gif")).toBeUndefined();
  });

  it("WebP：VP8 / VP8L / VP8X 三种形态", () => {
    expect(parseImageSize(webpVp8(800, 600), "image/webp")).toEqual({ width: 800, height: 600 });
    expect(parseImageSize(webpVp8l(16384 - 1, 5), "image/webp")).toEqual({
      width: 16383,
      height: 5,
    });
    expect(parseImageSize(webpVp8x(4000, 3000), "image/webp")).toEqual({
      width: 4000,
      height: 3000,
    });
  });

  it("WebP：截断、缺起始码、未知 chunk → undefined", () => {
    expect(parseImageSize(webpVp8(1, 1).subarray(0, 16), "image/webp")).toBeUndefined();
    expect(parseImageSize(webpVp8(1, 1).subarray(0, 25), "image/webp")).toBeUndefined();
    const noStart = webpVp8(1, 1);
    noStart[23] = 0x00; // 抹掉 9D
    expect(parseImageSize(noStart, "image/webp")).toBeUndefined();
    const badSig = webpVp8l(1, 1);
    badSig[20] = 0x00; // VP8L 签名必须 0x2F
    expect(parseImageSize(badSig, "image/webp")).toBeUndefined();
    expect(parseImageSize(webpHeader("XTRA", [1, 2, 3]), "image/webp")).toBeUndefined();
  });
});
