/**
 * 配置加载入口（config.md 第 6 节）。
 * base = 用户配置 + 环境变量 + 命令行参数（不含项目层）；
 * forWorkspace(root) 按会话记录的工作区加载项目层与 Grant 存储。
 */
import type { Platform } from "../platform/index.js";
import { envLayerConfig, cliLayerConfig } from "./env.js";
import { ConfigError } from "./errors.js";
import { loadConfigFile, writeJsonAtomic } from "./files.js";
import { loadGrantStore } from "./grants.js";
import { mergeLayers, type MergeLayer } from "./merge.js";
import { readTrustList } from "./trust.js";
import type { LoadConfigOptions, RuntimeConfig, WorkspaceConfig } from "./types.js";

const PROJECT_CONFIG_DIR = ".nocturne";
const PROJECT_CONFIG_NAME = "config.json";

export async function loadConfig(
  platform: Platform,
  options: LoadConfigOptions = {},
): Promise<RuntimeConfig> {
  const { fs, paths } = platform;
  const home = paths.resolve(options.nocturneHome ?? platform.nocturneHome(), ".");
  const sessionsDir = paths.join(home, "sessions");
  const trustPath = paths.join(home, "trust.json");
  const grantsDir = paths.join(home, "grants");

  // 用户配置：损坏即快速失败（config.md 第 2 节）
  const userFile = (await loadConfigFile(fs, paths.join(home, "config.json"))) ?? {};

  const env = envLayerConfig(options.env ?? ((n) => platform.env(n)));
  const cli = cliLayerConfig(options.cliArgs);

  const baseLayers: MergeLayer[] = [
    { origin: "user", file: userFile },
    // 环境变量层不能携带权限规则；origin 仅用于标注（该层不产生 rules）
  ];
  const base = mergeLayers([
    ...baseLayers,
    { origin: "cli", file: env.file },
    { origin: "cli", file: cli.file },
  ]);
  base.warnings.push(...env.warnings, ...cli.warnings);

  const trust = await readTrustList(platform, trustPath);
  if (trust.warning !== undefined) base.warnings.push(trust.warning);
  // trust.workspaces 对外是只读视图；内部持可变副本供 setWorkspaceTrusted 更新
  const trustedSet = new Set(trust.workspaces);

  async function forWorkspace(workspaceRoot: string): Promise<WorkspaceConfig> {
    const realRoot = await platform.resolveReal(workspaceRoot);
    const canonical = paths.canonicalize(realRoot);
    const trusted = trustedSet.has(canonical);
    const projectPath = paths.join(realRoot, PROJECT_CONFIG_DIR, PROJECT_CONFIG_NAME);

    const warnings: string[] = [];
    let projectFile;
    let projectPresent = false;
    try {
      projectFile = await loadConfigFile(fs, projectPath);
      projectPresent = projectFile !== undefined;
    } catch (e) {
      // 项目配置损坏：整份忽略 + 警告，不阻塞会话（config.md 第 2 节）
      if (e instanceof ConfigError) {
        warnings.push(`项目配置 ${projectPath} 无效（${e.message}），已整份忽略`);
        projectPresent = true;
      } else {
        throw e;
      }
    }

    const layers: MergeLayer[] = [
      { origin: "user", file: userFile },
      ...(trusted && projectFile !== undefined
        ? [{ origin: "project" as const, file: projectFile }]
        : []),
      { origin: "cli", file: env.file },
      { origin: "cli", file: cli.file },
    ];
    const resolved = mergeLayers(layers);
    // mcpServers 标注来源目录：相对 cwd 按该层配置文件所在目录解析（config.md 第 2 节）
    resolved.mcpServers = resolved.mcpServers.map((s) => ({
      ...s,
      dir: s.origin === "project" ? paths.dirname(projectPath) : home,
    }));
    resolved.warnings.push(...base.warnings, ...warnings);

    if (!trusted && projectFile !== undefined) {
      // 未信任项目配置：其余字段全部忽略；rules 中只保留收紧方向（permissions.md 5.2）
      for (const rule of projectFile.permissions?.rules ?? []) {
        if (rule.action === "allow") continue;
        resolved.untrustedRules.push({ rule, origin: "project-untrusted" });
      }
      // mcp / hooks 段整段忽略（ADR-0012：Hook 一旦运行就是任意代码，"运行但只收紧"
      // 约束不了副作用）；明确警告让用户知道配置没生效
      const hasMcp = Object.keys(projectFile.mcp?.servers ?? {}).length > 0;
      const hasHooks = Object.keys(projectFile.hooks ?? {}).length > 0;
      if (hasMcp || hasHooks) {
        const parts = [hasMcp ? "mcp" : "", hasHooks ? "hooks" : ""].filter(Boolean).join("、");
        resolved.warnings.push(`项目配置未信任：其中的 ${parts} 配置已忽略（nctrn trust 后生效）`);
      }
    }

    const loaded = await loadGrantStore(platform, grantsDir, realRoot);
    if (loaded.warning !== undefined) resolved.warnings.push(loaded.warning);

    return {
      resolved,
      projectConfig: {
        present: projectPresent,
        trusted,
        path: projectPresent ? projectPath : undefined,
      },
      grants: loaded.store,
    };
  }

  async function setWorkspaceTrusted(workspaceRoot: string, trusted: boolean): Promise<void> {
    const realRoot = await platform.resolveReal(workspaceRoot);
    const canonical = paths.canonicalize(realRoot);
    const next = new Set(trustedSet);
    if (trusted) next.add(canonical);
    else next.delete(canonical);
    await writeJsonAtomic(platform.fs, paths, trustPath, {
      version: 1,
      workspaces: [...next].sort(),
    });
    trustedSet.clear();
    for (const w of next) trustedSet.add(w);
  }

  return {
    nocturneHome: home,
    sessionsDir,
    attachmentsDir: paths.join(sessionsDir, "attachments"),
    grantsDir,
    base,
    forWorkspace,
    setWorkspaceTrusted,
  };
}
