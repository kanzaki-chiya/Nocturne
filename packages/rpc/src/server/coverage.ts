/**
 * 公开 API 与 RPC 方法的对应表（ADR-0044 第 4 节："方法清单以公开 API 为准"）。
 * 键类型由 `keyof Runtime` / `keyof RuntimeSession` / `keyof RuntimeConfig` 推导：
 * 公开 API 新增方法而这里没登记，编译失败；覆盖测试再用真实对象的键、
 * Core 顶层导出的服务商配置函数与服务端方法表对照一遍。
 */
import type { Runtime, RuntimeConfig, RuntimeSession } from "@nocturne/core";

import type { RpcMethodName } from "../shared/methods.js";

/** 没有（或没有一一对应的）RPC 方法的 Runtime 成员，附原因 */
export const RUNTIME_NOT_MAPPED = {
  updateProviders:
    "参数是含函数的进程内 RuntimeConfig，无法序列化；服务端在配置变更方法后自动重载，客户端收 runtime.providersChanged 通知",
} as const satisfies Partial<Record<keyof Runtime, string>>;

export const RUNTIME_METHODS: Record<
  Exclude<keyof Runtime, keyof typeof RUNTIME_NOT_MAPPED>,
  RpcMethodName
> = {
  describeModelRoles: "runtime.describeModelRoles",
  setModelRole: "runtime.setModelRole",
  describeSettings: "runtime.describeSettings",
  updateSettings: "runtime.updateSettings",
  listReviewerProviders: "runtime.listReviewerProviders",
  defaultReviewer: "runtime.defaultReviewer",
  listReviewerModels: "runtime.listReviewerModels",
  setDefaultModel: "runtime.setDefaultModel",
  createSession: "runtime.createSession",
  resumeSession: "runtime.resumeSession",
  forkSession: "runtime.forkSession",
  listSessions: "runtime.listSessions",
  listModels: "runtime.listModels",
  defaultModel: "runtime.defaultModel",
  listRecentModels: "runtime.listRecentModels",
  getPreference: "runtime.getPreference",
  setPreference: "runtime.setPreference",
};

export const SESSION_NOT_MAPPED = {
  id: "会话 id 是方法参数 sessionId，打开会话时在 SessionOpened 里返回",
  warnings: "打开时的警告随 SessionOpened 返回",
  recovery: "打开时的恢复修复汇总随 SessionOpened 返回",
  durableEvents: "持久事件由 session.subscribe 的回放推送（afterSeq 之后的全部）",
  interrupt: "是通知 session.interrupt（无应答），不在请求方法表里",
} as const satisfies Partial<Record<keyof RuntimeSession, string>>;

export const SESSION_METHODS: Record<
  Exclude<keyof RuntimeSession, keyof typeof SESSION_NOT_MAPPED>,
  RpcMethodName
> = {
  rewindTargets: "session.rewindTargets",
  rewind: "session.rewind",
  state: "session.state",
  subscribe: "session.subscribe",
  readInputHistory: "session.readInputHistory",
  recordInputHistory: "session.recordInputHistory",
  fileIndex: "session.fileIndex",
  submit: "session.submit",
  respondPermission: "session.respondPermission",
  respondQuestion: "session.respondQuestion",
  setModel: "session.setModel",
  setPermissionPreset: "session.setPermissionPreset",
  setReasoningEffort: "session.setReasoningEffort",
  shellInfo: "session.shellInfo",
  visionInfo: "session.visionInfo",
  listShells: "session.listShells",
  setShell: "session.setShell",
  reasoningEffortInfo: "session.reasoningEffortInfo",
  compact: "session.compact",
  describeContext: "session.describeContext",
  mcpServers: "session.mcpServers",
  close: "session.close",
};

