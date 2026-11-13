import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { defineConfig } from "tsdown";

const WASM_SPECS = [
  ["squoosh_png_bg.wasm", "@jsquash/png/codec/pkg/squoosh_png_bg.wasm"],
  ["mozjpeg_dec.wasm", "@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm"],
  ["mozjpeg_enc.wasm", "@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm"],
  ["webp_dec.wasm", "@jsquash/webp/codec/dec/webp_dec.wasm"],
  ["squoosh_resize_bg.wasm", "@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm"],
] as const;

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "protocol/index": "src/protocol/index.ts",
    "image-worker": "src/tools/image-worker.ts",
  },
  format: "esm",
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: "dist",
  platform: "node",
  target: "node24",
  onSuccess() {
    const req = createRequire(import.meta.url);
    const wasmDir = join(process.cwd(), "dist", "wasm");
    mkdirSync(wasmDir, { recursive: true });
    for (const [file, spec] of WASM_SPECS) {
      copyFileSync(req.resolve(spec), join(wasmDir, file));
    }
  },
});
