/**
 * 配置加载入口（config.md 第 6 节）。
 * base = 向导配置（providers.json）+ 用户配置 + 环境变量 + 命令行参数
 * （不含项目层）；forWorkspace(root) 按会话记录的工作区加载项目层与 Grant。
 * v0.2 增补：凭据存储、providers.json 向导写入接口、recent-models.json。
 */
import type { ModelRef } from "../protocol/index.js";
import type { Platform } from "../platform/index.js";
import { envLayerConfig, cliLayerConfig } from "./env.js";
import { ConfigError } from "./errors.js";
import { loadConfigFile, writeJsonAtomic } from "./files.js";
import { createCredentialStore } from "./credentials.js";
import { loadGrantStore } from "./grants.js";
import { mergeLayers, type MergeLayer } from "./merge.js";
import {
  describeProviderLayers,
  loadProviderSetup,
  readRecentModels,
  recordRecentModel,
  refreshUpstreamLimits,
  removeSetupProvider,
  saveSetupProvider,
  saveSetupThinking,
  setSetupDefaultModel,
} from "./setup.js";
import { readTrustList } from "./trust.js";
import type {
  ConfigFile,
  LoadConfigOptions,
  ProviderOverview,
  ProviderSetupFile,
  RuntimeConfig,
  WorkspaceConfig,
} from "./types.js";

const PROJECT_CONFIG_DIR = ".nocturne";
const PROJECT_CONFIG_NAME = "config.json";

export async function loadConfig(
  platform: Platform,
  options: LoadConfigOptions = {},
): Promise<RuntimeConfig> {
  const { fs, paths } = platform;
  const home = paths.resolve(options.nocturneHome ?? platform.nocturneHome(), ".");
  // POSIX 上以 0700 创建（会话日志含代码与对话内容，repository-layout.md 第 5 节）；
  // Windows 维持用户目录默认权限（mode 被忽略）
  await fs.mkdir(home, { mode: 0o700 });
  const sessionsDir = paths.join(home, "sessions");
  const trustPath = paths.join(home, "trust.json");
  const grantsDir = paths.join(home, "grants");

  const env = options.env ?? ((n: string) => platform.env(n));

  // 凭据存储（provider-setup.md 第 3 节）：按平台探测系统后端
  const credentialsInit =
    options.credentials !== undefined
      ? { store: options.credentials, warning: undefined }
      : await createCredentialStore(platform, home);
  const credentials = credentialsInit.store;

  // 向导配置层（providers.json）：损坏/版本不符 → 忽略 + provider_setup_invalid
  const setup = await loadProviderSetup(platform, home);
  const setupFile: ProviderSetupFile = setup.file ?? { version: 1 };

  // 用户配置：损坏即快速失败（config.md 第 2 节）
  const userFile: ConfigFile = (await loadConfigFile(fs, paths.join(home, "config.json"))) ?? {};

  const envLayer = envLayerConfig(env);
  const cliLayer = cliLayerConfig(options.cliArgs);

  const baseLayers: MergeLayer[] = [
    { origin: "setup", file: setupFile },
    { origin: "user", file: userFile },
  ];
  const base = mergeLayers([
    ...baseLayers,
    { origin: "cli", file: envLayer.file },
    { origin: "cli", file: cliLayer.file },
  ]);
  base.warnings.push(...envLayer.warnings, ...cliLayer.warnings);
  if (credentialsInit.warning !== undefined) base.warnings.push(credentialsInit.warning);

  const trust = await readTrustList(platform, trustPath);
  if (trust.warning !== undefined) base.warnings.push(trust.warning);
  // trust.workspaces 对外是只读视图；内部持可变副本供 setWorkspaceTrusted 更新
  const trustedSet = new Set(trust.workspaces);

  /** 可信工作区的项目层文件（describeProviders 复用；不含 Grant 加载） */
  async function projectFileIfTrusted(workspaceRoot: string) {
    const realRoot = await platform.resolveReal(workspaceRoot);
    const canonical = paths.canonicalize(realRoot);
    if (!trustedSet.has(canonical)) return undefined;
    const projectPath = paths.join(realRoot, PROJECT_CONFIG_DIR, PROJECT_CONFIG_NAME);
    try {
      return await loadConfigFile(fs, projectPath);
    } catch {
      return undefined;
    }
  }

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
      { origin: "setup", file: setupFile },
      { origin: "user", file: userFile },
      ...(trusted && projectFile !== undefined
        ? [{ origin: "project" as const, file: projectFile }]
        : []),
      { origin: "cli", file: envLayer.file },
      { origin: "cli", file: cliLayer.file },
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

  // 最近模型列表：load 时预读，recentModels() 同步返回；recordRecentModel
  // 更新缓存并原子写（setModel/新建会话时调用）
  let recent = await readRecentModels(platform, home);

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

    providerSetupWarning: setup.warning,
    credentials,
    saveSetupProvider: (entry, opts) => saveSetupProvider(platform, home, credentials, entry, opts),
    setCredential: (providerId, key) => credentials.set(providerId, key),
    saveSetupThinking: (providerId, levels) =>
      saveSetupThinking(platform, home, providerId, levels),
    removeSetupProvider: (providerId) =>
      removeSetupProvider(platform, home, credentials, providerId),
    async describeProviders(workspaceRoot?: string): Promise<ProviderOverview[]> {
      // 向导层每次现读：本会话内 /provider add|remove 写入 providers.json 后
      // 立即可见（user/env/cli 层沿用加载时快照，与运行时配置一致）
      const setupNow = await loadProviderSetup(platform, home);
      const project =
        workspaceRoot !== undefined ? await projectFileIfTrusted(workspaceRoot) : undefined;
      return describeProviderLayers(
        {
          setup: setupNow.file?.providers,
          user: userFile.providers,
          project: project?.providers,
          env: envLayer.file.providers,
          cli: cliLayer.file.providers,
        },
        credentials,
        env,
      );
    },
    refreshUpstreamLimits: (providerId: string) =>
      refreshUpstreamLimits(platform, home, credentials, env, options.upstreamFetch, providerId),
    setDefaultModel: (model: string) => setSetupDefaultModel(platform, home, model),
    recentModels: () => [...recent],
    recordRecentModel: async (ref: ModelRef) => {
      await recordRecentModel(platform, home, ref);
      recent = await readRecentModels(platform, home);
    },
  };
}
