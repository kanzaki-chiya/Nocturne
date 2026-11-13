import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import jpegDecode, { init as initJpegDecode } from "@jsquash/jpeg/decode.js";
import jpegEncode, { init as initJpegEncode } from "@jsquash/jpeg/encode.js";
import webpEncode, { init as initWebpEncode } from "@jsquash/webp/encode.js";

import { createPlatform } from "../platform/index.js";
import { createAttachmentStore } from "./attachments.js";
import {
  IMAGE_MAX_BYTES,
  IMAGE_TARGET_MAX_BYTES,
  ImageTooLargeError,
  parseImageSize,
  planImageProcessing,
} from "./image.js";
import { createImageProcessor } from "./image-processor.js";

const require = createRequire(import.meta.url);
const platform = createPlatform();
const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmpDir(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

let codecsReady: Promise<void> | undefined;
function ensureTestCodecs(): Promise<void> {
  if (codecsReady === undefined) {
    codecsReady = (async () => {
      const g = globalThis as unknown as {
        WebAssembly: { Module: new (b: Uint8Array) => unknown };
      };
      const loadMod = (spec: string) =>
        new g.WebAssembly.Module(readFileSync(require.resolve(spec)));
      await (initJpegDecode as unknown as (m: unknown) => Promise<void>)(
        loadMod("@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm"),
      );
      await (initJpegEncode as unknown as (m: unknown) => Promise<void>)(
        loadMod("@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm"),
      );
      await (initWebpEncode as unknown as (m: unknown) => Promise<void>)(
        loadMod("@jsquash/webp/codec/enc/webp_enc.wasm"),
      );
    })();
  }
  return codecsReady;
}

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 4, "ascii");
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePngRgba(
  width: number,
  height: number,
  fill: (x: number, y: number) => [number, number, number, number],
): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const rowBytes = 1 + width * 4;
  const raw = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowBytes;
    raw[rowStart] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = fill(x, y);
      const p = rowStart + 1 + x * 4;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
      raw[p + 3] = a;
    }
  }
  const idat = deflateSync(raw, { level: 1 });
  return Uint8Array.from(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk("IHDR", ihdr),
      pngChunk("IDAT", idat),
      pngChunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

function makeGifHeader(width: number, height: number, bytesLength: number): Uint8Array {
  const buf = new Uint8Array(Math.max(14, bytesLength));
  buf.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]); // GIF89a
  buf[6] = width & 0xff;
  buf[7] = (width >> 8) & 0xff;
  buf[8] = height & 0xff;
  buf[9] = (height >> 8) & 0xff;
  return buf;
}

