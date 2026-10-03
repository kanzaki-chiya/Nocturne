import { createPublicKey, randomUUID, verify, type JsonWebKey } from "node:crypto";
import type { CredentialStore, ProviderEntryConfig } from "../config/index.js";
import { writeJsonAtomic } from "../config/files.js";
import type { Platform } from "../platform/index.js";
import {
  parseOAuthCredential,
  type LoginSession,
  type OAuthCredentialRecord,
} from "../protocol/index.js";
import { acquireSessionLock } from "../session/lock.js";
import { ProviderLoginError, type ProviderLoginOptions } from "./errors.js";
import { openLoginLoopback } from "./loopback.js";
import { createLoginLifecycle, createLoginSecrets } from "./session.js";

export const SIWC_RESOURCE = "https://api.openai.com/v1";
const SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
export interface SiwcDependencies {
  issuer?: string;
  authorizeEndpoint?: string;
  tokenEndpoint?: string;
  jwksEndpoint?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProviderLoginError("identity");
  return value as Record<string, unknown>;
}

/** 只信任固定 issuer 的 JWKS，绝不按 JWT 内的 URL 取公钥。 */
export async function verifySiwcIdentity(
  token: string,
  clientId: string,
  signal: AbortSignal,
  nonce: string | undefined,
  deps: SiwcDependencies = {},
): Promise<{ subject: string; email?: string }> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) throw new ProviderLoginError("identity");
    const header = object(JSON.parse(Buffer.from(parts[0] ?? "", "base64url").toString("utf8")));
    const claims = object(JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")));
    if (header.alg !== "RS256" || typeof header.kid !== "string")
      throw new ProviderLoginError("identity");
    const response = await (deps.fetchImpl ?? fetch)(
      deps.jwksEndpoint ?? "https://auth.openai.com/.well-known/jwks.json",
      { signal, redirect: "error" },
    );
    if (!response.ok) throw new ProviderLoginError("identity");
    const jwks = object(await response.json());
    const keys = Array.isArray(jwks.keys) ? jwks.keys : [];
    const candidates = keys
      .map(object)
      .filter(
        (key) =>
          key.kid === header.kid &&
          key.kty === "RSA" &&
          (key.use === undefined || key.use === "sig") &&
          (key.alg === undefined || key.alg === "RS256"),
      );
    const key = candidates[0];
    if (
      candidates.length !== 1 ||
      !key ||
      !verify(
        "RSA-SHA256",
        Buffer.from(`${parts[0]}.${parts[1]}`),
        createPublicKey({ key: key as JsonWebKey, format: "jwk" }),
        Buffer.from(parts[2] ?? "", "base64url"),
      )
    )
      throw new ProviderLoginError("identity");
    const audience = claims.aud;
    if (
      claims.iss !== (deps.issuer ?? "https://auth.openai.com") ||
      !(audience === clientId || (Array.isArray(audience) && audience.includes(clientId))) ||
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
      ...(typeof claims.email === "string" ? { email: claims.email } : {}),
    };
  } catch {
    if (signal.aborted) signal.throwIfAborted();
    throw new ProviderLoginError("identity");
  }
}

export async function siwcRecord(
  data: unknown,
  clientId: string,
  signal: AbortSignal,
  nonce: string | undefined,
  deps: SiwcDependencies = {},
  previous?: OAuthCredentialRecord,
): Promise<OAuthCredentialRecord> {
  const value = object(data);
  const scopes =
    typeof value.scope === "string" ? value.scope.split(/\s+/).filter(Boolean) : previous?.scopes;
  if (!scopes?.includes("chatgpt.tokens.use.direct")) throw new ProviderLoginError("scope");
  if (
    typeof value.access_token !== "string" ||
    !value.access_token ||
    typeof value.refresh_token !== "string" ||
    !value.refresh_token ||
    typeof value.expires_in !== "number" ||
    !Number.isFinite(value.expires_in) ||
    value.expires_in <= 0 ||
    (value.token_type !== undefined &&
      (typeof value.token_type !== "string" || value.token_type.toLowerCase() !== "bearer"))
  )
    throw new ProviderLoginError("exchange");
  const idToken = typeof value.id_token === "string" ? value.id_token : previous?.idToken;
  if (!idToken) throw new ProviderLoginError("identity");
  const identity =
    value.id_token === undefined && previous !== undefined
      ? {
          subject: previous.subject,
          ...(previous.email !== undefined ? { email: previous.email } : {}),
        }
      : await verifySiwcIdentity(idToken, clientId, signal, nonce, deps);
  if (previous !== undefined && identity.subject !== previous.subject)
    throw new ProviderLoginError("identity");
  return {
    version: 1,
    clientId,
    ...identity,
    idToken,
    accessToken: value.access_token,
    refreshToken: value.refresh_token,
    expiresAt: Date.now() + value.expires_in * 1000,
    scopes,
  };
}

