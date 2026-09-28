/** config — 分层配置加载、校验、合并与信任/授权数据存储（config.md） */
export * from "./types.js";
export * from "./errors.js";
export { loadConfig } from "./load.js";
export { workspaceKey } from "./grants.js";
// settings.json 设置层（ADR-0022 第 3 节）：loadConfig 内部使用，测试可注入
export { loadSettingsStore, type SettingsStore } from "./settings.js";
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
  saveSetupThinking,
  saveSetupUserModels,
  setSetupDefaultModel,
  writeProviderSetup,
  type DescribeLayers,
  type ProviderSetupState,
} from "./setup.js";
// 模型设置编辑（ADR-0024）：编辑页/CLI 问答用的来源文案与行式问答向导
export { modelFieldSourceText } from "./model-settings.js";
export { runProviderModelWizard } from "./wizard.js";
// 向导流程编排（provider-setup.md 第 1、6 节）：交互外壳在客户端，
// fetch/presets/env 能力由客户端注入
export {
  runProviderKeyWizard,
  runProviderSetupWizard,
  runProviderThinkingWizard,
  WizardAbort,
  type SetupWizardDeps,
  type WizardFetchRequest,
  type WizardIo,
  type WizardPreset,
  type WizardResult,
} from "./wizard.js";
