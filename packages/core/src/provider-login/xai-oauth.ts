import { createPublicKey, verify, type JsonWebKey } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { CredentialStore, ProviderEntryConfig } from "../config/index.js";
import type { Platform } from "../platform/index.js";
import {
  parseXaiOAuthCredential,
  type LoginSession,
  type XaiOAuthCredentialRecord,
} from "../protocol/index.js";
import { nocturneUserAgent } from "../provider/http.js";
import { ProviderAuthError, ProviderError } from "../provider/errors.js";
import { acquireSessionLock } from "../session/lock.js";
import { SessionError } from "../session/errors.js";
import { ProviderLoginError, type ProviderLoginOptions } from "./errors.js";
import { openLoginLoopback } from "./loopback.js";
import { createLoginLifecycle, createLoginSecrets } from "./session.js";

/** 推理只发往这个代理。项目配置不能改。ADR-0043。 */
export const XAI_OAUTH_PROXY = "https://cli-chat-proxy.grok.com/v1";
export const XAI_OAUTH_ISSUER = "https://auth.x.ai";
/** 官方 Grok Build 公开客户端。没有第三方注册端点，见 ADR-0043。 */
export const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const REQUIRED_SCOPE = "grok-cli:access";
const SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  REQUIRED_SCOPE,
  "api:access",
  "conversations:read",
  "conversations:write",
  "workspaces:read",
  "workspaces:write",
];
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const TERMINAL_REFRESH = [
  "invalid_grant",
  "invalid_client",
  "refresh_token_reused",
  "refresh_token_expired",
  "invalid_refresh_token",
] as const;

/** 端点注入仅供离线测试；公开入口不接受端点覆盖。 */
export interface XaiOAuthDependencies {
  fetchImpl?: typeof fetch | undefined;
  authorizeEndpoint?: string | undefined;
  deviceEndpoint?: string | undefined;
  tokenEndpoint?: string | undefined;
  jwksEndpoint?: string | undefined;
  issuer?: string | undefined;
  timeoutMs?: number | undefined;
  /** 测试把轮询间隔压到 0。公开入口不传。 */
  pollIntervalMs?: number | undefined;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function issuerOf(deps: XaiOAuthDependencies): string {
  return deps.issuer ?? XAI_OAUTH_ISSUER;
}

function endpoints(deps: XaiOAuthDependencies) {
  const issuer = issuerOf(deps).replace(/\/+$/, "");
  return {
    authorize: deps.authorizeEndpoint ?? `${issuer}/oauth2/authorize`,
    device: deps.deviceEndpoint ?? `${issuer}/oauth2/device/code`,
    token: deps.tokenEndpoint ?? `${issuer}/oauth2/token`,
    jwks: deps.jwksEndpoint ?? `${issuer}/.well-known/jwks.json`,
  };
}

function oauthHeaders(surface: "cli" | "headless"): Record<string, string> {
  const agent = nocturneUserAgent();
  return {
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
    "User-Agent": agent,
    "x-grok-client-version": agent,
    "x-grok-client-surface": surface,
  };
}

function safeUri(value: string): boolean {
  if (value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    if (url.protocol === "https:") return true;
    return (
      url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost")
    );
  } catch {
    return false;
  }
}

/** 只信任调用方给出的固定 JWKS，绝不按 JWT 内的 URL 取公钥。 */
export async function verifyXaiIdentity(
  token: string,
  signal: AbortSignal,
  nonce: string | undefined,
  deps: XaiOAuthDependencies = {},
): Promise<{ subject: string; email?: string }> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) throw new ProviderLoginError("identity");
    const header = object(JSON.parse(Buffer.from(parts[0] ?? "", "base64url").toString("utf8")));
    const claims = object(JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")));
    if (header.alg !== "ES256" || typeof header.kid !== "string" || header.kid === "")
      throw new ProviderLoginError("identity");
    const response = await (deps.fetchImpl ?? fetch)(endpoints(deps).jwks, {
      headers: { Accept: "application/json", "User-Agent": nocturneUserAgent() },
      signal,
      redirect: "error",
    });
    if (!response.ok) throw new ProviderLoginError("identity");
    const jwks = object(await response.json());
    const keys = Array.isArray(jwks.keys) ? jwks.keys : [];
    const candidates = keys
      .map(object)
      .filter(
        (key) =>
          key.kid === header.kid &&
          key.kty === "EC" &&
          key.crv === "P-256" &&
          (key.use === undefined || key.use === "sig") &&
          (key.alg === undefined || key.alg === "ES256"),
      );
    const key = candidates[0];
    if (
      candidates.length !== 1 ||
      !key ||
      !verify(
        "sha256",
        Buffer.from(`${parts[0]}.${parts[1]}`),
        {
          key: createPublicKey({ key: key as JsonWebKey, format: "jwk" }),
          dsaEncoding: "ieee-p1363",
        },
        Buffer.from(parts[2] ?? "", "base64url"),
      )
    )
      throw new ProviderLoginError("identity");
    const audience = claims.aud;
    if (
      claims.iss !== issuerOf(deps) ||
      !(
        audience === XAI_OAUTH_CLIENT_ID ||
        (Array.isArray(audience) && audience.includes(XAI_OAUTH_CLIENT_ID))
      ) ||
      typeof claims.exp !== "number" ||
      !Number.isFinite(claims.exp) ||
      claims.exp <= Date.now() / 1000 ||
      (nonce !== undefined && claims.nonce !== nonce) ||
      typeof claims.sub !== "string" ||
      !claims.sub
    )
      throw new ProviderLoginError("identity");
    signal.throwIfAborted();
    return {
      subject: claims.sub,
      ...(typeof claims.email === "string" && claims.email !== "" ? { email: claims.email } : {}),
    };
  } catch (error) {
    if (signal.aborted) signal.throwIfAborted();
    if (error instanceof ProviderLoginError) throw error;
    throw new ProviderLoginError("identity");
  }
}

