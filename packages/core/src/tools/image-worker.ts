/**
 * 图片解码、铺白底、缩放、切段与 JPEG 编码 worker（ADR-0090）。
 * 保持仅使用可擦除 TS 语法且不写本地相对 .js 运行时导入，
 * 使源码在 Node 24（vitest）与 tsdown 产物（.mjs）中都能直接以 Worker 启动。
 */
import { parentPort, workerData } from "node:worker_threads";
import jpegDecode, { init as initJpegDecode } from "@jsquash/jpeg/decode.js";
import jpegEncode, { init as initJpegEncode } from "@jsquash/jpeg/encode.js";
import pngDecode, { init as initPngDecode } from "@jsquash/png/decode.js";
import resize, { initResize } from "@jsquash/resize";
import webpDecode, { init as initWebpDecode } from "@jsquash/webp/decode.js";
import type { ImageWasmBytes } from "../platform/image-wasm.js";
import type { ImageRegion } from "../protocol/index.js";

export interface WorkerJobRequest {
  id: number;
  data: Uint8Array;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  maxPixels: number;
  targetMaxBytes: number;
  qualities: readonly number[];
  plan:
    | { kind: "downscale"; targetWidth: number; targetHeight: number; region: ImageRegion }
    | {
        kind: "tile";
        scaledWidth: number;
        scaledHeight: number;
        tiles: readonly {
          x: number;
          y: number;
          width: number;
          height: number;
          region: ImageRegion;
        }[];
      };
}

export type WorkerJobResponse =
  | {
      id: number;
      type: "tile";
      index: number;
      data: ArrayBuffer;
      width: number;
      height: number;
      region: ImageRegion;
    }
  | { id: number; type: "done" }
  | {
      id: number;
      type: "error";
      kind: "corrupt" | "too_large" | "failed";
      message: string;
    };

interface RgbaFrame {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

const g = globalThis as unknown as {
  ImageData?: new (
    dataOrWidth: Uint8ClampedArray | number,
    widthOrHeight: number,
    height?: number,
  ) => RgbaFrame;
  WebAssembly: { Module: new (bytes: Uint8Array) => unknown };
};

class FallbackImageData implements RgbaFrame {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  constructor(dataOrWidth: Uint8ClampedArray | number, widthOrHeight: number, height?: number) {
    if (typeof dataOrWidth === "number") {
      this.width = dataOrWidth;
      this.height = widthOrHeight;
      this.data = new Uint8ClampedArray(this.width * this.height * 4);
    } else {
      this.data = dataOrWidth;
      this.width = widthOrHeight;
      this.height = height ?? Math.floor(dataOrWidth.length / 4 / widthOrHeight);
    }
  }
}

g.ImageData ??= FallbackImageData;

const wasm = (workerData as { wasm: ImageWasmBytes }).wasm;
let pngReady: Promise<void> | undefined;
let jpegDecReady: Promise<void> | undefined;
let jpegEncReady: Promise<void> | undefined;
let webpReady: Promise<void> | undefined;
let resizeReady: Promise<void> | undefined;

function ensurePng(): Promise<void> {
  if (pngReady === undefined) {
    const init = initPngDecode as unknown as (mod: unknown) => Promise<unknown>;
    pngReady = init(new g.WebAssembly.Module(wasm.pngDec)).then(() => undefined);
  }
  return pngReady;
}

function ensureJpegDecode(): Promise<void> {
  if (jpegDecReady === undefined) {
    const init = initJpegDecode as unknown as (mod: unknown) => Promise<void>;
    jpegDecReady = init(new g.WebAssembly.Module(wasm.jpegDec));
  }
  return jpegDecReady;
}

function ensureJpegEncode(): Promise<void> {
  if (jpegEncReady === undefined) {
    const init = initJpegEncode as unknown as (mod: unknown) => Promise<void>;
    jpegEncReady = init(new g.WebAssembly.Module(wasm.jpegEnc));
  }
  return jpegEncReady;
}

function ensureWebp(): Promise<void> {
  if (webpReady === undefined) {
    const init = initWebpDecode as unknown as (mod: unknown) => Promise<void>;
    webpReady = init(new g.WebAssembly.Module(wasm.webpDec));
  }
  return webpReady;
}

function ensureResize(): Promise<void> {
  if (resizeReady === undefined) {
    const init = initResize as unknown as (mod: unknown) => Promise<unknown>;
    resizeReady = init(new g.WebAssembly.Module(wasm.resize)).then(() => undefined);
  }
  return resizeReady;
}

function toExactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength &&
    bytes.buffer instanceof ArrayBuffer
  ) {
    return bytes.buffer;
  }
  return bytes.slice().buffer;
}

