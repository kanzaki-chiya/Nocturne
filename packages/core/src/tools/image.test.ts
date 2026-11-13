import { describe, expect, it } from "vitest";

import {
  IMAGE_MAX_BYTES,
  IMAGE_MAX_PIXELS,
  IMAGE_TARGET_MAX_BYTES,
  IMAGE_TARGET_MAX_EDGE,
  exceedsImageHardLimit,
  needsImageProcessing,
  nextShrinkDimensions,
  parseImageSize,
  planImageProcessing,
  shouldTileImage,
  sniffImageMime,
} from "./image.js";

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

describe("image processing math & planning (ADR-0090)", () => {
  it("硬上限：50 MB 与 64,000,000 像素边界", () => {
    expect(
      exceedsImageHardLimit({ width: 8000, height: 8000, bytes: IMAGE_MAX_BYTES }),
    ).toBeUndefined();
    expect(exceedsImageHardLimit({ width: 8000, height: 8000, bytes: IMAGE_MAX_BYTES + 1 })).toBe(
      "bytes",
    );
    expect(exceedsImageHardLimit({ width: 8001, height: 8001, bytes: 1000 })).toBe("pixels");
    expect(exceedsImageHardLimit({ width: 1849, height: 16348, bytes: 9_900_000 })).toBeUndefined();
    expect(1849 * 16348).toBeLessThanOrEqual(IMAGE_MAX_PIXELS);
  });

  it("三种处理条件边界：(a) >3.5 MB、(b) >8000 px、(c) 长边 >2576 且长短比 >2576/768", () => {
    expect(needsImageProcessing({ width: 1920, height: 1080, bytes: IMAGE_TARGET_MAX_BYTES })).toBe(
      false,
    );
    expect(needsImageProcessing({ width: 8000, height: 8000, bytes: IMAGE_TARGET_MAX_BYTES })).toBe(
      false,
    );
    expect(needsImageProcessing({ width: 768, height: 2576, bytes: 100_000 })).toBe(false);
    expect(needsImageProcessing({ width: 1000, height: 3354, bytes: 100_000 })).toBe(false);
    expect(shouldTileImage(1000, 3354)).toBe(false);

    expect(
      needsImageProcessing({ width: 1920, height: 1080, bytes: IMAGE_TARGET_MAX_BYTES + 1 }),
    ).toBe(true);
    expect(needsImageProcessing({ width: 8001, height: 4000, bytes: 100_000 })).toBe(true);
    expect(shouldTileImage(8001, 4000)).toBe(false);
    expect(shouldTileImage(768, 2577)).toBe(true);
    expect(shouldTileImage(1000, 3355)).toBe(true);
    expect(needsImageProcessing({ width: 1000, height: 3355, bytes: 100_000 })).toBe(true);
  });

  it("整张缩小：长边<=2576 保持尺寸只转码；长边>2576 缩到长边 2576", () => {
    expect(planImageProcessing({ width: 1000, height: 1000, bytes: 100_000 })).toEqual({
      kind: "none",
    });
    expect(
      planImageProcessing({ width: 1000, height: 1000, bytes: IMAGE_TARGET_MAX_BYTES + 1 }),
    ).toEqual({
      kind: "downscale",
      targetWidth: 1000,
      targetHeight: 1000,
      region: { x: 0, y: 0, width: 1000, height: 1000 },
    });
    expect(planImageProcessing({ width: 8001, height: 4000, bytes: 100_000 })).toEqual({
      kind: "downscale",
      targetWidth: 2576,
      targetHeight: 1288,
      region: { x: 0, y: 0, width: 8001, height: 4000 },
    });
  });

  it("切段计算：1849×16348 切成 7 段，重叠 64 px，短边<=2576 不先缩", () => {
    const plan = planImageProcessing({ width: 1849, height: 16348, bytes: 9_900_000 });
    expect(plan.kind).toBe("tile");
    if (plan.kind !== "tile") return;
    expect(plan.scaledWidth).toBe(1849);
    expect(plan.scaledHeight).toBe(16348);
    expect(plan.tiles).toHaveLength(7);
    for (let i = 0; i < plan.tiles.length; i++) {
      const tile = plan.tiles[i];
      if (!tile) throw new Error("missing tile");
      expect(tile.width).toBe(1849);
      expect(tile.height).toBeLessThanOrEqual(IMAGE_TARGET_MAX_EDGE);
      expect(tile.region).toEqual({ x: tile.x, y: tile.y, width: tile.width, height: tile.height });
      if (i > 0) {
        const prev = plan.tiles[i - 1];
        if (!prev) throw new Error("missing prev tile");
        expect(prev.y + prev.height - tile.y).toBe(64);
      }
    }
    const last = plan.tiles.at(-1);
    expect(last?.y).toBeDefined();
    expect((last?.y ?? 0) + (last?.height ?? 0)).toBe(16348);
  });

  it("切段：短边超过 2576 px 先等比缩到 2576；横向宽图沿 X 轴切", () => {
    const tall = planImageProcessing({ width: 3000, height: 12000, bytes: 1_000_000 });
    expect(tall.kind).toBe("tile");
    if (tall.kind === "tile") {
      expect(tall.scaledWidth).toBe(2576);
      expect(tall.scaledHeight).toBe(Math.round((12000 * 2576) / 3000));
      expect(tall.tiles.length).toBeLessThanOrEqual(8);
    }

    const wide = planImageProcessing({ width: 10000, height: 1000, bytes: 500_000 });
    expect(wide.kind).toBe("tile");
    if (wide.kind === "tile") {
      expect(wide.scaledWidth).toBe(10000);
      expect(wide.scaledHeight).toBe(1000);
      expect(wide.tiles).toHaveLength(4);
      const t0 = wide.tiles[0];
      const t1 = wide.tiles[1];
      expect(t1?.x).toBe(2512);
      expect((t0?.x ?? 0) + (t0?.width ?? 0) - (t1?.x ?? 0)).toBe(64);
    }
  });

  it("切段上限：最多 8 段，超长图先等比缩到 8 段能放下的尺寸", () => {
    const plan = planImageProcessing({ width: 1000, height: 30_000, bytes: 1_000_000 });
    expect(plan.kind).toBe("tile");
    if (plan.kind !== "tile") return;
    expect(plan.tiles).toHaveLength(8);
    expect(plan.scaledHeight).toBe(8 * 2576 - 7 * 64);
    expect(plan.scaledWidth).toBe(Math.round((1000 * plan.scaledHeight) / 30_000));
    expect(plan.tiles[0]?.region.y).toBe(0);
    const last = plan.tiles.at(-1);
    expect((last?.region.y ?? 0) + (last?.region.height ?? 0)).toBe(30_000);
  });

  it("降质后仍超 3.5 MB 时等比缩小尺寸严格递减", () => {
    const next = nextShrinkDimensions(2576, 2576, 6 * 1024 * 1024, IMAGE_TARGET_MAX_BYTES);
    expect(next.width).toBeLessThan(2576);
    expect(next.height).toBeLessThan(2576);
    expect(next.width).toBeGreaterThan(0);
    expect(nextShrinkDimensions(1, 1, 10_000_000, 1000)).toEqual({ width: 1, height: 1 });
  });
});
