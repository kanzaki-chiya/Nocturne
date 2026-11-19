import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

const agentContextBoundaryMessage =
  "不得在 Agent Loop 或 Context 中按工具名或 Provider 写分支；请改为在工具声明或 Provider 适配器中表达（见 AGENTS.md 第 3 节）。";
const memberOrChain = (attrs) =>
  `:matches(MemberExpression${attrs}, ChainExpression:has(> MemberExpression${attrs}))`;
const toolNameSelector = memberOrChain("[computed=false][property.name=/^(name|toolName)$/]");
const providerIdSelector = `:matches(${[
  memberOrChain("[computed=false][property.name=/^(provider|providerId|protocol|api)$/]"),
  memberOrChain('[computed=false][property.name=/^(id|type)$/][object.name="provider"]'),
  memberOrChain('[computed=false][property.name=/^(id|type)$/][object.property.name="provider"]'),
  "Identifier[name=/^(providerId|currentModelProvider|currentModelProtocol)$/]",
].join(", ")})`;
const stringLiteralSelector =
  ":matches(Literal[raw=/^['\"]/], TemplateLiteral[expressions.length=0])";
const toolNameStringLiteralSelector =
  ":matches(Literal[raw=/^['\"]/]:not([value=/Error$/]), TemplateLiteral[expressions.length=0]:not([quasis.0.value.raw=/Error$/]))";
const eqComparisonBothSides = (expr, literal) => [
  `BinaryExpression[operator=/^(===|!==|==|!=)$/]:has(> .left${expr}):has(> .right${literal})`,
  `BinaryExpression[operator=/^(===|!==|==|!=)$/]:has(> .left${literal}):has(> .right${expr})`,
];

const fixedWaitInTestMessage =
  "测试中禁止 new Promise + setTimeout 固定等待；请改用 await 真实事件/Promise、vi.useFakeTimers() 或 vi.waitFor()，确需反向断言或测试替身延时时用 eslint-disable-next-line 注明原因（见 docs/development/workflow.md 第 4 节）。";
const testFixedWaitSelector = [
  'NewExpression[callee.name="Promise"]:not(:has(CallExpression[callee.name="reject"])):not(CallExpression[callee.object.name="Promise"][callee.property.name="race"] > ArrayExpression > NewExpression)',
  'CallExpression:matches([callee.name="setTimeout"], [callee.object.name=/^(globalThis|window)$/][callee.property.name="setTimeout"]):matches([arguments.1.raw=/^[0-9]/], [arguments.1.type="Identifier"])',
].join(" ");

export default tseslint.config(
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  prettier,
  {
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
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
    // 桌面端与安卓 App 前端不使用 Node 全局（types 里带 node 仅为上游源码 typecheck）
    files: ["apps/desktop/src/**/*.{ts,tsx}", "apps/android/src/**/*.{ts,tsx}"],
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
    // 主界面不弹浏览器自带的 alert / confirm / prompt：确认用应用内对话框（ProvidersPage ConfirmDialog）
    files: ["apps/desktop/src/**/*.{ts,tsx}"],
    rules: {
      "no-alert": "error",
    },
  },
  {
    // AGENTS.md 第 3 节硬性约束：Agent Loop 与 Context 不按工具名或 Provider 写分支
    files: [
      "packages/core/src/agent/turn.ts",
      "packages/core/src/agent/stream.ts",
      "packages/core/src/context/**/*.ts",
    ],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...[
          ...eqComparisonBothSides(toolNameSelector, toolNameStringLiteralSelector),
          ...eqComparisonBothSides(providerIdSelector, stringLiteralSelector),
          `SwitchStatement:has(> .discriminant:matches(${toolNameSelector}, ${providerIdSelector})) > SwitchCase:has(> .test${stringLiteralSelector})`,
        ].map((selector) => ({
          selector,
          message: agentContextBoundaryMessage,
        })),
      ],
    },
  },
  {
    files: ["**/*.test.{ts,tsx}", "packages/*/test/**/*.{ts,tsx}", "apps/*/test/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: testFixedWaitSelector,
          message: fixedWaitInTestMessage,
        },
      ],
    },
  },
  {
    files: [
      "**/*.test.{ts,tsx}",
      "**/*.smoke.ts",
      "test/**/*.{ts,tsx}",
      "**/test/**/*.{ts,tsx}",
      "**/test/**/*.d.mts",
      "**/*.config.ts",
      "**/*.config.mts",
      "**/*.config.mjs",
      "apps/desktop/public-web/*.js",
      // Magpie 在自己的 moejs 里运行的纯 JS 插件，不属于任何 tsconfig
      "packaging/magpie-plugin/*.js",
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
      "apps/desktop/dist-web/",
      "coverage/",
      "**/src-tauri/target/",
      "**/src-tauri/gen/",
      // 打包产物：scripts/bundle-nctrn.mjs 生成的单文件后台
      "**/src-tauri/resources/",
    ],
  },
);
