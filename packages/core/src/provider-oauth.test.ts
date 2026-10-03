/**
 * ADR-0042 第 10 节：ChatGPT 登录、刷新与请求链路的离线测试。
 * 不连接真实授权服务，也不读取本机凭据文件。
 */
import {
  createHash,
  createSign,
  generateKeyPairSync,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCredentialStore } from "./config/credentials.js";
import { loadConfig, type CredentialStore, type ProviderEntryConfig } from "./config/index.js";
import { createRuntime } from "./index.js";
import { createPlatform, type Platform } from "./platform/index.js";
import { createSiwcLogin } from "./provider-login/openai-siwc.js";
import { resolveProviderAuth } from "./provider-oauth.js";
import { constrainedResponseError } from "./provider/errors.js";
import { createEntryProvider } from "./provider/entry.js";
import { fetchModels } from "./provider/presets.js";
import type { ModelRequest, ModelStreamEvent } from "./provider/types.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = publicKey.export({ format: "jwk" }) as JsonWebKey;
jwk.kid = "test-kid";
jwk.alg = "RS256";
jwk.use = "sig";

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function home(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "nocturne-siwc-"));
  dirs.push(dir);
  return dir;
}

function jwt(claims: Record<string, unknown>, key: KeyObject = privateKey): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-kid" })).toString(
    "base64url",
  );
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createSign("RSA-SHA256")
    .update(`${header}.${body}`)
    .sign(key)
    .toString("base64url");
  return `${header}.${body}.${signature}`;
}

function record(
  over: { accessToken?: string; refreshToken?: string; expiresAt?: number } = {},
): string {
  return JSON.stringify({
    version: 1,
    clientId: "oaiapp_test",
    subject: "user-1",
    email: "ada@example.test",
    idToken: "stored-id-token",
    accessToken: over.accessToken ?? "stored-access",
    refreshToken: over.refreshToken ?? "stored-refresh",
    expiresAt: over.expiresAt ?? Date.now() + 3_600_000,
    scopes: ["openid", "chatgpt.tokens.use.direct"],
  });
}

const entry: ProviderEntryConfig = {
  id: "chatgpt",
  type: "openai-compatible",
  baseURL: "https://api.openai.com/v1",
  auth: { kind: "openai-siwc" },
  models: { "gpt-test": { protocol: "openai-responses" } },
};

async function noneStore(): Promise<{
  credentials: CredentialStore;
  root: string;
  platform: Platform;
}> {
  const platform = createPlatform();
  const root = await home();
  const credentials = (await createCredentialStore(platform, root, { backend: "none" })).store;
  return { credentials, root, platform };
}

function listen(
  handler: (url: URL, body: string, respond: (status: number, payload: unknown) => void) => void,
) {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      handler(url, Buffer.concat(chunks).toString("utf8"), (status, payload) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
      });
    });
  });
  servers.push(server);
  return new Promise<string>((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("测试服务器未监听");
      resolvePromise(`http://127.0.0.1:${address.port}`);
    });
  });
}

function callbackOf(authorize: URL, clientId: string): string {
  const redirect = authorize.searchParams.get("redirect_uri") ?? "";
  return `${redirect}?state=${authorize.searchParams.get("state")}&code=auth-code&client_id=${clientId}`;
}

