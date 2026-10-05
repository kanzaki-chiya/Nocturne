/**
 * login.* 方法与 login.completed 通知（rpc.md 3.4）：草稿登录 → prepare → commit、
 * 取消、断开清理（回环端口关闭、草稿登录丢弃）、已保存服务商登录后自动重载、
 * 无系统后端的一次性密钥只经 login.completed.unstoredKey 传一次。
 * OpenRouter 授权交换与模型列表用 vi.stubGlobal 桩掉 fetch，完全离线。
 */
import { get as httpGet } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createMemoryTransportPair, createRpcClient } from "@nocturne/rpc/client";
import type { LoginCompleted } from "@nocturne/rpc/client";

import { cleanupTmp, connectWithConfig, until, type ProviderHarness } from "./harness.js";

afterEach(cleanupTmp);
afterEach(() => {
  vi.unstubAllGlobals();
});

const OR_KEY = "sk-or-wire-secret";

/** OpenRouter 的授权交换与模型列表；其余 URL 交给离线守护 fetch（只放行本机） */
function stubOpenRouter(key = OR_KEY): void {
  const offline = globalThis.fetch;
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "https://openrouter.ai/api/v1/auth/keys") {
      return Promise.resolve(new Response(JSON.stringify({ key }), { status: 200 }));
    }
    if (url === "https://openrouter.ai/api/v1/models") {
      return Promise.resolve(
        new Response(JSON.stringify({ data: [{ id: "or-model" }] }), { status: 200 }),
      );
    }
    return offline(input, init);
  });
}

/** 收集 login.completed 通知（按 loginId 索引） */
function watchLogins(h: ProviderHarness): Map<string, LoginCompleted> {
  const completed = new Map<string, LoginCompleted>();
  h.client.onLoginCompleted((n) => {
    completed.set(n.loginId, n);
  });
  return completed;
}

/** 等待指定 loginId 的 login.completed 并返回 */
async function completed(
  h: ProviderHarness,
  map: Map<string, LoginCompleted>,
  loginId: string,
): Promise<LoginCompleted> {
  await until(() => map.has(loginId), `login.completed ${loginId}`);
  return map.get(loginId) as LoginCompleted;
}

/** 探测本机端口是否仍可连接（回环端口关闭检查） */
async function connectable(url: string): Promise<boolean> {
  return await new Promise((resolve) => {
    const request = httpGet(url, () => {
      request.destroy();
      resolve(true);
    });
    request.on("error", () => resolve(false));
    request.setTimeout(2000, () => {
      request.destroy();
      resolve(false);
    });
  });
}

function callbackPort(authorizeUrl: string): string {
  const callback = new URL(authorizeUrl).searchParams.get("callback_url");
  expect(callback).toBeTruthy();
  return callback as string;
}

