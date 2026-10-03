/**
 * 公开 API 与 RPC 方法的对应表（ADR-0044 第 4 节："方法清单以公开 API 为准"）。
 * 键类型由 `keyof Runtime` / `keyof RuntimeSession` 推导：公开 API 新增方法而这里没登记，
 * 编译失败；覆盖测试再用真实 Runtime 对象的键与服务端方法表对照一遍。
 */
import type { Runtime, RuntimeSession } from "@nocturne/core";

import type { RpcMethodName } from "../shared/methods.js";

/** 没有（或没有一一对应的）RPC 方法的 Runtime 成员，附原因 */
export const RUNTIME_NOT_MAPPED = {
  updateProviders:
    "参数是含函数的进程内 RuntimeConfig，无法序列化；第 5 步改为服务端重载配置的数据方法",
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
