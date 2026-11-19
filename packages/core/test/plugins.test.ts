/**
 * 插件发现、翻译、执行、环境隔离、整目录指纹信任与技能集成测试（ADR-0096 第二期）。
 * 所有测试均使用临时目录夹具，不读写本机真实 `~/.codex` / `~/.claude`。
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
  computePluginFingerprint,
  describePlugins,
  discoverInstalledPlugins,
  selectActivePluginVersion,
  setPluginEnabled,
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
      manifest: { interface: { displayName: "From Codex" } },
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
      manifest: { displayName: "Claude Fallback" },
    });
    // Claude 来源只看 .claude-plugin，不看 .codex-plugin
    writeClaudePlugin(f.claudeHome, {
      name: "claudeonly",
      marketplace: "mkt",
      manifest: { displayName: "Claude Native" },
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
      manifest: { name: "symlinked" },
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
const TINY_PNG_2 = Buffer.concat([TINY_PNG, Buffer.from([0x00, 0x01])]);
const TINY_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/></svg>`;
const TINY_JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const TINY_WEBP = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
]);

describe("插件图标读取与指纹排除", () => {
  it("优先取 interface.composerIcon，没有时退到 interface.logo，支持 png/jpg/webp/svg", async () => {
    const f = makeFixtureEnv();
    writeCodexPlugin(f.codexHome, {
      name: "both",
      marketplace: "mkt",
      version: "1.0.0",
      manifest: {
        name: "both",
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

  it("图标文件变化与清单图标字段变化不改变插件指纹，且不能借图标字段绕过脚本指纹校验", async () => {
    const f = makeFixtureEnv();
    const pluginDir = writeCodexPlugin(f.codexHome, {
      name: "stable",
      marketplace: "mkt",
      version: "1.0.0",
      manifest: {
        name: "stable",
        interface: {
          displayName: "Stable Plugin",
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

    await setPluginEnabled(f.plat, {
      nocturneHome: f.nocturneHome,
      codexHome: f.codexHome,
      claudeHome: f.claudeHome,
      id: "codex:stable@mkt",
      enabled: true,
    });

    const hashBefore = await computePluginFingerprint(
      f.plat.fs,
      f.plat.paths,
      pluginDir,
      pluginDir,
    );

    // 1. 修改图标文件内容：指纹不变，状态仍为 on
    writeFileSync(path.join(pluginDir, "assets", "icon.png"), TINY_PNG_2);
    const hashAfterIconEdit = await computePluginFingerprint(
      f.plat.fs,
      f.plat.paths,
      pluginDir,
      pluginDir,
    );
    expect(hashAfterIconEdit).toBe(hashBefore);
    const afterEdit = await describePlugins(f.plat, {
      nocturneHome: f.nocturneHome,
      codexHome: f.codexHome,
      claudeHome: f.claudeHome,
    });
    expect(afterEdit.plugins[0]?.state).toBe("on");
    expect(afterEdit.plugins[0]?.icon).toBe(
      `data:image/png;base64,${TINY_PNG_2.toString("base64")}`,
    );

    // 2. 替换清单中的图标字段与文件（icon.png -> logo.svg）：指纹不变，状态仍为 on
    writeFileSync(
      path.join(pluginDir, ".codex-plugin", "plugin.json"),
      JSON.stringify(
        {
          name: "stable",
          interface: {
            displayName: "Stable Plugin",
            logo: "./assets/logo.svg",
          },
          hooks: {
            SessionStart: [{ hooks: [{ type: "command", command: "node ./run.mjs" }] }],
          },
        },
        null,
        2,
      ),
    );
    writeFileSync(path.join(pluginDir, "assets", "logo.svg"), TINY_SVG);
    // 删除旧 icon.png（仅保留新 logo.svg）
    unlinkSync(path.join(pluginDir, "assets", "icon.png"));
    const afterSwitch = await describePlugins(f.plat, {
      nocturneHome: f.nocturneHome,
      codexHome: f.codexHome,
      claudeHome: f.claudeHome,
    });
    expect(afterSwitch.plugins[0]?.state).toBe("on");
    expect(afterSwitch.plugins[0]?.icon).toBe(
      `data:image/svg+xml;base64,${Buffer.from(TINY_SVG, "utf8").toString("base64")}`,
    );

    // 3. 安全边界：尝试将 composerIcon 指向脚本 ./run.mjs 并修改脚本，必须触发 changed
    writeFileSync(
      path.join(pluginDir, ".codex-plugin", "plugin.json"),
      JSON.stringify(
        {
          name: "stable",
          interface: {
            displayName: "Stable Plugin",
            composerIcon: "./run.mjs",
          },
          hooks: {
            SessionStart: [{ hooks: [{ type: "command", command: "node ./run.mjs" }] }],
          },
        },
        null,
        2,
      ),
    );
    unlinkSync(path.join(pluginDir, "assets", "logo.svg"));
    writeFileSync(path.join(pluginDir, "run.mjs"), "console.log('tampered');");
    const afterTamper = await describePlugins(f.plat, {
      nocturneHome: f.nocturneHome,
      codexHome: f.codexHome,
      claudeHome: f.claudeHome,
    });
    expect(afterTamper.plugins[0]?.state).toBe("changed");
    expect(afterTamper.plugins[0]?.icon).toBeUndefined();
  });
});