describe("login.startDraft：草稿登录", () => {
  it("登录完成 → prepare 引用 loginId → commit；草稿登录不触发重载", async () => {
    stubOpenRouter();
    const h = await connectWithConfig();
    const logins = watchLogins(h);
    let changed = 0;
    h.client.onProvidersChanged(() => {
      changed += 1;
    });

    const started = await h.client.login.startDraft({
      presetId: "openrouter",
      name: "openrouter",
    });
    expect(started.manualInput).toBe("code");
    // 截止时间由服务端给出（Unix 毫秒），客户端倒计时以它为准
    expect(started.expiresAt).toBeGreaterThan(Date.now());
    expect(started.expiresAt).toBeLessThanOrEqual(Date.now() + 15 * 60_000);
    const authorize = new URL(started.authorizeUrl);
    expect(authorize.origin).toBe("https://openrouter.ai");
    expect(authorize.searchParams.get("state")).toBeTruthy();
    callbackPort(started.authorizeUrl);

    await h.client.login.submitManual(started.loginId, "code-ok");
    const done = await completed(h, logins, started.loginId);
    expect(done.error).toBeUndefined();
    expect(done.result).toEqual({ providerId: "openrouter" });
    expect(done.unstoredKey).toBeUndefined();
    // 草稿登录完成不重载（没写盘）
    expect(changed).toBe(0);
    expect(h.reloadCount()).toBe(0);

    const prepared = await h.client.provider.prepareProvider({
      presetId: "openrouter",
      credential: { kind: "login", loginId: started.loginId },
    });
    expect(prepared.modelCount).toBe(1);
    const result = await h.client.provider.commitProvider(prepared.draftId);
    expect(result).toMatchObject({ providerId: "openrouter", modelCount: 1 });
    expect(changed).toBe(1);
    expect(await h.credentials.get("openrouter")).toBe(OR_KEY);
    h.client.close();
    await h.served;
  });

  it("cancel 进行中的登录：响应后收到 cancelled 的 login.completed", async () => {
    stubOpenRouter();
    const h = await connectWithConfig();
    const logins = watchLogins(h);
    const started = await h.client.login.startDraft({
      presetId: "openrouter",
      name: "openrouter",
    });
    await h.client.login.cancel(started.loginId);
    const done = await completed(h, logins, started.loginId);
    expect(done.result).toBeUndefined();
    expect(done.error).toMatchObject({ code: "cancelled" });
    // 同一 loginId 再次 cancel/submitManual → unknown_login
    await expect(h.client.login.cancel(started.loginId)).rejects.toMatchObject({
      code: "unknown_login",
      rpcCode: -32004,
    });
    await expect(h.client.login.submitManual(started.loginId, "x")).rejects.toMatchObject({
      code: "unknown_login",
    });
    h.client.close();
    await h.served;
  });

  it("断开：进行中登录的回环端口关闭；完成未提交的草稿登录被丢弃", async () => {
    stubOpenRouter();
    const h = await connectWithConfig();
    const logins = watchLogins(h);

    // 完成但不提交：留在 draftLogins 里等断开清理
    const settled = await h.client.login.startDraft({
      presetId: "openrouter",
      name: "openrouter",
    });
    await h.client.login.submitManual(settled.loginId, "code-ok");
    await completed(h, logins, settled.loginId);

    // 另一个进行中的草稿登录：断开时 cancel 关闭回环端口
    const pending = await h.client.login.startDraft({
      presetId: "openrouter",
      name: "openrouter-2",
    });
    const callback = callbackPort(pending.authorizeUrl);
    expect(await connectable(callback)).toBe(true);

    h.client.close();
    await h.served;
    expect(await connectable(callback)).toBe(false);

    // 新连接（同一配置对象）：已完成的草稿登录被清理，引用它报 -32005/credential
    const [serverEnd, clientEnd] = createMemoryTransportPair();
    const served2 = h.server.serve(serverEnd);
    const client2 = createRpcClient(clientEnd, { clientName: "rpc-test-2" });
    await client2.initialize();
    await expect(
      client2.provider.prepareProvider({
        presetId: "openrouter",
        credential: { kind: "login", loginId: settled.loginId },
      }),
    ).rejects.toMatchObject({ rpcCode: -32005, field: "credential" });
    client2.close();
    await served2;
  });
});

