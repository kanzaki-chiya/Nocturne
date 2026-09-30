// 依赖方向检查：把 docs/architecture/modules.md 第 1 节的规则固化进 CI。
// 箭头表示"可以 import"；任何未声明的依赖都视为禁止。

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // ── 全局 ────────────────────────────────────────────────
    {
      name: "no-circular",
      severity: "error",
      comment: "禁止循环依赖（modules.md 第 1 节）",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-orphans-core",
      severity: "warn",
      comment: "core/src 下不应有不被引用的模块（index/protocol 入口除外）",
      from: {
        orphan: true,
        path: "^packages/core/src",
        pathNot: ["(^|/)index\\.ts$", "(^|/)protocol/index\\.ts$", "\\.test\\.ts$", "\\.d\\.ts$"],
      },
      to: {},
    },

    // ── Node 内置模块的使用边界 ────────────────────────────
    {
      name: "only-platform-touches-fs",
      severity: "error",
      comment:
        "node:fs / node:fs/promises 只允许 platform 与 provider 适配器使用（modules.md：真实 I/O 集中在 platform 与 Provider 适配器）",
      from: {
        path: "^packages/core/src",
        pathNot: [
          "^packages/core/src/platform/",
          "^packages/core/src/provider/adapters/",
          "\\.test\\.ts$",
        ],
      },
      to: { dependencyTypes: ["core"], path: "^node:(fs|fs/promises)$" },
    },
    {
      name: "only-platform-touches-process",
      severity: "error",
      comment: "node:child_process / node:process spawn 只允许 platform 使用",
      from: {
        path: "^packages/core/src",
        pathNot: ["^packages/core/src/platform/", "\\.test\\.ts$"],
      },
      to: {
        dependencyTypes: ["core"],
        path: "^node:(child_process|process)$",
      },
    },
    {
      name: "protocol-no-node",
      severity: "error",
      comment: "protocol 只有类型与纯函数，不依赖 Node 内置模块",
      from: { path: "^packages/core/src/protocol/" },
      to: { dependencyTypes: ["core"] },
    },

    // ── 模块边界 ────────────────────────────────────────────
    {
      name: "protocol-depends-on-nothing",
      severity: "error",
      comment: "protocol 不依赖任何项目内模块",
      from: { path: "^packages/core/src/protocol/" },
      to: { path: "^packages/core/src/(?!protocol/)" },
    },
    {
      name: "platform-depends-on-nothing",
      severity: "error",
      comment: "platform 只依赖 Node 标准库，不依赖项目内模块",
      from: { path: "^packages/core/src/platform/" },
      to: { path: "^packages/core/src/(?!platform/)" },
    },
    {
      name: "session-deps",
      severity: "error",
      comment: "session 只能依赖 protocol 与 platform",
      from: { path: "^packages/core/src/session/" },
      to: {
        path: "^packages/core/src/(?!session/|protocol/|platform/)",
      },
    },
    {
      name: "provider-deps",
      severity: "error",
      comment: "provider 只能依赖 protocol（不能依赖 session/agent/tools/context/platform）",
      from: { path: "^packages/core/src/provider/" },
      to: {
        path: "^packages/core/src/(?!provider/|protocol/)",
      },
    },
    {
      name: "context-deps",
      severity: "error",
      comment:
        "context 只能依赖 protocol 与 provider 的类型（import type）；不能依赖 agent/tools/session/platform",
      from: { path: "^packages/core/src/context/" },
      to: {
        path: "^packages/core/src/(?!context/|protocol/|provider/)",
      },
    },
    {
      name: "tools-deps",
      severity: "error",
      comment: "tools 只能依赖 protocol、permission、platform",
      from: { path: "^packages/core/src/tools/" },
      to: {
        path: "^packages/core/src/(?!tools/|protocol/|permission/|platform/)",
      },
    },
    {
      name: "permission-deps",
      severity: "error",
      comment: "permission 只能依赖 protocol（不能依赖 tools/agent/platform）",
      from: { path: "^packages/core/src/permission/" },
      to: {
        path: "^packages/core/src/(?!permission/|protocol/)",
      },
    },
    {
      name: "config-deps",
      severity: "error",
      comment: "config 只能依赖 protocol 与 platform",
      from: { path: "^packages/core/src/config/" },
      to: {
        path: "^packages/core/src/(?!config/|protocol/|platform/)",
      },
    },
    {
      name: "diagnostics-deps",
      severity: "error",
      comment: "diagnostics 只依赖 protocol 与 platform（observability.md 第 4 节）",
      from: { path: "^packages/core/src/diagnostics/" },
      to: { path: "^packages/core/src/(?!diagnostics/|protocol/|platform/)" },
    },
    {
      name: "hooks-deps",
      severity: "error",
      comment:
        "hooks 只能依赖 protocol、platform、tools（HookRunner 接口类型）与 diagnostics（注入）",
      from: { path: "^packages/core/src/hooks/" },
      to: {
        path: "^packages/core/src/(?!hooks/|protocol/|platform/|tools/|diagnostics/)",
      },
    },
    {
      name: "agent-deps",
      severity: "error",
      comment:
        "agent 能依赖 session/context/provider/tools/permission/config/protocol，不能依赖 platform 或 apps",
      from: { path: "^packages/core/src/agent/" },
      to: {
        path: "^packages/core/src/(?!agent/|session/|context/|provider/|tools/|permission/|config/|protocol/)",
      },
    },
    {
      name: "input-history-deps",
      severity: "error",
      comment: "input-history 只能依赖 platform（modules.md：单文件业务模块）",
      from: { path: "^packages/core/src/input-history\\.ts$" },
      to: { path: "^packages/core/src/(?!platform/)" },
    },
    {
      name: "only-index-imports-agent",
      severity: "error",
      comment: "除 core/index（src/index.ts）外，任何模块不能 import agent",
      from: {
        path: "^packages/core/src",
        pathNot: ["^packages/core/src/index\\.ts$", "^packages/core/src/agent/"],
      },
      to: { path: "^packages/core/src/agent/" },
    },
    {
      name: "no-deep-import-from-outside-core",
      severity: "error",
      comment:
        "包外（apps、packages/mcp）只能 import @nocturne/core（src/index.ts）或 @nocturne/core/protocol（src/protocol/index.ts），任何内部路径一律禁止",
      from: { path: "^(apps|packages/mcp)/" },
      to: {
        path: "^packages/core/src/",
        pathNot: ["^packages/core/src/index\\.ts$", "^packages/core/src/protocol/index\\.ts$"],
      },
    },
    {
      name: "mcp-deps",
      severity: "error",
      comment:
        "packages/mcp 只能依赖 @nocturne/core 公开入口与 MCP SDK（modules.md：Core 不依赖 mcp，mcp 不依赖 apps）",
      from: { path: "^packages/mcp/src" },
      to: { path: "^(packages/(?!mcp)|apps)/" },
    },
    {
      name: "cli-tui-static-boundary",
      severity: "error",
      comment: "CLI 仅能静态引用 slash-catalog 和纯文本 text-format；其余 TUI 入口必须惰性加载",
      from: { path: "^apps/cli/src/" },
      to: {
        path: "^apps/tui/src/(?!(?:slash-catalog|text-format)\\.ts$)",
        dependencyTypesNot: ["dynamic-import"],
      },
    },
    {
      name: "text-format-pure-boundary",
      severity: "error",
      comment:
        "CLI 复用的文本格式入口只允许纯格式函数、protocol 类型与 string-width，不加载 Ink/React",
      from: { path: "^apps/tui/src/(?:text-format|format)\\.ts$" },
      to: {
        pathNot: [
          "^apps/tui/src/format\\.ts$",
          "^packages/core/src/protocol/index\\.ts$",
          "node_modules/string-width/",
        ],
      },
    },
    {
      name: "slash-catalog-depends-on-nothing",
      severity: "error",
      comment: "逐行 REPL 引用的命令表不得加载 Ink 或任何其他模块",
      from: { path: "^apps/tui/src/slash-catalog\\.ts$" },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.base.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
      extensions: [".ts", ".js", ".json"],
      mainFields: ["module", "main", "types"],
    },
    reporterOptions: {
      text: { highlightFocused: true },
      dot: { collapsePattern: "node_modules/[^/]+" },
    },
  },
};