describe("image worker & AttachmentStore processing (ADR-0090)", () => {
  it("支持 PNG（含透明铺白底）、JPEG、WebP 输入并产出 JPEG 处理结果", async () => {
    await ensureTestCodecs();
    const processor = createImageProcessor({ idleTimeoutMs: 5000 });
    try {
      const dir = tmpDir("nct-w-");
      const store = createAttachmentStore({
        fs: platform.fs,
        paths: platform.paths,
        attachmentsDir: dir,
        sessionId: "s1",
        processor,
      });

      // 1. 透明 PNG（超长触发切段：100×3600）→ 铺白底切 2 段 JPEG
      const transparentPng = encodePngRgba(100, 3600, (_x, y) =>
        y < 100 ? [0, 0, 0, 0] : [20, 40, 200, 255],
      );
      const pngAtt = await store.save({
        data: transparentPng,
        mimeType: "image/png",
        source: "paste",
      });
      expect(pngAtt.processed).toHaveLength(2);
      const p0 = pngAtt.processed?.[0];
      const p1 = pngAtt.processed?.[1];
      if (!p0 || !p1) throw new Error("missing processed tiles");
      expect(p0).toMatchObject({
        mimeType: "image/jpeg",
        width: 100,
        height: 1832,
        region: { x: 0, y: 0, width: 100, height: 1832 },
      });
      expect(p1).toMatchObject({
        mimeType: "image/jpeg",
        width: 100,
        height: 1832,
        region: { x: 0, y: 1768, width: 100, height: 1832 },
      });
      // 第一段顶部原为完全透明，铺白底后应接近 (255,255,255)
      const tile0Bytes = await store.load(p0);
      if (!tile0Bytes) throw new Error("missing tile0 bytes");
      const decoded0 = await jpegDecode(tile0Bytes.slice().buffer);
      expect(decoded0.data[0]).toBeGreaterThanOrEqual(250);
      expect(decoded0.data[1]).toBeGreaterThanOrEqual(250);
      expect(decoded0.data[2]).toBeGreaterThanOrEqual(250);
      // 原图文件仍在
      expect(await store.load(pngAtt)).toEqual(transparentPng);

      // 2. JPEG 输入（100×3600）→ 切 2 段 JPEG
      const rgba = new Uint8ClampedArray(100 * 3600 * 4).fill(200);
      const tallJpeg = new Uint8Array(
        await (
          jpegEncode as unknown as (
            img: { data: Uint8ClampedArray; width: number; height: number },
            opts: { quality: number },
          ) => Promise<ArrayBuffer>
        )({ data: rgba, width: 100, height: 3600 }, { quality: 80 }),
      );
      const jpgAtt = await store.save({
        data: tallJpeg,
        mimeType: "image/jpeg",
        source: "read",
      });
      expect(jpgAtt.processed).toHaveLength(2);

      // 3. WebP 输入（100×3600）→ 切 2 段 JPEG
      const tallWebp = new Uint8Array(
        await (
          webpEncode as unknown as (
            img: { data: Uint8ClampedArray; width: number; height: number },
            opts: { quality: number },
          ) => Promise<ArrayBuffer>
        )({ data: rgba, width: 100, height: 3600 }, { quality: 80 }),
      );
      const webpAtt = await store.save({
        data: tallWebp,
        mimeType: "image/webp",
        source: "read",
      });
      expect(webpAtt.processed).toHaveLength(2);
    } finally {
      await processor.close();
    }
  });

  it("高熵大图触发 JPEG 降质或缩尺寸，最终不超过 3.5 MB", async () => {
    // 构造一张高熵不可压缩的 2000×2000 PNG（>3.5 MB）或用 worker 直接验证单图预算
    // 注意：2576×2576 的确定性伪随机噪声编码成 JPEG q85 约 4.5-6 MB，会触发 q85->q75->q60
    const width = 2576;
    const height = 2576;
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const rowBytes = 1 + width * 4;
    const raw = Buffer.alloc(rowBytes * height);
    let seed = 0x12345678;
    for (let y = 0; y < height; y++) {
      const rowStart = y * rowBytes;
      raw[rowStart] = 0;
      for (let x = 0; x < width; x++) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        const p = rowStart + 1 + x * 4;
        raw[p] = seed & 0xff;
        raw[p + 1] = (seed >>> 8) & 0xff;
        raw[p + 2] = (seed >>> 16) & 0xff;
        raw[p + 3] = 255;
      }
    }
    const idat = deflateSync(raw, { level: 1 });
    const noisyPng = Uint8Array.from(
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk("IHDR", ihdr),
        pngChunk("IDAT", idat),
        pngChunk("IEND", Buffer.alloc(0)),
      ]),
    );
    expect(noisyPng.byteLength).toBeGreaterThan(IMAGE_TARGET_MAX_BYTES);
    const processor = createImageProcessor({ idleTimeoutMs: 5000 });
    try {
      const plan = planImageProcessing({ width, height, bytes: noisyPng.byteLength });
      expect(plan.kind).toBe("downscale");
      if (plan.kind === "none") return;
      const tiles: Uint8Array[] = [];
      await processor.process(
        { data: noisyPng, mimeType: "image/png", plan },
        {
          onTile(t) {
            tiles.push(t.data);
          },
        },
      );
      expect(tiles).toHaveLength(1);
      const t0 = tiles[0];
      if (!t0) throw new Error("missing tile0");
      expect(t0.byteLength).toBeLessThanOrEqual(IMAGE_TARGET_MAX_BYTES);
      const size = parseImageSize(t0, "image/jpeg");
      expect(size).toBeDefined();
      expect(size?.width).toBeLessThanOrEqual(2576);
    } finally {
      await processor.close();
    }
  }, 30_000);

  it("超过硬上限与需要处理的 GIF 报 ImageTooLargeError；小 GIF 原样保留", async () => {
    const processor = createImageProcessor({ idleTimeoutMs: 5000 });
    try {
      const dir = tmpDir("nct-lim-");
      const store = createAttachmentStore({
        fs: platform.fs,
        paths: platform.paths,
        attachmentsDir: dir,
        sessionId: "s1",
        processor,
      });

      const tooBigBytes = new Uint8Array(IMAGE_MAX_BYTES + 1);
      tooBigBytes.set(makeGifHeader(10, 10, 14));
      await expect(
        store.save({ data: tooBigBytes, mimeType: "image/gif", source: "paste" }),
      ).rejects.toBeInstanceOf(ImageTooLargeError);

      const tooManyPixels = encodePngRgba(10, 10, () => [0, 0, 0, 255]);
      // 伪造 IHDR 为 8001x8001（>64M 像素）
      const spoofed = Uint8Array.from(tooManyPixels);
      const view = Buffer.from(spoofed.buffer, spoofed.byteOffset, spoofed.byteLength);
      view.writeUInt32BE(8001, 16);
      view.writeUInt32BE(8001, 20);
      await expect(
        store.save({ data: spoofed, mimeType: "image/png", source: "paste" }),
      ).rejects.toBeInstanceOf(ImageTooLargeError);

      // 小 GIF：原样保存，不报错
      const smallGif = makeGifHeader(100, 100, 100);
      const okGif = await store.save({ data: smallGif, mimeType: "image/gif", source: "paste" });
      expect(okGif.processed).toBeUndefined();

      // 触发处理条件的 GIF：报不支持自动缩小
      const bigGif = makeGifHeader(100, 4000, 100);
      await expect(
        store.save({ data: bigGif, mimeType: "image/gif", source: "paste" }),
      ).rejects.toThrow("GIF");
    } finally {
      await processor.close();
    }
  });

  it("worker 空闲超时后自动退出释放内存；处理中途取消会终止 worker 并删除半成品文件", async () => {
    const processor = createImageProcessor({ idleTimeoutMs: 80 });
    const dir = tmpDir("nct-abort-");
    const store = createAttachmentStore({
      fs: platform.fs,
      paths: platform.paths,
      attachmentsDir: dir,
      sessionId: "s1",
      processor,
    });

    const tallPng = encodePngRgba(200, 16000, (x, y) => [x & 0xff, y & 0xff, (x ^ y) & 0xff, 255]);
    // 1. 先跑完一次，验证空闲退出
    const doneAtt = await store.save({ data: tallPng, mimeType: "image/png", source: "paste" });
    expect(doneAtt.processed?.length).toBeGreaterThan(1);
    expect(processor.hasWorker()).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    expect(processor.hasWorker()).toBe(false);

    // 2. 处理中途取消：等首段落盘触发后再中止
    const sessionDir = path.join(dir, "s2");
    const store2 = createAttachmentStore({
      fs: platform.fs,
      paths: platform.paths,
      attachmentsDir: dir,
      sessionId: "s2",
      processor,
    });
    const ac = new AbortController();
    const savePromise = store2.save({
      data: tallPng,
      mimeType: "image/png",
      source: "paste",
      signal: ac.signal,
    });
    // 轮询直到至少写出首段半成品后再立即中止
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      let existing: string[] = [];
      try {
        existing = readdirSync(sessionDir);
      } catch {
        existing = [];
      }
      if (existing.some((f) => f.startsWith("img-1-"))) {
        ac.abort();
        break;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    if (!ac.signal.aborted) ac.abort();
    await expect(savePromise).rejects.toMatchObject({ name: "AbortError" });
    expect(processor.hasWorker()).toBe(false);
    const remaining = readdirSync(sessionDir);
    expect(remaining).toEqual([]);
    await processor.close();
  });
});
