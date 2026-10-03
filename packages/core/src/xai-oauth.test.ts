/**
 * ADR-0043：Grok Build 登录、设备码与刷新的离线测试。
 * 不连接真实授权服务，也不读取本机凭据文件。
 */
import { createSign, generateKeyPairSync, type JsonWebKey, type KeyObject } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mergeLayers } from "./config/merge.js";
import type { CredentialStore, ProviderEntryConfig } from "./config/index.js";
import { createPlatform } from "./platform/index.js";
import { ProviderLoginError } from "./provider-login/errors.js";
import {
  XAI_OAUTH_CLIENT_ID,
  XAI_OAUTH_PROXY,
  createXaiLogin,
  createXaiAuthResolver,
} from "./provider-login/xai-oauth.js";
import { parseXaiOAuthCredential } from "./protocol/index.js";
import { NOCTURNE_VERSION } from "./protocol/version.js";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const jwk = publicKey.export({ format: "jwk" }) as JsonWebKey;
jwk.kid = "test-kid";
jwk.alg = "ES256";
jwk.use = "sig";
const issuer = "https://auth.test";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function jwt(claims: Record<string, unknown>, key: KeyObject = privateKey): string {
  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: "test-kid" })).toString(
    "base64url",
  );
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createSign("SHA256")
    .update(`${header}.${body}`)
    .sign({ key, dsaEncoding: "ieee-p1363" })
    .toString("base64url");
  return `${header}.${body}.${signature}`;
}

function identity(nonce?: string) {
  return jwt({
    iss: issuer,
    aud: XAI_OAUTH_CLIENT_ID,
    sub: "user-1",
    email: "ada@example.test",
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...(nonce !== undefined ? { nonce } : {}),
  });
}

function tokenBody(nonce?: string, scope = "openid offline_access grok-cli:access") {
  return {
    access_token: "access-1",
    refresh_token: "refresh-1",
    expires_in: 900,
    token_type: "Bearer",
    scope,
    id_token: identity(nonce),
  };
}

const entry: ProviderEntryConfig = {
  id: "grok",
  type: "openai-compatible",
  baseURL: XAI_OAUTH_PROXY,
  auth: { kind: "xai-oauth2" },
};

function memoryStore(initial?: string): CredentialStore & { raw(): string | undefined } {
  let value = initial;
  return {
    backend: () => "memory",
    get: async () => value,
    set: async (_id, key) => {
      value = key;
    },
    delete: async () => {
      value = undefined;
    },
    has: () => value !== undefined,
    storage: () => (value === undefined ? undefined : "memory"),
    raw: () => value,
  };
}

