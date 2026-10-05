import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  prettier,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/restrict-template-expressions": "off",
    },
  },
  {
    // 桌面端前端不使用 Node 全局（types 里带 node 仅为上游源码 typecheck）
    files: ["apps/desktop/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-globals": [
        "error",
        "process",
        "Buffer",
        "require",
        "module",
        "exports",
        "__dirname",
        "__filename",
        "global",
        "setImmediate",
        "clearImmediate",
      ],
    },
  },
  {
    files: [
      "**/*.test.{ts,tsx}",
      "**/*.smoke.ts",
      "test/**/*.{ts,tsx}",
      "**/test/**/*.{ts,tsx}",
      "**/*.config.ts",
      "**/*.config.mts",
      "**/*.config.mjs",
    ],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ["**/*.cjs", "**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    ignores: [
      "dist/",
      "node_modules/",
      "**/dist/",
      "coverage/",
      "**/src-tauri/target/",
      "**/src-tauri/gen/",
      // 打包产物：scripts/bundle-nctrn.mjs 生成的单文件后台
      "**/src-tauri/resources/",
    ],
  },
);
