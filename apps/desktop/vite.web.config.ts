import path from "node:path";
import { fileURLToPath } from "node:url";
import { rename } from "node:fs/promises";
import { defineConfig, mergeConfig } from "vite";
import desktop from "./vite.config";

const here = path.dirname(fileURLToPath(import.meta.url));
export default mergeConfig(
  desktop,
  defineConfig({
    publicDir: "public-web",
    resolve: {
      alias: [
        {
          find: /^@nocturne\/remote$/,
          replacement: path.resolve(here, "../../packages/remote/src/index.ts"),
        },
      ],
    },
    build: { outDir: "dist-web", rollupOptions: { input: path.resolve(here, "web.html") } },
    plugins: [
      {
        name: "phone-index",
        async closeBundle() {
          await rename(
            path.resolve(here, "dist-web/web.html"),
            path.resolve(here, "dist-web/index.html"),
          );
        },
      },
    ],
  }),
);
