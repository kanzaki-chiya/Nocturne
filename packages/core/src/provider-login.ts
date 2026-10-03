import type { ProviderEntryConfig, RuntimeConfig } from "./config/index.js";
import type { LoginSession } from "./protocol/index.js";
import { listProviderPresets } from "./provider/index.js";
import { ProviderLoginError, type ProviderLoginOptions } from "./provider-login/errors.js";
import { createOpenRouterLogin } from "./provider-login/openrouter.js";
import { createSiwcLogin } from "./provider-login/openai-siwc.js";
import {
  dropPendingLogin,
  registerPendingLogin,
  stagingCredentials,
  type PendingLogin,
} from "./provider-login/pending.js";
import { createXaiLogin } from "./provider-login/xai-oauth.js";
import { createPlatform } from "./platform/index.js";

export { ProviderLoginError, type ProviderLoginErrorCode } from "./provider-login/errors.js";
export type { ProviderLoginOptions } from "./provider-login/errors.js";

/** 无系统后端的账号型登录必须先由客户端选好保存位置，授权前就拒绝，不让用户白走一遍浏览器。 */
function requireAccountStorage(
  config: RuntimeConfig,
  entry: ProviderEntryConfig,
  options: ProviderLoginOptions,
): void {
  if (
    (entry.auth?.kind === "openai-siwc" || entry.auth?.kind === "xai-oauth2") &&
    config.credentials.backend() === "none" &&
    options.accountStorage !== "plaintext" &&
    options.accountStorage !== "memory"
  ) {
    throw new ProviderLoginError("accountStorage");
  }
}

async function startEntryLogin(
  config: RuntimeConfig,
  entry: ProviderEntryConfig,
  credentials: RuntimeConfig["credentials"],
  options: ProviderLoginOptions,
): Promise<LoginSession> {
  requireAccountStorage(config, entry, options);
  if (entry.auth?.kind === "openai-siwc") {
    return createSiwcLogin(entry, credentials, createPlatform(), config.nocturneHome, options);
  }
  if (entry.auth?.kind === "xai-oauth2") {
    return createXaiLogin(entry, credentials, createPlatform(), config.nocturneHome, options);
  }
  if (entry.auth?.kind !== undefined && entry.auth.kind !== "apiKey") {
    throw new ProviderLoginError("unsupported");
  }
  const preset = listProviderPresets().find(
    (item) => item.baseURL !== undefined && item.baseURL === entry.baseURL,
  );
  if (preset?.login !== "openrouter" || (entry.type && entry.type !== preset.type)) {
    throw new ProviderLoginError("unsupported");
  }
  return createOpenRouterLogin(entry, credentials, options);
}

/** 已保存服务商（重新登录）：凭据完成后直接写入凭据存储。 */
export async function startProviderLogin(
  config: RuntimeConfig,
  providerId: string,
  options: ProviderLoginOptions = {},
): Promise<LoginSession> {
  const entry = options.entry ?? config.base.providers.find((item) => item.id === providerId);
  if (entry?.id !== providerId) throw new ProviderLoginError("missing");
  return startEntryLogin(config, entry, config.credentials, options);
}

/** 表单里尚未保存的服务商：预设 id 加名称与地址。 */
export interface DraftLoginTarget {
  presetId: string;
  name: string;
  baseURL?: string | undefined;
}

/**
 * 草稿登录（ADR-0044 第 6 节）：服务商还没保存，凭据暂存在 Core 里，
 * 完成后把返回的 loginId 交给 addProvider 提交——此前不写任何凭据或条目。
 */
export async function startDraftProviderLogin(
  config: RuntimeConfig,
  draft: DraftLoginTarget,
  options: Omit<ProviderLoginOptions, "entry"> = {},
): Promise<LoginSession & { loginId: string }> {
  const preset = listProviderPresets().find((item) => item.id === draft.presetId);
  if (preset?.login === undefined || draft.name === "") throw new ProviderLoginError("unsupported");
  const baseURL = preset.baseURL ?? draft.baseURL;
  const entry: ProviderEntryConfig = {
    id: draft.name,
    type: preset.type,
    ...(baseURL !== undefined ? { baseURL } : {}),
    ...(preset.auth !== undefined ? { auth: preset.auth } : {}),
  };
  const pending: PendingLogin = {
    presetId: preset.id,
    providerId: draft.name,
    baseURL,
    account: preset.auth?.kind === "openai-siwc" || preset.auth?.kind === "xai-oauth2",
    settled: false,
  };
  const session = await startEntryLogin(
    config,
    entry,
    stagingCredentials(config.credentials, pending),
    { ...options, entry },
  );
  const loginId = registerPendingLogin(config, pending);
  void session.completion.then(
    () => {
      pending.settled = true;
    },
    () => {
      dropPendingLogin(config, loginId);
    },
  );
  return { ...session, loginId };
}

/** 丢弃草稿登录暂存的凭据（表单放弃或客户端断开）；进行中的登录用 LoginSession.cancel。commit 后调用为空操作。 */
export function discardDraftLogin(config: RuntimeConfig, loginId: string): void {
  dropPendingLogin(config, loginId);
}

export async function logoutProvider(config: RuntimeConfig, providerId: string): Promise<void> {
  const entry = config.base.providers.find((item) => item.id === providerId);
  if (!entry) throw new ProviderLoginError("missing");
  if (entry.auth?.kind === "external-file") return;
  try {
    await config.credentials.delete(providerId);
  } catch {
    throw new ProviderLoginError("storage");
  }
}