export async function xaiRecord(
  data: unknown,
  signal: AbortSignal,
  deps: XaiOAuthDependencies = {},
  previous?: XaiOAuthCredentialRecord,
  nonce?: string,
): Promise<XaiOAuthCredentialRecord> {
  const value = object(data);
  const scopes =
    typeof value.scope === "string" ? value.scope.split(/\s+/).filter(Boolean) : previous?.scopes;
  if (!scopes?.includes(REQUIRED_SCOPE)) throw new ProviderLoginError("scope");
  if (
    typeof value.access_token !== "string" ||
    !value.access_token ||
    typeof value.expires_in !== "number" ||
    !Number.isFinite(value.expires_in) ||
    value.expires_in <= 0 ||
    (value.token_type !== undefined &&
      (typeof value.token_type !== "string" || value.token_type.toLowerCase() !== "bearer"))
  )
    throw new ProviderLoginError("exchange");
  const refreshToken =
    typeof value.refresh_token === "string" && value.refresh_token !== ""
      ? value.refresh_token
      : previous?.refreshToken;
  if (!refreshToken) throw new ProviderLoginError("exchange");
  const idToken =
    typeof value.id_token === "string" && value.id_token !== "" ? value.id_token : undefined;
  let identity: { subject: string; email?: string };
  if (idToken !== undefined) {
    identity = await verifyXaiIdentity(idToken, signal, nonce, deps);
  } else if (previous !== undefined) {
    identity = {
      subject: previous.subject,
      ...(previous.email !== undefined ? { email: previous.email } : {}),
    };
  } else throw new ProviderLoginError("identity");
  if (previous !== undefined && identity.subject !== previous.subject)
    throw new ProviderLoginError("identity");
  return {
    version: 1,
    kind: "xai-oauth2",
    clientId: XAI_OAUTH_CLIENT_ID,
    ...identity,
    accessToken: value.access_token,
    refreshToken,
    expiresAt: Date.now() + value.expires_in * 1000,
    scopes,
  };
}

async function saveLoginRecord(
  entry: ProviderEntryConfig,
  credentials: CredentialStore,
  record: XaiOAuthCredentialRecord,
  signal: AbortSignal,
  options: ProviderLoginOptions,
): Promise<void> {
  signal.throwIfAborted();
  try {
    if (credentials.backend() === "none") {
      if (!options.chooseAccountStorage || !credentials.setAccount)
        throw new ProviderLoginError("accountStorage");
      const storage: string = await options.chooseAccountStorage();
      signal.throwIfAborted();
      if (storage !== "plaintext" && storage !== "memory")
        throw new ProviderLoginError("accountStorage");
      await credentials.setAccount(entry.id, JSON.stringify(record), storage);
    } else await credentials.set(entry.id, JSON.stringify(record));
  } catch (error) {
    throw error instanceof ProviderLoginError ? error : new ProviderLoginError("storage");
  }
  signal.throwIfAborted();
}

