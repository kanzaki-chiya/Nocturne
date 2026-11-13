/**
 * 图片编解码 WASM 与 worker 脚本定位（ADR-0090）。
 * 放在 platform/ 中统一承担 node:fs 与路径探测，保持 tools/ 不直接触碰文件系统。
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const IMAGE_WASM_SPECS = [
  {
    key: "pngDec",
    file: "squoosh_png_bg.wasm",
    pkgSpecifier: "@jsquash/png/codec/pkg/squoosh_png_bg.wasm",
  },
  {
    key: "jpegDec",
    file: "mozjpeg_dec.wasm",
    pkgSpecifier: "@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm",
  },
  {
    key: "jpegEnc",
    file: "mozjpeg_enc.wasm",
    pkgSpecifier: "@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm",
  },
  {
    key: "webpDec",
    file: "webp_dec.wasm",
    pkgSpecifier: "@jsquash/webp/codec/dec/webp_dec.wasm",
  },
  {
    key: "resize",
    file: "squoosh_resize_bg.wasm",
    pkgSpecifier: "@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm",
  },
] as const;

export type ImageWasmKey = (typeof IMAGE_WASM_SPECS)[number]["key"];
export type ImageWasmBytes = Record<ImageWasmKey, Uint8Array>;

let cachedWasm: Promise<ImageWasmBytes> | undefined;

function candidateBaseDirs(fromUrl: string): string[] {
  const dirs: string[] = [];
  try {
    const selfDir = dirname(fileURLToPath(fromUrl));
    dirs.push(selfDir, resolve(selfDir, ".."), resolve(selfDir, "..", ".."));
  } catch {
    // 非 file: URL 时跳过
  }
  const entry = process.argv[1];
  if (entry !== undefined && entry.length > 0) {
    const entryDir = dirname(resolve(entry));
    if (!dirs.includes(entryDir)) dirs.push(entryDir);
  }
  return dirs;
}

/** 定位图片处理 worker 入口 URL（构建产物优先用 .mjs，源码测试环境回落到 .ts） */
export function resolveImageWorkerUrl(fromUrl: string): URL {
  const dirs = candidateBaseDirs(fromUrl);
  for (const dir of dirs) {
    const built = join(dir, "image-worker.mjs");
    if (existsSync(built)) return pathToFileURL(built);
    const src = join(dir, "image-worker.ts");
    if (existsSync(src)) return pathToFileURL(src);
  }
  return new URL("./image-worker.mjs", fromUrl);
}

function resolveWasmFile(
  fromUrl: string,
  spec: (typeof IMAGE_WASM_SPECS)[number],
): string | undefined {
  for (const dir of candidateBaseDirs(fromUrl)) {
    const bundled = join(dir, "wasm", spec.file);
    if (existsSync(bundled)) return bundled;
    const distBundled = join(dir, "dist", "wasm", spec.file);
    if (existsSync(distBundled)) return distBundled;
  }
  try {
    return createRequire(fromUrl).resolve(spec.pkgSpecifier);
  } catch {
    return undefined;
  }
}

/** 异步读取五个 @jsquash WASM 二进制并缓存；全部找不到时抛出明确错误 */
export function loadImageWasmBytes(fromUrl: string): Promise<ImageWasmBytes> {
  if (cachedWasm !== undefined) return cachedWasm;
  cachedWasm = (async () => {
    const entries = await Promise.all(
      IMAGE_WASM_SPECS.map(async (spec) => {
        const filePath = resolveWasmFile(fromUrl, spec);
        if (filePath === undefined) {
          throw new Error(`找不到图片编解码 WASM 文件：${spec.file}`);
        }
        const buf = await readFile(filePath);
        return [spec.key, new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)] as const;
      }),
    );
    return Object.fromEntries(entries) as ImageWasmBytes;
  })().catch((err: unknown) => {
    cachedWasm = undefined;
    throw err;
  });
  return cachedWasm;
}
