/** config — 分层配置加载、校验、合并与信任/授权数据存储（config.md） */
export * from "./types.js";
export * from "./reviewer.js";
export * from "./errors.js";
export { loadConfig } from "./load.js";
export { workspaceKey } from "./grants.js";
// settings.json 设置层（ADR-0034）：loadConfig 内部使用，测试可注入
export { loadSettingsStore, validateSettingsPatch, type SettingsStore } from "./settings.js";
// 向导配置层与凭据存储（provider-setup.md）：CLI/TUI 的向导与 /provider 命令共用
export { createCredentialStore, type CredentialStoreInit } from "./credentials.js";
export {
  describeProviderLayers,
  hostOf,
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
// 模型设置编辑（ADR-0024）：编辑页/CLI 问答用的来源文案
export { modelFieldSourceText } from "./model-settings.js";
// 编辑工具内置默认表（ADR-0035 §5）：装配处注入 provider 的模型解析
export { defaultEditToolForModel } from "./edit-tool.js";
export { discoverSkills, type DiscoveredSkill } from "./skills.js";
