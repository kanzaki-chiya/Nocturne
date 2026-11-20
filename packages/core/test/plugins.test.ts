/**
 * 插件发现、翻译、执行、环境隔离、整目录指纹信任与技能集成测试（ADR-0096 第二期）。
 * 所有测试均使用临时目录夹具，不读写本机真实 `~/.codex` / `~/.claude`。
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  createPlatform,
  createRuntime,
  loadConfig,
  type Runtime,
  type RuntimeSession,
} from "../src/index.js";
import { createHookRunner } from "../src/hooks/index.js";
import {
  applyToolMetaToPluginSurfaces,
  computePluginFingerprint,
  describePlugins,
  discoverInstalledPlugins,
  installLocalPlugin,
  resolvePlugins,
  selectActivePluginVersion,
  setPluginEnabled,
  uninstallPlugin,
  type PluginHookEntry,
} from "../src/plugins/index.js";
import { FakeProvider } from "../src/provider/index.js";
import { createProcessCleanup, removeTempDirs } from "../../../scripts/test/process-cleanup.mjs";

const processes = createProcessCleanup();
const basePlatform = processes.platform(createPlatform());
const tmpRoots: string[] = [];
const openRuntimes: Runtime[] = [];
const openSessions: RuntimeSession[] = [];

function must<T>(value: T | undefined, label = "value"): T {
  if (value === undefined) throw new Error(`Expected ${label} to be defined`);
  return value;
}

afterEach(async () => {
  for (const s of openSessions.splice(0)) {
    await s.close().catch(() => undefined);
  }
  for (const rt of openRuntimes.splice(0)) {
    await rt.close().catch(() => undefined);
  }
  await processes.cleanup();
  await removeTempDirs(tmpRoots.splice(0));
});

function tmpDir(prefix = "nct-plugins-"): string {
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), prefix)));
  tmpRoots.push(dir);
  return dir;
}

function makeFixtureEnv() {
  const root = tmpDir();
  const nocturneHome = path.join(root, "nocturne-home");
  const codexHome = path.join(root, "codex-home");
  const claudeHome = path.join(root, "claude-home");
  const ws = path.join(root, "workspace");
  const sessionsDir = path.join(nocturneHome, "sessions");
  mkdirSync(nocturneHome, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(claudeHome, { recursive: true });
  mkdirSync(ws, { recursive: true });
  writeFileSync(
    path.join(nocturneHome, "config.json"),
    JSON.stringify({ modelsDev: false, skills: { sources: { agents: false, claude: false } } }),
  );
  const plat = {
    ...basePlatform,
    homeDir: () => root,
    nocturneHome: () => nocturneHome,
  };
  return { root, nocturneHome, codexHome, claudeHome, ws, sessionsDir, plat };
}

function writeCodexPlugin(
  codexHome: string,
  opts: {
    name: string;
    marketplace: string;
    version: string;
    enabled?: boolean;
    manifestDir?: ".codex-plugin" | ".claude-plugin" | "root";
    manifest?: Record<string, unknown>;
    files?: Record<string, string | Uint8Array>;
  },
): string {
  const pluginDir = path.join(
    codexHome,
    "plugins",
    "cache",
    opts.marketplace,
    opts.name,
    opts.version,
  );
  mkdirSync(pluginDir, { recursive: true });
  if (opts.manifest !== undefined) {
    const dir =
      opts.manifestDir === "root"
        ? pluginDir
        : path.join(pluginDir, opts.manifestDir ?? ".codex-plugin");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "plugin.json"), JSON.stringify(opts.manifest, null, 2));
  }
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    const target = path.join(pluginDir, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  const configPath = path.join(codexHome, "config.toml");
  let existing = "";
  try {
    existing = readFileSync(configPath, "utf8");
  } catch {
    // 首个插件
  }
  const enabled = opts.enabled ?? true;
  writeFileSync(
    configPath,
    `${existing}\n[plugins."${opts.name}@${opts.marketplace}"]\nenabled = ${enabled}\n`,
  );
  return pluginDir;
}

function writeClaudePlugin(
  claudeHome: string,
  opts: {
    name: string;
    marketplace: string;
    enabled?: boolean;
    scope?: string;
    manifest?: Record<string, unknown>;
    files?: Record<string, string | Uint8Array>;
  },
): string {
  const slug = `${opts.name}@${opts.marketplace}`;
  const pluginDir = path.join(claudeHome, "plugins", "store", opts.name);
  mkdirSync(pluginDir, { recursive: true });
  if (opts.manifest !== undefined) {
    mkdirSync(path.join(pluginDir, ".claude-plugin"), { recursive: true });
    writeFileSync(
      path.join(pluginDir, ".claude-plugin", "plugin.json"),
      JSON.stringify(opts.manifest, null, 2),
    );
  }
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    const target = path.join(pluginDir, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  const installedPath = path.join(claudeHome, "plugins", "installed_plugins.json");
  let installed: { version: number; plugins: Record<string, unknown[]> } = {
    version: 2,
    plugins: {},
  };
  try {
    installed = JSON.parse(readFileSync(installedPath, "utf8")) as typeof installed;
  } catch {
    // 初始化
  }
  installed.plugins[slug] = [
    {
      scope: opts.scope ?? "user",
      installPath: pluginDir,
      version: "1.0.0",
      secretToken: "must-not-be-kept",
    },
  ];
  mkdirSync(path.dirname(installedPath), { recursive: true });
  writeFileSync(installedPath, JSON.stringify(installed, null, 2));

  const settingsPath = path.join(claudeHome, "settings.json");
  let settings: { enabledPlugins?: Record<string, boolean>; apiKeyHelper?: string } = {
    apiKeyHelper: "secret-helper",
  };
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8")) as typeof settings;
  } catch {
    // 初始化
  }
  settings.enabledPlugins ??= {};
  settings.enabledPlugins[slug] = opts.enabled ?? true;
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return pluginDir;
}

describe("Codex 版本选择规则", () => {
  it("5.3.2 与 5.3.3 选 5.3.3", () => {
    expect(
      selectActivePluginVersion([
        { name: "5.3.2", type: "directory" },
        { name: "5.3.3", type: "directory" },
      ]),
    ).toBe("5.3.3");
  });

  it("26.1027.30824、26.1029.61003 与 latest 选 latest", () => {
    expect(
      selectActivePluginVersion([
        { name: "26.1027.30824", type: "directory" },
        { name: "26.1029.61003", type: "directory" },
        { name: "latest", type: "directory" },
      ]),
    ).toBe("latest");
  });

  it("含 local 时优先选 local", () => {
    expect(
      selectActivePluginVersion([
        { name: "9.9.9", type: "directory" },
        { name: "local", type: "directory" },
        { name: "latest", type: "directory" },
      ]),
    ).toBe("local");
  });

  it("单个预发布版本 0.1.13-77c10e110b37 正常选中", () => {
    expect(selectActivePluginVersion([{ name: "0.1.13-77c10e110b37", type: "directory" }])).toBe(
      "0.1.13-77c10e110b37",
    );
  });

  it("忽略非法目录名与非目录项", () => {
    expect(
      selectActivePluginVersion([
        { name: ".", type: "directory" },
        { name: "..", type: "directory" },
        { name: "bad dir", type: "directory" },
        { name: "v1@2", type: "directory" },
        { name: "9.9.9", type: "file" },
        { name: "1.2.3", type: "directory" },
      ]),
    ).toBe("1.2.3");
  });
});

describe("清单查找、hooks 来源与跳过规则", () => {
  it("忽略根目录无 $schema 的 plugin.json，且按宿主顺序查找清单", async () => {
    const f = makeFixtureEnv();
    // 只有根目录 plugin.json 的插件应被忽略
    writeCodexPlugin(f.codexHome, {
      name: "rootonly",
      marketplace: "mkt",
      version: "1.0.0",
      manifestDir: "root",
      manifest: { name: "rootonly", hooks: "./hooks/h.json" },
      files: {
        "hooks/h.json": JSON.stringify({
          hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }] },
        }),
      },
    });
    // Codex 同时有 .codex-plugin 和 .claude-plugin 时优先取 .codex-plugin
    writeCodexPlugin(f.codexHome, {
      name: "both",
      marketplace: "mkt",
      version: "1.0.0",
      manifestDir: ".codex-plugin",
      manifest: {
        interface: { displayName: "From Codex" },
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo codex" }] }] },
      },
      files: {
        ".claude-plugin/plugin.json": JSON.stringify({ displayName: "From Claude" }),
      },
    });
    // Codex 仅有 .claude-plugin 时回退到 .claude-plugin
    writeCodexPlugin(f.codexHome, {
      name: "fallback",
      marketplace: "mkt",
      version: "1.0.0",
      manifestDir: ".claude-plugin",
      manifest: {
        displayName: "Claude Fallback",
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo fb" }] }] },
      },
    });
    // Claude 来源只看 .claude-plugin，不看 .codex-plugin
    writeClaudePlugin(f.claudeHome, {
      name: "claudeonly",
      marketplace: "mkt",
      manifest: {
        displayName: "Claude Native",
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo claude" }] }] },
      },
      files: {
        ".codex-plugin/plugin.json": JSON.stringify({ interface: { displayName: "Wrong Codex" } }),
      },
    });

    const { plugins } = await discoverInstalledPlugins(f.plat, {
      nocturneHome: f.nocturneHome,
      codexHome: f.codexHome,
      claudeHome: f.claudeHome,
    });
    expect(plugins.map((p) => p.overview.id)).toEqual([
      "claude:claudeonly@mkt",
      "codex:both@mkt",
      "codex:fallback@mkt",
    ]);
    expect(plugins.find((p) => p.overview.id === "codex:both@mkt")?.overview.displayName).toBe(
      "From Codex",
    );
    expect(plugins.find((p) => p.overview.id === "codex:fallback@mkt")?.overview.displayName).toBe(
      "Claude Fallback",
    );
    expect(
      plugins.find((p) => p.overview.id === "claude:claudeonly@mkt")?.overview.displayName,
    ).toBe("Claude Native");
  });

  it("支持 hooks 的四种形式、跳过无 hooks 键文件（claude-band 形状）并拒绝越界路径", async () => {
    const f = makeFixtureEnv();
    const outsideFile = path.join(f.root, "outside-hooks.json");
    writeFileSync(
      outsideFile,
      JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo pwn" }] }] },
      }),
    );

    // 1. Codex 省略 hooks 时读取 hooks/hooks.json
    writeCodexPlugin(f.codexHome, {
      name: "p-default",
      marketplace: "mkt",
      version: "1.0.0",
      manifest: { name: "p-default" },
      files: {
        "hooks/hooks.json": JSON.stringify({
          hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo def" }] }] },
        }),
      },
    });
    // 2. Codex 字符串路径 + 越界路径被拒 + claude-band.json 无 hooks 键静默跳过
    writeCodexPlugin(f.codexHome, {
      name: "p-array",
      marketplace: "mkt",
      version: "1.0.0",
      manifest: {
        name: "p-array",
        hooks: [
          "./hooks/a.json",
          "./hooks/claude-band.json",
          "../outside-hooks.json",
          "hooks/no-dot.json",
          { UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo inline" }] }] },
        ],
      },
      files: {
        "hooks/a.json": JSON.stringify({
          hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo a" }] }] },
        }),
        "hooks/claude-band.json": JSON.stringify({ modules: ["a", "b"] }),
      },
    });
    // 3. Codex 内联对象形式
    writeCodexPlugin(f.codexHome, {
      name: "p-inline",
      marketplace: "mkt",
      version: "1.0.0",
      manifest: {
        name: "p-inline",
        hooks: { SessionEnd: [{ hooks: [{ type: "command", command: "echo end" }] }] },
      },
    });
    // 4. Claude 合并 hooks/hooks.json 与清单 hooks 字符串路径
    writeClaudePlugin(f.claudeHome, {
      name: "p-claude-merge",
      marketplace: "mkt",
      manifest: { name: "p-claude-merge", hooks: "./hooks/extra.json" },
      files: {
        "hooks/hooks.json": JSON.stringify({
          hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo base" }] }] },
        }),
        "hooks/extra.json": JSON.stringify({
          hooks: { SubagentStart: [{ hooks: [{ type: "command", command: "echo extra" }] }] },
        }),
      },
    });

    const { plugins } = await discoverInstalledPlugins(f.plat, {
      nocturneHome: f.nocturneHome,
      codexHome: f.codexHome,
      claudeHome: f.claudeHome,
    });

    const pDef = must(
      plugins.find((p) => p.overview.id === "codex:p-default@mkt"),
      "pDef",
    );
    expect(pDef.overview.hooks.map((h) => h.command)).toEqual(["echo def"]);

    const pArr = must(
      plugins.find((p) => p.overview.id === "codex:p-array@mkt"),
      "pArr",
    );
    expect(pArr.overview.hooks.map((h) => h.command)).toEqual(["echo a", "echo inline"]);
    // claude-band.json 不报警告，但两条越界/非法路径应报警告
    expect(pArr.overview.warnings.some((w) => w.includes("claude-band"))).toBe(false);
    expect(pArr.overview.warnings.some((w) => w.includes("outside-hooks.json"))).toBe(true);
    expect(pArr.overview.warnings.some((w) => w.includes("no-dot.json"))).toBe(true);

    const pInline = must(
      plugins.find((p) => p.overview.id === "codex:p-inline@mkt"),
      "pInline",
    );
    expect(pInline.overview.hooks).toEqual([{ point: "SessionEnd", command: "echo end" }]);

    const pClaude = must(
      plugins.find((p) => p.overview.id === "claude:p-claude-merge@mkt"),
      "pClaude",
    );
    expect(pClaude.overview.hooks.map((h) => [h.point, h.command])).toEqual([
      ["SessionStart", "echo base"],
      ["SubagentStart", "echo extra"],
    ]);
  });

  it("跳过非 command、async、user_config 与不支持的点位并记入 unsupported", async () => {
    const f = makeFixtureEnv();
    writeClaudePlugin(f.claudeHome, {
      name: "skip-test",
      marketplace: "mkt",
      manifest: {
        hooks: {
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo allow" }] }],
          PermissionRequest: [{ hooks: [{ type: "command", command: "echo perm" }] }],
          PostToolUse: [{ hooks: [{ type: "command", command: "echo post" }] }],
          SessionStart: [
            {
              hooks: [
                { type: "prompt", prompt: "hi" },
                { type: "command", command: "echo async", async: true },
                { type: "command", command: "echo ${user_config.token}" },
                { type: "command", command: "node", args: ["${user_config.script}"] },
                { type: "command", command: "echo ok" },
              ],
            },
          ],
        },
      },
    });

    const res = await describePlugins(f.plat, {
      nocturneHome: f.nocturneHome,
      codexHome: f.codexHome,
      claudeHome: f.claudeHome,
    });
    const p = must(res.plugins[0], "skip-test plugin");
    expect(p.hooks).toEqual([{ point: "SessionStart", command: "echo ok" }]);
    expect(p.unsupported).toEqual([
      { point: "PreToolUse", reason: "point" },
      { point: "PermissionRequest", reason: "point" },
      { point: "PostToolUse", reason: "point" },
      { point: "SessionStart", reason: "type" },
      { point: "SessionStart", reason: "async" },
      { point: "SessionStart", reason: "user_config" },
      { point: "SessionStart", reason: "user_config" },
    ]);
  });

  it("config.toml 或两份 Claude JSON 损坏时仅报 warning，不抛出", async () => {
    const f = makeFixtureEnv();
    writeFileSync(path.join(f.codexHome, "config.toml"), "[[broken toml = =");
    mkdirSync(path.join(f.claudeHome, "plugins"), { recursive: true });
    writeFileSync(path.join(f.claudeHome, "plugins", "installed_plugins.json"), "{bad json");
    writeFileSync(path.join(f.claudeHome, "settings.json"), "{also bad");

    const d1 = await describePlugins(f.plat, {
      nocturneHome: f.nocturneHome,
      codexHome: f.codexHome,
      claudeHome: f.claudeHome,
    });
    expect(d1.plugins).toEqual([]);
    expect(d1.warnings.length).toBeGreaterThanOrEqual(2);

    // installed_plugins.json 正常而 settings.json 损坏
    writeFileSync(
      path.join(f.claudeHome, "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: {} }),
    );
    const d2 = await describePlugins(f.plat, {
      nocturneHome: f.nocturneHome,
      codexHome: f.codexHome,
      claudeHome: f.claudeHome,
    });
    expect(d2.warnings.some((w) => w.includes("claude_settings_invalid"))).toBe(true);
  });
});

describe("插件 Hook 执行、环境、matcher、stdin/stdout 与父子会话", () => {
  it("环境变量隔离（剥离 OPENAI_API_KEY）、注入 PLUGIN_DATA 等变量与占位符替换", async () => {
    const f = makeFixtureEnv();
    const outFile = path.join(f.root, "env-seen.json");
    const scriptRel = "hooks/dump-env.cjs";
    const pluginDir = writeClaudePlugin(f.claudeHome, {
      name: "envcheck",
      marketplace: "mkt",
      manifest: {
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: "command",
                  command: "node",
                  args: [
                    "${CLAUDE_PLUGIN_ROOT}/hooks/dump-env.cjs",
                    "${PLUGIN_ROOT}",
                    "${PLUGIN_DATA}",
                    "${CLAUDE_PLUGIN_DATA}",
                    "${CLAUDE_PROJECT_DIR}",
                  ],
                },
              ],
            },
          ],
        },
      },
      files: {
        [scriptRel]: `
const fs = require("node:fs");
let raw = "";
process.stdin.on("data", d => raw += d).on("end", () => {
  fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({
    argv: process.argv.slice(2),
    stdin: JSON.parse(raw),
    env: {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? null,
      PLUGIN_ROOT: process.env.PLUGIN_ROOT ?? null,
      CLAUDE_PLUGIN_ROOT: process.env.CLAUDE_PLUGIN_ROOT ?? null,
      PLUGIN_DATA: process.env.PLUGIN_DATA ?? null,
      CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA ?? null,
      CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR ?? null,
      NOCTURNE_HOOK_EVENT: process.env.NOCTURNE_HOOK_EVENT ?? null,
      NOCTURNE_SESSION_ID: process.env.NOCTURNE_SESSION_ID ?? null,
      NOCTURNE_WORKSPACE_ROOT: process.env.NOCTURNE_WORKSPACE_ROOT ?? null,
      NOCTURNE_CWD: process.env.NOCTURNE_CWD ?? null,
      dataDirExists: fs.existsSync(process.env.PLUGIN_DATA),
    },
  }));
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: "env-ok" } }));
});`,
      },
    });

    const prevKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-should-not-leak";
    try {
      const { plugins } = await discoverInstalledPlugins(f.plat, {
        nocturneHome: f.nocturneHome,
        codexHome: f.codexHome,
        claudeHome: f.claudeHome,
      });
      const r = createHookRunner({
        hooks: must(plugins[0], "envcheck plugin").hooks,
        platform: f.plat,
        sessionId: "s-env",
        cwd: f.ws,
        workspaceRoot: f.ws,
      });
      const out = await r.run("SessionStart", { resumed: true, source: "fork" });
      expect(out?.contextEntries).toEqual([
        { hook: "plugin envcheck@mkt SessionStart", text: "env-ok" },
      ]);

      const expectedDataDir = path.join(f.nocturneHome, "plugins", "data", "envcheck-mkt");
      const seen = JSON.parse(readFileSync(outFile, "utf8")) as {
        argv: string[];
        stdin: Record<string, unknown>;
        env: Record<string, unknown>;
      };
      expect(seen.argv).toEqual([pluginDir, expectedDataDir, expectedDataDir, f.ws]);
      expect(seen.stdin).toEqual({
        hook_event_name: "SessionStart",
        session_id: "s-env",
        cwd: f.ws,
        source: "resume", // fork → resume
      });
      expect(seen.env).toEqual({
        OPENAI_API_KEY: null,
        PLUGIN_ROOT: pluginDir,
        CLAUDE_PLUGIN_ROOT: pluginDir,
        PLUGIN_DATA: expectedDataDir,
        CLAUDE_PLUGIN_DATA: expectedDataDir,
        CLAUDE_PROJECT_DIR: f.ws,
        NOCTURNE_HOOK_EVENT: "SessionStart",
        NOCTURNE_SESSION_ID: "s-env",
        NOCTURNE_WORKSPACE_ROOT: f.ws,
        NOCTURNE_CWD: f.ws,
        dataDirExists: true,
      });
    } finally {
      if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevKey;
    }
  });

  it.runIf(process.platform === "win32")(
    "Windows 真机执行 ponytail 形态嵌套双引号 commandWindows",
    async () => {
      const f = makeFixtureEnv();
      writeCodexPlugin(f.codexHome, {
        name: "winquote",
        marketplace: "mkt",
        version: "1.0.0",
        manifest: {
          hooks: {
            SessionStart: [
              {
                hooks: [
                  {
                    type: "command",
                    command: "echo posix-fallback-should-not-run",
                    commandWindows: `node -e "require(require('path').join(process.env.CLAUDE_PLUGIN_ROOT.split(String.fromCharCode(92)).join('/'), 'hooks/emit.cjs'))"`,
                  },
                ],
              },
            ],
          },
        },
        files: {
          "hooks/emit.cjs": `process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: "nested-quotes-ok" } }));`,
        },
      });

      const { plugins } = await discoverInstalledPlugins(f.plat, {
        nocturneHome: f.nocturneHome,
        codexHome: f.codexHome,
        claudeHome: f.claudeHome,
      });
      const winPlugin = must(plugins[0], "winquote plugin");
      expect(winPlugin.overview.hooks[0]?.command).toContain("split(String.fromCharCode(92))");
      const r = createHookRunner({
        hooks: winPlugin.hooks,
        platform: f.plat,
        sessionId: "s-win",
        cwd: f.ws,
        workspaceRoot: f.ws,
      });
      const out = await r.run("SessionStart", { resumed: false, source: "startup" });
      expect(out?.contextEntries).toEqual([
        { hook: "plugin winquote@mkt SessionStart", text: "nested-quotes-ok" },
      ]);
    },
  );

  it("Claude shell 形式执行（Windows Git Bash 优先或回退 PowerShell；POSIX sh -c）", async () => {
    const f = makeFixtureEnv();
    writeClaudePlugin(f.claudeHome, {
      name: "claudeshell",
      marketplace: "mkt",
      manifest: {
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: "command",
                  command: `node -e "process.stdout.write('shell-form-ok')"`,
                },
              ],
            },
          ],
        },
      },
    });
    const { plugins } = await discoverInstalledPlugins(f.plat, {
      nocturneHome: f.nocturneHome,
      codexHome: f.codexHome,
      claudeHome: f.claudeHome,
    });
    const r = createHookRunner({
      hooks: must(plugins[0], "claudeshell plugin").hooks,
      platform: f.plat,
      sessionId: "s-sh",
      cwd: f.ws,
      workspaceRoot: f.ws,
    });
    const out = await r.run("SessionStart", { resumed: false, source: "startup" });
    expect(out?.contextEntries).toEqual([
      { hook: "plugin claudeshell@mkt SessionStart", text: "shell-form-ok" },
    ]);
  });

  it("matcher（精确列表、正则、非法正则告警跳过、UserPromptSubmit 忽略 matcher）", async () => {
    const f = makeFixtureEnv();
    writeClaudePlugin(f.claudeHome, {
      name: "matchers",
      marketplace: "mkt",
      manifest: {
        hooks: {
          SessionStart: [
            {
              matcher: "startup,resume",
              hooks: [{ type: "command", command: "node -e \"console.log('exact')\"" }],
            },
            {
              matcher: "^comp.*$",
              hooks: [{ type: "command", command: "node -e \"console.log('regex')\"" }],
            },
            {
              matcher: "[unclosed",
              hooks: [{ type: "command", command: "node -e \"console.log('bad')\"" }],
            },
          ],
          UserPromptSubmit: [
            {
              matcher: "OnlySomeToolThatDoesNotMatch",
              hooks: [{ type: "command", command: "node -e \"console.log('ups-always')\"" }],
            },
          ],
        },
      },
    });

    const { plugins } = await discoverInstalledPlugins(f.plat, {
      nocturneHome: f.nocturneHome,
      codexHome: f.codexHome,
      claudeHome: f.claudeHome,
    });
    const matcherPlugin = must(plugins[0], "matchers plugin");
    expect(matcherPlugin.overview.warnings.some((w) => w.includes("[unclosed"))).toBe(true);

    // 也验证 runner 直接收到非法正则时跳过并告警
    const warnings: { code: string; message: string }[] = [];
    const badEntry: PluginHookEntry = {
      matcher: "[broken-regex",
      command: "echo never",
      plugin: {
        pluginLabel: "matchers@mkt",
        host: "claude",
        mode: "compat",
        compatHost: "claude",
        pluginRoot: matcherPlugin.overview.root,
        pluginDataDir: path.join(f.nocturneHome, "plugins", "data", "matchers-mkt"),
        rawCommand: "echo never",
      },
    };
    const r = createHookRunner({
      hooks: {
        ...matcherPlugin.hooks,
        SubagentStart: [badEntry],
      },
      platform: f.plat,
      sessionId: "s-m",
      cwd: f.ws,
      workspaceRoot: f.ws,
      warn: (code, message) => warnings.push({ code, message }),
    });

    const startStartup = await r.run("SessionStart", { resumed: false, source: "startup" });
    expect(startStartup?.contextEntries).toEqual([
      { hook: "plugin matchers@mkt SessionStart", text: "exact" },
    ]);

    const startFork = await r.run("SessionStart", { resumed: true, source: "fork" });
    expect(startFork?.contextEntries).toEqual([
      { hook: "plugin matchers@mkt SessionStart", text: "exact" },
    ]);

    const startCompact = await r.run("SessionStart", { resumed: false, source: "compact" });
    expect(startCompact?.contextEntries).toEqual([
      { hook: "plugin matchers@mkt SessionStart", text: "regex" },
    ]);

    const ups = await r.run("UserPromptSubmit", { turnId: "t1", text: "hello" });
    expect(ups?.contextEntries).toEqual([
      { hook: "plugin matchers@mkt UserPromptSubmit", text: "ups-always" },
    ]);

    const sub = await r.run("SubagentStart", { agentType: "explore" });
    expect(sub).toBeUndefined();
    expect(
      warnings.some((w) => w.code === "hook_failed" && w.message.includes("matchers@mkt")),
    ).toBe(true);
  });

  it("stdin（技能 prompt）与 stdout 翻译（纯文本、hookSpecificOutput、decision:block、退出码 2）", async () => {
    const f = makeFixtureEnv();
    const seenPath = path.join(f.root, "ups-stdin.jsonl");
    const upsScript = path.join("hooks", "ups.cjs");
    const modePath = path.join(f.root, "ups-mode.json");
    writeFileSync(modePath, JSON.stringify({ mode: "plain" }));

    writeClaudePlugin(f.claudeHome, {
      name: "upsplugin",
      marketplace: "mkt",
      manifest: {
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: "command",
                  command: "node",
                  args: ["${CLAUDE_PLUGIN_ROOT}/hooks/fail2.cjs"],
                },
              ],
            },
          ],
          UserPromptSubmit: [
            {
              hooks: [
                { type: "command", command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/hooks/ups.cjs"] },
              ],
            },
          ],
        },
      },
      files: {
        "hooks/fail2.cjs": `process.stderr.write("not ups"); process.exit(2);`,
        [upsScript]: `
const fs = require("node:fs");
let raw = "";
process.stdin.on("data", d => raw += d).on("end", () => {
  fs.appendFileSync(${JSON.stringify(seenPath)}, raw.trim() + "\\n");
  const cfg = JSON.parse(fs.readFileSync(${JSON.stringify(modePath)}, "utf8"));
  if (cfg.mode === "plain") process.stdout.write("plain text note");
  else if (cfg.mode === "hso") process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: "hso note" } }));
  else if (cfg.mode === "block-json") process.stdout.write(JSON.stringify({ decision: "block", reason: "json blocked" }));
  else if (cfg.mode === "exit2") { process.stderr.write("stderr blocked"); process.exit(2); }
});`,
      },
    });

    const { plugins } = await discoverInstalledPlugins(f.plat, {
      nocturneHome: f.nocturneHome,
      codexHome: f.codexHome,
      claudeHome: f.claudeHome,
    });
    const warnings: { code: string; message: string }[] = [];
    const r = createHookRunner({
      hooks: must(plugins[0], "upsplugin").hooks,
      platform: f.plat,
      sessionId: "s-io",
      cwd: f.ws,
      workspaceRoot: f.ws,
      warn: (code, message) => warnings.push({ code, message }),
    });

    // SessionStart 退出码 2 视为失败
    const ss = await r.run("SessionStart", { resumed: false, source: "startup" });
    expect(ss).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain("plugin upsplugin@mkt SessionStart");
    expect(warnings[0]?.message).not.toContain(f.root);

    // 1. 纯文本 + 技能带参数
    expect(
      await r.run("UserPromptSubmit", {
        turnId: "t1",
        text: "/ponytail ultra",
        skill: { name: "ponytail", arguments: "ultra" },
      }),
    ).toEqual({
      contextEntries: [{ hook: "plugin upsplugin@mkt UserPromptSubmit", text: "plain text note" }],
    });

    // 2. hookSpecificOutput + 技能无参数
    writeFileSync(modePath, JSON.stringify({ mode: "hso" }));
    expect(
      await r.run("UserPromptSubmit", {
        turnId: "t2",
        text: "/ponytail",
        skill: { name: "ponytail", arguments: "" },
      }),
    ).toEqual({
      contextEntries: [{ hook: "plugin upsplugin@mkt UserPromptSubmit", text: "hso note" }],
    });

    // 3. decision: "block" + 原文
    writeFileSync(modePath, JSON.stringify({ mode: "block-json" }));
    expect(await r.run("UserPromptSubmit", { turnId: "t3", text: "hello world" })).toEqual({
      block: true,
      reason: "json blocked",
    });

    // 4. 退出码 2 拦截
    writeFileSync(modePath, JSON.stringify({ mode: "exit2" }));
    expect(await r.run("UserPromptSubmit", { turnId: "t4", text: "hello 2" })).toEqual({
      block: true,
      reason: "stderr blocked",
    });

    const inputs = readFileSync(seenPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(inputs.map((i) => [i.turn_id, i.prompt])).toEqual([
      ["t1", "/ponytail ultra"],
      ["t2", "/ponytail"],
      ["t3", "hello world"],
      ["t4", "hello 2"],
    ]);
  });

  it("SessionStart / SessionEnd 只在父会话运行，子会话只跑 SubagentStart", async () => {
    const f = makeFixtureEnv();
    const logPath = path.join(f.root, "lifecycle.log").replace(/\\/g, "/");
    const logger = (tag: string) =>
      `node -e "require('fs').appendFileSync('${logPath}', '${tag}' + String.fromCharCode(10))"`;
    writeCodexPlugin(f.codexHome, {
      name: "codexlife",
      marketplace: "mkt",
      version: "1.0.0",
      manifest: {
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: logger("codex-start") }] }],
          SubagentStart: [{ hooks: [{ type: "command", command: logger("codex-sub") }] }],
          SessionEnd: [{ hooks: [{ type: "command", command: logger("codex-end") }] }],
        },
      },
    });
    writeClaudePlugin(f.claudeHome, {
      name: "claudelife",
      marketplace: "mkt",
      manifest: {
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: logger("claude-start") }] }],
          SubagentStart: [{ hooks: [{ type: "command", command: logger("claude-sub") }] }],
          SessionEnd: [{ hooks: [{ type: "command", command: logger("claude-end") }] }],
        },
      },
    });

    const { plugins } = await discoverInstalledPlugins(f.plat, {
      nocturneHome: f.nocturneHome,
      codexHome: f.codexHome,
      claudeHome: f.claudeHome,
    });
    const combined: Partial<Record<string, PluginHookEntry[]>> = {};
    for (const p of plugins) {
      for (const [k, v] of Object.entries(p.hooks)) {
        const list = (combined[k] ??= []);
        list.push(...v);
      }
    }
    const r = createHookRunner({
      hooks: combined,
      platform: f.plat,
      sessionId: "parent-1",
      cwd: f.ws,
      workspaceRoot: f.ws,
    });

    await r.run("SessionStart", { resumed: false, source: "startup" });
    await r.run("SessionStart", {
      resumed: false,
      source: "startup",
      subagent: { parentSessionId: "parent-1", parentCallId: "c1", depth: 1 },
    });
    await r.run("SubagentStart", {
      agentType: "explore",
      subagent: { parentSessionId: "parent-1", parentCallId: "c1", depth: 1 },
    });
    await r.run("SessionEnd", {
      reason: "close",
      subagent: { parentSessionId: "parent-1", parentCallId: "c1", depth: 1 },
    });
    await r.run("SessionEnd", { reason: "close" });

    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toEqual([
      "claude-start",
      "codex-start",
      "claude-sub",
      "codex-sub",
      "claude-end",
      "codex-end",
    ]);
  });
});

describe("启用、整目录指纹信任、技能与 Runtime 集成", () => {
  it("缺省不启用，启用写 plugins.json，改动后变 changed 且发 plugin_changed，再启用恢复", async () => {
    const f = makeFixtureEnv();
    const pluginDir = writeCodexPlugin(f.codexHome, {
      name: "demo",
      marketplace: "mkt",
      version: "1.0.0",
      manifest: {
        interface: { displayName: "Demo Plugin" },
        description: "desc",
        skills: "./skills/",
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: "command",
                  command: `node -e "console.log('from-demo-plugin')"`,
                },
              ],
            },
          ],
        },
      },
      files: {
        "skills/demo-skill/SKILL.md": "---\ndescription: plugin skill\n---\nPLUGIN_SKILL_BODY",
        "skills/user-wins/SKILL.md": "---\ndescription: from plugin\n---\nPLUGIN_LOSES",
      },
    });
    // 同名用户技能优先于插件技能
    mkdirSync(path.join(f.nocturneHome, "skills", "user-wins"), { recursive: true });
    writeFileSync(
      path.join(f.nocturneHome, "skills", "user-wins", "SKILL.md"),
      "---\ndescription: from user\n---\nUSER_WINS",
    );

    const config = await loadConfig(f.plat, { nocturneHome: f.nocturneHome });
    const rt = await createRuntime({
      cwd: f.ws,
      sessionsDir: f.sessionsDir,
      config,
      providers: [new FakeProvider({ scripts: [] })],
      plugins: { codexHome: f.codexHome, claudeHome: f.claudeHome },
    });
    openRuntimes.push(rt);

    // 1. 缺省为 off：不运行 Hook、不提供插件技能
    const d0 = await rt.describePlugins();
    expect(d0.plugins).toHaveLength(1);
    expect(d0.plugins[0]).toMatchObject({
      id: "codex:demo@mkt",
      state: "off",
      skills: ["demo-skill", "user-wins"],
    });
    expect((await rt.describeSkills()).skills.find((s) => s.name === "demo-skill")).toBeUndefined();

    const s0 = await rt.createSession({ model: "fake/fake-model" });
    openSessions.push(s0);
    expect(s0.state().hookContext).toBeUndefined();

    // 2. 启用：写 plugins.json，并在空闲会话上重建技能
    const toggle1 = await rt.setPluginEnabled({ id: "codex:demo@mkt", enabled: true });
    expect(toggle1).toEqual({ affectedSessions: 1 });

    const pluginsJson = JSON.parse(readFileSync(path.join(f.nocturneHome, "plugins.json"), "utf8"));
    expect(pluginsJson).toMatchObject({
      version: 1,
      plugins: {
        "codex:demo@mkt": {
          enabled: true,
          hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        },
      },
    });

    // 已打开的旧会话 s0 技能已刷新，但 Hook 仅对新开会话生效
    expect(s0.describeSkills().skills.find((s) => s.name === "demo-skill")).toMatchObject({
      source: "plugin",
      plugin: "demo@mkt",
      layer: "user",
    });
    expect(s0.describeSkills().skills.find((s) => s.name === "user-wins")).toMatchObject({
      source: ".nocturne",
    });
    expect(
      (await rt.describeSkills()).skills.find(
        (s) => s.name === "user-wins" && s.source === "plugin",
      )?.shadowedBy,
    ).toBeDefined();

    // 新开会话 s1 收到 hook.context，且 hook 条目名不含绝对路径
    const s1 = await rt.createSession({ model: "fake/fake-model" });
    openSessions.push(s1);
    const snap = s1.state().hookContext?.SessionStart;
    expect(snap).toEqual([{ hook: "plugin demo@mkt SessionStart", text: "from-demo-plugin" }]);
    expect(JSON.stringify(snap)).not.toContain(f.root);

    // 3. 改动插件文件 → 状态变为 changed，技能消失，新开会话发 plugin_changed 且不跑 Hook
    writeFileSync(path.join(pluginDir, "extra.txt"), "tampered");
    const dChanged = await rt.describePlugins();
    expect(dChanged.plugins[0]?.state).toBe("changed");
    expect((await rt.describeSkills()).skills.find((s) => s.name === "demo-skill")).toBeUndefined();

    const s2 = await rt.createSession({ model: "fake/fake-model" });
    openSessions.push(s2);
    expect(s2.state().hookContext).toBeUndefined();
    expect(s2.warnings.some((w) => w.includes("demo@mkt") && w.includes("变化"))).toBe(true);

    // 4. 再次启用后恢复为 on
    await rt.setPluginEnabled({ id: "codex:demo@mkt", enabled: true });
    expect((await rt.describePlugins()).plugins[0]?.state).toBe("on");
    expect((await rt.describeSkills()).skills.find((s) => s.name === "demo-skill")?.source).toBe(
      "plugin",
    );

    // 5. 停用从 plugins.json 移除
    await rt.setPluginEnabled({ id: "codex:demo@mkt", enabled: false });
    const afterOff = JSON.parse(readFileSync(path.join(f.nocturneHome, "plugins.json"), "utf8"));
    expect(afterOff.plugins).toEqual({});
    expect((await rt.describePlugins()).plugins[0]?.state).toBe("off");
  });

  it("插件目录含符号链接时禁止启用并抛错说明原因", async () => {
    const f = makeFixtureEnv();
    const targetFile = path.join(f.root, "target.txt");
    writeFileSync(targetFile, "hello");
    const pluginDir = writeClaudePlugin(f.claudeHome, {
      name: "symlinked",
      marketplace: "mkt",
      manifest: {
        name: "symlinked",
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo sym" }] }] },
      },
    });
    try {
      symlinkSync(targetFile, path.join(pluginDir, "link.txt"), "file");
    } catch {
      // Windows 无权限建文件 symlink 时尝试 directory junction
      const targetDir = path.join(f.root, "target-dir");
      mkdirSync(targetDir, { recursive: true });
      symlinkSync(
        targetDir,
        path.join(pluginDir, "link-dir"),
        process.platform === "win32" ? "junction" : "dir",
      );
    }

    await expect(
      computePluginFingerprint(f.plat.fs, f.plat.paths, pluginDir, pluginDir),
    ).rejects.toThrow(/符号链接|symlink/);

    await expect(
      setPluginEnabled(f.plat, {
        nocturneHome: f.nocturneHome,
        codexHome: f.codexHome,
        claudeHome: f.claudeHome,
        id: "claude:symlinked@mkt",
        enabled: true,
      }),
    ).rejects.toThrow(/symlink|符号链接/);
  });

  it("plugins.json 损坏、版本不符或单个条目无效时降级告警", async () => {
    const f = makeFixtureEnv();
    writeFileSync(path.join(f.nocturneHome, "plugins.json"), "{broken");
    const d1 = await describePlugins(f.plat, {
      nocturneHome: f.nocturneHome,
      codexHome: f.codexHome,
      claudeHome: f.claudeHome,
    });
    expect(d1.warnings.some((w) => w.includes("plugins_config_invalid"))).toBe(true);

    writeFileSync(
      path.join(f.nocturneHome, "plugins.json"),
      JSON.stringify({ version: 1, plugins: { bad: { enabled: true, hash: "not-sha" } } }),
    );
    const d2 = await describePlugins(f.plat, {
      nocturneHome: f.nocturneHome,
      codexHome: f.codexHome,
      claudeHome: f.claudeHome,
    });
    expect(d2.warnings.some((w) => w.includes("bad"))).toBe(true);
  });
});

// 1x1 透明 PNG
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const TINY_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/></svg>`;
const TINY_JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const TINY_WEBP = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
]);

const MINIMAL_HOOKS = {
  SessionStart: [{ hooks: [{ type: "command", command: "echo ok" }] }],
};

describe("插件图标读取", () => {
  it("优先取 interface.composerIcon，没有时退到 interface.logo，支持 png/jpg/webp/svg", async () => {
    const f = makeFixtureEnv();
    writeCodexPlugin(f.codexHome, {
      name: "both",
      marketplace: "mkt",
      version: "1.0.0",
      manifest: {
        name: "both",
        hooks: MINIMAL_HOOKS,
        interface: {
          composerIcon: "./assets/composer.png",
          logo: "./assets/logo.svg",
        },
      },
      files: {
        "assets/composer.png": TINY_PNG,
        "assets/logo.svg": TINY_SVG,
      },
    });
    writeCodexPlugin(f.codexHome, {
      name: "logo-only",
      marketplace: "mkt",
      version: "1.0.0",
      manifest: {
        name: "logo-only",
        hooks: MINIMAL_HOOKS,
        interface: {
          logo: "./assets/logo.svg",
        },
      },
      files: {
        "assets/logo.svg": TINY_SVG,
      },
    });
    writeCodexPlugin(f.codexHome, {
      name: "jpg-icon",
      marketplace: "mkt",
      version: "1.0.0",
      manifest: {
        name: "jpg-icon",
        hooks: MINIMAL_HOOKS,
        interface: { composerIcon: "assets/pic.jpg" },
      },
      files: { "assets/pic.jpg": TINY_JPG },
    });
    writeCodexPlugin(f.codexHome, {
      name: "webp-icon",
      marketplace: "mkt",
      version: "1.0.0",
      manifest: {
        name: "webp-icon",
        hooks: MINIMAL_HOOKS,
        interface: { composerIcon: "./assets/pic.webp" },
      },
      files: { "assets/pic.webp": TINY_WEBP },
    });

    const res = await describePlugins(f.plat, {
      nocturneHome: f.nocturneHome,
      codexHome: f.codexHome,
      claudeHome: f.claudeHome,
    });
    const byName = (name: string) =>
      must(
        res.plugins.find((p) => p.name === name),
        name,
      );

    expect(byName("both").icon).toBe(`data:image/png;base64,${TINY_PNG.toString("base64")}`);
    expect(byName("logo-only").icon).toBe(
      `data:image/svg+xml;base64,${Buffer.from(TINY_SVG, "utf8").toString("base64")}`,
    );
    expect(byName("jpg-icon").icon).toBe(`data:image/jpeg;base64,${TINY_JPG.toString("base64")}`);
    expect(byName("webp-icon").icon).toBe(`data:image/webp;base64,${TINY_WEBP.toString("base64")}`);
    for (const p of res.plugins) {
      expect(p.warnings).toEqual([]);
    }
  });

  it("越界路径、符号链接指向外部、超过 64 KB、不支持格式时均无 icon 且不报警告", async () => {
    const f = makeFixtureEnv();
    const outsidePng = path.join(f.root, "outside.png");
    writeFileSync(outsidePng, TINY_PNG);

    // 1. .. 越界
    writeCodexPlugin(f.codexHome, {
      name: "escape",
      marketplace: "mkt",
      version: "1.0.0",
      manifest: {
        name: "escape",
        hooks: MINIMAL_HOOKS,
        interface: { composerIcon: "../../../../../../outside.png" },
      },
    });
    // 2. 超过 64 KB（65537 字节）
    const oversized = Buffer.concat([TINY_PNG, Buffer.alloc(64 * 1024 + 1 - TINY_PNG.length)]);
    writeCodexPlugin(f.codexHome, {
      name: "too-big",
      marketplace: "mkt",
      version: "1.0.0",
      manifest: {
        name: "too-big",
        hooks: MINIMAL_HOOKS,
        interface: { composerIcon: "./big.png" },
      },
      files: { "big.png": oversized },
    });
    // 3. 不支持的格式（.gif 与内容不符的 .png）
    writeCodexPlugin(f.codexHome, {
      name: "bad-ext",
      marketplace: "mkt",
      version: "1.0.0",
      manifest: {
        name: "bad-ext",
        hooks: MINIMAL_HOOKS,
        interface: { composerIcon: "./anim.gif" },
      },
      files: { "anim.gif": Buffer.from("GIF89a") },
    });
    writeCodexPlugin(f.codexHome, {
      name: "bad-magic",
      marketplace: "mkt",
      version: "1.0.0",
      manifest: {
        name: "bad-magic",
        hooks: MINIMAL_HOOKS,
        interface: { composerIcon: "./fake.png" },
      },
      files: { "fake.png": "not really a png" },
    });
    // 4. 符号链接指向根目录外（Windows 若无文件 symlink 权限则用目录 junction）
    const symlinkPluginDir = writeCodexPlugin(f.codexHome, {
      name: "sym-icon",
      marketplace: "mkt",
      version: "1.0.0",
      manifest: {
        name: "sym-icon",
        hooks: MINIMAL_HOOKS,
        interface: { composerIcon: "./linked/outside.png" },
      },
    });
    const outsideDir = path.join(f.root, "outside-icons");
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(path.join(outsideDir, "outside.png"), TINY_PNG);
    symlinkSync(
      outsideDir,
      path.join(symlinkPluginDir, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const { plugins } = await discoverInstalledPlugins(f.plat, {
      nocturneHome: f.nocturneHome,
      codexHome: f.codexHome,
      claudeHome: f.claudeHome,
    });
    for (const name of ["escape", "too-big", "bad-ext", "bad-magic", "sym-icon"]) {
      const p = must(
        plugins.find((item) => item.overview.name === name),
        name,
      );
      expect(p.overview.icon).toBeUndefined();
      expect(p.overview.warnings).toEqual([]);
    }
  });

  it("同一插件目录两次计算指纹相同，且图标读取不影响指纹", async () => {
    const f = makeFixtureEnv();
    const withIconDir = writeCodexPlugin(f.codexHome, {
      name: "with-icon",
      marketplace: "mkt",
      version: "1.0.0",
      manifest: {
        name: "with-icon",
        interface: {
          displayName: "With Icon",
          composerIcon: "./assets/icon.png",
        },
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "node ./run.mjs" }] }],
        },
      },
      files: {
        "assets/icon.png": TINY_PNG,
        "run.mjs": "console.log('v1');",
      },
    });
    const noIconDir = writeCodexPlugin(f.codexHome, {
      name: "no-icon",
      marketplace: "mkt",
      version: "1.0.0",
      manifest: {
        name: "no-icon",
        interface: {
          displayName: "No Icon",
          composerIcon: "./assets/missing.png",
        },
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "node ./run.mjs" }] }],
        },
      },
      files: {
        "run.mjs": "console.log('v1');",
      },
    });

    // 1. 同一插件目录两次计算，指纹相同
    const hash1 = await computePluginFingerprint(f.plat.fs, f.plat.paths, withIconDir, withIconDir);
    const hash2 = await computePluginFingerprint(f.plat.fs, f.plat.paths, withIconDir, withIconDir);
    expect(hash1).toBe(hash2);

    const noIconHash1 = await computePluginFingerprint(
      f.plat.fs,
      f.plat.paths,
      noIconDir,
      noIconDir,
    );
    const noIconHash2 = await computePluginFingerprint(
      f.plat.fs,
      f.plat.paths,
      noIconDir,
      noIconDir,
    );
    expect(noIconHash1).toBe(noIconHash2);

    // 2. 图标读取不影响指纹：以整目录指纹启用后，有 icon 与无 icon 的 overview 均对应同一个指纹并保持 on
    await setPluginEnabled(f.plat, {
      nocturneHome: f.nocturneHome,
      codexHome: f.codexHome,
      claudeHome: f.claudeHome,
      id: "codex:with-icon@mkt",
      enabled: true,
    });
    await setPluginEnabled(f.plat, {
      nocturneHome: f.nocturneHome,
      codexHome: f.codexHome,
      claudeHome: f.claudeHome,
      id: "codex:no-icon@mkt",
      enabled: true,
    });

    const stored = JSON.parse(readFileSync(path.join(f.nocturneHome, "plugins.json"), "utf8")) as {
      plugins: Record<string, { hash: string }>;
    };
    expect(stored.plugins["codex:with-icon@mkt"]?.hash).toBe(hash1);
    expect(stored.plugins["codex:no-icon@mkt"]?.hash).toBe(noIconHash1);

    const res = await describePlugins(f.plat, {
      nocturneHome: f.nocturneHome,
      codexHome: f.codexHome,
      claudeHome: f.claudeHome,
    });
    const withIconOverview = must(
      res.plugins.find((p) => p.id === "codex:with-icon@mkt"),
      "with-icon",
    );
    const noIconOverview = must(
      res.plugins.find((p) => p.id === "codex:no-icon@mkt"),
      "no-icon",
    );
    expect(withIconOverview.state).toBe("on");
    expect(withIconOverview.icon).toBe(`data:image/png;base64,${TINY_PNG.toString("base64")}`);
    expect(noIconOverview.state).toBe("on");
    expect(noIconOverview.icon).toBeUndefined();

    // 图标读取后再次计算目录指纹，结果不变
    const hashAfterDescribe = await computePluginFingerprint(
      f.plat.fs,
      f.plat.paths,
      withIconDir,
      withIconDir,
    );
    expect(hashAfterDescribe).toBe(hash1);
  });
});

describe("排除 Codex 系统市场与无 Hook 无技能插件", () => {
  it("排除 Codex 系统市场 openai-bundled 与 openai-primary-runtime 插件且不报警告", async () => {
    const f = makeFixtureEnv();
    writeCodexPlugin(f.codexHome, {
      name: "browser",
      marketplace: "openai-bundled",
      version: "1.0.0",
      manifest: {
        name: "browser",
        hooks: MINIMAL_HOOKS,
        skills: "./skills",
      },
      files: {
        "skills/bundled-skill/SKILL.md": "---\ndescription: bundled\n---\nbody",
      },
    });
    writeCodexPlugin(f.codexHome, {
      name: "documents",
      marketplace: "openai-primary-runtime",
      version: "1.0.0",
      manifest: {
        name: "documents",
        hooks: MINIMAL_HOOKS,
        skills: "./skills",
      },
      files: {
        "skills/doc-skill/SKILL.md": "---\ndescription: doc\n---\nbody",
      },
    });
    writeCodexPlugin(f.codexHome, {
      name: "kept",
      marketplace: "openai-curated",
      version: "1.0.0",
      manifest: { name: "kept", hooks: MINIMAL_HOOKS },
    });

    const res = await describePlugins(f.plat, {
      nocturneHome: f.nocturneHome,
      codexHome: f.codexHome,
      claudeHome: f.claudeHome,
    });
    expect(res.plugins.map((p) => p.id)).toEqual(["codex:kept@openai-curated"]);
    expect(res.warnings).toEqual([]);
  });

  it("排除无 Hook 无技能与仅有不受支持 Hook 的插件，保留有技能无 Hook 的插件且不报警告", async () => {
    const f = makeFixtureEnv();
    // 无 Hook 无技能（Codex & Claude）
    writeCodexPlugin(f.codexHome, {
      name: "empty-codex",
      marketplace: "mkt",
      version: "1.0.0",
      manifest: { name: "empty-codex" },
    });
    writeClaudePlugin(f.claudeHome, {
      name: "empty-claude",
      marketplace: "mkt",
      manifest: { name: "empty-claude" },
    });
    // 只有不受支持 Hook 且无技能
    writeCodexPlugin(f.codexHome, {
      name: "unsupported-only",
      marketplace: "mkt",
      version: "1.0.0",
      manifest: {
        name: "unsupported-only",
        hooks: {
          PreToolUse: [{ hooks: [{ type: "command", command: "echo tool" }] }],
          SessionStart: [{ hooks: [{ type: "prompt", prompt: "ignored" }] }],
        },
      },
    });
    // 有技能无 Hook：应保留
    writeClaudePlugin(f.claudeHome, {
      name: "skills-only",
      marketplace: "mkt",
      manifest: { name: "skills-only" },
      files: {
        "skills/only-skill/SKILL.md": "---\ndescription: useful skill\n---\nSKILL_BODY",
      },
    });

    const res = await describePlugins(f.plat, {
      nocturneHome: f.nocturneHome,
      codexHome: f.codexHome,
      claudeHome: f.claudeHome,
    });
    expect(res.plugins.map((p) => p.id)).toEqual(["claude:skills-only@mkt"]);
    expect(res.plugins[0]?.hooks).toEqual([]);
    expect(res.plugins[0]?.skills).toEqual(["only-skill"]);
    expect(res.warnings).toEqual([]);
  });

  it("被排除插件在 plugins.json 中已有的启用记录保持原样，且不参与 Hook 注入和技能加载", async () => {
    const f = makeFixtureEnv();
    const bundledDir = writeCodexPlugin(f.codexHome, {
      name: "visualize",
      marketplace: "openai-bundled",
      version: "1.0.0",
      manifest: {
        name: "visualize",
        hooks: {
          SessionStart: [
            { hooks: [{ type: "command", command: `node -e "console.log('bundled-ran')"` }] },
          ],
        },
      },
      files: {
        "skills/viz-skill/SKILL.md": "---\ndescription: viz\n---\nVIZ",
      },
    });
    const emptyDir = writeClaudePlugin(f.claudeHome, {
      name: "empty-stored",
      marketplace: "mkt",
      manifest: { name: "empty-stored" },
    });
    const bundledHash = await computePluginFingerprint(
      f.plat.fs,
      f.plat.paths,
      bundledDir,
      bundledDir,
    );
    const emptyHash = await computePluginFingerprint(f.plat.fs, f.plat.paths, emptyDir, emptyDir);

    const storedPayload = JSON.stringify(
      {
        version: 1,
        plugins: {
          "codex:visualize@openai-bundled": { enabled: true, hash: bundledHash },
          "claude:empty-stored@mkt": { enabled: true, hash: emptyHash },
        },
      },
      null,
      2,
    );
    const pluginsJsonPath = path.join(f.nocturneHome, "plugins.json");
    writeFileSync(pluginsJsonPath, storedPayload);

    const config = await loadConfig(f.plat, { nocturneHome: f.nocturneHome });
    const rt = await createRuntime({
      cwd: f.ws,
      sessionsDir: f.sessionsDir,
      config,
      providers: [new FakeProvider({ scripts: [] })],
      plugins: { codexHome: f.codexHome, claudeHome: f.claudeHome },
    });
    openRuntimes.push(rt);

    const desc = await rt.describePlugins();
    expect(desc.plugins).toEqual([]);
    expect(desc.warnings).toEqual([]);
    expect((await rt.describeSkills()).skills.find((s) => s.name === "viz-skill")).toBeUndefined();

    const s = await rt.createSession({ model: "fake/fake-model" });
    openSessions.push(s);
    expect(s.state().hookContext).toBeUndefined();
    expect(s.warnings).toEqual([]);

    // plugins.json 保持原样，不删除、不改写
    expect(readFileSync(pluginsJsonPath, "utf8")).toBe(storedPayload);
  });
});

// ── ADR-0100 自有插件（内置、本地安装、9 点位 Hook、MCP 服务器） ──────────────

function writeNativePlugin(
  parentDir: string,
  opts: {
    dirName?: string;
    manifestDir?: ".nocturne-plugin" | ".codex-plugin" | ".claude-plugin";
    manifest: Record<string, unknown>;
    files?: Record<string, string | Uint8Array>;
  },
): string {
  const name = opts.dirName ?? String(opts.manifest.name ?? "sample");
  const pluginDir = path.join(parentDir, name);
  const mDir = path.join(pluginDir, opts.manifestDir ?? ".nocturne-plugin");
  mkdirSync(mDir, { recursive: true });
  writeFileSync(path.join(mDir, "plugin.json"), JSON.stringify(opts.manifest, null, 2));
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    const target = path.join(pluginDir, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return pluginDir;
}

describe("ADR-0100 自有插件发现与启停", () => {
  it("自有清单内置插件默认 on、无指纹；关闭记 enabled:false，再开启恢复 on", async () => {
    const f = makeFixtureEnv();
    const builtinDir = path.join(f.root, "builtin-plugins");
    const pluginDir = writeNativePlugin(builtinDir, {
      dirName: "office-fixture",
      manifest: {
        name: "office-fixture",
        version: "0.1.0",
        description: "内置夹具插件",
      },
      files: {
        "skills/doc-read/SKILL.md": "---\ndescription: read doc\n---\nDOC BODY",
      },
    });

    const discOpts = {
      nocturneHome: f.nocturneHome,
      builtinPluginsDir: builtinDir,
      codexHome: f.codexHome,
      claudeHome: f.claudeHome,
    };

    // 默认开启，无 plugins.json 也是 on
    const initial = await describePlugins(f.plat, discOpts);
    expect(initial.plugins).toHaveLength(1);
    const p = must(initial.plugins[0]);
    expect(p.id).toBe("nocturne:office-fixture@builtin");
    expect(p.host).toBe("nocturne");
    expect(p.marketplace).toBe("builtin");
    expect(p.state).toBe("on");
    expect(p.skills).toEqual(["doc-read"]);

    // 修改内置插件文件不会触发 changed（不做指纹）
    writeFileSync(path.join(pluginDir, "extra.txt"), "updated");
    const afterModify = await describePlugins(f.plat, discOpts);
    expect(afterModify.plugins[0]?.state).toBe("on");

    // 关闭后 plugins.json 记 enabled: false，状态为 off
    await setPluginEnabled(f.plat, { ...discOpts, id: p.id, enabled: false });
    const stored = JSON.parse(readFileSync(path.join(f.nocturneHome, "plugins.json"), "utf8")) as {
      plugins: Record<string, unknown>;
    };
    expect(stored.plugins[p.id]).toEqual({ enabled: false });
    expect((await describePlugins(f.plat, discOpts)).plugins[0]?.state).toBe("off");

    // 再开启恢复 on，且不写哈希
    await setPluginEnabled(f.plat, { ...discOpts, id: p.id, enabled: true });
    const storedAgain = JSON.parse(
      readFileSync(path.join(f.nocturneHome, "plugins.json"), "utf8"),
    ) as { plugins: Record<string, unknown> };
    expect(storedAgain.plugins[p.id]).toBeUndefined();
    expect((await describePlugins(f.plat, discOpts)).plugins[0]?.state).toBe("on");
  });

  it("本地安装目录里的插件默认 off，启用后内容变化变为 changed；兼容清单仍只接 4 点位", async () => {
    const f = makeFixtureEnv();
    const localBase = path.join(f.nocturneHome, "plugins", "installed", "local");
    const nativeDir = writeNativePlugin(path.join(localBase, "local-native"), {
      dirName: "1.0.0",
      manifest: {
        name: "local-native",
        version: "1.0.0",
        hooks: {
          PreToolUse: [{ matcher: "shell", command: "node", args: ["./hook.mjs"] }],
        },
      },
      files: { "hook.mjs": "console.log('{}')" },
    });
    writeNativePlugin(path.join(localBase, "local-compat"), {
      dirName: "1.0.0",
      manifestDir: ".claude-plugin",
      manifest: {
        name: "local-compat",
        version: "1.0.0",
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "node -e 1" }] }],
          PreToolUse: [{ hooks: [{ type: "command", command: "node -e 1" }] }],
        },
      },
    });

    const discOpts = {
      nocturneHome: f.nocturneHome,
      codexHome: f.codexHome,
      claudeHome: f.claudeHome,
    };

    const initial = await describePlugins(f.plat, discOpts);
    const nativeItem = must(initial.plugins.find((p) => p.id === "nocturne:local-native@local"));
    const compatItem = must(initial.plugins.find((p) => p.id === "nocturne:local-compat@local"));
    expect(nativeItem.state).toBe("off");
    expect(nativeItem.hooks.map((h) => h.point)).toEqual(["PreToolUse"]);
    expect(compatItem.state).toBe("off");
    // 兼容清单只接 4 点位，PreToolUse 记入 unsupported
    expect(compatItem.hooks.map((h) => h.point)).toEqual(["SessionStart"]);
    expect(compatItem.unsupported).toEqual([{ point: "PreToolUse", reason: "point" }]);

    // 启用后为 on，改内容后变为 changed
    await setPluginEnabled(f.plat, { ...discOpts, id: nativeItem.id, enabled: true });
    expect(
      (await describePlugins(f.plat, discOpts)).plugins.find((p) => p.id === nativeItem.id)?.state,
    ).toBe("on");
    writeFileSync(path.join(nativeDir, "hook.mjs"), 'console.log(\'{"decision":"deny"}\')');
    expect(
      (await describePlugins(f.plat, discOpts)).plugins.find((p) => p.id === nativeItem.id)?.state,
    ).toBe("changed");
  });
});

describe("ADR-0100 自有插件 Hook（9 点位）与 MCP 策略", () => {
  it("自有插件 PreToolUse(deny) 与 PermissionRequest(allow) 在真实会话生效，PreToolUse(allow) 不被接受", async () => {
    const f = makeFixtureEnv();
    const builtinDir = path.join(f.root, "builtin-hooks");
    const hookScript = `
const fs = require("node:fs");
const input = JSON.parse(fs.readFileSync(0, "utf8"));
if (input.point === "PreToolUse") {
  const p = String((input.input && input.input.path) || "");
  if (p.includes("blocked.txt")) {
    console.log(JSON.stringify({ decision: "deny", reason: "blocked by native plugin" }));
  } else if (p.includes("try-allow.txt")) {
    // PreToolUse 返回 allow 必须被忽略（不能绕过权限层）
    console.log(JSON.stringify({ decision: "allow", reason: "should be ignored" }));
  }
} else if (input.point === "PermissionRequest") {
  const subjects = input.subjects || [];
  if (subjects.some((s) => String(s.target || "").includes("approved.txt"))) {
    console.log(JSON.stringify({ action: "allow", reason: "approved by native plugin" }));
  }
}
`;
    writeNativePlugin(builtinDir, {
      dirName: "guard-plugin",
      manifest: {
        name: "guard-plugin",
        version: "1.0.0",
        hooks: {
          PreToolUse: [
            {
              matcher: "write",
              command: process.execPath,
              args: ["${PLUGIN_ROOT}/hook.cjs"],
              timeoutMs: 10000,
            },
          ],
          PermissionRequest: [
            {
              matcher: "write",
              command: process.execPath,
              args: ["${PLUGIN_ROOT}/hook.cjs"],
              timeoutMs: 10000,
            },
          ],
        },
      },
      files: { "hook.cjs": hookScript },
    });

    const config = await loadConfig(f.plat, { nocturneHome: f.nocturneHome });
    const provider = new FakeProvider({
      scripts: [
        // Turn 1: blocked.txt → PreToolUse deny
        [
          {
            type: "tool_call",
            toolCallId: "c1",
            name: "write",
            input: { path: "blocked.txt", content: "x" },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text_delta", text: "t1" },
          { type: "finish", reason: "stop" },
        ],
        // Turn 2: try-allow.txt → PreToolUse 返回 allow 不被接受；非交互模式 ask → deny
        [
          {
            type: "tool_call",
            toolCallId: "c2",
            name: "write",
            input: { path: "try-allow.txt", content: "y" },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text_delta", text: "t2" },
          { type: "finish", reason: "stop" },
        ],
        // Turn 3: approved.txt → PermissionRequest 返回 allow 放行写入
        [
          {
            type: "tool_call",
            toolCallId: "c3",
            name: "write",
            input: { path: "approved.txt", content: "ok" },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text_delta", text: "t3" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    const rt = await createRuntime({
      cwd: f.ws,
      sessionsDir: f.sessionsDir,
      config,
      interactive: false,
      providers: [provider],
      builtinPluginsDir: builtinDir,
      plugins: { codexHome: f.codexHome, claudeHome: f.claudeHome },
    });
    openRuntimes.push(rt);
    const s = await rt.createSession({ model: "fake/fake-model" });
    openSessions.push(s);

    const events: { type: string; payload: Record<string, unknown> }[] = [];
    s.subscribe((e) => {
      events.push({ type: e.type, payload: e.payload as Record<string, unknown> });
    });

    await s.submit({ text: "write blocked" });
    await s.submit({ text: "write try-allow" });
    await s.submit({ text: "write approved" });

    const completed = events.filter((e) => e.type === "tool.completed");
    expect(completed[0]?.payload.status).toBe("denied");
    expect(
      String((completed[0]?.payload.error as { message?: string } | undefined)?.message),
    ).toContain("blocked by native plugin");
    // PreToolUse 返回 allow 未被接受，仍由非交互权限层拒绝且未落盘
    expect(completed[1]?.payload.status).toBe("denied");
    expect(existsSync(path.join(f.ws, "try-allow.txt"))).toBe(false);
    const c2Resolved = events.find(
      (e) => e.type === "permission.resolved" && e.payload.callId === completed[1]?.payload.callId,
    );
    expect(c2Resolved?.payload.source).toBe("non_interactive");
    // PermissionRequest 返回 allow 放行写入
    expect(completed[2]?.payload.status).toBe("ok");
    expect(readFileSync(path.join(f.ws, "approved.txt"), "utf8")).toBe("ok");
    const c3Resolved = events.find(
      (e) => e.type === "permission.resolved" && e.payload.callId === completed[2]?.payload.callId,
    );
    expect(c3Resolved?.payload.action).toBe("allow");
    expect(c3Resolved?.payload.source).toBe("hook");
  });

  it("MCP 策略：只带 MCP 的插件会列出；{stored:true} 被拒；type:http 记入 unsupported；同名冲突跳过并告警；启停触发空闲会话 reconcile", async () => {
    const f = makeFixtureEnv();
    const builtinDir = path.join(f.root, "builtin-mcp");
    // 仅含受支持 stdio MCP 的插件 + 同名冲突 + stored 被拒 + http 记 unsupported
    writeNativePlugin(builtinDir, {
      dirName: "mcp-mix",
      manifest: {
        name: "mcp-mix",
        version: "0.2.0",
        mcpServers: {
          alpha: {
            command: "${NOCTURNE_NODE}",
            args: ["${PLUGIN_ROOT}/srv.mjs", "${PLUGIN_DATA}"],
            env: { DATA_DIR: "${PLUGIN_DATA}" },
          },
          conflictSrv: {
            command: "${NOCTURNE_NODE}",
            args: ["${PLUGIN_ROOT}/conflict.mjs"],
          },
          badStored: {
            command: "${NOCTURNE_NODE}",
            args: ["${PLUGIN_ROOT}/stored.mjs"],
            env: { API_KEY: { stored: true } },
          },
          remoteHttp: {
            type: "http",
            url: "https://example.com/mcp",
          },
        },
      },
    });
    // 只有不支持的 http MCP、无 Hook 无技能的插件：不应列出
    writeNativePlugin(builtinDir, {
      dirName: "http-only",
      manifest: {
        name: "http-only",
        version: "0.1.0",
        mcpServers: {
          onlyHttp: { type: "http", url: "https://example.com/mcp" },
        },
      },
    });

    // 用户配置已声明同名服务器 conflictSrv
    writeFileSync(
      path.join(f.nocturneHome, "config.json"),
      JSON.stringify({
        modelsDev: false,
        skills: { sources: { agents: false, claude: false } },
        mcp: {
          servers: {
            conflictSrv: { command: process.execPath, args: ["-e", ""] },
          },
        },
      }),
    );

    const openCalls: string[][] = [];
    const reconcileCalls: string[][] = [];
    const fakeMcp = {
      probe: async () => ({ ok: true as const, tools: [], durationMs: 1 }),
      open: async (scope: { servers: readonly { name: string }[] }) => {
        openCalls.push(scope.servers.map((s) => s.name));
        return {
          startup: async () => undefined,
          reconcile: async (servers: readonly { name: string }[]) => {
            reconcileCalls.push(servers.map((s) => s.name));
          },
          tools: () => [],
          status: () => [],
          applyPendingTools: () => ({ add: [], remove: [] }),
          close: async () => undefined,
        };
      },
    };

    const config = await loadConfig(f.plat, { nocturneHome: f.nocturneHome });
    const rt = await createRuntime({
      cwd: f.ws,
      sessionsDir: f.sessionsDir,
      config,
      mcp: fakeMcp,
      providers: [new FakeProvider({ scripts: [] })],
      builtinPluginsDir: builtinDir,
      plugins: { codexHome: f.codexHome, claudeHome: f.claudeHome },
    });
    openRuntimes.push(rt);

    const desc = await rt.describePlugins();
    expect(desc.plugins.map((p) => p.id)).toEqual(["nocturne:mcp-mix@builtin"]);
    const mix = must(desc.plugins[0]);
    expect(mix.unsupported).toContainEqual({ point: "mcp:remoteHttp", reason: "type" });
    expect(mix.mcpServers).toEqual([
      { id: "alpha", command: "${NOCTURNE_NODE} ${PLUGIN_ROOT}/srv.mjs ${PLUGIN_DATA}" },
      {
        id: "conflictSrv",
        command: "${NOCTURNE_NODE} ${PLUGIN_ROOT}/conflict.mjs",
        skipped: true,
        skipReason: "conflict",
      },
      {
        id: "badStored",
        command: "${NOCTURNE_NODE} ${PLUGIN_ROOT}/stored.mjs",
        skipped: true,
        skipReason: "stored",
      },
      {
        id: "remoteHttp",
        command: "https://example.com/mcp",
        skipped: true,
        skipReason: "http",
      },
    ]);

    const s = await rt.createSession({ model: "fake/fake-model" });
    openSessions.push(s);
    const conflictWarnings: string[] = [];
    // 打开会话时冲突警告写入 s.warnings，且只把 conflictSrv（配置优先）和 alpha 交给 MCP connector
    expect(openCalls).toEqual([["conflictSrv", "alpha"]]);
    expect(s.warnings.some((w) => w.includes("conflictSrv"))).toBe(true);

    s.subscribe((e) => {
      if (e.type === "runtime.warning" && e.payload.code === "plugin_mcp_conflict") {
        conflictWarnings.push(e.payload.message);
      }
    });

    // 关闭插件 → 空闲会话立即 reconcile，移除 alpha
    await rt.setPluginEnabled({ id: "nocturne:mcp-mix@builtin", enabled: false });
    expect(reconcileCalls.at(-1)).toEqual(["conflictSrv"]);

    // 再开启插件 → 空闲会话立即 reconcile，恢复 alpha 并发冲突告警
    await rt.setPluginEnabled({ id: "nocturne:mcp-mix@builtin", enabled: true });
    expect(reconcileCalls.at(-1)).toEqual(["conflictSrv", "alpha"]);
    expect(conflictWarnings.some((w) => w.includes("conflictSrv"))).toBe(true);
  });

  it("支持 mcpServers 相对路径与默认 .mcp.json；自有插件 Hook 走白名单环境并注入 PLUGIN_ROOT/PLUGIN_DATA", async () => {
    const f = makeFixtureEnv();
    const builtinDir = path.join(f.root, "builtin-forms");
    writeNativePlugin(builtinDir, {
      dirName: "by-path",
      manifest: {
        name: "by-path",
        version: "0.1.0",
        mcpServers: "./cfg/mcp.json",
      },
      files: {
        "cfg/mcp.json": JSON.stringify({
          mcpServers: {
            fromPath: { command: "${NOCTURNE_NODE}", args: ["${PLUGIN_ROOT}/s.mjs"] },
          },
        }),
      },
    });
    writeNativePlugin(builtinDir, {
      dirName: "by-default",
      manifest: {
        name: "by-default",
        version: "0.1.0",
        hooks: {
          SessionStart: [
            {
              command: process.execPath,
              args: [
                "-e",
                "console.log(JSON.stringify({ additionalContext: [process.env.PLUGIN_ROOT ? 'R' : '', process.env.PLUGIN_DATA ? 'D' : '', process.env.ANTHROPIC_API_KEY || 'NOKEY'].join(':') }))",
              ],
            },
          ],
        },
      },
      files: {
        ".mcp.json": JSON.stringify({
          mcpServers: {
            fromDefault: { command: "${NOCTURNE_NODE}", args: ["${PLUGIN_DATA}/d.mjs"] },
          },
        }),
      },
    });

    const platWithSecret = {
      ...f.plat,
      env: (name: string) => (name === "ANTHROPIC_API_KEY" ? "sk-ant-secret" : f.plat.env(name)),
    };
    const origKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-secret";
    try {
      const discovered = await discoverInstalledPlugins(platWithSecret, {
        nocturneHome: f.nocturneHome,
        builtinPluginsDir: builtinDir,
        codexHome: f.codexHome,
        claudeHome: f.claudeHome,
      });
      const byPath = must(
        discovered.plugins.find((p) => p.overview.id === "nocturne:by-path@builtin"),
      );
      const byDefault = must(
        discovered.plugins.find((p) => p.overview.id === "nocturne:by-default@builtin"),
      );
      expect(byPath.mcpServers[0]?.id).toBe("fromPath");
      expect(byPath.mcpServers[0]?.entry.type).not.toBe("http");
      expect(byDefault.mcpServers[0]?.id).toBe("fromDefault");

      const runner = createHookRunner({
        hooks: byDefault.hooks,
        platform: platWithSecret,
        sessionId: "s-native-env",
        cwd: f.ws,
        workspaceRoot: f.ws,
      });
      const out = await runner.run("SessionStart", { resumed: false, source: "startup" });
      expect(out?.contextEntries?.[0]?.text).toBe("R:D:NOKEY");
    } finally {
      if (origKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = origKey;
    }
  });
});

describe("ADR-0100 第三期：本地目录安装与卸载", () => {
  it("安装成功：支持三种清单（nocturne/codex/claude），跳过 .git 与符号链接，新装状态为 off，缺省或不合法版本用 local", async () => {
    const f = makeFixtureEnv();
    const sourcesRoot = path.join(f.root, "sources");

    // 1. 自有清单（含 .git、符号链接与合法版本）
    const nocturneSrc = writeNativePlugin(sourcesRoot, {
      dirName: "src-nocturne",
      manifestDir: ".nocturne-plugin",
      manifest: {
        name: "my-native",
        version: "1.2.0",
        description: "自有本地插件",
      },
      files: {
        "skills/native-hello/SKILL.md": "---\ndescription: native skill\n---\nHello",
        ".git/HEAD": "ref: refs/heads/main\n",
      },
    });
    const outsideFile = path.join(f.root, "outside-secret.txt");
    writeFileSync(outsideFile, "do-not-copy");
    try {
      symlinkSync(outsideFile, path.join(nocturneSrc, "linked.txt"), "file");
    } catch {
      // 无符号链接权限的环境跳过创建，主断言仍覆盖 .git 与清单
    }

    // 2. Codex 兼容清单（无 version → 版本目录为 local）
    const codexSrc = writeNativePlugin(sourcesRoot, {
      dirName: "src-codex",
      manifestDir: ".codex-plugin",
      manifest: {
        name: "my-codex",
        interface: { displayName: "My Codex", shortDescription: "Codex 描述" },
      },
      files: {
        "skills/codex-s/SKILL.md": "---\ndescription: codex skill\n---\nCodex",
      },
    });

    // 3. Claude Code 兼容清单（非法版本含空格/斜杠 → 版本目录为 local）
    const claudeSrc = writeNativePlugin(sourcesRoot, {
      dirName: "src-claude",
      manifestDir: ".claude-plugin",
      manifest: {
        name: "my-claude",
        version: "bad version/1",
        description: "Claude 描述",
      },
      files: {
        "skills/claude-s/SKILL.md": "---\ndescription: claude skill\n---\nClaude",
      },
    });

    const discOpts = {
      nocturneHome: f.nocturneHome,
      codexHome: f.codexHome,
      claudeHome: f.claudeHome,
    };

    const p1 = await installLocalPlugin(f.plat, { ...discOpts, path: nocturneSrc });
    expect(p1.id).toBe("nocturne:my-native@local");
    expect(p1.state).toBe("off");
    expect(p1.version).toBe("1.2.0");
    expect(p1.skills).toEqual(["native-hello"]);
    expect(existsSync(path.join(p1.root, ".git"))).toBe(false);
    expect(existsSync(path.join(p1.root, "linked.txt"))).toBe(false);

    const p2 = await installLocalPlugin(f.plat, { ...discOpts, path: codexSrc });
    expect(p2.id).toBe("nocturne:my-codex@local");
    expect(p2.state).toBe("off");
    expect(p2.version).toBe("local");
    expect(p2.displayName).toBe("My Codex");
    expect(path.basename(p2.root)).toBe("local");

    const p3 = await installLocalPlugin(f.plat, { ...discOpts, path: claudeSrc });
    expect(p3.id).toBe("nocturne:my-claude@local");
    expect(p3.state).toBe("off");
    expect(p3.version).toBe("local");
    expect(path.basename(p3.root)).toBe("local");
  });

  it("清单无效被拒：缺清单、非法 JSON、非法 name、非法相对路径、无可用能力", async () => {
    const f = makeFixtureEnv();
    const sourcesRoot = path.join(f.root, "bad-sources");
    const discOpts = {
      nocturneHome: f.nocturneHome,
      codexHome: f.codexHome,
      claudeHome: f.claudeHome,
    };

    // 缺少清单
    const noManifest = path.join(sourcesRoot, "no-manifest");
    mkdirSync(noManifest, { recursive: true });
    await expect(installLocalPlugin(f.plat, { ...discOpts, path: noManifest })).rejects.toThrow(
      /未找到/,
    );

    // 非法 JSON
    const badJson = path.join(sourcesRoot, "bad-json");
    mkdirSync(path.join(badJson, ".nocturne-plugin"), { recursive: true });
    writeFileSync(path.join(badJson, ".nocturne-plugin", "plugin.json"), "{broken");
    await expect(installLocalPlugin(f.plat, { ...discOpts, path: badJson })).rejects.toThrow(
      /合法 JSON/,
    );

    // 非法 name（自有清单不允许大写）
    const badName = writeNativePlugin(sourcesRoot, {
      dirName: "bad-name",
      manifest: { name: "Bad_Name", version: "1.0.0" },
      files: { "skills/s1/SKILL.md": "---\ndescription: s\n---\nhi" },
    });
    await expect(installLocalPlugin(f.plat, { ...discOpts, path: badName })).rejects.toThrow(
      /只允许小写字母/,
    );

    // 相对路径不以 ./ 开头或越界
    const badRel = writeNativePlugin(sourcesRoot, {
      dirName: "bad-rel",
      manifest: { name: "bad-rel", version: "1.0.0", skills: ["../outside"] },
    });
    await expect(installLocalPlugin(f.plat, { ...discOpts, path: badRel })).rejects.toThrow(
      /必须以 "\.\/" 开头/,
    );

    const escapeRel = writeNativePlugin(sourcesRoot, {
      dirName: "escape-rel",
      manifest: { name: "escape-rel", version: "1.0.0", skills: ["./../../outside"] },
    });
    await expect(installLocalPlugin(f.plat, { ...discOpts, path: escapeRel })).rejects.toThrow(
      /越出插件目录/,
    );

    // 无可用能力
    const emptyCap = writeNativePlugin(sourcesRoot, {
      dirName: "empty-cap",
      manifest: { name: "empty-cap", version: "1.0.0" },
    });
    await expect(installLocalPlugin(f.plat, { ...discOpts, path: emptyCap })).rejects.toThrow(
      /不包含可用的技能、Hook 或 MCP 服务器/,
    );
  });

  it("路径在 plugins/ 内或不存在/非目录时被拒", async () => {
    const f = makeFixtureEnv();
    const insidePlugins = writeNativePlugin(path.join(f.nocturneHome, "plugins", "tmp"), {
      dirName: "inside",
      manifest: { name: "inside", version: "1.0.0" },
      files: { "skills/s/SKILL.md": "---\ndescription: s\n---\nhi" },
    });
    const singleFile = path.join(f.root, "plain.txt");
    writeFileSync(singleFile, "file");
    const discOpts = {
      nocturneHome: f.nocturneHome,
      codexHome: f.codexHome,
      claudeHome: f.claudeHome,
    };

    await expect(installLocalPlugin(f.plat, { ...discOpts, path: insidePlugins })).rejects.toThrow(
      /插件目录内/,
    );
    await expect(
      installLocalPlugin(f.plat, { ...discOpts, path: path.join(f.root, "missing-dir") }),
    ).rejects.toThrow(/不存在/);
    await expect(installLocalPlugin(f.plat, { ...discOpts, path: singleFile })).rejects.toThrow(
      /不是目录/,
    );
  });

  it("同名重装替换整个 local/<name>/ 且已启用插件按指纹变为 changed", async () => {
    const f = makeFixtureEnv();
    const v1Src = writeNativePlugin(path.join(f.root, "v1"), {
      dirName: "src",
      manifest: { name: "demo-tool", version: "1.0.0" },
      files: { "skills/demo/SKILL.md": "---\ndescription: v1\n---\nV1" },
    });
    const v2Src = writeNativePlugin(path.join(f.root, "v2"), {
      dirName: "src",
      manifest: { name: "demo-tool", version: "2.0.0" },
      files: { "skills/demo/SKILL.md": "---\ndescription: v2\n---\nV2" },
    });
    const discOpts = {
      nocturneHome: f.nocturneHome,
      codexHome: f.codexHome,
      claudeHome: f.claudeHome,
    };

    const first = await installLocalPlugin(f.plat, { ...discOpts, path: v1Src });
    expect(first.state).toBe("off");
    expect(first.version).toBe("1.0.0");

    await setPluginEnabled(f.plat, { ...discOpts, id: first.id, enabled: true });
    expect((await describePlugins(f.plat, discOpts)).plugins[0]?.state).toBe("on");

    // 重装新版本：旧版本目录 1.0.0 被整体替换，plugins.json 记录保留，状态变为 changed
    const second = await installLocalPlugin(f.plat, { ...discOpts, path: v2Src });
    expect(second.id).toBe("nocturne:demo-tool@local");
    expect(second.version).toBe("2.0.0");
    expect(second.state).toBe("changed");
    expect(
      existsSync(path.join(f.nocturneHome, "plugins", "installed", "local", "demo-tool", "1.0.0")),
    ).toBe(false);
    expect(
      existsSync(path.join(f.nocturneHome, "plugins", "installed", "local", "demo-tool", "2.0.0")),
    ).toBe(true);
  });

  it("中途复制失败不留临时残留，且原有已安装副本保持完好", async () => {
    const f = makeFixtureEnv();
    const v1Src = writeNativePlugin(path.join(f.root, "ok"), {
      dirName: "src",
      manifest: { name: "atomic-demo", version: "1.0.0" },
      files: { "skills/a/SKILL.md": "---\ndescription: a\n---\nA" },
    });
    const v2Src = writeNativePlugin(path.join(f.root, "fail"), {
      dirName: "src",
      manifest: { name: "atomic-demo", version: "2.0.0" },
      files: {
        "skills/a/SKILL.md": "---\ndescription: a2\n---\nA2",
        "boom.txt": "trigger-fail",
      },
    });
    const discOpts = {
      nocturneHome: f.nocturneHome,
      codexHome: f.codexHome,
      claudeHome: f.claudeHome,
    };

    await installLocalPlugin(f.plat, { ...discOpts, path: v1Src });

    const failingPlat = {
      ...f.plat,
      fs: {
        ...f.plat.fs,
        writeFile: async (
          p: string,
          data: string | Uint8Array,
          opts?: { mode?: number },
        ): Promise<void> => {
          if (p.endsWith("boom.txt")) {
            throw new Error("simulated disk full");
          }
          await f.plat.fs.writeFile(p, data, opts);
        },
      },
    };

    await expect(installLocalPlugin(failingPlat, { ...discOpts, path: v2Src })).rejects.toThrow(
      /simulated disk full/,
    );

    const localDir = path.join(f.nocturneHome, "plugins", "installed", "local");
    const entries = await f.plat.fs.readdir(localDir);
    expect(entries.map((e) => e.name)).toEqual(["atomic-demo"]);
    expect(existsSync(path.join(localDir, "atomic-demo", "1.0.0", "skills", "a", "SKILL.md"))).toBe(
      true,
    );
  });

  it("卸载删除目录、plugins.json 记录与 MCP 工具缓存，不动 PLUGIN_DATA；删除失败时状态回滚一致", async () => {
    const f = makeFixtureEnv();
    const src = writeNativePlugin(path.join(f.root, "u-src"), {
      dirName: "src",
      manifest: { name: "removable", version: "1.0.0" },
      files: { "skills/rem/SKILL.md": "---\ndescription: rem\n---\nREM" },
    });
    const discOpts = {
      nocturneHome: f.nocturneHome,
      codexHome: f.codexHome,
      claudeHome: f.claudeHome,
    };

    const installed = await installLocalPlugin(f.plat, { ...discOpts, path: src });
    await setPluginEnabled(f.plat, { ...discOpts, id: installed.id, enabled: true });

    // 准备 PLUGIN_DATA 与 MCP 工具缓存（本插件 + 其他插件）
    const pluginDataDir = path.join(f.nocturneHome, "plugins", "data", "removable-local");
    mkdirSync(pluginDataDir, { recursive: true });
    writeFileSync(path.join(pluginDataDir, "keep.txt"), "keep-me");

    const cacheDir = path.join(f.nocturneHome, "plugins", "cache", "mcp-tools");
    mkdirSync(cacheDir, { recursive: true });
    const ownCache = path.join(cacheDir, "nocturne_removable_local__srv__0123456789abcdef.json");
    const otherCache = path.join(cacheDir, "nocturne_docx_builtin__word__fedcba9876543210.json");
    writeFileSync(
      ownCache,
      JSON.stringify({ schemaVersion: 1, pluginId: installed.id, serverId: "srv", tools: [] }),
    );
    writeFileSync(
      otherCache,
      JSON.stringify({
        schemaVersion: 1,
        pluginId: "nocturne:docx@builtin",
        serverId: "word",
        tools: [],
      }),
    );

    // 1. 模拟插件目录被占用（EBUSY）：报错，且磁盘目录与 plugins.json 记录都保持原样
    const removableDir = path.join(f.nocturneHome, "plugins", "installed", "local", "removable");
    const busyPlat = {
      ...f.plat,
      fs: {
        ...f.plat.fs,
        rename: async (oldPath: string, newPath: string): Promise<void> => {
          if (f.plat.paths.equals(oldPath, removableDir)) {
            const err = new Error("resource busy or locked") as NodeJS.ErrnoException;
            err.code = "EBUSY";
            throw err;
          }
          await f.plat.fs.rename(oldPath, newPath);
        },
      },
    };
    await expect(uninstallPlugin(busyPlat, { ...discOpts, id: installed.id })).rejects.toThrow(
      /占用/,
    );
    expect(
      existsSync(path.join(f.nocturneHome, "plugins", "installed", "local", "removable")),
    ).toBe(true);
    const storedAfterFail = JSON.parse(
      readFileSync(path.join(f.nocturneHome, "plugins.json"), "utf8"),
    ) as { plugins: Record<string, unknown> };
    expect(storedAfterFail.plugins[installed.id]).toBeDefined();

    // 2. 经 Runtime 卸载：广播已打开会话、删除目录/记录/本插件缓存，保留 PLUGIN_DATA 与其他缓存
    const cfg = await loadConfig(f.plat, { nocturneHome: f.nocturneHome });
    const rt = await createRuntime({
      config: cfg,
      cwd: f.ws,
      sessionsDir: f.sessionsDir,
      providers: [new FakeProvider({ scripts: [] })],
      plugins: { codexHome: f.codexHome, claudeHome: f.claudeHome },
    });
    openRuntimes.push(rt);
    const session = await rt.createSession({
      model: { provider: "fake", model: "fake-1" },
      cwd: f.ws,
    });
    openSessions.push(session);

    const res = await rt.uninstallPlugin({ id: installed.id });
    expect(res.affectedSessions).toBe(1);
    expect(
      existsSync(path.join(f.nocturneHome, "plugins", "installed", "local", "removable")),
    ).toBe(false);
    const storedAfterOk = JSON.parse(
      readFileSync(path.join(f.nocturneHome, "plugins.json"), "utf8"),
    ) as { plugins: Record<string, unknown> };
    expect(storedAfterOk.plugins[installed.id]).toBeUndefined();
    expect(existsSync(ownCache)).toBe(false);
    expect(existsSync(otherCache)).toBe(true);
    expect(readFileSync(path.join(pluginDataDir, "keep.txt"), "utf8")).toBe("keep-me");
  });

  it("卸载内置插件或 Codex / Claude Code 插件报错", async () => {
    const f = makeFixtureEnv();
    const discOpts = {
      nocturneHome: f.nocturneHome,
      codexHome: f.codexHome,
      claudeHome: f.claudeHome,
    };

    await expect(
      uninstallPlugin(f.plat, { ...discOpts, id: "nocturne:docx@builtin" }),
    ).rejects.toThrow(/只能卸载本地安装的 Nocturne 插件/);
    await expect(uninstallPlugin(f.plat, { ...discOpts, id: "codex:demo@mkt" })).rejects.toThrow(
      /只能卸载本地安装的 Nocturne 插件/,
    );
    await expect(uninstallPlugin(f.plat, { ...discOpts, id: "claude:demo@mkt" })).rejects.toThrow(
      /只能卸载本地安装的 Nocturne 插件/,
    );
    await expect(
      uninstallPlugin(f.plat, { ...discOpts, id: "nocturne:nonexistent@local" }),
    ).rejects.toThrow(/未找到本地安装的插件/);
  });
});

describe("插件清单 ui.surfaces（ADR-0101 第 4 节）", () => {
  it("解析合法 ui.surfaces 到 PluginOverview，非法条目跳过并记入 warnings，兼容清单不读 ui", async () => {
    const f = makeFixtureEnv();
    const builtinDir = path.join(f.root, "builtin");
    const ownDir = path.join(builtinDir, "ui-kit");
    mkdirSync(path.join(ownDir, ".nocturne-plugin"), { recursive: true });
    writeFileSync(
      path.join(ownDir, ".nocturne-plugin", "plugin.json"),
      JSON.stringify({
        name: "ui-kit",
        version: "1.0.0",
        mcpServers: {
          viewer: { command: "${NOCTURNE_NODE}", args: ["${PLUGIN_ROOT}/srv.mjs"] },
        },
        ui: {
          surfaces: [
            {
              id: "main-panel",
              title: "文档查看",
              server: "viewer",
              resourceUri: "ui://viewer/index.html",
              open: { tool: "open_doc", fileTypes: [".docx", ".md"] },
            },
            {
              id: "upper-ext",
              title: "大写扩展名",
              server: "viewer",
              resourceUri: "ui://viewer/upper.html",
              open: { tool: "open_doc", fileTypes: [".DOCX"] },
            },
            {
              id: "Bad_ID",
              title: "非法 id",
              server: "viewer",
              resourceUri: "ui://viewer/bad.html",
            },
            {
              id: "no-title",
              title: "",
              server: "viewer",
              resourceUri: "ui://viewer/bad.html",
            },
            {
              id: "missing-srv",
              title: "不存在的服务器",
              server: "ghost",
              resourceUri: "ui://ghost/index.html",
            },
            {
              id: "bad-uri",
              title: "非 ui 协议",
              server: "viewer",
              resourceUri: "https://example.com/app.html",
            },
            {
              id: "main-panel",
              title: "重复 id",
              server: "viewer",
              resourceUri: "ui://viewer/dup.html",
            },
          ],
        },
      }),
    );

    // 兼容清单（.codex-plugin / .claude-plugin）即使写了 ui 也必须忽略
    const codexDir = path.join(f.codexHome, "plugins", "cache", "mkt", "cx-ui", "1.0.0");
    mkdirSync(path.join(codexDir, ".codex-plugin"), { recursive: true });
    mkdirSync(path.join(codexDir, "skills", "s1"), { recursive: true });
    writeFileSync(
      path.join(codexDir, "skills", "s1", "SKILL.md"),
      "---\ndescription: s1\n---\nbody",
    );
    writeFileSync(
      path.join(codexDir, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        name: "cx-ui",
        ui: {
          surfaces: [
            {
              id: "ignored",
              title: "不应读取",
              server: "s",
              resourceUri: "ui://s/index.html",
            },
          ],
        },
      }),
    );
    writeFileSync(path.join(f.codexHome, "config.toml"), `[plugins."cx-ui@mkt"]\nenabled = true\n`);

    const claudeDir = path.join(f.claudeHome, "plugins", "cache", "mkt", "cl-ui", "1.0.0");
    mkdirSync(path.join(claudeDir, ".claude-plugin"), { recursive: true });
    mkdirSync(path.join(claudeDir, "skills", "s1"), { recursive: true });
    writeFileSync(
      path.join(claudeDir, "skills", "s1", "SKILL.md"),
      "---\ndescription: s1\n---\nbody",
    );
    writeFileSync(
      path.join(claudeDir, ".claude-plugin", "plugin.json"),
      JSON.stringify({
        name: "cl-ui",
        ui: {
          surfaces: [
            {
              id: "ignored",
              title: "不应读取",
              server: "s",
              resourceUri: "ui://s/index.html",
            },
          ],
        },
      }),
    );
    writeFileSync(
      path.join(f.claudeHome, "settings.json"),
      JSON.stringify({ enabledPlugins: { "cl-ui@mkt": true } }),
    );
    writeFileSync(
      path.join(f.claudeHome, "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: { "cl-ui@mkt": [{ scope: "user", installPath: claudeDir, version: "1.0.0" }] },
      }),
    );

    const desc = await describePlugins(f.plat, {
      nocturneHome: f.nocturneHome,
      codexHome: f.codexHome,
      claudeHome: f.claudeHome,
      builtinPluginsDir: builtinDir,
    });
    const own = must(
      desc.plugins.find((p) => p.id === "nocturne:ui-kit@builtin"),
      "own plugin",
    );
    expect(own.surfaces).toEqual([
      {
        id: "main-panel",
        title: "文档查看",
        server: "viewer",
        resourceUri: "ui://viewer/index.html",
        open: { tool: "open_doc", fileTypes: [".docx", ".md"] },
      },
      {
        id: "upper-ext",
        title: "大写扩展名",
        server: "viewer",
        resourceUri: "ui://viewer/upper.html",
      },
    ]);
    expect(own.warnings.filter((w) => w.includes("ui.surfaces"))).toHaveLength(6);

    const cx = must(
      desc.plugins.find((p) => p.id === "codex:cx-ui@mkt"),
      "codex plugin",
    );
    expect(cx.surfaces).toEqual([]);
    const cl = must(
      desc.plugins.find((p) => p.id === "claude:cl-ui@mkt"),
      "claude plugin",
    );
    expect(cl.surfaces).toEqual([]);
  });

  it("open.tool 指向非只读或非 app 可见工具时，不参与文件打开并记入 warnings", () => {
    const warnings: string[] = [];
    const surfaces = [
      {
        id: "ok",
        title: "只读打开",
        server: "demo",
        resourceUri: "ui://demo/ok.html",
        open: { tool: "open_ro", fileTypes: [".nctdemo"] },
      },
      {
        id: "write-open",
        title: "写入打开",
        server: "demo",
        resourceUri: "ui://demo/w.html",
        open: { tool: "open_rw", fileTypes: [".nctdemo"] },
      },
      {
        id: "model-only-open",
        title: "仅模型可见",
        server: "demo",
        resourceUri: "ui://demo/m.html",
        open: { tool: "open_model_only", fileTypes: [".nctdemo"] },
      },
    ];
    const toolsByServer = new Map([
      [
        "demo",
        [
          { name: "open_ro", readOnly: true, visibility: ["app" as const] },
          { name: "open_rw", readOnly: false, visibility: ["app" as const] },
          { name: "open_model_only", readOnly: true, visibility: ["model" as const] },
        ],
      ],
    ]);
    const filtered = applyToolMetaToPluginSurfaces(
      "demo@builtin",
      surfaces,
      toolsByServer,
      warnings,
    );
    expect(filtered[0]?.open).toEqual({ tool: "open_ro", fileTypes: [".nctdemo"] });
    expect(filtered[1]?.open).toBeUndefined();
    expect(filtered[2]?.open).toBeUndefined();
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("open_rw");
    expect(warnings[1]).toContain("open_model_only");
  });

  it("Core 插件发现加载四个内置文档插件（docx/xlsx/pptx/pdf）时 warnings 为空且 surface 完整", async () => {
    const f = makeFixtureEnv();
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    const builtPluginsDir = path.join(repoRoot, "plugins");
    const expected = [
      {
        name: "docx",
        server: "word",
        title: "Word 文档",
        fileTypes: [".docx", ".doc", ".odt", ".rtf"],
      },
      { name: "xlsx", server: "sheets", title: "电子表格", fileTypes: [".xlsx", ".xls", ".ods"] },
      { name: "pptx", server: "slides", title: "演示文档", fileTypes: [".pptx", ".ppt", ".odp"] },
      { name: "pdf", server: "pdf", title: "PDF", fileTypes: [".pdf"] },
    ];

    // 已构建的 plugins/ 存在时直接加载真产物，否则用 manifests 装配同结构目录
    let targetDir = builtPluginsDir;
    const allBuilt = expected.every((e) =>
      existsSync(path.join(builtPluginsDir, e.name, ".nocturne-plugin", "plugin.json")),
    );
    if (!allBuilt) {
      targetDir = path.join(f.root, "doc-builtin");
      mkdirSync(targetDir, { recursive: true });
      for (const e of expected) {
        cpSync(
          path.join(repoRoot, "plugins-src", "manifests", e.name),
          path.join(targetDir, e.name),
          {
            recursive: true,
          },
        );
      }
    }

    const desc = await describePlugins(f.plat, {
      nocturneHome: f.nocturneHome,
      codexHome: f.codexHome,
      claudeHome: f.claudeHome,
      builtinPluginsDir: targetDir,
    });
    expect(desc.warnings).toEqual([]);

    for (const e of expected) {
      const plugin = must(
        desc.plugins.find((p) => p.id === `nocturne:${e.name}@builtin`),
        `builtin plugin ${e.name}`,
      );
      expect(plugin.warnings).toEqual([]);
      expect(plugin.surfaces).toEqual([
        {
          id: "viewer",
          title: e.title,
          server: e.server,
          resourceUri: `ui://${e.server}/viewer.html`,
          open: {
            tool: "show_in_viewer",
            fileTypes: e.fileTypes,
          },
        },
      ]);
    }
  });

  it("内置插件存在 .nocturne-plugin/build-id 时缓存键带 +buildId 后缀，缺失或为空时退回纯版本号", async () => {
    const f = makeFixtureEnv();
    const builtinDir = path.join(f.root, "builtin-cache-key");
    writeNativePlugin(builtinDir, {
      dirName: "with-build-id",
      manifest: {
        name: "with-build-id",
        version: "0.56.0",
        mcpServers: {
          srv: { command: "node", args: ["server.mjs"] },
        },
      },
      files: {
        ".nocturne-plugin/build-id": "a1b2c3d4e5f60708",
        "server.mjs": "export {};",
      },
    });
    writeNativePlugin(builtinDir, {
      dirName: "without-build-id",
      manifest: {
        name: "without-build-id",
        version: "0.56.0",
        mcpServers: {
          srv2: { command: "node", args: ["server.mjs"] },
        },
      },
      files: {
        "server.mjs": "export {};",
      },
    });
    writeNativePlugin(builtinDir, {
      dirName: "blank-build-id",
      manifest: {
        name: "blank-build-id",
        version: "0.56.0",
        mcpServers: {
          srv3: { command: "node", args: ["server.mjs"] },
        },
      },
      files: {
        ".nocturne-plugin/build-id": "   \n",
        "server.mjs": "export {};",
      },
    });

    const resolved = await resolvePlugins(f.plat, {
      nocturneHome: f.nocturneHome,
      codexHome: f.codexHome,
      claudeHome: f.claudeHome,
      builtinPluginsDir: builtinDir,
    });
    const withId = must(
      resolved.mcpServers.find((s) => s.id === "srv"),
      "srv",
    );
    const withoutId = must(
      resolved.mcpServers.find((s) => s.id === "srv2"),
      "srv2",
    );
    const blankId = must(
      resolved.mcpServers.find((s) => s.id === "srv3"),
      "srv3",
    );
    expect(withId.cache).toEqual({
      pluginId: "nocturne:with-build-id@builtin",
      keyKind: "version",
      keyValue: "0.56.0+a1b2c3d4e5f60708",
    });
    expect(withoutId.cache).toEqual({
      pluginId: "nocturne:without-build-id@builtin",
      keyKind: "version",
      keyValue: "0.56.0",
    });
    expect(blankId.cache).toEqual({
      pluginId: "nocturne:blank-build-id@builtin",
      keyKind: "version",
      keyValue: "0.56.0",
    });
  });
});
