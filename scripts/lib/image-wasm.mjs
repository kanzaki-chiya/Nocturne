import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

export const IMAGE_WASM_FILES = [
  ["squoosh_png_bg.wasm", "@jsquash/png/codec/pkg/squoosh_png_bg.wasm"],
  ["mozjpeg_dec.wasm", "@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm"],
  ["mozjpeg_enc.wasm", "@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm"],
  ["webp_dec.wasm", "@jsquash/webp/codec/dec/webp_dec.wasm"],
  ["squoosh_resize_bg.wasm", "@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm"],
];

export function copyImageWasmToDir(corePackageJsonPath, destWasmDir) {
  const req = createRequire(corePackageJsonPath);
  mkdirSync(destWasmDir, { recursive: true });
  for (const [file, spec] of IMAGE_WASM_FILES) {
    copyFileSync(req.resolve(spec), join(destWasmDir, file));
  }
}

export function copyImageAssetsFromDir(srcDir, destDir) {
  const workerSrc = join(srcDir, "image-worker.mjs");
  if (!existsSync(workerSrc)) {
    throw new Error(`找不到图片处理 worker ${workerSrc}；先运行 node scripts/bundle-nctrn.mjs`);
  }
  copyFileSync(workerSrc, join(destDir, "image-worker.mjs"));
  const destWasmDir = join(destDir, "wasm");
  mkdirSync(destWasmDir, { recursive: true });
  for (const [file] of IMAGE_WASM_FILES) {
    const wasmSrc = join(srcDir, "wasm", file);
    if (!existsSync(wasmSrc)) {
      throw new Error(`找不到 WASM 文件 ${wasmSrc}；先运行 node scripts/bundle-nctrn.mjs`);
    }
    copyFileSync(wasmSrc, join(destWasmDir, file));
  }
}
