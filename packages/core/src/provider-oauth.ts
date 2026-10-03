import { setTimeout as delay } from "node:timers/promises";
import type { RuntimeConfig } from "./config/index.js";
import { createPlatform, type Platform } from "./platform/index.js";
import { parseOAuthCredential } from "./protocol/index.js";
import {
  createAuthResolver,
  fetchModels,
  ProviderAuthError,
  ProviderError,
  type AuthResolver,
  type FetchModelsRequest,
} from "./provider/index.js";
import type { AuthConfig } from "./provider/auth.js";
import { SIWC_RESOURCE, siwcRecord, type SiwcDependencies } from "./provider-login/openai-siwc.js";
import { createXaiAuthResolver, type XaiOAuthDependencies } from "./provider-login/xai-oauth.js";
import { acquireSessionLock } from "./session/lock.js";
import { SessionError } from "./session/errors.js";

const resolvers = new WeakMap<object, Map<string, AuthResolver>>();

/** 根装配层桥接 config/session/provider；协议实现不依赖存储或 UI。 */
export function resolveProviderAuth(
  config: Pick<RuntimeConfig, "credentials" | "nocturneHome"> | undefined,
  entry: AuthConfig,
  platform: Platform = createPlatform(),
  deps: SiwcDependencies & XaiOAuthDependencies = {},
): AuthResolver {
  if (entry.authResolver) return entry.authResolver;
  if (entry.auth?.kind === "xai-oauth2" && config !== undefined) {
    let byId = resolvers.get(config.credentials);
    if (!byId) {
      byId = new Map();
      resolvers.set(config.credentials, byId);
    }
    const existing = byId.get(entry.id);
    if (existing) return existing;
    const resolver = createXaiAuthResolver(
      entry,
      config.credentials,
      platform,
      config.nocturneHome,
      deps,
    );
    byId.set(entry.id, resolver);
    return resolver;
  }
  if (
    (entry.auth?.kind !== "openai-siwc" && entry.auth?.kind !== "xai-oauth2") ||
    config === undefined
  ) {
    return createAuthResolver(
      {
        ...entry,
        credentials:
          entry.credentials ??
          (config === undefined ? undefined : (id) => config.credentials.get(id)),
      },
      (name) => platform.env(name),
    );
  }
  let byId = resolvers.get(config.credentials);
  if (!byId) {
    byId = new Map();
    resolvers.set(config.credentials, byId);
  }
  const existing = byId.get(entry.id);
  if (existing) return existing;
  const credentials = config.credentials;
  const home = config.nocturneHome;
  const message = `ChatGPT 登录已失效，请执行 /provider login ${entry.id}`;
  const authError = () => new ProviderAuthError(message);
  let force = false;
  let flight: Promise<string> | undefined;

  async function current(fresh = false) {
    const record = parseOAuthCredential(await credentials.get(entry.id, { fresh }));
    if (!record) throw authError();
    return record;
  }
  async function refresh(signal: AbortSignal): Promise<string> {
    const initial = await current();
    if (!force && initial.expiresAt - Date.now() >= 300_000) return initial.accessToken;
    const storage =
      credentials.storage?.(entry.id) ?? (credentials.backend() === "memory" ? "memory" : "system");
    const lockPath = platform.paths.join(
      home,
      "locks",
      `oauth-${encodeURIComponent(entry.id)}.lock`,
    );
    let lock: Awaited<ReturnType<typeof acquireSessionLock>> | undefined;
    try {
      if (storage !== "memory") {
        await platform.fs.mkdir(platform.paths.dirname(lockPath), { mode: 0o700 });
        const deadline = Date.now() + 15_000;
        for (;;) {
          signal.throwIfAborted();
          try {
            lock = await acquireSessionLock(platform.fs, platform, lockPath);
            break;
          } catch (error) {
            if (!(error instanceof SessionError) || error.code !== "session_locked") throw error;
            if (Date.now() >= deadline)
              throw new ProviderError({ kind: "timeout", message: "账号刷新正在进行，请稍后重试" });
            await delay(50, undefined, { signal });
          }
        }
      }
      const record = await current(storage !== "memory");
      if (
        record.expiresAt - Date.now() >= 300_000 &&
        (!force ||
          record.refreshToken !== initial.refreshToken ||
          record.accessToken !== initial.accessToken)
      ) {
        force = false;
        return record.accessToken;
      }
      let response;
      try {
        response = await (deps.fetchImpl ?? fetch)(
          deps.tokenEndpoint ?? "https://auth.openai.com/api/accounts/oauth/token",
          {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "refresh_token",
              client_id: record.clientId,
              refresh_token: record.refreshToken,
              resource: SIWC_RESOURCE,
            }),
            redirect: "error",
            signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
          },
        );
      } catch {
        signal.throwIfAborted();
        throw new ProviderError({ kind: "network", message: "无法连接账号刷新服务，请稍后重试" });
      }
      let data: unknown;
      try {
        data = await response.json();
      } catch {
        throw new ProviderError({
          kind: response.status >= 500 ? "server" : "auth",
          message: "账号刷新响应无效，请稍后重试",
          status: response.status,
        });
      }
      if (!response.ok) {
        const value = data as { error?: unknown } | null;
        const error =
          typeof value?.error === "string"
            ? value.error
            : typeof value?.error === "object" && value.error !== null
              ? (value.error as { code?: unknown }).code
              : undefined;
        if (
          [
            "invalid_grant",
            "refresh_token_reused",
            "refresh_token_expired",
            "invalid_refresh_token",
          ].includes(String(error))
        ) {
          await credentials.delete(entry.id);
          throw authError();
        }
        throw new ProviderError({
          kind: response.status >= 500 ? "server" : "auth",
          message: response.status >= 500 ? "账号刷新服务暂不可用，请稍后重试" : message,
          status: response.status,
        });
      }
      let next;
      try {
        next = await siwcRecord(data, record.clientId, signal, undefined, deps, record);
      } catch {
        signal.throwIfAborted();
        throw authError();
      }
      signal.throwIfAborted();
      // 退出登录与删除记录不能被正在进行的刷新复活。
      if ((await current(storage !== "memory")).refreshToken !== record.refreshToken)
        throw authError();
      try {
        if (storage === "plaintext" || (storage === "memory" && credentials.backend() === "none")) {
          if (!credentials.setAccount) throw authError();
          await credentials.setAccount(entry.id, JSON.stringify(next), storage);
        } else await credentials.set(entry.id, JSON.stringify(next));
      } catch {
        throw new ProviderAuthError("无法保存刷新后的账号凭据，请重新登录");
      }
      force = false;
      return next.accessToken;
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof ProviderError) throw error;
      throw new ProviderAuthError("无法读取或保存账号凭据，请重新登录");
    } finally {
      await lock?.release();
    }
  }

  const resolver: AuthResolver = {
    unauthorizedMessage: message,
    modelFormat: "siwc",
    protocol: "openai-responses",
    requestConstraints: {
      omitFields: [
        "max_output_tokens",
        "temperature",
        "top_p",
        "metadata",
        "truncation",
        "user",
        "prompt_cache_retention",
        "safety_identifier",
        "previous_response_id",
        // 预览限制页列出的其余不支持字段（2026-10-03 核对）
        "background",
        "conversation",
        "max_tool_calls",
        "moderation",
        "multi_agent",
        "prompt",
        "top_logprobs",
      ],
      systemAsInstructions: true,
      namespaceTools: true,
      requireCompleted: true,
      // 缓存按会话路由：只带 prompt_cache_key 时命中率仍很低（实测约 1%），官方客户端另发 session_id 头
      sessionHeader: "session_id",
      // 同一会话的多步请求仍会落到不同后端（命中在 100% 与仅公共前缀之间跳），回传路由令牌
      stickyRoutingHeader: "x-codex-turn-state",
    },
    async token(signal) {
      signal.throwIfAborted();
      flight ??= refresh(signal).finally(() => {
        flight = undefined;
      });
      const value = await flight;
      signal.throwIfAborted();
      return value;
    },
    invalidate() {
      force = true;
      return Promise.resolve();
    },
  };
  byId.set(entry.id, resolver);
  return resolver;
}

/** 模型列表与会话、角色和审查器共用鉴权。 */
export function fetchProviderModels(
  config: RuntimeConfig,
  entry: FetchModelsRequest & { apiKeyEnv?: string | undefined },
  key?: string,
  signal?: AbortSignal,
) {
  return fetchModels(
    entry,
    resolveProviderAuth(config, {
      ...entry,
      id: entry.id ?? "provider",
      credentials: key === undefined ? undefined : () => Promise.resolve(key),
    }),
    signal,
  );
}