export async function oauthHostId(platform: Platform, home: string): Promise<string> {
  const path = platform.paths.join(home, "oauth-host.json");
  const load = async () => {
    if (!(await platform.fs.exists(path))) return undefined;
    const raw = object(JSON.parse(await platform.fs.readTextFile(path)));
    if (
      raw.version !== 1 ||
      typeof raw.hostId !== "string" ||
      !/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw.hostId)
    )
      throw new ProviderLoginError("storage");
    return raw.hostId;
  };
  try {
    const existing = await load();
    if (existing) return existing;
    await platform.fs.mkdir(platform.paths.join(home, "locks"), { mode: 0o700 });
    const lock = await acquireSessionLock(
      platform.fs,
      platform,
      platform.paths.join(home, "locks", "oauth-host.lock"),
    );
    try {
      const winner = await load();
      if (winner) return winner;
      const hostId = `urn:uuid:${randomUUID()}`;
      await writeJsonAtomic(platform.fs, platform.paths, path, { version: 1, hostId });
      return hostId;
    } finally {
      await lock.release();
    }
  } catch {
    throw new ProviderLoginError("storage");
  }
}

/** 端点注入仅供离线测试；公开入口不接受端点覆盖。 */
export async function createSiwcLogin(
  entry: ProviderEntryConfig,
  credentials: CredentialStore,
  platform: Platform,
  home: string,
  options: ProviderLoginOptions = {},
  deps: SiwcDependencies = {},
): Promise<LoginSession> {
  if (entry.auth?.kind !== "openai-siwc" || entry.baseURL !== SIWC_RESOURCE)
    throw new ProviderLoginError("unsupported");
  const hostId = await oauthHostId(platform, home);
  const previous = parseOAuthCredential(await credentials.get(entry.id));
  const secrets = createLoginSecrets();
  const lifecycle = createLoginLifecycle(deps.timeoutMs);
  let redirectUri = "";
  const authorize = new URL(
    deps.authorizeEndpoint ?? "https://auth.openai.com/api/accounts/authorize",
  );
  for (const [name, value] of Object.entries({
    response_type: "code",
    client_id: previous?.clientId ?? "dynamic_agent_client",
    agent_name_hint: "Nocturne",
    ext_agent_host_id: hostId,
    scope: SCOPE,
    resource: SIWC_RESOURCE,
    state: secrets.state,
    nonce: secrets.nonce,
    code_challenge: secrets.challenge,
    code_challenge_method: "S256",
    ...(previous?.email !== undefined ? { login_hint: previous.email } : {}),
    ...(previous !== undefined ? { id_token_hint: previous.idToken } : {}),
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
    const clientId = url.searchParams.get("client_id") ?? previous?.clientId;
    if (
      url.searchParams.getAll("code").length !== 1 ||
      !code ||
      code.length > 4096 ||
      /\s/.test(code) ||
      url.searchParams.getAll("client_id").length > 1 ||
      !clientId ||
      !/^oaiapp_[A-Za-z0-9_-]+$/.test(clientId) ||
      (previous !== undefined && clientId !== previous.clientId)
    )
      return false;
    void lifecycle
      .run(async (signal) => {
        let response;
        try {
          response = await (deps.fetchImpl ?? fetch)(
            deps.tokenEndpoint ?? "https://auth.openai.com/api/accounts/oauth/token",
            {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                grant_type: "authorization_code",
                code,
                client_id: clientId,
                code_verifier: secrets.verifier,
                redirect_uri: redirectUri,
                resource: SIWC_RESOURCE,
              }),
              signal,
              redirect: "error",
            },
          );
        } catch {
          throw new ProviderLoginError("network");
        }
        if (!response.ok) throw new ProviderLoginError("exchange");
        const record = await siwcRecord(
          await response.json(),
          clientId,
          signal,
          secrets.nonce,
          deps,
        );
        signal.throwIfAborted();
        try {
          if (credentials.backend() === "none") {
            const storage = options.accountStorage;
            if (!credentials.setAccount || (storage !== "plaintext" && storage !== "memory"))
              throw new ProviderLoginError("accountStorage");
            await credentials.setAccount(entry.id, JSON.stringify(record), storage);
          } else await credentials.set(entry.id, JSON.stringify(record));
        } catch (error) {
          throw error instanceof ProviderLoginError ? error : new ProviderLoginError("storage");
        }
        signal.throwIfAborted();
        return {
          providerId: entry.id,
          ...(record.email !== undefined ? { account: record.email } : {}),
        };
      })
      .catch(() => undefined);
    return true;
  }
  try {
    const loopback = await openLoginLoopback({
      state: secrets.state,
      path: "/auth/callback",
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
    lifecycle.fail(new ProviderLoginError("callback"));
    throw error instanceof ProviderLoginError ? error : new ProviderLoginError("callback");
  }
}
