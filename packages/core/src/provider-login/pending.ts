import { randomUUID } from "node:crypto";

import type { CredentialStore, RuntimeConfig } from "../config/index.js";

/** 草稿登录拿到、尚未写入凭据存储的凭据；addProvider 提交时才落盘。 */
export type StagedCredential =
  | { kind: "secret"; value: string }
  | { kind: "account"; value: string; storage?: "plaintext" | "memory" | undefined };

export interface PendingLogin {
  presetId: string;
  providerId: string;
  baseURL: string | undefined;
  /** 账号型登录（令牌 JSON）；否则是 API Key 型 */
  account: boolean;
  settled: boolean;
  staged?: StagedCredential | undefined;
}

/** 每个 RuntimeConfig 一张表：登录会话由 loginId 引用，随进程结束丢弃。 */
const registry = new WeakMap<RuntimeConfig, Map<string, PendingLogin>>();

export function registerPendingLogin(config: RuntimeConfig, pending: PendingLogin): string {
  let table = registry.get(config);
  if (table === undefined) {
    table = new Map();
    registry.set(config, table);
  }
  const loginId = randomUUID();
  table.set(loginId, pending);
  return loginId;
}

export function findPendingLogin(config: RuntimeConfig, loginId: string): PendingLogin | undefined {
  return registry.get(config)?.get(loginId);
}

export function dropPendingLogin(config: RuntimeConfig, loginId: string): void {
  registry.get(config)?.delete(loginId);
}

/**
 * 登录实现照常调用 credentials.set / setAccount；草稿登录把写入拦截到 pending.staged，
 * 其余能力委托给真实存储（后端判断、读取、删除不受影响）。
 */
export function stagingCredentials(real: CredentialStore, pending: PendingLogin): CredentialStore {
  return {
    get: (providerId, options) => real.get(providerId, options),
    set: (_providerId, key) => {
      pending.staged = { kind: "secret", value: key };
      return Promise.resolve();
    },
    ...(real.setAccount !== undefined
      ? {
          setAccount: (_providerId: string, record: string, storage?: "plaintext" | "memory") => {
            pending.staged = { kind: "account", value: record, storage };
            return Promise.resolve();
          },
        }
      : {}),
    ...(real.storage !== undefined ? { storage: (id: string) => real.storage?.(id) } : {}),
    delete: (providerId) => real.delete(providerId),
    has: (providerId) => real.has(providerId),
    backend: () => real.backend(),
  };
}
