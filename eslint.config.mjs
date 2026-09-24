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
    ignores: ["dist/", "node_modules/", "**/dist/", "coverage/"],
  },
);