async function postForm(
  url: string,
  body: Record<string, string>,
  surface: "cli" | "headless",
  signal: AbortSignal,
  deps: XaiOAuthDependencies,
): Promise<Response> {
  try {
    return await (deps.fetchImpl ?? fetch)(url, {
      method: "POST",
      headers: oauthHeaders(surface),
      body: new URLSearchParams(body),
      signal,
      redirect: "error",
    });
  } catch {
    if (signal.aborted) signal.throwIfAborted();
    throw new ProviderLoginError("network");
  }
}

async function deviceLogin(
  entry: ProviderEntryConfig,
  credentials: CredentialStore,
  options: ProviderLoginOptions,
  deps: XaiOAuthDependencies,
  lifecycle: ReturnType<typeof createLoginLifecycle>,
): Promise<LoginSession> {
  const surface = "headless";
  const issued = await postForm(
    endpoints(deps).device,
    {
      client_id: XAI_OAUTH_CLIENT_ID,
      scope: SCOPES.join(" "),
      referrer: "nocturne",
    },
    surface,
    lifecycle.signal,
    deps,
  );
  if (!issued.ok) throw new ProviderLoginError("exchange");
  const payload = object(await issued.json().catch(() => undefined));
  const deviceCode = payload.device_code;
  const userCode = payload.user_code;
  const verification = payload.verification_uri;
  const complete = payload.verification_uri_complete;
  const expiresIn = payload.expires_in;
  const interval = payload.interval;
  if (
    typeof deviceCode !== "string" ||
    !deviceCode ||
    typeof userCode !== "string" ||
    !/^[A-Za-z0-9-]+$/.test(userCode) ||
    typeof verification !== "string" ||
    !safeUri(verification) ||
    (complete !== undefined && (typeof complete !== "string" || !safeUri(complete))) ||
    typeof expiresIn !== "number" ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0
  )
    throw new ProviderLoginError("exchange");
  const display = typeof complete === "string" ? complete : verification;
  const pollMs =
    deps.pollIntervalMs ??
    Math.max(1, typeof interval === "number" && Number.isFinite(interval) ? interval : 5) * 1000;
  const deadline = Date.now() + Math.max(expiresIn, 600) * 1000;
  void lifecycle
    .run(async (signal) => {
      let wait = pollMs;
      for (;;) {
        if (wait > 0) await delay(wait, undefined, { signal });
        if (Date.now() > deadline) throw new ProviderLoginError("timeout");
        const response = await postForm(
          endpoints(deps).token,
          {
            grant_type: DEVICE_GRANT,
            device_code: deviceCode,
            client_id: XAI_OAUTH_CLIENT_ID,
          },
          surface,
          signal,
          deps,
        );
        if (response.ok) {
          const record = await xaiRecord(await response.json(), signal, deps);
          await saveLoginRecord(entry, credentials, record, signal, options);
          return {
            providerId: entry.id,
            ...(record.email !== undefined ? { account: record.email } : {}),
          };
        }
        const errorBody = object(await response.json().catch(() => undefined));
        const code = typeof errorBody.error === "string" ? errorBody.error : "";
        if (code === "authorization_pending") continue;
        if (code === "slow_down") {
          wait += 5_000;
          continue;
        }
        throw new ProviderLoginError("exchange");
      }
    })
    .catch(() => undefined);
  return {
    authorizeUrl: display,
    userCode,
    manualInput: "none",
    completion: lifecycle.completion,
    submitManual() {
      return Promise.reject(new ProviderLoginError("input"));
    },
    cancel: lifecycle.cancel,
  };
}