describe("login.start：已保存服务商", () => {
  it("登录成功写入凭据，providersChanged 先于 login.completed 到达", async () => {
    stubOpenRouter();
    const h = await connectWithConfig();
    const logins = watchLogins(h);

    // 先经 RPC 添加 openrouter（apiKey），reload 一次
    const prepared = await h.client.provider.prepareProvider({
      presetId: "openrouter",
      credential: { kind: "apiKey", key: "sk-or-old" },
    });
    await h.client.provider.commitProvider(prepared.draftId);
    expect(h.reloadCount()).toBe(1);
    const wireMark = h.wire.length;

    const started = await h.client.login.start({ providerId: "openrouter" });
    expect(started.manualInput).toBe("code");
    await h.client.login.submitManual(started.loginId, "code-refresh");
    const done = await completed(h, logins, started.loginId);
    expect(done.result).toEqual({ providerId: "openrouter" });
    expect(done.unstoredKey).toBeUndefined();
    expect(await h.credentials.get("openrouter")).toBe(OR_KEY);
    // 登录成功触发重载（+1）；providersChanged 先于 login.completed 到达
    expect(h.reloadCount()).toBe(2);
    const tail = h.wire.slice(wireMark);
    const providersChanged = tail.findIndex((l) => l.includes("runtime.providersChanged"));
    const loginCompleted = tail.findIndex(
      (l) => l.includes("login.completed") && l.includes(started.loginId),
    );
    expect(providersChanged).toBeGreaterThanOrEqual(0);
    expect(loginCompleted).toBeGreaterThan(providersChanged);
    h.client.close();
    await h.served;
  });

  it("未知服务商与非法 accountStorage 报错；unknown_login", async () => {
    const h = await connectWithConfig();
    await expect(h.client.login.start({ providerId: "nope" })).rejects.toMatchObject({
      code: "missing",
      rpcCode: -32003,
    });
    await expect(
      h.client.login.startDraft({
        presetId: "openrouter",
        name: "openrouter",
        accountStorage: "bogus" as never,
      }),
    ).rejects.toMatchObject({ code: "invalid_params", rpcCode: -32602 });
    await expect(h.client.login.submitManual("nope", "x")).rejects.toMatchObject({
      code: "unknown_login",
    });
    await expect(h.client.login.cancel("nope")).rejects.toMatchObject({
      code: "unknown_login",
    });
    h.client.close();
    await h.served;
  });

  it("未注入 providerConfig：login.* 全部报 provider_config_unavailable", async () => {
    const h = await connectWithConfig({ noProviderConfig: true });
    await expect(h.client.login.start({ providerId: "x" })).rejects.toMatchObject({
      code: "provider_config_unavailable",
    });
    await expect(
      h.client.login.startDraft({ presetId: "openrouter", name: "x" }),
    ).rejects.toMatchObject({ code: "provider_config_unavailable" });
    await expect(h.client.login.cancel("x")).rejects.toMatchObject({
      code: "provider_config_unavailable",
    });
    h.client.close();
    await h.served;
  });
});

describe("无系统凭据后端的一次性密钥", () => {
  it("unstoredKey 只在对应 login.completed 出现一次；其他报文与诊断不含密钥", async () => {
    stubOpenRouter("sk-or-unstored-xyz");
    const h = await connectWithConfig({ credentialBackend: "none" });
    const logins = watchLogins(h);
    const started = await h.client.login.startDraft({
      presetId: "openrouter",
      name: "openrouter",
    });
    await h.client.login.submitManual(started.loginId, "code-unstored");
    const done = await completed(h, logins, started.loginId);
    expect(done.result).toEqual({ providerId: "openrouter" });
    expect(done.unstoredKey).toEqual({
      key: "sk-or-unstored-xyz",
      envName: "OPENROUTER_API_KEY",
    });

    // 密钥在全部线上报文里恰好出现一次（那条通知本身）
    const hits = h.wire.filter((line) => line.includes("sk-or-unstored-xyz"));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("login.completed");
    // 诊断记录不含密钥
    expect(JSON.stringify(h.diagnostics)).not.toContain("sk-or-unstored-xyz");

    // 无后端草稿登录的条目改读预设默认环境变量：仍可 prepare+commit
    const prepared = await h.client.provider.prepareProvider({
      presetId: "openrouter",
      credential: { kind: "login", loginId: started.loginId },
    });
    const result = await h.client.provider.commitProvider(prepared.draftId);
    expect(result).toMatchObject({ providerId: "openrouter" });
    h.client.close();
    await h.served;
  });
});

describe("敏感参数", () => {
  it("submitManual 的错误响应与诊断不含粘贴的授权码", async () => {
    stubOpenRouter();
    const h = await connectWithConfig();
    const started = await h.client.login.startDraft({
      presetId: "openrouter",
      name: "openrouter",
    });
    // 授权码带空白 → ProviderLoginError("input")，错误不含原文；无论如何线上不该出现
    await expect(
      h.client.login.submitManual(started.loginId, "bad code with space"),
    ).rejects.toMatchObject({ rpcCode: -32003 });
    const text = h.wire.join("\n") + JSON.stringify(h.diagnostics);
    expect(text).not.toContain("bad code with space");
    h.client.close();
    await h.served;
  });
});