class TaggedWorkerError extends Error {
  readonly kind: "corrupt" | "too_large" | "failed";
  constructor(kind: "corrupt" | "too_large" | "failed", message: string) {
    super(message);
    this.kind = kind;
  }
}

async function decodeSource(
  data: Uint8Array,
  mimeType: WorkerJobRequest["mimeType"],
): Promise<RgbaFrame> {
  const buf = toExactArrayBuffer(data);
  const decodePngFn = pngDecode as unknown as (input: ArrayBuffer) => Promise<RgbaFrame>;
  const decodeJpegFn = jpegDecode as unknown as (input: ArrayBuffer) => Promise<RgbaFrame>;
  const decodeWebpFn = webpDecode as unknown as (input: ArrayBuffer) => Promise<RgbaFrame>;
  try {
    if (mimeType === "image/png") {
      await ensurePng();
      const decoded = await decodePngFn(buf);
      return { data: decoded.data, width: decoded.width, height: decoded.height };
    }
    if (mimeType === "image/jpeg") {
      await ensureJpegDecode();
      const decoded = await decodeJpegFn(buf);
      return { data: decoded.data, width: decoded.width, height: decoded.height };
    }
    await ensureWebp();
    const decoded = await decodeWebpFn(buf);
    return { data: decoded.data, width: decoded.width, height: decoded.height };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new TaggedWorkerError("corrupt", `图片解码失败（可能损坏或被截断）：${msg}`);
  }
}

function flattenAlphaOnWhite(data: Uint8ClampedArray): void {
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] ?? 255;
    if (a === 255) continue;
    if (a === 0) {
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = 255;
    } else {
      const inv = 255 - a;
      data[i] = Math.round(((data[i] ?? 0) * a + 255 * inv) / 255);
      data[i + 1] = Math.round(((data[i + 1] ?? 0) * a + 255 * inv) / 255);
      data[i + 2] = Math.round(((data[i + 2] ?? 0) * a + 255 * inv) / 255);
      data[i + 3] = 255;
    }
  }
}

function makeContiguousFrame(frame: RgbaFrame): RgbaFrame {
  if (
    frame.data.byteOffset === 0 &&
    frame.data.byteLength === frame.data.buffer.byteLength &&
    frame.data.buffer instanceof ArrayBuffer
  ) {
    return frame;
  }
  return { data: frame.data.slice(), width: frame.width, height: frame.height };
}

async function resizeFrame(frame: RgbaFrame, width: number, height: number): Promise<RgbaFrame> {
  if (frame.width === width && frame.height === height) return frame;
  await ensureResize();
  const contiguous = makeContiguousFrame(frame);
  const ImageDataCtor = g.ImageData ?? FallbackImageData;
  const input = new ImageDataCtor(
    new Uint8ClampedArray(contiguous.data.buffer, 0, contiguous.data.byteLength),
    contiguous.width,
    contiguous.height,
  );
  const fn = resize as unknown as (
    data: RgbaFrame,
    opts: { width: number; height: number },
  ) => Promise<RgbaFrame>;
  const out = await fn(input, { width, height });
  return { data: out.data, width: out.width, height: out.height };
}

function nextShrinkSize(
  width: number,
  height: number,
  encodedBytes: number,
  targetMaxBytes: number,
): { width: number; height: number } {
  const ratio = Math.min(0.85, Math.max(0.25, Math.sqrt(targetMaxBytes / encodedBytes) * 0.9));
  return {
    width: width === 1 ? 1 : Math.max(1, Math.min(width - 1, Math.round(width * ratio))),
    height: height === 1 ? 1 : Math.max(1, Math.min(height - 1, Math.round(height * ratio))),
  };
}

async function encodeJpeg(frame: RgbaFrame, quality: number): Promise<ArrayBuffer> {
  await ensureJpegEncode();
  const fn = jpegEncode as unknown as (
    data: RgbaFrame,
    opts: { quality: number },
  ) => Promise<ArrayBuffer>;
  return fn(frame, { quality });
}