export async function createXaiLogin(
  entry: ProviderEntryConfig,
  credentials: CredentialStore,
  _platform: Platform,
  _home: string,
  options: ProviderLoginOptions = {},
  deps: XaiOAuthDependencies = {},
): Promise<LoginSession> {
  if (entry.auth?.kind !== "xai-oauth2" || entry.baseURL !== XAI_OAUTH_PROXY)
    throw new ProviderLoginError("unsupported");
  const secrets = createLoginSecrets();
  const lifecycle = createLoginLifecycle(deps.timeoutMs ?? 10 * 60_000);
  try {
    if (options.remote) return await deviceLogin(entry, credentials, options, deps, lifecycle);
    let redirectUri = "";
    const authorize = new URL(endpoints(deps).authorize);
    for (const [name, value] of Object.entries({
      response_type: "code",
      client_id: XAI_OAUTH_CLIENT_ID,
      scope: SCOPES.join(" "),
      state: secrets.state,
      nonce: secrets.nonce,
      code_challenge: secrets.challenge,
      code_challenge_method: "S256",
      referrer: "nocturne",
    }))
      authorize.searchParams.set(name, value);

    function accept(url: URL): boolean {
      if (
        !lifecycle.accepting ||
        url.searchParams.getAll("state").length !== 1 ||
        url.searchParams.get("state") !== secrets.state
      )
        return false;
      if (url.searchParams.has("error")) {
        setImmediate(() => {
          lifecycle.fail(new ProviderLoginError("exchange"));
        });
        return true;
      }
      const code = url.searchParams.get("code");
      if (
        url.searchParams.getAll("code").length !== 1 ||
        !code ||
        code.length > 4096 ||
        /\s/.test(code)
      )
        return false;
      void lifecycle
        .run(async (signal) => {
          const response = await postForm(
            endpoints(deps).token,
            {
              grant_type: "authorization_code",
              code,
              client_id: XAI_OAUTH_CLIENT_ID,
              code_verifier: secrets.verifier,
              redirect_uri: redirectUri,
            },
            "cli",
            signal,
            deps,
          );
          if (!response.ok) throw new ProviderLoginError("exchange");
          const record = await xaiRecord(
            await response.json(),
            signal,
            deps,
            undefined,
            secrets.nonce,
          );
          await saveLoginRecord(entry, credentials, record, signal, options);
          return {
            providerId: entry.id,
            ...(record.email !== undefined ? { account: record.email } : {}),
          };
        })
        .catch(() => undefined);
      return true;
    }

    const loopback = await openLoginLoopback({
      state: secrets.state,
      path: "/callback",
      dualStack: false,
      accept,
    });
    lifecycle.addCleanup(loopback.close);
    redirectUri = loopback.callbackUrl;
    authorize.searchParams.set("redirect_uri", redirectUri);
    return {
      authorizeUrl: authorize.toString(),
      manualInput: "callback-url",
      completion: lifecycle.completion,
      async submitManual(text) {
        let url;
        try {
          url = new URL(text.trim());
        } catch {
          throw new ProviderLoginError("input");
        }
        const expected = new URL(redirectUri);
        if (
          url.origin !== expected.origin ||
          url.pathname !== expected.pathname ||
          url.username ||
          url.password ||
          url.hash ||
          !accept(url)
        )
          throw new ProviderLoginError("input");
        loopback.close();
        await lifecycle.completion;
      },
      cancel: lifecycle.cancel,
    };
  } catch (error) {
    const wrapped =
      error instanceof ProviderLoginError
        ? error
        : new ProviderLoginError(options.remote ? "exchange" : "callback");
    lifecycle.fail(wrapped);
    throw wrapped;
  }
}

export function createXaiAuthResolver(
  entry: { id: string },
  credentials: CredentialStore,
  platform: Platform,
  home: string,
  deps: XaiOAuthDependencies = {},
) {
  const message = `Grok 登录已失效，请执行 /provider login ${entry.id}`;
  const authError = () => new ProviderAuthError(message);
  let force = false;
  let flight: Promise<string> | undefined;

  async function current(fresh = false) {
    const record = parseXaiOAuthCredential(await credentials.get(entry.id, { fresh }));
    if (record?.clientId !== XAI_OAUTH_CLIENT_ID) throw authError();
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
      let response: Response;
      try {
        response = await (deps.fetchImpl ?? fetch)(endpoints(deps).token, {
          method: "POST",
          headers: oauthHeaders("headless"),
          body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: XAI_OAUTH_CLIENT_ID,
            refresh_token: record.refreshToken,
          }),
          redirect: "error",
          signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        });
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
        const value = object(data);
        const error = typeof value.error === "string" ? value.error : undefined;
        if (error !== undefined && (TERMINAL_REFRESH as readonly string[]).includes(error)) {
          await credentials.delete(entry.id);
          throw authError();
        }
        throw new ProviderError({
          kind: response.status >= 500 ? "server" : "auth",
          message: response.status >= 500 ? "账号刷新服务暂不可用，请稍后重试" : message,
          status: response.status,
        });
      }
      let next: XaiOAuthCredentialRecord;
      try {
        next = await xaiRecord(data, signal, deps, record);
      } catch {
        signal.throwIfAborted();
        throw authError();
      }
      signal.throwIfAborted();
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

  return {
    unauthorizedMessage: message,
    async token(signal: AbortSignal) {
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
}