function sse(): Response {
  const event = {
    type: "response.completed",
    response: {
      id: "resp_1",
      status: "completed",
      output: [],
      usage: {
        input_tokens: 12,
        output_tokens: 5,
        total_tokens: 17,
        input_tokens_details: { cached_tokens: 3 },
        output_tokens_details: { reasoning_tokens: 2 },
      },
      incomplete_details: null,
    },
  };
  const payload = `data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`;

  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

const signal = new AbortController().signal;

describe("ChatGPT 登录", () => {
  it("校验 PKCE、拒绝错误 state，成功后才保存", async () => {
    const { credentials, root, platform } = await noneStore();
    let nonce = "";
    const exchanged: URLSearchParams[] = [];
    const base = await listen((url, body, respond) => {
      if (url.pathname === "/jwks") {
        respond(200, { keys: [jwk] });
        return;
      }
      const params = new URLSearchParams(body);
      exchanged.push(params);
      const clientId = params.get("client_id") ?? "";
      respond(200, {
        access_token: "issued-access",
        refresh_token: "issued-refresh",
        expires_in: 3600,
        token_type: "Bearer",
        scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
        id_token: jwt({
          iss: base,
          aud: clientId,
          exp: Math.floor(Date.now() / 1000) + 600,
          nonce,
          sub: "user-1",
          email: "ada@example.test",
        }),
      });
    });
    const session = await createSiwcLogin(
      entry,
      credentials,
      platform,
      root,
      {
        accountStorage: "memory",
      },
      {
        issuer: base,
        authorizeEndpoint: `${base}/authorize`,
        tokenEndpoint: `${base}/token`,
        jwksEndpoint: `${base}/jwks`,
      },
    );
    const authorize = new URL(session.authorizeUrl);
    nonce = authorize.searchParams.get("nonce") ?? "";
    expect(authorize.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(authorize.searchParams.get("agent_name_hint")).toBe("Nocturne");
    expect(authorize.searchParams.get("ext_agent_host_id")).toMatch(/^urn:uuid:/);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("resource")).toBe("https://api.openai.com/v1");
    expect(authorize.searchParams.get("scope")).toContain("chatgpt.tokens.use.direct");
    const redirect = new URL(authorize.searchParams.get("redirect_uri") ?? "");
    let settled = false;
    void session.completion.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const mismatched = await fetch(
      `${redirect.origin}${redirect.pathname}?state=wrong&code=auth-code&client_id=oaiapp_issued`,
    );
    expect(mismatched.status).toBe(400);
    await Promise.resolve();
    expect(settled).toBe(false);
    const matched = await fetch(callbackOf(authorize, "oaiapp_issued"));
    expect(matched.status).toBe(200);
    await expect(session.completion).resolves.toEqual({
      providerId: "chatgpt",
      account: "ada@example.test",
    });
    const sent = exchanged[0];
    expect(sent?.get("grant_type")).toBe("authorization_code");
    expect(sent?.get("client_secret")).toBeNull();
    expect(
      createHash("sha256")
        .update(sent?.get("code_verifier") ?? "")
        .digest("base64url"),
    ).toBe(authorize.searchParams.get("code_challenge"));
    expect(credentials.storage?.("chatgpt")).toBe("memory");
    const saved = await credentials.get("chatgpt");
    expect(saved).toContain("oaiapp_issued");
    expect(saved).not.toContain("auth-code");
    const hostFile = await platform.fs.readTextFile(platform.paths.join(root, "oauth-host.json"));
    expect(hostFile).not.toContain("issued-");
  });

  it("缺少 scope、nonce 不符、超时和取消都失败且不保存", async () => {
    const { credentials, root, platform } = await noneStore();
    const base = await listen((_url, _body, respond) => {
      respond(200, {
        access_token: "should-not-store",
        refresh_token: "should-not-store",
        expires_in: 60,
        scope: "openid",
      });
    });
    const missingScope = await createSiwcLogin(
      entry,
      credentials,
      platform,
      root,
      {},
      {
        issuer: base,
        tokenEndpoint: `${base}/token`,
        jwksEndpoint: `${base}/jwks`,
        timeoutMs: 5_000,
      },
    );
    await fetch(callbackOf(new URL(missingScope.authorizeUrl), "oaiapp_issued"));
    await expect(missingScope.completion).rejects.toMatchObject({ code: "scope" });
    expect(await credentials.get("chatgpt")).toBeUndefined();

    const wrongNonce = await listen((url, _body, respond) => {
      if (url.pathname.endsWith("/jwks")) {
        respond(200, { keys: [jwk] });
        return;
      }
      respond(200, {
        access_token: "should-not-store",
        refresh_token: "should-not-store",
        expires_in: 60,
        scope: "chatgpt.tokens.use.direct",
        id_token: jwt({
          iss: wrongNonce,
          aud: "oaiapp_issued",
          exp: Math.floor(Date.now() / 1000) + 60,
          nonce: "wrong-nonce",
          sub: "user-1",
        }),
      });
    });
    const mismatched = await createSiwcLogin(
      entry,
      credentials,
      platform,
      root,
      {},
      {
        issuer: wrongNonce,
        tokenEndpoint: `${wrongNonce}/token`,
        jwksEndpoint: `${wrongNonce}/jwks`,
        timeoutMs: 5_000,
      },
    );
    await fetch(callbackOf(new URL(mismatched.authorizeUrl), "oaiapp_issued"));
    const identity = await mismatched.completion.catch((value: unknown) => value);
    expect(identity).toMatchObject({ code: "identity" });
    expect(String(identity)).not.toContain("should-not-store");

    const cancelled = await createSiwcLogin(
      entry,
      credentials,
      platform,
      root,
      {},
      { timeoutMs: 5_000 },
    );
    cancelled.cancel();
    await expect(cancelled.completion).rejects.toMatchObject({ code: "cancelled" });
    const timed = await createSiwcLogin(entry, credentials, platform, root, {}, { timeoutMs: 15 });
    await expect(timed.completion).rejects.toMatchObject({ code: "timeout" });
  });

  it("无系统后端时必须显式给出保存位置，缺省不落盘", async () => {
    const { credentials, root, platform } = await noneStore();
    let nonce = "";
    const base = await listen((url, _body, respond) => {
      if (url.pathname.endsWith("/jwks")) {
        respond(200, { keys: [jwk] });
        return;
      }
      respond(200, {
        access_token: "should-not-store",
        refresh_token: "should-not-store",
        expires_in: 60,
        scope: "chatgpt.tokens.use.direct",
        id_token: jwt({
          iss: base,
          aud: "oaiapp_issued",
          exp: Math.floor(Date.now() / 1000) + 60,
          nonce,
          sub: "user-1",
        }),
      });
    });
    const deps = {
      issuer: base,
      tokenEndpoint: `${base}/token`,
      jwksEndpoint: `${base}/jwks`,
      timeoutMs: 5_000,
    };
    const missing = await createSiwcLogin(entry, credentials, platform, root, {}, deps);
    nonce = new URL(missing.authorizeUrl).searchParams.get("nonce") ?? "";
    await fetch(callbackOf(new URL(missing.authorizeUrl), "oaiapp_issued"));
    await expect(missing.completion).rejects.toMatchObject({ code: "accountStorage" });
    expect(await credentials.get("chatgpt")).toBeUndefined();
  });
});

describe("ChatGPT 刷新与请求链路", () => {
  it("轮换先写入再使用；写入失败不使用新令牌，也不删除旧记录", async () => {
    const platform = createPlatform();
    const nocturneHome = await home();
    const credentials = (await createCredentialStore(platform, nocturneHome, { backend: "none" }))
      .store;
    await credentials.setAccount?.(
      "chatgpt",
      record({ expiresAt: Date.now() - 1_000 }),
      "plaintext",
    );
    const failing = {
      ...credentials,
      setAccount: vi.fn(async () => {
        throw new Error("issued-access");
      }),
    };
    const resolver = resolveProviderAuth({ credentials: failing, nocturneHome }, entry, platform, {
      tokenEndpoint: "https://auth.test/token",
      fetchImpl: async () =>
        Response.json({
          access_token: "issued-access",
          refresh_token: "issued-refresh",
          expires_in: 3600,
          scope: "chatgpt.tokens.use.direct",
        }),
    });
    const error = await resolver.token(signal).catch((value: unknown) => value);
    expect(error).toMatchObject({ kind: "auth", retryable: false });
    expect(String(error)).not.toContain("issued-access");
    expect(await credentials.get("chatgpt")).toContain("stored-access");
    expect(failing.setAccount).toHaveBeenCalled();
  });

  it("跨进程锁挡住刷新；内存凭据不取锁", async () => {
    const platform = createPlatform();
    const nocturneHome = await home();
    const credentials = (await createCredentialStore(platform, nocturneHome, { backend: "none" }))
      .store;
    await credentials.setAccount?.(
      "chatgpt",
      record({ expiresAt: Date.now() - 1_000 }),
      "plaintext",
    );
    const lockPath = platform.paths.join(nocturneHome, "locks", "oauth-chatgpt.lock");
    await platform.fs.mkdir(platform.paths.dirname(lockPath), { mode: 0o700 });
    await platform.fs.writeFile(
      lockPath,
      JSON.stringify({
        pid: platform.pid(),
        hostname: platform.hostname(),
        startedAt: Date.now(),
      }),
    );
    let calls = 0;
    const resolver = resolveProviderAuth({ credentials, nocturneHome }, entry, platform, {
      tokenEndpoint: "https://auth.test/token",
      fetchImpl: async () => {
        calls += 1;
        return Response.json({
          access_token: "rotated-access",
          refresh_token: "rotated-refresh",
          expires_in: 3600,
          scope: "chatgpt.tokens.use.direct",
        });
      },
    });
    const pending = resolver.token(signal);
    // 刷新撞锁后按真实 50ms 退避重试；node:timers/promises 不受假时钟控制。
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 80);
    });
    expect(calls).toBe(0);
    await platform.fs.unlink(lockPath);
    expect(await pending).toBe("rotated-access");
    expect(await credentials.get("chatgpt")).toContain("rotated-refresh");

    const memory = (await createCredentialStore(platform, nocturneHome, { backend: "none" })).store;
    await memory.setAccount?.("chatgpt", record({ expiresAt: Date.now() - 1_000 }), "memory");
    await platform.fs.writeFile(
      lockPath,
      JSON.stringify({
        pid: platform.pid(),
        hostname: platform.hostname(),
        startedAt: Date.now(),
      }),
    );
    let markFetched: () => void = () => undefined;
    const fetched = new Promise<void>((resolve) => {
      markFetched = () => resolve();
    });
    const memoryResolver = resolveProviderAuth(
      { credentials: memory, nocturneHome },
      entry,
      platform,
      {
        tokenEndpoint: "https://auth.test/token",
        fetchImpl: async () => {
          markFetched();
          return Response.json({
            access_token: "memory-access",
            refresh_token: "memory-refresh",
            expires_in: 3600,
            scope: "chatgpt.tokens.use.direct",
          });
        },
      },
    );
    const memoryToken = memoryResolver.token(signal);
    await fetched;
    expect(await memoryToken).toBe("memory-access");
  });

  it("refresh token 不可再用时删除记录；5xx 保留记录", async () => {
    const platform = createPlatform();
    const nocturneHome = await home();
    const credentials = (await createCredentialStore(platform, nocturneHome, { backend: "none" }))
      .store;
    await credentials.setAccount?.(
      "chatgpt",
      record({ expiresAt: Date.now() - 1_000 }),
      "plaintext",
    );
    const reused = resolveProviderAuth({ credentials, nocturneHome }, entry, platform, {
      tokenEndpoint: "https://auth.test/token",
      fetchImpl: async () => Response.json({ error: "refresh_token_reused" }, { status: 400 }),
    });
    const error = await reused.token(signal).catch((value: unknown) => value);
    expect(error).toMatchObject({
      retryable: false,
      message: "ChatGPT 登录已失效，请执行 /provider login chatgpt",
    });
    expect(String(error)).not.toContain("stored-refresh");
    expect(await credentials.get("chatgpt")).toBeUndefined();

    const kept = (await createCredentialStore(platform, nocturneHome, { backend: "none" })).store;
    await kept.setAccount?.("chatgpt", record({ expiresAt: Date.now() - 1_000 }), "plaintext");
    const down = resolveProviderAuth({ credentials: kept, nocturneHome }, entry, platform, {
      tokenEndpoint: "https://auth.test/token",
      fetchImpl: async () => Response.json({ error: "temporarily_unavailable" }, { status: 503 }),
    });
    await expect(down.token(signal)).rejects.toMatchObject({
      kind: "server",
      retryable: true,
      message: "账号刷新服务暂不可用，请稍后重试",
    });
    expect(await kept.get("chatgpt")).toContain("stored-access");
  });

  it("401 失效后强制刷新并只重发一次，请求体受声明约束", async () => {
    const platform = createPlatform();
    const nocturneHome = await home();
    const credentials = (await createCredentialStore(platform, nocturneHome, { backend: "memory" }))
      .store;
    await credentials.set?.("chatgpt", record());
    const seen: { authorization?: string | null; body?: Record<string, unknown> }[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/token")) {
        return Response.json({
          access_token: "refreshed-access",
          refresh_token: "refreshed-refresh",
          expires_in: 3600,
          scope: "chatgpt.tokens.use.direct",
        });
      }
      const headers = new Headers(init?.headers);
      seen.push({
        authorization: headers.get("authorization"),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return seen.length === 1 ? new Response("secret-body", { status: 401 }) : sse();
    });
    const provider = createEntryProvider(
      {
        id: "chatgpt",
        type: "openai-compatible",
        baseURL: "https://api.openai.com/v1",
        auth: { kind: "openai-siwc" },
        models: { "gpt-test": {} },
        authResolver: resolveProviderAuth({ credentials, nocturneHome }, entry, platform, {
          fetchImpl,
          tokenEndpoint: "https://auth.test/token",
        }),
      },
      () => "must-not-read",
      fetchImpl,
    );
    const request: ModelRequest = {
      model: "gpt-test",
      system: [{ text: "sys" }],
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [{ name: "echo", description: "回显", inputSchema: { type: "object" } }],
      maxOutputTokens: 1024,
    };
    const events: ModelStreamEvent[] = [];
    for await (const event of provider.stream(request, signal)) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: "finish" });
    expect(seen.map((call) => call.authorization)).toEqual([
      "Bearer stored-access",
      "Bearer refreshed-access",
    ]);
    expect(seen[1]?.body).toMatchObject({ store: false, stream: true });
    expect(Array.isArray(seen[1]?.body?.input)).toBe(true);
    expect(seen[1]?.body).not.toHaveProperty("max_output_tokens");
    expect(seen[1]?.body).not.toHaveProperty("previous_response_id");
    expect(JSON.stringify(events)).not.toContain("secret-body");
    expect(JSON.stringify(events)).not.toContain("refreshed-access");
  });

  it("运行时注册表、模型列表和 API key 回归都走同一解析语义", async () => {
    const platform = createPlatform();
    const nocturneHome = await home();
    const workspace = path.join(nocturneHome, "ws");
    await platform.fs.mkdir(workspace);
    await platform.fs.writeFile(
      platform.paths.join(nocturneHome, "providers.json"),
      JSON.stringify({
        version: 1,
        providers: [entry],
      }),
    );
    const credentials = (await createCredentialStore(platform, nocturneHome, { backend: "memory" }))
      .store;
    await credentials.set?.("chatgpt", record());
    const config = await loadConfig(platform, { nocturneHome, credentials, env: () => undefined });
    const runtime = await createRuntime({
      cwd: workspace,
      sessionsDir: path.join(nocturneHome, "sessions"),
      config,
    });
    expect(runtime.listModels().find((model) => model.ref.model === "gpt-test")?.protocol).toBe(
      "openai-responses",
    );
    const session = await runtime.createSession({ model: "chatgpt/gpt-test" });
    await session.close();

    const api = resolveProviderAuth(
      config,
      { id: "api", credentials: async () => "stored-api-key" },
      platform,
      { fetchImpl: vi.fn() },
    );
    expect(api.requestConstraints).toBeUndefined();
    expect(api.protocol).toBeUndefined();
    expect(await api.token(signal)).toBe("stored-api-key");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          models: [
            { visibility: "list", slug: "gpt-test", display_name: "GPT Test" },
            { visibility: "hidden", slug: "hidden" },
          ],
        }),
      ),
    );
    await expect(
      fetchModels(
        {
          id: "chatgpt",
          type: "openai-compatible",
          baseURL: "https://api.openai.com/v1",
          auth: { kind: "openai-siwc" },
        },
        resolveProviderAuth(config, entry),
      ),
    ).resolves.toEqual([{ id: "gpt-test", displayName: "GPT Test" }]);
    const overview = await config.describeProviders();
    expect(overview.find((item) => item.id === "chatgpt")).toMatchObject({
      credentialStorage: "memory",
      auth: "ChatGPT 账号 ada@example.test",
    });
    expect(JSON.stringify(overview)).not.toContain("stored-access");
  });

  it("额度用完不可重试，安全的上游说明可以附上", () => {
    const exhausted = constrainedResponseError(429, {
      detail: "subscription_sharing_usage_limit_exceeded",
    });
    expect(exhausted).toMatchObject({ kind: "rate_limit", retryable: false });
    const explained = constrainedResponseError(400, {
      error: {
        code: "subscription_sharing_unsupported_capability",
        message: "image input is not enabled",
      },
    });
    expect(explained.message).toContain("image input is not enabled");
    const leaked = constrainedResponseError(400, {
      error: { code: "subscription_sharing_unsupported_capability", message: "secret-access" },
    });
    expect(leaked.message).not.toContain("secret-access");
  });

  it("未映射的 4xx 附带脱敏后的上游说明与参数名，5xx 不附", () => {
    const rejected = constrainedResponseError(400, {
      error: { message: "Unsupported parameter: reasoning.summary", param: "reasoning.summary" },
    });
    expect(rejected).toMatchObject({ kind: "invalid_request" });
    expect(rejected.message).toContain("Unsupported parameter: reasoning.summary");
    expect(rejected.message).toContain("参数 reasoning.summary");
    expect(constrainedResponseError(400, { detail: "Bearer abc" }).message).not.toContain("abc");
    expect(constrainedResponseError(500, { error: { message: "boom" } }).message).not.toContain(
      "boom",
    );
  });
});