/** 没有（或没有一一对应的）RPC 方法的 RuntimeConfig 成员，附原因 */
export const CONFIG_NOT_MAPPED = {
  nocturneHome: "本机路径，客户端不需要",
  attachmentsDir: "本机路径，客户端不需要",
  grantsDir: "本机路径，客户端不需要",
  sessionsDir: "initialize 的结果里返回",
  base: "进程内合并结果；经 runtime.listModels / provider.describeProviders / runtime.describeSettings 获取",
  resolvedSettings: "进程内合并结果；经 runtime.describeSettings 获取",
  forWorkspace: "进程内合并入口；经 runtime.listModels / provider.describeProviders 获取",
  setWorkspaceTrusted: "项目信任由 nctrn trust 管理，第一版不经 RPC",
  credentials: "凭据存储对象，含明文凭据，不离开服务端进程",
  saveSetupProvider: "底层写入接口，经 provider.prepareProvider + provider.commitProvider 使用",
  recordRecentModel: "setModel / 新建会话时 Runtime 自动记录",
  providerSetupWarning: "随 provider.describeProviders 的 setupWarning 返回",
} as const satisfies Partial<Record<keyof RuntimeConfig, string>>;

export const CONFIG_METHODS: Record<
  Exclude<keyof RuntimeConfig, keyof typeof CONFIG_NOT_MAPPED>,
  RpcMethodName
> = {
  describeProviders: "provider.describeProviders",
  describeSettings: "runtime.describeSettings",
  updateSettings: "runtime.updateSettings",
  setDefaultModel: "runtime.setDefaultModel",
  setModelRole: "runtime.setModelRole",
  shellSetting: "session.shellInfo",
  setShellSetting: "session.setShell",
  getPreference: "runtime.getPreference",
  setPreference: "runtime.setPreference",
  recentModels: "runtime.listRecentModels",
  setCredential: "provider.setCredential",
  refreshModelsDev: "provider.refreshModelsDev",
  listModelSettings: "provider.listModelSettings",
  saveModelSettings: "provider.saveModelSettings",
  removeSetupProvider: "provider.removeSetupProvider",
  refreshUpstreamLimits: "provider.refreshUpstreamLimits",
};

/** 映射到 RPC 方法的 Core 顶层服务商配置函数（覆盖测试从 index.ts 导出块校验全集） */
export const PROVIDER_FUNCTION_METHODS = {
  listProviderPresets: "provider.listProviderPresets",
  describeProviderSetup: "provider.describeProviderSetup",
  describeAccountStorage: "provider.describeAccountStorage",
  prepareProvider: "provider.prepareProvider",
  commitProvider: "provider.commitProvider",
  discardProvider: "provider.discardProvider",
  logoutProvider: "provider.logoutProvider",
} as const satisfies Record<string, RpcMethodName>;

/** 不映射的服务商配置函数，附原因 */
export const PROVIDER_FUNCTIONS_NOT_MAPPED = {
  addProvider: "prepare + commit 的兼容组合，RPC 客户端分两步调用以便保存前展示结果",
  credentialBackendLabel:
    "纯文案函数，输入是描述数据；描述与 prepare 结果的 steps/notices 已带文案",
  setupFieldStep: "纯文案函数，输入是描述数据；prepare 结果的 steps 已带摘要文案",
  setupCredentialStep: "纯文案函数，输入是描述数据；prepare 结果的 steps 已带摘要文案",
  setupCredentialNotice: "纯文案函数，输入是描述数据；prepare 结果的 notices 已带说明文案",
  fetchProviderModels: "底层获取，prepare / refresh 内部使用，参数含密钥",
  fetchModels: "底层获取，prepare / refresh 内部使用，参数含密钥",
  ProviderSetupError: "错误类，经 RPC error 映射（-32005，data.field 给字段名）",
  ProviderLoginError: "错误类，经 RPC error 映射（-32003）",
  ProviderUpstreamError: "错误类，经 RPC error 映射",
  startProviderLogin: "登录会话经 login.* 方法组映射（方法与通知拆分的下一步）",
  startDraftProviderLogin: "草稿登录经 login.* 方法组映射（方法与通知拆分的下一步）",
} as const satisfies Record<string, string>;
