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
import {
  devProviderEndpoints,
  matchModelsDev,
  modelOverrideFromDev,
  readModelsDev,
  refreshModelsDev,
  type ModelsDevData,
} from "./models-dev.js";
import { modelsDevSnapshot } from "./models-dev-snapshot.js";
import { createCredentialStore } from "./credentials.js";
import { describeMcp, loadMcpStore, McpSettingsError } from "./mcp.js";
import { describeExternalAgents, loadExternalAgentStore } from "./external-agents.js";
import { loadGrantStore } from "./grants.js";
import {
  mergeLayers,
  restrictProjectProviderAuth,
  type MergeLayer,
  type MergeResult,
} from "./merge.js";
import {
  applyModelPatch,
  buildModelSettingsViews,
  configFieldError,
  effectiveValueError,
  patchValueError,
  providerOriginHint,
} from "./model-settings.js";
import {
  describeProviderLayers,
  findProviderConflict as findLayerConflict,
  loadProviderSetup,
  readRecentModels,
  recordRecentModel,
  refreshUpstreamLimits,
  removeSetupProvider,
  saveSetupProvider,
  saveSetupUserModels,
  writeProviderSetup,
  type DescribeLayers,
  type ProviderSetupState,
} from "./setup.js";
import { loadSettingsStore } from "./settings.js";
import { reviewerText } from "./reviewer.js";
import { readTrustList } from "./trust.js";
import type {
  ConfigFile,
  LoadConfigOptions,
  ModelSettingsPatch,
  ProviderEntryConfig,
  ProviderOverview,
  ProviderSetupFile,
  RuntimeConfig,
  SettingItem,
  WorkspaceConfig,
} from "./types.js";

const PROJECT_CONFIG_DIR = ".nocturne";
const PROJECT_CONFIG_NAME = "config.json";

/**
 * 向导层 + 用户编辑合成层（ADR-0024 第 2 节）：providers.json 条目里的
 * userModels 包成同形状的 providers 列表，插在 setup 与 user 之间参与
 * 逐字段合并；mergeLayers 在合并后丢弃仅由该层引入的清单外模型。
 */
