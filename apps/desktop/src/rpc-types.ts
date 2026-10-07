/**
 * 桌面端只能从 `@nocturne/rpc/client` 与 `@nocturne/core/protocol` 引类型；
 * provider/settings 的负载类型经客户端接口的返回/参数类型推导（desktop-* 依赖规则）。
 */
import type { RpcProvider, RpcRuntime } from "@nocturne/rpc/client";

export type ProvidersDescribed = Awaited<ReturnType<RpcProvider["describeProviders"]>>;
export type ProviderOverview = ProvidersDescribed["providers"][number];
export type ProviderPreset = Awaited<ReturnType<RpcProvider["listProviderPresets"]>>[number];
export type ProviderSetupDescription = Awaited<ReturnType<RpcProvider["describeProviderSetup"]>>;
export type PrepareProviderResult = Awaited<ReturnType<RpcProvider["prepareProvider"]>>;
export type AddProviderResult = Awaited<ReturnType<RpcProvider["commitProvider"]>>;
export type SetupProviderEntry = NonNullable<
  Awaited<ReturnType<RpcProvider["describeSetupProvider"]>>
>;
export type UpdateSetupProviderPatch = Parameters<RpcProvider["updateSetupProvider"]>[1];
export type ModelSettingsView = Awaited<ReturnType<RpcProvider["listModelSettings"]>>[number];
export type ModelFieldSource = ModelSettingsView["fields"]["displayName"]["source"];
export type ModelSettingsPatch = Parameters<RpcProvider["saveModelSettings"]>[2];
export type SettingItem = Awaited<ReturnType<RpcRuntime["describeSettings"]>>[number];
export type SkillImportPreview = Extract<
  Awaited<ReturnType<RpcRuntime["importSkills"]>>,
  { mode: "preview" }
>;
export type SkillImportCandidate = SkillImportPreview["candidates"][number];
export type SkillImportCommit = Extract<
  Awaited<ReturnType<RpcRuntime["importSkills"]>>,
  { mode: "commit" }
>;
export type SettingsPatch = Parameters<RpcRuntime["updateSettings"]>[0];
export type ModelInfo = Awaited<ReturnType<RpcRuntime["listModels"]>>[number];
export type ModelRoleInfo = Awaited<ReturnType<RpcRuntime["describeModelRoles"]>>[number];
export type JevReviewerConfig = Awaited<ReturnType<RpcRuntime["defaultReviewer"]>>;
export type SecurityReviewerConfig = NonNullable<SettingsPatch["permission.reviewer"]>;
export type JevEndpoint = JevReviewerConfig["endpoint"];
export type ReasoningEffortLevel = ModelSettingsView["fields"]["reasoningEffort"]["value"] extends
  (infer L)[] | undefined
  ? L
  : never;
export type ModelProtocol = ModelSettingsView["fields"]["protocol"]["value"];
export type EditToolKind = ModelSettingsView["fields"]["editTool"]["value"];
export type AccountStorageSetup = NonNullable<
  Awaited<ReturnType<RpcProvider["describeAccountStorage"]>>
>;
