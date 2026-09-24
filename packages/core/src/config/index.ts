/** config — 分层配置加载、校验、合并与信任/授权数据存储（config.md） */
export * from "./types.js";
export * from "./errors.js";
export { loadConfig } from "./load.js";
export { workspaceKey } from "./grants.js";
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
  setSetupDefaultModel,
  writeProviderSetup,
  type DescribeLayers,
  type ProviderSetupState,
} from "./setup.js";
