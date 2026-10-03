/**
 * provider.* 方法映射（rpc.md 3.3）：只读方法与 Core 相等、prepare/commit 两段提交、
 * 变更后串行重载 + providersChanged、草稿生命周期、"正在使用"拒绝删除、敏感参数抹除。
 * 上游模型列表走测试内 127.0.0.1 假服务；models.dev 与 refresh 用注入实现，完全离线。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createCredentialStore,
  createPlatform,
  describeAccountStorage,
  describeProviderSetup,
  listProviderPresets,
  loadConfig,
  type CredentialStore,
} from "@nocturne/core";
import { createMemoryTransportPair, createRpcClient } from "@nocturne/rpc/client";

import { cleanupTmp, connectWithConfig, tmpDir, type ProviderHarness } from "./harness.js";

afterEach(cleanupTmp);

const servers: Server[] = [];

/** 本机假上游：只答 GET /v1/models，其余 404 */
async function serveUpstream(models: { id: string; context_length?: number }[]): Promise<{
  baseURL: string;
}> {
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ data: models }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` };
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

const providersFile = (h: ProviderHarness) =>
  existsSync(path.join(h.home, "providers.json"))
    ? (JSON.parse(readFileSync(path.join(h.home, "providers.json"), "utf8")) as {
        providers?: { id: string }[];
      })
    : undefined;

async function addProvider(h: ProviderHarness, baseURL: string, name = "e2e") {
  const prepared = await h.client.provider.prepareProvider({
    presetId: "custom-openai",
    name,
    baseURL,
    credential: { kind: "apiKey", key: "sk-e2e" },
  });
  return { prepared, commit: await h.client.provider.commitProvider(prepared.draftId) };
}

describe("provider.* 只读方法", () => {
  it("结果与直接调用 Core 相等", async () => {
    const h = await connectWithConfig();
    const { provider } = h.client;

    expect(await provider.listProviderPresets()).toEqual(listProviderPresets());
    expect(await provider.describeProviderSetup("openrouter")).toEqual(
      describeProviderSetup(h.config, "openrouter"),
    );
    expect(await provider.describeProviders()).toEqual({
      providers: await h.config.describeProviders(h.ws),
    });
    // memory 后端：describeAccountStorage 恒为 undefined（线上 null）
    expect(await provider.describeAccountStorage("chatgpt")).toBeUndefined();
    h.client.close();
    await h.served;
  });

  it("无系统凭据后端且为账号型条目：describeAccountStorage 返回保存位置描述", async () => {
    // providers.json 先写好账号型条目，再加载
    const home = tmpDir("nct-rpc-seed-home-");
    writeFileSync(
      path.join(home, "providers.json"),
      JSON.stringify({
        version: 1,
        providers: [
          {
            id: "chatgpt",
            type: "openai-compatible",
            baseURL: "https://api.openai.com/v1",
            auth: { kind: "openai-siwc" },
            models: {},
          },
        ],
      }),
    );
    const platform = createPlatform();
    const config = await loadConfig(platform, {
      nocturneHome: home,
      env: () => undefined,
      credentials: (await createCredentialStore(platform, home, { backend: "none" })).store,
      modelsDevFetch: () => Promise.reject(new Error("离线")),
      upstreamFetch: () => Promise.resolve([]),
    });
    const h = await connectWithConfig({ config, credentialBackend: "none" });
    expect(await h.client.provider.describeAccountStorage("chatgpt")).toEqual(
      describeAccountStorage(h.config, h.config.base.providers[0] ?? {}),
    );
    expect((await h.client.provider.describeAccountStorage("chatgpt"))?.options.length).toBe(2);
    // 非账号型条目（含不存在的 id）→ null
    expect(await h.client.provider.describeAccountStorage("deepseek")).toBeUndefined();
    h.client.close();
    await h.served;
  });

  it("未注入 providerConfig：provider.* 全部报 provider_config_unavailable", async () => {
    const h = await connectWithConfig({ noProviderConfig: true });
    await expect(h.client.provider.describeProviders()).rejects.toMatchObject({
      code: "provider_config_unavailable",
      rpcCode: -32004,
    });
    await expect(h.client.provider.listProviderPresets()).rejects.toMatchObject({
      code: "provider_config_unavailable",
    });
    h.client.close();
    await h.served;
  });
});

describe("provider.prepareProvider / commitProvider", () => {
  it("prepare 不落盘；commit 后 listModels 立刻含新模型，providersChanged 在响应前到达", async () => {
    const { baseURL } = await serveUpstream([{ id: "e2e-model", context_length: 128000 }]);
    const h = await connectWithConfig();
    let changed = 0;
    h.client.onProvidersChanged(() => {
      changed += 1;
    });

    const prepared = await h.client.provider.prepareProvider({
      presetId: "custom-openai",
      name: "e2e",
      baseURL,
      credential: { kind: "apiKey", key: "sk-e2e" },
    });
    expect(prepared.modelCount).toBe(1);
    expect(prepared.draftId).toMatch(/^[0-9a-f-]{36}$/);
    expect(providersFile(h)?.providers).toBeUndefined();
    expect(h.reloadCount()).toBe(0);

    const result = await h.client.provider.commitProvider(prepared.draftId);
    expect(result).toMatchObject({ providerId: "e2e", modelCount: 1 });
    // 响应到达时通知已经先到
    expect(changed).toBe(1);
    expect(h.reloadCount()).toBe(1);
    expect(providersFile(h)?.providers?.map((p) => p.id)).toEqual(["e2e"]);

    const models = await h.client.runtime.listModels();
    expect(models.map((m) => `${m.ref.provider}/${m.ref.model}`)).toContain("e2e/e2e-model");
    // 服务端 Runtime 同样已看到新配置
    expect(h.runtimes[0]?.listModels().map((m) => m.ref.provider)).toContain("e2e");
    h.client.close();
    await h.served;
  });

  it("discard 后 commit 报 -32005 / field=draftId；断开后新连接 commit 同一 draftId 同样失败", async () => {
    const { baseURL } = await serveUpstream([{ id: "m" }]);
    const h = await connectWithConfig();

    const first = await h.client.provider.prepareProvider({
      presetId: "custom-openai",
      name: "e2e",
      baseURL,
      credential: { kind: "env", name: "NCT_E2E_KEY" },
    });
    await h.client.provider.discardProvider(first.draftId);
    await expect(h.client.provider.commitProvider(first.draftId)).rejects.toMatchObject({
      rpcCode: -32005,
      field: "draftId",
    });

    const second = await h.client.provider.prepareProvider({
      presetId: "custom-openai",
      name: "e2e",
      baseURL,
      credential: { kind: "env", name: "NCT_E2E_KEY" },
    });
    // 断开：服务端清理时丢弃本连接未提交的草稿
    h.client.close();
    await h.served;

    // 新连接（同一服务端、同一配置对象）：draftId 已失效
    const [serverEnd, clientEnd] = createMemoryTransportPair();
    const served2 = h.server.serve(serverEnd);
    const client2 = createRpcClient(clientEnd, { clientName: "rpc-test-2" });
    await client2.initialize();
    await expect(client2.provider.commitProvider(second.draftId)).rejects.toMatchObject({
      rpcCode: -32005,
      field: "draftId",
    });
    client2.close();
    await served2;
  });

  it("重载失败：请求以重载错误失败，但写入已生效", async () => {
    const { baseURL } = await serveUpstream([{ id: "m" }]);
    const h = await connectWithConfig({ reloadError: new Error("重载失败（测试注入）") });
    const prepared = await h.client.provider.prepareProvider({
      presetId: "custom-openai",
      name: "e2e",
      baseURL,
      credential: { kind: "env", name: "NCT_E2E_KEY" },
    });
    await expect(h.client.provider.commitProvider(prepared.draftId)).rejects.toMatchObject({
      message: "重载失败（测试注入）",
    });
    expect(providersFile(h)?.providers?.map((p) => p.id)).toEqual(["e2e"]);
    h.client.close();
    await h.served;
  });
});

describe("provider.* 写方法与重载", () => {
  it("setCredential / saveModelSettings / refreshUpstreamLimits / refreshModelsDev / removeSetupProvider / logoutProvider", async () => {
    const { baseURL } = await serveUpstream([
      { id: "m1", context_length: 8000 },
      { id: "m2", context_length: 16000 },
    ]);
    const h = await connectWithConfig({
      upstreamModels: [
        { id: "m1", contextWindow: 8000 },
        { id: "m2", contextWindow: 16000 },
        { id: "m3", contextWindow: 32000 },
      ],
    });
    await addProvider(h, baseURL);
    expect(h.reloadCount()).toBe(1);

    // setCredential：密钥进凭据存储
    await h.client.provider.setCredential("e2e", "sk-new");
    expect(await h.credentials.get("e2e")).toBe("sk-new");
    expect(h.reloadCount()).toBe(2);

    // listModelSettings / saveModelSettings：用户编辑写入 providers.json
    const settings = await h.client.provider.listModelSettings("e2e");
    expect(settings.map((v) => v.modelId).sort()).toEqual(["m1", "m2"]);
    expect(settings).toEqual(await h.config.listModelSettings("e2e", h.ws));
    await h.client.provider.saveModelSettings("e2e", "m1", { displayName: "改名" });
    expect(h.reloadCount()).toBe(3);
    const after = await h.client.provider.listModelSettings("e2e");
    expect(after.find((v) => v.modelId === "m1")?.fields.displayName.userValue).toBe("改名");

    // refreshUpstreamLimits：注入的上游实现返回新列表，models.dev 失败只留提示
    const refresh = await h.client.provider.refreshUpstreamLimits("e2e");
    expect(refresh).toContain("models.dev");
    expect(h.reloadCount()).toBe(4);
    expect((await h.client.provider.listModelSettings("e2e")).map((v) => v.modelId).sort()).toEqual(
      ["m1", "m2", "m3"],
    );

    const dev = await h.client.provider.refreshModelsDev();
    expect(dev).toContain("models.dev");
    expect(h.reloadCount()).toBe(5);

    // 会话正在使用时拒绝删除（provider_in_use），条目仍在
    const { session } = await h.client.runtime.createSession({ model: "e2e/m1" });
    await expect(h.client.provider.removeSetupProvider("e2e")).rejects.toMatchObject({
      code: "provider_in_use",
      rpcCode: -32004,
    });
    expect((await h.client.provider.describeProviders()).providers.map((p) => p.id)).toContain(
      "e2e",
    );
    expect(h.reloadCount()).toBe(5);
    await session.close();

    await h.client.provider.removeSetupProvider("e2e");
    expect(h.reloadCount()).toBe(6);
    expect((await h.client.provider.describeProviders()).providers.map((p) => p.id)).not.toContain(
      "e2e",
    );
    h.client.close();
    await h.served;
  });

  it("logoutProvider：已保存服务商的凭据被删除并触发重载", async () => {
    const { baseURL } = await serveUpstream([{ id: "m" }]);
    const h = await connectWithConfig();
    await addProvider(h, baseURL);
    expect(h.reloadCount()).toBe(1);
    await h.client.provider.logoutProvider("e2e");
    expect(h.reloadCount()).toBe(2);
    expect(await h.credentials.get("e2e")).toBeUndefined();
    h.client.close();
    await h.served;
  });

  it("并发两个变更：reload 串行、各 +1、两项都生效", async () => {
    const { baseURL } = await serveUpstream([
      { id: "m1", context_length: 8000 },
      { id: "m2", context_length: 16000 },
    ]);
    const h = await connectWithConfig();
    await addProvider(h, baseURL);
    const before = h.reloadCount();

    await Promise.all([
      h.client.provider.saveModelSettings("e2e", "m1", { displayName: "一" }),
      h.client.provider.saveModelSettings("e2e", "m2", { displayName: "二" }),
    ]);
    expect(h.reloadCount()).toBe(before + 2);
    expect(h.maxConcurrentReloads()).toBe(1);
    const views = await h.client.provider.listModelSettings("e2e");
    expect(views.find((v) => v.modelId === "m1")?.fields.displayName.userValue).toBe("一");
    expect(views.find((v) => v.modelId === "m2")?.fields.displayName.userValue).toBe("二");
    h.client.close();
    await h.served;
  });
});

describe("敏感参数", () => {
  const wireText = (h: ProviderHarness) => h.wire.join("\n") + JSON.stringify(h.diagnostics);

  it("错误报文与诊断记录都不含秘密值（setCredential / updateSettings / prepareProvider）", async () => {
    const { baseURL } = await serveUpstream([{ id: "m" }]);
    const mem = new Map<string, string>();
    const store: CredentialStore = {
      backend: () => "memory",
      get: (id) => Promise.resolve(mem.get(id)),
      set: (id, key) => Promise.reject(new Error(`bad ${key}`)),
      setAccount: (id, record) => {
        mem.set(id, record);
        return Promise.resolve();
      },
      delete: () => Promise.resolve(),
      has: (id) => mem.has(id),
    };
    const h = await connectWithConfig({ credentials: store });

    const key1 = "sk-secret-one";
    await expect(h.client.provider.setCredential("e2e", key1)).rejects.toMatchObject({
      message: "bad [redacted]",
    });
    await expect(
      h.client.runtime.updateSettings(
        {
          "permission.reviewer": {
            backend: "jev",
            endpoint: "custom",
            baseURL,
            model: "jev-1",
            credential: { stored: true },
          },
        },
        { reviewerKey: "rk-secret-two" },
      ),
    ).rejects.toMatchObject({ message: "bad [redacted]" });
    // chatgpt 预设不接受 apiKey：ProviderSetupError(credential)；密钥本就不应出现在任何报文里
    await expect(
      h.client.provider.prepareProvider({
        presetId: "chatgpt",
        name: "chatgpt",
        credential: { kind: "apiKey", key: "sk-secret-three" },
      }),
    ).rejects.toMatchObject({ rpcCode: -32005, field: "credential" });

    const text = wireText(h);
    expect(text).not.toContain("sk-secret-one");
    expect(text).not.toContain("rk-secret-two");
    expect(text).not.toContain("sk-secret-three");
    h.client.close();
    await h.served;
  });
});
