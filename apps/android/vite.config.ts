import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));

// App 入口复用 apps/desktop/src/web 的界面与逻辑；不带网页版的 service worker、manifest 与 public-web。
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  publicDir: false,
  resolve: {
    alias: [
      {
        find: /^@nocturne\/remote$/,
        replacement: path.resolve(here, "../../packages/remote/src/index.ts"),
      },
      {
        find: /^@nocturne\/core\/protocol$/,
        replacement: path.resolve(here, "../../packages/core/src/protocol/index.ts"),
      },
      {
        find: /^@nocturne\/rpc\/client$/,
        replacement: path.resolve(here, "../../packages/rpc/src/client/index.ts"),
      },
    ],
  },
  server: {
    port: 31421,
    strictPort: true,
    // `tauri android dev` 经 TAURI_DEV_HOST 告诉开发服务器监听哪个地址，设备才连得上
    host: process.env.TAURI_DEV_HOST || false,
    ...(process.env.TAURI_DEV_HOST
      ? { hmr: { protocol: "ws", host: process.env.TAURI_DEV_HOST, port: 31422 } }
      : {}),
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: { outDir: "dist", target: "es2022" },
});