function setupLayers(setupFile: ProviderSetupFile, providersPath: string): MergeLayer[] {
  const layers: MergeLayer[] = [{ kind: "setup", path: providersPath, file: setupFile }];
  const userModels: ProviderEntryConfig[] = [];
  for (const entry of setupFile.providers ?? []) {
    if (entry.userModels === undefined) continue;
    userModels.push({ id: entry.id, models: entry.userModels });
  }
  if (userModels.length > 0) {
    layers.push({ kind: "userModels", path: providersPath, file: { providers: userModels } });
  }
  return layers;
}

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
  const providersPath = paths.join(home, "providers.json");
  const userConfigPath = paths.join(home, "config.json");

  const env = options.env ?? ((n: string) => platform.env(n));

  // 凭据存储（provider-setup.md 第 3 节）：按平台探测系统后端
  const credentialsInit =
    options.credentials !== undefined
      ? { store: options.credentials, warning: undefined }
      : await createCredentialStore(platform, home);
  const credentials = credentialsInit.store;
  const mcpStore = await loadMcpStore(platform, home, credentials);
  const mcpLayer = (): MergeLayer => ({
    kind: "app",
    path: paths.join(home, "mcp.json"),
    file: mcpStore.fields(),
  });
  const externalAgentStore = await loadExternalAgentStore(platform, home);
  const externalAgentLayer = (): MergeLayer => ({
    kind: "app",
    path: paths.join(home, "external-agents.json"),
    file: externalAgentStore.fields(),
  });

  // 向导配置层（providers.json）：损坏/版本不符 → 忽略 + provider_setup_invalid
  const setup = await loadProviderSetup(platform, home);
  const setupFile: ProviderSetupFile = setup.file ?? { version: 1 };

  // 用户配置：损坏即快速失败（config.md 第 2 节）
  const userFile: ConfigFile = (await loadConfigFile(fs, userConfigPath)) ?? {};
  let modelsDev: ModelsDevData =
    userFile.modelsDev === false ? modelsDevSnapshot : await readModelsDev(platform, home);

  function mergeWithModelsDev(layers: MergeLayer[]): MergeResult {
    const entries = new Map<string, Set<string>>();
    // 条目的 modelsDevProvider 声明（ADR-0031 §4）：高层覆盖低层
    const devProviderKey = new Map<string, string>();
    const devPricingKey = new Map<string, string>();
    for (const layer of layers) {
      if (layer.kind === "userModels") continue;
      for (const provider of layer.file.providers ?? []) {
        const ids = entries.get(provider.id) ?? new Set<string>();
        for (const id of Object.keys(provider.models ?? {})) ids.add(id);
        entries.set(provider.id, ids);
        if (provider.modelsDevProvider !== undefined) {
          devProviderKey.set(provider.id, provider.modelsDevProvider);
        }
        if (provider.modelsDevPricing !== undefined) {
          devPricingKey.set(provider.id, provider.modelsDevPricing);
        }
      }
    }
    const providers: ProviderEntryConfig[] = [];
    for (const [id, ids] of entries) {
      const models: NonNullable<ProviderEntryConfig["models"]> = {};
      const providerKey = devProviderKey.get(id);
      const priceModels = modelsDev.providers?.[devPricingKey.get(id) ?? providerKey ?? ""]?.models;
      for (const modelId of ids) {
        const record = matchModelsDev(modelsDev.models, modelId);
        // models.dev 服务商层的 endpoints 声明（ADR-0031 §4）：与
        // 其他字段同一层参与逐字段合并，优先级低于上游/手写
        const endpoints =
          providerKey !== undefined
            ? devProviderEndpoints(modelsDev, providerKey, modelId)
            : undefined;
        const override = {
          ...(record !== undefined ? modelOverrideFromDev(record) : {}),
          ...(endpoints !== undefined ? { endpoints } : {}),
          ...(priceModels !== undefined && matchModelsDev(priceModels, modelId)?.cost !== undefined
            ? { pricing: matchModelsDev(priceModels, modelId)?.cost }
            : {}),
        };
        if (record !== undefined || endpoints !== undefined || override.pricing !== undefined)
          models[modelId] = override;
      }
      if (Object.keys(models).length > 0) providers.push({ id, models });
    }
    return mergeLayers([{ kind: "modelsDev", file: { providers } }, ...layers]);
  }

  const envLayer = envLayerConfig(env);
  const cliLayer = cliLayerConfig(options.cliArgs);

  // settings.json（ADR-0034）：白名单设置参与合并，界面偏好仅保留；
  // 损坏降级为忽略 + 警告。store 持内存态，setShell 写盘后 live getter 立即可见
  const settingsPath = paths.join(home, "settings.json");
  const settings = await loadSettingsStore(platform, settingsPath);
  const workspaceLayers = new Map<string, MergeLayer[]>();
  const settingsLayer = (): MergeLayer => ({
    kind: "settings",
    path: settingsPath,
    file: settings.store.fields(),
  });

  const trust = await readTrustList(platform, trustPath);
  // trust.workspaces 对外是只读视图；内部持可变副本供 setWorkspaceTrusted 更新
  const trustedSet = new Set(trust.workspaces);

  /**
   * 某份向导文件参与的合并（ADR-0024）：base 与 forWorkspace 之外的第三处
   * 层构造点——listModelSettings/saveModelSettings 需要与 mergeLayers 同一份
   * 层列表（可信项目层才并入），并取回逐字段来源表。
   */
  async function mergeFor(sFile: ProviderSetupFile, workspaceRoot?: string): Promise<MergeResult> {
    const layers: MergeLayer[] = [
      ...setupLayers(sFile, providersPath),
      mcpLayer(),
      externalAgentLayer(),
      settingsLayer(),
      { kind: "user", path: userConfigPath, file: userFile },
    ];
    if (workspaceRoot !== undefined) {
      const project = await projectFileIfTrusted(workspaceRoot);
      if (project !== undefined) {
        layers.push({
          kind: "project",
          path: paths.join(
            await platform.resolveReal(workspaceRoot),
            PROJECT_CONFIG_DIR,
            PROJECT_CONFIG_NAME,
          ),
          file: project,
        });
      }
    }
    layers.push({ kind: "env", file: envLayer.file }, { kind: "cli", file: cliLayer.file });
    return mergeWithModelsDev(layers);
  }

  // 合并产物之外的加载期警告：base 与工作区 resolved 各加一次（合并自身
  // 的警告已在 mergeLayers 内计算，不再重复）
  const loadWarnings: string[] = [...envLayer.warnings, ...cliLayer.warnings];
  loadWarnings.push(...mcpStore.warnings);
  loadWarnings.push(...externalAgentStore.warnings);
  if (credentialsInit.warning !== undefined) loadWarnings.push(credentialsInit.warning);
  if (settings.warning !== undefined) loadWarnings.push(settings.warning);
  if (trust.warning !== undefined) loadWarnings.push(trust.warning);

  const baseLayers = (): MergeLayer[] => [
    ...setupLayers(setupFile, providersPath),
    mcpLayer(),
    externalAgentLayer(),
    settingsLayer(),
    { kind: "user", path: userConfigPath, file: userFile },
    { kind: "env", file: envLayer.file },
    { kind: "cli", file: cliLayer.file },
  ];
  const base = (): MergeResult => {
    const merged = mergeWithModelsDev(baseLayers());
    merged.resolved.warnings.push(...loadWarnings);
    return merged;
  };

  function mergedSettings(workspaceRoot?: string, shellEnv?: string): MergeResult {
    const layers = workspaceRoot !== undefined ? workspaceLayers.get(workspaceRoot) : undefined;
    const current = (layers ?? baseLayers()).map((layer) =>
      layer.kind === "settings" ? settingsLayer() : layer,
    );
    if (shellEnv !== undefined)
      current.splice(
        current.findIndex((layer) => layer.kind === "cli"),
        0,
        {
          kind: "env",
          file: envLayerConfig((name) => (name === "NOCTURNE_SHELL" ? shellEnv : undefined)).file,
        },
      );
    return mergeWithModelsDev(current);
  }
  function describeSettings(workspaceRoot?: string, shellEnv?: string): SettingItem[] {
    const merged = mergedSettings(workspaceRoot, shellEnv);
    const saved = settings.store.fields();
    return (
      [
        [
          "compaction.threshold",
          "compaction.threshold",
          String(merged.resolved.compactionThreshold ?? "90%"),
          saved.compaction?.threshold === undefined
            ? undefined
            : String(saved.compaction.threshold),
        ],
        [
          "permissions.preset",
          "permissions.preset",
          merged.resolved.permissionPreset ?? "default",
          saved.permissions?.preset,
        ],
        ["defaultModel", "model", merged.resolved.model, saved.model],
        [
          "modelRoles.task",
          "modelRoles.task",
          merged.resolved.modelRoles?.task,
          saved.modelRoles?.task,
        ],
        [
          "modelRoles.vision",
          "modelRoles.vision",
          merged.resolved.modelRoles?.vision,
          saved.modelRoles?.vision,
        ],
        [
          "modelRoles.smol",
          "modelRoles.smol",
          merged.resolved.modelRoles?.smol,
          saved.modelRoles?.smol,
        ],
        [
          "permission.reviewer",
          "permission.reviewer",
          reviewerText(merged.resolved.permissionReviewer),
          saved.permission?.reviewer ? reviewerText(saved.permission.reviewer) : undefined,
        ],
        [
          "reasoningEffort",
          "reasoningEffort",
          merged.resolved.reasoningEffort ?? "off",
          saved.reasoningEffort,
        ],
        [
          "shell",
          "shell",
          merged.resolved.shellPath ?? merged.resolved.shell ?? "auto",
          saved.shellPath ?? saved.shell,
        ],
      ] as const
    ).map(([key, field, effective, value]) => {
      const origin =
        key === "shell" && merged.resolved.shellPath !== undefined
          ? merged.origins.shellPath
          : merged.origins[field];
      const source =
        origin === "modelsDev" ||
        origin === "app" ||
        origin === "userModels" ||
        origin === undefined
          ? "default"
          : origin;
      return {
        key,
        ...(key === "permission.reviewer"
          ? {
              reviewer: {
                effective: merged.resolved.permissionReviewer,
                saved: saved.permission?.reviewer,
              },
            }
          : {}),
        effective,
        saved: value,
        source,
        overridden: value !== undefined && ["user", "project", "env", "cli"].includes(source),
        ...(key === "defaultModel" || key === "reasoningEffort" ? { readonly: true as const } : {}),
      };
    });
  }

  /** 可信工作区的项目层文件（describeProviders 复用；不含 Grant 加载） */
  async function projectFileIfTrusted(workspaceRoot: string) {
    const realRoot = await platform.resolveReal(workspaceRoot);
    const canonical = paths.canonicalize(realRoot);
    if (!trustedSet.has(canonical)) return undefined;
    const projectPath = paths.join(realRoot, PROJECT_CONFIG_DIR, PROJECT_CONFIG_NAME);
    try {
      return await loadConfigFile(fs, projectPath, "project");
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
      projectFile = await loadConfigFile(fs, projectPath, "project");
      if (!trusted) warnings.push(...(projectFile?.externalAgentWarnings ?? []));
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
      ...setupLayers(setupFile, providersPath),
      mcpLayer(),
      externalAgentLayer(),
      settingsLayer(),
      { kind: "user", path: userConfigPath, file: userFile },
      ...(trusted && projectFile !== undefined
        ? [{ kind: "project" as const, path: projectPath, file: projectFile }]
        : []),
      { kind: "env", file: envLayer.file },
      { kind: "cli", file: cliLayer.file },
    ];
    workspaceLayers.set(workspaceRoot, layers);
    const resolved = mergeWithModelsDev(layers).resolved;
    // mcpServers 标注来源目录：相对 cwd 按该层配置文件所在目录解析（config.md 第 2 节）
    resolved.mcpServers = resolved.mcpServers.map((s) => ({
      ...s,
      dir: s.origin === "project" ? paths.dirname(projectPath) : home,
    }));
    resolved.warnings.push(...loadWarnings, ...warnings);

    if (!trusted && projectFile !== undefined) {
      restrictProjectProviderAuth(projectFile.providers ?? [], resolved.providers, (message) => {
        resolved.providerAuthWarnings ??= [];
        resolved.providerAuthWarnings.push(message);
      });
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

  // /provider 概览与名称冲突检查共用的分层条目。向导层每次现读：本会话内
  // /provider add|remove 写入 providers.json 后立即可见（user/env/cli 层沿用
  // 加载时快照，与运行时配置一致）。
  async function describeLayersFor(
    workspaceRoot: string | undefined,
  ): Promise<{ setupNow: ProviderSetupState; layers: DescribeLayers }> {
    const setupNow = await loadProviderSetup(platform, home);
    const project =
      workspaceRoot !== undefined ? await projectFileIfTrusted(workspaceRoot) : undefined;
    const userProviders = mergeLayers([
      ...setupLayers(setupNow.file ?? { version: 1 }, providersPath),
      { kind: "user", path: userConfigPath, file: userFile },
    ]).resolved.providers;
    const projectProviders =
      project?.providers !== undefined
        ? restrictProjectProviderAuth(project.providers, userProviders, () => undefined).map(
            (entry) => {
              const userEntry = userProviders.find((provider) => provider.id === entry.id);
              // 概览按整条取最高层；受保护账号需补回被过滤掉的用户字段。
              return userEntry?.auth !== undefined && userEntry.auth.kind !== "apiKey"
                ? { ...userEntry, ...entry }
                : entry;
            },
          )
        : undefined;
    return {
      setupNow,
      layers: {
        setup: setupNow.file?.providers,
        user: userFile.providers,
        project: projectProviders,
        env: envLayer.file.providers,
        cli: cliLayer.file.providers,
      },
    };
  }

  // 用户鉴权 URL 无效时在加载阶段失败，而不是等首次读取 base。
  base();
  return {
    reload: () => loadConfig(platform, { ...options, nocturneHome: home, credentials }),
    skillConfig: () => userFile.skills ?? {},
    disabledSkills: () => settings.store.disabledSkills(),
    setSkillEnabled: (name, enabled) => settings.store.setSkillEnabled(name, enabled),
    async describeExternalAgents(input = {}) {
      const resolved = input.workspaceRoot
        ? (await forWorkspace(input.workspaceRoot)).resolved
        : base().resolved;
      return { agents: describeExternalAgents(resolved), warnings: resolved.warnings };
    },
    async saveExternalAgent(input) {
      await externalAgentStore.save(input, base().resolved);
      const agent = describeExternalAgents(base().resolved).find(
        (item) => item.name === input.name,
      );
      if (agent === undefined) throw new Error("保存后的外部 agent 不存在");
      return agent;
    },
    deleteExternalAgent: ({ name }) => externalAgentStore.remove(name, base().resolved),
    setExternalAgentEnabled: ({ name, enabled }) =>
      externalAgentStore.enabled(name, enabled, base().resolved),
    async describeMcpServers(input = {}) {
      const resolved = input.workspaceRoot
        ? (await forWorkspace(input.workspaceRoot)).resolved
        : base().resolved;
      const servers = describeMcp(resolved, home, input.workspaceRoot, credentials, platform);
      if (input.workspaceRoot) {
        const workspace = await forWorkspace(input.workspaceRoot);
        if (!workspace.projectConfig.trusted && workspace.projectConfig.path) {
          const project = await loadConfigFile(fs, workspace.projectConfig.path, "project").catch(
            () => undefined,
          );
          for (const [name, entry] of Object.entries(project?.mcp?.servers ?? {})) {
            const item = describeMcp(
              { ...resolved, mcpServers: [{ name, entry, origin: "project" }] },
              home,
              input.workspaceRoot,
              credentials,
              platform,
            )[0];
            if (item) servers.push({ ...item, trusted: false });
          }
        }
      }
      return { servers, warnings: resolved.warnings };
    },
    async saveMcpServer(input) {
      if (input.mode === "create" && input.workspaceRoot) {
        const workspace = await forWorkspace(input.workspaceRoot);
        const project = workspace.projectConfig.path
          ? await loadConfigFile(fs, workspace.projectConfig.path, "project").catch(() => undefined)
          : undefined;
        if (
          Object.keys(project?.mcp?.servers ?? {}).some(
            (id) => id.toLowerCase() === input.id.toLowerCase(),
          )
        )
          throw new McpSettingsError("id", "服务器名称已存在");
      }
      const resolved = input.workspaceRoot
        ? (await forWorkspace(input.workspaceRoot)).resolved
        : base().resolved;
      await mcpStore.save(input, resolved);
      const updated = input.workspaceRoot
        ? (await forWorkspace(input.workspaceRoot)).resolved
        : base().resolved;
      const server = describeMcp(updated, home, input.workspaceRoot, credentials, platform).find(
        (s) => s.id === input.id,
      );
      if (server === undefined) throw new Error("保存后的服务器不存在");
      return server;
    },
    async deleteMcpServer(input) {
      await mcpStore.remove(
        input.id,
        input.workspaceRoot ? (await forWorkspace(input.workspaceRoot)).resolved : base().resolved,
      );
    },
    async setMcpServerEnabled(input) {
      await mcpStore.enabled(
        input.id,
        input.enabled,
        input.workspaceRoot ? (await forWorkspace(input.workspaceRoot)).resolved : base().resolved,
      );
    },
    nocturneHome: home,
    sessionsDir,
    attachmentsDir: paths.join(sessionsDir, "attachments"),
    grantsDir,
    get base() {
      return base().resolved;
    },
    forWorkspace,
    setWorkspaceTrusted,

    providerSetupWarning: setup.warning,
    credentials,
    saveSetupProvider: (entry, opts) => saveSetupProvider(platform, home, credentials, entry, opts),
    describeSetupProvider: async (providerId) => {
      const state = await loadProviderSetup(platform, home);
      return state.file?.providers?.find((p) => p.id === providerId);
    },
    setCredential: async (providerId, key) => {
      await credentials.set(providerId, key);
      const now = await loadProviderSetup(platform, home);
      if (now.file?.providers?.some((p) => p.id === providerId)) {
        await writeProviderSetup(platform, home, now.file);
      }
    },
    refreshModelsDev: async () => {
      if (userFile.modelsDev === false) return undefined;
      const result = await refreshModelsDev(platform, home, options.modelsDevFetch);
      modelsDev = result.data;
      return result.warning;
    },
    // ADR-0024 第 3 节：来源按"实际参与合并的层"计算；trustedSet 与
    // projectFileIfTrusted 复用 forWorkspace 同一口径
    listModelSettings: async (providerId, workspaceRoot) => {
      const setupNow = await loadProviderSetup(platform, home);
      const sFile = setupNow.file ?? { version: 1 };
      const merged = await mergeFor(sFile, workspaceRoot);
      const managed = (sFile.providers ?? []).some((e) => e.id === providerId);
      return buildModelSettingsViews({
        providerId,
        entry: merged.resolved.providers.find((p) => p.id === providerId),
        managed,
        userModels: sFile.providers?.find((e) => e.id === providerId)?.userModels,
        modelInfo: merged.modelInfo,
        ...(options.builtinModel !== undefined ? { builtinModel: options.builtinModel } : {}),
      });
    },
    saveModelSettings: (providerId, modelId, patch, workspaceRoot) =>
      saveModelSettingsImpl(
        platform,
        home,
        providerId,
        modelId,
        patch,
        workspaceRoot,
        mergeFor,
        options,
      ),
    removeSetupProvider: (providerId) =>
      removeSetupProvider(platform, home, credentials, providerId),
    async findProviderConflict(id: string, workspaceRoot?: string) {
      const { layers } = await describeLayersFor(workspaceRoot);
      return findLayerConflict(layers, id);
    },
    async describeProviders(workspaceRoot?: string): Promise<ProviderOverview[]> {
      const { setupNow, layers } = await describeLayersFor(workspaceRoot);
      const overview = describeProviderLayers(layers, credentials, env);
      // 凭据内容只用于计算状态，绝不返回给客户端。
      const effective = (await mergeFor(setupNow.file ?? { version: 1 }, workspaceRoot)).resolved
        .providers;
      await Promise.all(
        overview.map(async (item) => {
          const entry = effective.find((p) => p.id === item.id);
          if (entry?.auth?.kind === "external-file") {
            const auth = entry.auth;
            const file =
              auth.path.startsWith("~/") || auth.path.startsWith("~\\")
                ? paths.join(platform.homeDir(), auth.path.slice(2))
                : paths.resolve(".", auth.path);
            try {
              let value: unknown = JSON.parse(await platform.fs.readTextFile(file));
              for (const key of auth.keyPath) {
                value =
                  value !== null && typeof value === "object" && Object.hasOwn(value, key)
                    ? (value as Record<string, unknown>)[key]
                    : undefined;
              }
              item.credentialStatus =
                typeof value === "string" && value.trim() !== "" ? "valid" : "missing";
            } catch {
              item.credentialStatus = "missing";
            }
            item.auth = `CLI 凭据 ${auth.path}`;
            item.authKind = "external-file";
            item.keySource = "missing";
            delete item.credentialStorage;
          } else if (entry?.auth?.kind === "openai-siwc" || entry?.auth?.kind === "xai-oauth2") {
            const place = credentials.storage?.(entry.id);
            if (place !== undefined) item.credentialStorage = place;
            else delete item.credentialStorage;
            const label = entry.auth.kind === "xai-oauth2" ? "Grok 账号" : "ChatGPT 账号";
            item.authKind = "account";
            try {
              // 令牌刷新可能由另一个凭据存储实例写入，按盘上最新记录计算状态。
              const raw = await credentials.get(entry.id, { fresh: true });
              const record =
                raw === undefined
                  ? undefined
                  : (JSON.parse(raw) as {
                      email?: unknown;
                      expiresAt?: unknown;
                      refreshToken?: unknown;
                    });
              item.auth = `${label}${typeof record?.email === "string" ? ` ${record.email}` : ""}`;
              // 访问令牌过期后由下一次请求用刷新令牌自动续期，所以只要刷新令牌还在就是有效。
              // 终止性刷新失败（invalid_grant 等）时刷新逻辑在锁内删除整条记录
              // （provider-oauth.ts / xai-oauth.ts），这里读盘即得 missing；不发网络请求。
              item.credentialStatus =
                typeof record?.expiresAt !== "number"
                  ? "missing"
                  : typeof record.refreshToken === "string" && record.refreshToken !== ""
                    ? "valid"
                    : record.expiresAt <= Date.now()
                      ? "expired"
                      : record.expiresAt - Date.now() < 300_000
                        ? "expiring"
                        : "valid";
            } catch {
              item.credentialStatus = "missing";
            }
          }
        }),
      );
      return overview;
    },
    refreshUpstreamLimits: async (providerId: string) => {
      await refreshUpstreamLimits(
        platform,
        home,
        credentials,
        env,
        options.upstreamFetch,
        providerId,
      );
      if (userFile.modelsDev === false) return undefined;
      const result = await refreshModelsDev(platform, home, options.modelsDevFetch);
      modelsDev = result.data;
      return result.warning;
    },
    describeSettings,
    resolvedSettings: (root, shellEnv) => mergedSettings(root, shellEnv).resolved,
    updateSettings: (patch) => settings.store.update(patch),
    setDefaultModel: (model, effort) => settings.store.setDefaultModel(model, effort),
    setModelRole: (role, ref) => settings.store.update({ [`modelRoles.${role}`]: ref }),
    shellSetting: () => settings.store.shellFields(),
    setShellSetting: (kind, path) => settings.store.setShell(kind, path),
    getPreference: (key) => settings.store.getPreference(key),
    setPreference: (key, value) => settings.store.setPreference(key, value),
    recentModels: () => [...recent],
    recordRecentModel: async (ref: ModelRef) => {
      await recordRecentModel(platform, home, ref);
      recent = await readRecentModels(platform, home);
    },
  };
}

/**
 * 模型设置写入端（ADR-0024 第 3 节）：校验 → 应用到 userModels → 原子写
 * providers.json。校验一律以"保存后的最终生效值"计算；config.json 绝不写。
 * mergeFor 复用 loadConfig 的层构造（可信项目层才参与）。
 */
async function saveModelSettingsImpl(
  platform: Platform,
  nocturneHome: string,
  providerId: string,
  modelId: string,
  patch: ModelSettingsPatch,
  workspaceRoot: string | undefined,
  mergeFor: (sFile: ProviderSetupFile, workspaceRoot?: string) => Promise<MergeResult>,
  options: LoadConfigOptions,
): Promise<void> {
  const invalid = (msg: string): never => {
    throw new ConfigError("config_invalid", msg);
  };
  const valueError = patchValueError(patch);
  if (valueError !== undefined) invalid(valueError);

  const setupNow = await loadProviderSetup(platform, nocturneHome);
  const sFile = setupNow.file ?? { version: 1 };
  const entry = sFile.providers?.find((e) => e.id === providerId);
  if (entry === undefined) {
    const merged = await mergeFor(sFile, workspaceRoot);
    invalid(providerOriginHint(providerId, merged.modelInfo.providers.get(providerId)));
  }

  // 当前视图：模型须在清单内；来源为 config 的字段不接受编辑
  const current = await mergeFor(sFile, workspaceRoot);
  const currentEntry = current.resolved.providers.find((p) => p.id === providerId);
  if (currentEntry?.models?.[modelId] === undefined) {
    invalid(`模型 "${modelId}" 不在服务商 "${providerId}" 的清单中`);
  }
  const currentView = buildModelSettingsViews({
    providerId,
    entry: currentEntry,
    managed: true,
    userModels: entry?.userModels,
    modelInfo: current.modelInfo,
    ...(options.builtinModel !== undefined ? { builtinModel: options.builtinModel } : {}),
  }).find((v) => v.modelId === modelId);
  if (currentView === undefined) {
    throw new ConfigError(
      "config_invalid",
      `模型 "${modelId}" 不在服务商 "${providerId}" 的清单中`,
    );
  }
  const cfgError = configFieldError(currentView, patch);
  if (cfgError !== undefined) invalid(cfgError);

  // 候选 userModels → 重新合并 → 以最终生效值校验
  const nextUserModels = applyModelPatch(entry?.userModels, modelId, patch);
  const candidateFile: ProviderSetupFile = {
    ...sFile,
    providers: (sFile.providers ?? []).map((e) =>
      e.id === providerId
        ? nextUserModels !== undefined
          ? { ...e, userModels: nextUserModels }
          : (() => {
              const { userModels: _dropped, ...rest } = e;
              return rest;
            })()
        : e,
    ),
  };
  const candidate = await mergeFor(candidateFile, workspaceRoot);
  const candidateView = buildModelSettingsViews({
    providerId,
    entry: candidate.resolved.providers.find((p) => p.id === providerId),
    managed: true,
    userModels: nextUserModels,
    modelInfo: candidate.modelInfo,
    ...(options.builtinModel !== undefined ? { builtinModel: options.builtinModel } : {}),
  }).find((v) => v.modelId === modelId);
  if (candidateView === undefined) {
    throw new ConfigError(
      "config_invalid",
      `模型 "${modelId}" 不在服务商 "${providerId}" 的清单中`,
    );
  }
  const effError = effectiveValueError(candidateView);
  if (effError !== undefined) invalid(effError);

  await saveSetupUserModels(platform, nocturneHome, providerId, nextUserModels);
}