async function encodeWithBudget(
  initial: RgbaFrame,
  qualities: readonly number[],
  targetMaxBytes: number,
): Promise<{ buffer: ArrayBuffer; width: number; height: number }> {
  let cur = initial;
  let lastBytes = 0;
  for (const quality of qualities) {
    const buffer = await encodeJpeg(cur, quality);
    lastBytes = buffer.byteLength;
    if (lastBytes <= targetMaxBytes) {
      return { buffer, width: cur.width, height: cur.height };
    }
  }
  const fallbackQuality = qualities[qualities.length - 1] ?? 60;
  for (let round = 0; round < 12; round++) {
    if (cur.width === 1 && cur.height === 1) break;
    const next = nextShrinkSize(cur.width, cur.height, lastBytes, targetMaxBytes);
    cur = await resizeFrame(cur, next.width, next.height);
    const buffer = await encodeJpeg(cur, fallbackQuality);
    lastBytes = buffer.byteLength;
    if (lastBytes <= targetMaxBytes) {
      return { buffer, width: cur.width, height: cur.height };
    }
  }
  throw new TaggedWorkerError("too_large", "图片压缩后仍超过单张体积上限");
}

function copyTileRect(
  frame: RgbaFrame,
  x: number,
  y: number,
  width: number,
  height: number,
  scratch?: Uint8ClampedArray,
): { frame: RgbaFrame; scratch?: Uint8ClampedArray } {
  if (x === 0 && width === frame.width) {
    const byteOffset = frame.data.byteOffset + y * frame.width * 4;
    const byteLength = height * frame.width * 4;
    const view = new Uint8ClampedArray(frame.data.buffer, byteOffset, byteLength);
    return { frame: { data: view, width, height }, ...(scratch ? { scratch } : {}) };
  }
  const needed = width * height * 4;
  const buf =
    scratch !== undefined && scratch.byteLength >= needed ? scratch : new Uint8ClampedArray(needed);
  const srcStride = frame.width * 4;
  const rowBytes = width * 4;
  for (let row = 0; row < height; row++) {
    const srcStart = (y + row) * srcStride + x * 4;
    buf.set(frame.data.subarray(srcStart, srcStart + rowBytes), row * rowBytes);
  }
  const view = buf.byteLength === needed ? buf : buf.subarray(0, needed);
  return { frame: { data: view, width, height }, scratch: buf };
}

async function processJob(job: WorkerJobRequest): Promise<void> {
  const port = parentPort;
  if (port === null) return;

  let decoded: RgbaFrame | undefined = await decodeSource(job.data, job.mimeType);
  if (decoded.width <= 0 || decoded.height <= 0) {
    throw new TaggedWorkerError("corrupt", "图片尺寸无效");
  }
  if (decoded.width * decoded.height > job.maxPixels) {
    throw new TaggedWorkerError(
      "too_large",
      `图片总像素超出上限：实际 ${decoded.width}×${decoded.height}`,
    );
  }
  flattenAlphaOnWhite(decoded.data);

  if (job.plan.kind === "downscale") {
    const { targetWidth, targetHeight, region } = job.plan;
    const frame =
      decoded.width === targetWidth && decoded.height === targetHeight
        ? decoded
        : await resizeFrame(decoded, targetWidth, targetHeight);
    decoded = undefined;
    const encoded = await encodeWithBudget(frame, job.qualities, job.targetMaxBytes);
    const msg: WorkerJobResponse = {
      id: job.id,
      type: "tile",
      index: 0,
      data: encoded.buffer,
      width: encoded.width,
      height: encoded.height,
      region,
    };
    port.postMessage(msg, [encoded.buffer]);
    port.postMessage({ id: job.id, type: "done" } satisfies WorkerJobResponse);
    return;
  }

  const { scaledWidth, scaledHeight, tiles } = job.plan;
  const frame =
    decoded.width === scaledWidth && decoded.height === scaledHeight
      ? decoded
      : await resizeFrame(decoded, scaledWidth, scaledHeight);
  decoded = undefined;

  let scratch: Uint8ClampedArray | undefined;
  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    if (tile === undefined) continue;
    const copied = copyTileRect(frame, tile.x, tile.y, tile.width, tile.height, scratch);
    scratch = copied.scratch;
    const encoded = await encodeWithBudget(copied.frame, job.qualities, job.targetMaxBytes);
    const msg: WorkerJobResponse = {
      id: job.id,
      type: "tile",
      index: i,
      data: encoded.buffer,
      width: encoded.width,
      height: encoded.height,
      region: tile.region,
    };
    port.postMessage(msg, [encoded.buffer]);
  }
  port.postMessage({ id: job.id, type: "done" } satisfies WorkerJobResponse);
}

parentPort?.on("message", (job: WorkerJobRequest) => {
  void processJob(job).catch((err: unknown) => {
    const kind = err instanceof TaggedWorkerError ? err.kind : "failed";
    const message = err instanceof Error ? err.message : String(err);
    const msg: WorkerJobResponse = { id: job.id, type: "error", kind, message };
    parentPort?.postMessage(msg);
  });
});
