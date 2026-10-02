import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CredentialStore, ProviderEntryConfig, RuntimeConfig } from "./config/index.js";
import { logoutProvider, ProviderLoginError, startProviderLogin } from "./provider-login.js";
import { createOpenRouterLogin } from "./provider-login/openrouter.js";
import { createLoginLifecycle, createLoginSecrets } from "./provider-login/session.js";
import type { LoginSession } from "./protocol/index.js";

const entry: ProviderEntryConfig = {
  id: "my-router",
  type: "openai-compatible",
  baseURL: "https://openrouter.ai/api/v1",
  apiKeyEnv: "MY_ROUTER_KEY",
};
const fakeKey = "synthetic-openrouter-key";
const fakeCode = "synthetic-authorization-code";
let server: Server;
let origin: string;
let sessions: LoginSession[];
let requests: { code: string; code_verifier: string; code_challenge_method: string }[];
let status: number;
let responseBody: string;
let delayResponse: boolean;
let releaseResponse: (() => void) | undefined;
let redirects: string | undefined;

function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error("required test value missing");
  return value;
}

function store(backend: ReturnType<CredentialStore["backend"]> = "dpapi"): CredentialStore {
  return {
    backend: () => backend,
    get: vi.fn(async () => undefined),
    has: vi.fn(() => false),
    set: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
}

function config(credentials: CredentialStore, providers = [entry]): RuntimeConfig {
  return { base: { providers }, credentials } as RuntimeConfig;
}

async function login(
  credentials = store(),
  options: Parameters<typeof createOpenRouterLogin>[2] = {},
  timeoutMs = 10_000,
) {
  const session = await createOpenRouterLogin(entry, credentials, options, {
    authorizeEndpoint: `${origin}/auth`,
    tokenEndpoint: `${origin}/api/v1/auth/keys`,
    timeoutMs,
  });
  sessions.push(session);
  return session;
}

function callback(session: LoginSession, host = "127.0.0.1", state?: string) {
  const authorize = new URL(session.authorizeUrl);
  const url = new URL(required(authorize.searchParams.get("callback_url")));
  url.hostname = host;
  url.searchParams.set("state", state ?? required(authorize.searchParams.get("state")));
  url.searchParams.set("code", fakeCode);
  return url;
}

async function waitForExchange() {
  await vi.waitFor(() => expect(requests).toHaveLength(1));
}

beforeEach(async () => {
  sessions = [];
  requests = [];
  status = 200;
  responseBody = JSON.stringify({ key: fakeKey });
  delayResponse = false;
  releaseResponse = undefined;
  redirects = undefined;
  server = createServer((request, response) => {
    const url = new URL(required(request.url), "http://localhost");
    if (url.pathname === "/auth") {
      const target = new URL(required(url.searchParams.get("callback_url")));
      target.searchParams.set("state", required(url.searchParams.get("state")));
      target.searchParams.set("code", fakeCode);
      response.writeHead(302, { Location: target.href });
      response.end();
      return;
    }
    if (url.pathname !== "/api/v1/auth/keys") {
      response.writeHead(404);
      response.end();
      return;
    }
    expect(request.method).toBe("POST");
    expect(request.headers["content-type"]).toBe("application/json");
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push(JSON.parse(body));
      const respond = () => {
        if (response.headersSent || response.destroyed) return;
        response.writeHead(status, {
          "Content-Type": "application/json",
          ...(redirects ? { Location: redirects } : {}),
        });
        response.end(responseBody);
      };
      if (delayResponse) releaseResponse = respond;
      else respond();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not listen");
  origin = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  for (const session of sessions) session.cancel();
  releaseResponse?.();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.restoreAllMocks();
});

describe("OpenRouter 登录：本地假授权服务器", () => {
  it("完整授权重定向、PKCE S256 与 POST keys 保存系统后端，结果不含 key", async () => {
    const credentials = store();
    const session = await login(credentials);
    const authorize = new URL(session.authorizeUrl);
    expect(session.manualInput).toBe("code");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("callback_url")).toMatch(
      /^http:\/\/localhost:\d+\/callback$/,
    );
    expect(authorize.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const page = await fetch(session.authorizeUrl);
    expect(await page.text()).toContain("可以关闭此页面");
    const result = await session.completion;
    expect(result).toEqual({ providerId: entry.id });
    expect(JSON.stringify(result)).not.toContain(fakeKey);
    expect(credentials.set).toHaveBeenCalledExactlyOnceWith(entry.id, fakeKey);
    expect(requests[0]).toEqual({
      code: fakeCode,
      code_verifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      code_challenge_method: "S256",
    });
    const challenge = createHash("sha256")
      .update(required(requests[0]).code_verifier)
      .digest("base64url");
    expect(challenge).toBe(authorize.searchParams.get("code_challenge"));
    expect(credentials.get).not.toHaveBeenCalled();
  });

  it.each(["127.0.0.1", "[::1]"])("同时监听同端口 %s，错误 state 不消费会话", async (host) => {
    const credentials = store();
    const session = await login(credentials);
    const wrong = await fetch(callback(session, host, "incorrect-state"));
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).not.toContain(fakeCode);
    expect(requests).toHaveLength(0);
    const correct = await fetch(callback(session, host));
    expect(correct.status).toBe(200);
    expect(correct.headers.get("cache-control")).toBe("no-store");
    await session.completion;
    expect(credentials.set).toHaveBeenCalledTimes(1);
  });

  it.each(["wrong-path", "missing-code", "duplicate-state", "duplicate-code", "post"])(
    "无效回调 %s 不消费会话",
    async (kind) => {
      const session = await login();
      const url = callback(session);
      if (kind === "wrong-path") url.pathname = "/wrong";
      if (kind === "missing-code") url.searchParams.delete("code");
      if (kind === "duplicate-state") url.searchParams.append("state", "other");
      if (kind === "duplicate-code") url.searchParams.append("code", "other");
      expect((await fetch(url, { method: kind === "post" ? "POST" : "GET" })).status).toBe(400);
      expect(requests).toHaveLength(0);
      expect((await fetch(callback(session))).status).toBe(200);
      await session.completion;
    },
  );

  it("正确回调立即释放双回环监听，授权交换只执行一次", async () => {
    delayResponse = true;
    const credentials = store();
    const session = await login(credentials);
    expect((await fetch(callback(session))).status).toBe(200);
    await waitForExchange();
    await expect(fetch(callback(session))).rejects.toThrow();
    await expect(fetch(callback(session, "[::1]"))).rejects.toThrow();
    const manual = session.submitManual("another-code");
    required(releaseResponse)();
    await manual;
    await session.completion;
    expect(requests).toHaveLength(1);
    expect(credentials.set).toHaveBeenCalledTimes(1);
  });

  it("remote 不传 callback_url；手动授权码换钥且重复提交只执行一次", async () => {
    const credentials = store();
    const session = await login(credentials, { remote: true });
    expect(new URL(session.authorizeUrl).searchParams.has("callback_url")).toBe(false);
    await Promise.all([session.submitManual(`  ${fakeCode}  `), session.submitManual("second")]);
    expect(requests).toHaveLength(1);
    expect(required(requests[0]).code).toBe(fakeCode);
    expect(credentials.set).toHaveBeenCalledExactlyOnceWith(entry.id, fakeKey);
  });

  it("无效手动输入不消耗会话", async () => {
    const session = await login(store(), { remote: true });
    await expect(session.submitManual(" \n ")).rejects.toMatchObject({ code: "input" });
    await expect(session.submitManual("two codes")).rejects.toMatchObject({ code: "input" });
    expect(requests).toHaveLength(0);
    await session.submitManual(fakeCode);
  });

  it("none 后端只展示一次 key 与环境变量名，绝不存储或返回 key", async () => {
    const credentials = store("none");
    const onUnstoredKey = vi.fn(async () => undefined);
    const session = await login(credentials, { remote: true, onUnstoredKey });
    await Promise.all([session.submitManual(fakeCode), session.submitManual(fakeCode)]);
    expect(onUnstoredKey).toHaveBeenCalledExactlyOnceWith(fakeKey, "MY_ROUTER_KEY");
    expect(credentials.set).not.toHaveBeenCalled();
    expect(await session.completion).toEqual({ providerId: entry.id });
  });

  it("none 后端缺少展示通道在开始前报错", async () => {
    await expect(login(store("none"))).rejects.toMatchObject({ code: "unstored" });
    expect(requests).toHaveLength(0);
  });

  it("取消立即释放双监听，禁止随后交换", async () => {
    const credentials = store();
    const session = await login(credentials);
    const url = callback(session);
    session.cancel();
    session.cancel();
    await expect(session.completion).rejects.toMatchObject({ code: "cancelled" });
    await expect(fetch(url)).rejects.toThrow();
    await expect(fetch(callback(session, "[::1]"))).rejects.toThrow();
    await expect(session.submitManual(fakeCode)).rejects.toMatchObject({ code: "cancelled" });
    expect(credentials.set).not.toHaveBeenCalled();
  });

  it("超时释放双监听", async () => {
    const session = await login(store(), {}, 100);
    const url = callback(session);
    await expect(session.completion).rejects.toMatchObject({ code: "timeout" });
    await expect(fetch(url)).rejects.toThrow();
    await expect(fetch(callback(session, "[::1]"))).rejects.toThrow();
  });

  it("取消进行中的授权交换不保存 key", async () => {
    delayResponse = true;
    const credentials = store();
    const session = await login(credentials, { remote: true });
    const pending = session.submitManual(fakeCode);
    void pending.catch(() => undefined);
    await waitForExchange();
    session.cancel();
    required(releaseResponse)();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect(credentials.set).not.toHaveBeenCalled();
  });

  it.each([400, 401, 500])("HTTP %s 错误不包含上游 body 或授权信息", async (httpStatus) => {
    status = httpStatus;
    responseBody = `${fakeCode} ${fakeKey} upstream-error`;
    const session = await login(store(), { remote: true });
    await expect(session.submitManual(fakeCode)).rejects.toMatchObject({ code: "exchange" });
    const error = await session.completion.catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ProviderLoginError);
    expect(String(error)).not.toContain(fakeCode);
    expect(String(error)).not.toContain(fakeKey);
    expect(String(error)).not.toContain("upstream-error");
    expect(error).not.toHaveProperty("cause");
  });

  it.each(["not-json", "{}", '{"key":5}', '{"key":" "}'])(
    "无效交换响应 %s 安全失败",
    async (body) => {
      responseBody = body;
      const credentials = store();
      const session = await login(credentials, { remote: true });
      await expect(session.submitManual(fakeCode)).rejects.toMatchObject({ code: "exchange" });
      expect(credentials.set).not.toHaveBeenCalled();
    },
  );

  it("换钥端点重定向被拒绝，不向重定向目标发送 verifier", async () => {
    status = 307;
    redirects = `${origin}/steal`;
    const session = await login(store(), { remote: true });
    await expect(session.submitManual(fakeCode)).rejects.toMatchObject({ code: "network" });
    expect(requests).toHaveLength(1);
  });

  it("系统保存失败不泄露异常里的 key", async () => {
    const credentials = store();
    vi.mocked(credentials.set).mockRejectedValue(new Error(fakeKey));
    const session = await login(credentials, { remote: true });
    await expect(session.submitManual(fakeCode)).rejects.toMatchObject({ code: "storage" });
    const error = await session.completion.catch((value: unknown) => value);
    expect(String(error)).not.toContain(fakeKey);
  });

  it("授权拒绝回调不回显服务商 error 或 error_description", async () => {
    const session = await login();
    const url = callback(session);
    url.searchParams.set("error", fakeKey);
    url.searchParams.set("error_description", fakeCode);
    const page = await fetch(url);
    const text = await page.text();
    expect(text).not.toContain(fakeKey);
    expect(text).not.toContain(fakeCode);
    await expect(session.completion).rejects.toMatchObject({ code: "exchange" });
    expect(requests).toHaveLength(0);
  });
});

describe("Core 登录入口与 API key 回归", () => {
  it("根据 baseURL 对应预设声明而非用户起的名称匹配，固定官方端点", async () => {
    const credentials = store();
    const session = await startProviderLogin(config(credentials, []), entry.id, {
      entry,
      remote: true,
    });
    sessions.push(session);
    expect(new URL(session.authorizeUrl).origin).toBe("https://openrouter.ai");
    expect(new URL(session.authorizeUrl).pathname).toBe("/auth");
    const offlineFetch = globalThis.fetch;
    const intercepted = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      expect(input).toBe("https://openrouter.ai/api/v1/auth/keys");
      expect(init?.redirect).toBe("error");
      return offlineFetch(`${origin}/api/v1/auth/keys`, init);
    });
    await session.submitManual(fakeCode);
    expect(intercepted).toHaveBeenCalledTimes(1);
    expect(credentials.set).toHaveBeenCalledExactlyOnceWith(entry.id, fakeKey);
  });

  it("向导条目 id 不一致拒绝", async () => {
    await expect(startProviderLogin(config(store()), "different", { entry })).rejects.toMatchObject(
      {
        code: "missing",
      },
    );
  });

  it("不存在的服务商拒绝", async () => {
    await expect(startProviderLogin(config(store()), "missing")).rejects.toMatchObject({
      code: "missing",
    });
  });

  it.each([
    { ...entry, baseURL: "https://untrusted.example/api/v1" },
    { ...entry, baseURL: "https://openrouter.ai/api/v1?redirect=evil" },
    { ...entry, type: "anthropic" as const },
    { ...entry, auth: { kind: "openai-siwc" as const } },
    {
      ...entry,
      auth: {
        kind: "external-file" as const,
        path: "~/synthetic.json",
        keyPath: ["key"],
        renewHint: "login",
      },
    },
  ])("非 OpenRouter API key 不支持浏览器登录 %#", async (custom) => {
    await expect(
      startProviderLogin(config(store()), entry.id, { entry: custom }),
    ).rejects.toMatchObject({
      code: "unsupported",
    });
  });

  it("普通 API key 退出仅调用现有 CredentialStore.delete", async () => {
    const credentials = store();
    await logoutProvider(config(credentials), entry.id);
    expect(credentials.delete).toHaveBeenCalledExactlyOnceWith(entry.id);
    expect(credentials.get).not.toHaveBeenCalled();
  });

  it("external-file 退出不删除凭据索引或官方文件", async () => {
    const credentials = store();
    const external: ProviderEntryConfig = {
      ...entry,
      auth: {
        kind: "external-file",
        path: "~/.grok/auth.json",
        keyPath: ["key"],
        renewHint: "grok login",
      },
    };
    await logoutProvider(config(credentials, [external]), entry.id);
    expect(credentials.delete).not.toHaveBeenCalled();
    expect(credentials.get).not.toHaveBeenCalled();
  });

  it("退出存储错误使用固定安全消息", async () => {
    const credentials = store();
    vi.mocked(credentials.delete).mockRejectedValue(new Error(fakeKey));
    await expect(logoutProvider(config(credentials), entry.id)).rejects.toMatchObject({
      code: "storage",
    });
  });
});

describe("共享登录生命周期", () => {
  it("默认超时五分钟，取消释放资源且不会重复清理", async () => {
    vi.useFakeTimers();
    try {
      const lifecycle = createLoginLifecycle();
      const cleanup = vi.fn();
      lifecycle.addCleanup(cleanup);
      await vi.advanceTimersByTimeAsync(299_999);
      expect(lifecycle.accepting).toBe(true);
      expect(cleanup).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(lifecycle.completion).rejects.toMatchObject({ code: "timeout" });
      lifecycle.cancel();
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(lifecycle.signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("PKCE、state、nonce 每次独立生成", () => {
    const one = createLoginSecrets();
    const two = createLoginSecrets();
    expect(one.state).not.toBe(two.state);
    expect(one.nonce).not.toBe(two.nonce);
    expect(one.verifier).not.toBe(two.verifier);
    expect(one.state).not.toBe(one.nonce);
    expect(one.challenge).toBe(createHash("sha256").update(one.verifier).digest("base64url"));
  });
});