describe("Grok Build OAuth", () => {
  it("本机登录用公开客户端换票，并校验身份", async () => {
    const credentials = memoryStore();
    const calls: { url: string; body: string; agent: string | null }[] = [];
    const nonceHolder: { value?: string } = {};
    const session = await createXaiLogin(
      entry,
      credentials,
      createPlatform(),
      "unused",
      {},
      {
        issuer,
        authorizeEndpoint: `${issuer}/oauth2/authorize`,
        tokenEndpoint: `${issuer}/oauth2/token`,
        jwksEndpoint: `${issuer}/.well-known/jwks.json`,
        timeoutMs: 5_000,
        fetchImpl: async (input, init) => {
          const url = String(input);
          const headers = new Headers(init?.headers);
          calls.push({
            url,
            body: String(init?.body ?? ""),
            agent: headers.get("user-agent"),
          });
          if (url.endsWith("/jwks.json")) return Response.json({ keys: [jwk] });
          return Response.json(tokenBody(nonceHolder.value));
        },
      },
    );
    const nonce = new URL(session.authorizeUrl).searchParams.get("nonce");
    if (nonce !== null) nonceHolder.value = nonce;
    const authorize = new URL(session.authorizeUrl);
    expect(authorize.origin).toBe(issuer);
    expect(authorize.searchParams.get("client_id")).toBe(XAI_OAUTH_CLIENT_ID);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("referrer")).toBe("nocturne");
    expect(authorize.searchParams.get("scope")).toContain("grok-cli:access");
    expect(session.manualInput).toBe("callback-url");
    const callback = new URL(authorize.searchParams.get("redirect_uri") ?? "");
    callback.searchParams.set("code", "auth-code");
    callback.searchParams.set("state", authorize.searchParams.get("state") ?? "");
    await fetch(callback);
    await expect(session.completion).resolves.toEqual({
      providerId: "grok",
      account: "ada@example.test",
    });
    const stored = parseXaiOAuthCredential(credentials.raw());
    expect(stored).toMatchObject({
      kind: "xai-oauth2",
      clientId: XAI_OAUTH_CLIENT_ID,
      subject: "user-1",
      accessToken: "access-1",
      refreshToken: "refresh-1",
    });
    expect(JSON.stringify(stored)).not.toContain("id_token");
    const exchange = calls.find((call) => call.url.endsWith("/oauth2/token"));
    expect(exchange?.body).toContain("grant_type=authorization_code");
    expect(exchange?.body).toContain(`client_id=${XAI_OAUTH_CLIENT_ID}`);
    expect(exchange?.agent).toBe(`nocturne/${NOCTURNE_VERSION}`);
    expect(exchange?.body).not.toContain("access-1");
  });

  it("缺少推理 scope 不保存凭据", async () => {
    const credentials = memoryStore();
    const session = await createXaiLogin(
      entry,
      credentials,
      createPlatform(),
      "unused",
      {},
      {
        issuer,
        tokenEndpoint: `${issuer}/oauth2/token`,
        jwksEndpoint: `${issuer}/.well-known/jwks.json`,
        timeoutMs: 5_000,
        fetchImpl: async (input) => {
          if (String(input).endsWith("/jwks.json")) return Response.json({ keys: [jwk] });
          return Response.json(tokenBody(undefined, "openid email"));
        },
      },
    );
    const authorize = new URL(session.authorizeUrl);
    const callback = new URL(authorize.searchParams.get("redirect_uri") ?? "");
    callback.searchParams.set("code", "auth-code");
    callback.searchParams.set("state", authorize.searchParams.get("state") ?? "");
    await fetch(callback);
    await expect(session.completion).rejects.toMatchObject({ code: "scope" });
    expect(credentials.raw()).toBeUndefined();
  });

  it("远程登录走设备码，不要求粘贴", async () => {
    const credentials = memoryStore();
    let polls = 0;
    const session = await createXaiLogin(
      entry,
      credentials,
      createPlatform(),
      "unused",
      { remote: true },
      {
        issuer,
        deviceEndpoint: `${issuer}/oauth2/device/code`,
        tokenEndpoint: `${issuer}/oauth2/token`,
        jwksEndpoint: `${issuer}/.well-known/jwks.json`,
        pollIntervalMs: 0,
        timeoutMs: 5_000,
        fetchImpl: async (input, init) => {
          const url = String(input);
          if (url.endsWith("/device/code")) {
            expect(String(init?.body)).toContain("referrer=nocturne");
            expect(new Headers(init?.headers).get("user-agent")).toBe(
              `nocturne/${NOCTURNE_VERSION}`,
            );
            return Response.json({
              device_code: "device-secret",
              user_code: "ABCD-EFGH",
              verification_uri: "https://auth.test/device",
              verification_uri_complete: "https://auth.test/device?user_code=ABCD-EFGH",
              expires_in: 600,
              interval: 5,
            });
          }
          if (url.endsWith("/jwks.json")) return Response.json({ keys: [jwk] });
          polls += 1;
          if (polls === 1)
            return Response.json({ error: "authorization_pending" }, { status: 400 });
          return Response.json(tokenBody());
        },
      },
    );
    expect(session.manualInput).toBe("none");
    expect(session.userCode).toBe("ABCD-EFGH");
    expect(session.authorizeUrl).toBe("https://auth.test/device?user_code=ABCD-EFGH");
    await expect(session.submitManual("nope")).rejects.toMatchObject({ code: "input" });
    await expect(session.completion).resolves.toMatchObject({ account: "ada@example.test" });
    expect(credentials.raw()).toContain("access-1");
  });

  it("错误地址与错误客户端记录不能登录或刷新", async () => {
    await expect(
      createXaiLogin(
        { ...entry, baseURL: "https://evil.test/v1" },
        memoryStore(),
        createPlatform(),
        "unused",
      ),
    ).rejects.toBeInstanceOf(ProviderLoginError);
    const home = await mkdtemp(path.join(tmpdir(), "nocturne-xai-"));
    dirs.push(home);
    const credentials = memoryStore(
      JSON.stringify({
        version: 1,
        kind: "xai-oauth2",
        clientId: "other-client",
        subject: "user-1",
        accessToken: "stale",
        refreshToken: "stale-refresh",
        expiresAt: Date.now() + 3_600_000,
        scopes: ["grok-cli:access"],
      }),
    );
    await expect(
      createXaiAuthResolver(entry, credentials, createPlatform(), home).token(
        new AbortController().signal,
      ),
    ).rejects.toThrow(/\/provider login grok/);
  });

  it("过期后刷新并轮换，不可再用的 refresh token 会删除记录", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "nocturne-xai-refresh-"));
    dirs.push(home);
    const credentials = memoryStore(
      JSON.stringify({
        version: 1,
        kind: "xai-oauth2",
        clientId: XAI_OAUTH_CLIENT_ID,
        subject: "user-1",
        email: "ada@example.test",
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: Date.now() - 1_000,
        scopes: ["openid", "grok-cli:access"],
      }),
    );
    let mode: "ok" | "dead" = "ok";
    const resolver = createXaiAuthResolver(entry, credentials, createPlatform(), home, {
      issuer,
      tokenEndpoint: `${issuer}/oauth2/token`,
      jwksEndpoint: `${issuer}/.well-known/jwks.json`,
      fetchImpl: async (input, init) => {
        if (String(input).endsWith("/jwks.json")) return Response.json({ keys: [jwk] });
        expect(String(init?.body)).toContain("grant_type=refresh_token");
        expect(String(init?.body)).toContain("refresh_token=old-refresh");
        if (mode === "dead") return Response.json({ error: "invalid_grant" }, { status: 400 });
        return Response.json({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 900,
          scope: "openid grok-cli:access",
          id_token: identity(),
        });
      },
    });
    await expect(resolver.token(new AbortController().signal)).resolves.toBe("new-access");
    expect(parseXaiOAuthCredential(credentials.raw())?.refreshToken).toBe("new-refresh");
    const expired = parseXaiOAuthCredential(credentials.raw());
    await credentials.set(
      "grok",
      JSON.stringify({ ...expired, expiresAt: Date.now() - 1_000, refreshToken: "old-refresh" }),
    );
    mode = "dead";
    resolver.invalidate();
    await expect(resolver.token(new AbortController().signal)).rejects.toThrow(
      /\/provider login grok/,
    );
    expect(credentials.raw()).toBeUndefined();
  });

  it("xai-oauth2 拒绝改写代理地址", () => {
    expect(() =>
      mergeLayers([
        {
          kind: "user",
          file: {
            providers: [{ id: "grok", auth: { kind: "xai-oauth2" }, baseURL: "https://evil.test" }],
          },
        },
      ]),
    ).toThrow(expect.objectContaining({ code: "config_invalid" }));
  });
});
