/**
 * 向导编排测试（provider-setup.md 第 1 节）：
 * 向导不发送模型请求——全程只允许 GET /models；密钥/地址/模型 id 的
 * 有效性由首次真实请求检验（agent/turn.ts 的 providerFailureHint）。
 * fetchModels 用 provider 层真实实现 + globalThis.fetch 桩。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  runProviderKeyWizard,
  runProviderSetupWizard,
  WizardAbort,
  type ProviderEntryConfig,
  type RuntimeConfig,
  type SetupWizardDeps,
  type WizardIo,
  type WizardPreset,
} from "../src/index.js";
import { fetchModels } from "../src/provider/index.js";

const PRESET: WizardPreset = {
  id: "deepseek",
  label: "DeepSeek",
  type: "openai-compatible",
  defaultName: "deepseek",
  baseURL: "https://api.corp.test/v1",
  defaultKeyEnv: "DEEPSEEK_API_KEY",
  fetchableModels: true,
};

/** 脚本化 WizardIo：answers 依次应答 ask/askSecret；print 记入 printed */
function scriptedIo(answers: string[]): { io: WizardIo; printed: string[] } {
  const printed: string[] = [];
  const queue = [...answers];
  const take = (prompt: string): Promise<string> => {
    printed.push(prompt);
    const a = queue.shift();
    if (a === undefined) return Promise.reject(new WizardAbort());
    return Promise.resolve(a);
  };
  return {
    printed,
    io: { ask: take, askSecret: take, print: (t) => printed.push(t) },
  };
}

function makeConfig(backend: "memory" | "none") {
  const saved: { entry: ProviderEntryConfig; opts: unknown }[] = [];
  const creds: { providerId: string; key: string }[] = [];
  const config = {
    credentials: { backend: () => backend },
    base: { providers: [] as ProviderEntryConfig[] },
    saveSetupProvider: (entry: ProviderEntryConfig, opts?: unknown) => {
      saved.push({ entry, opts });
      return Promise.resolve();
    },
    setCredential: (providerId: string, key: string) => {
      creds.push({ providerId, key });
      return Promise.resolve();
    },
  } as unknown as RuntimeConfig;
  return { config, saved, creds };
}

interface FetchCall {
  url: string;
  method: string;
}

function stubFetch(handler: (url: string) => Promise<Response>): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET" });
    return handler(String(input));
  });
  return calls;
}

const jsonRes = (data: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(data), { status }));

afterEach(() => {
  vi.unstubAllGlobals();
});

const deps: SetupWizardDeps = {
  presets: () => [PRESET],
  fetchModels: (req, key) => fetchModels(req, key),
  env: () => undefined,
};

describe("provider 向导（无连接测试）", () => {
  it("全程只发 GET /models：没有任何 POST/模型请求", async () => {
    const calls = stubFetch(() => jsonRes({ data: [{ id: "m1" }, { id: "m2" }] }));
    const { config, saved } = makeConfig("memory");
    const { io } = scriptedIo([
      "", // 名称 [deepseek]
      "sk-test", // API Key（askSecret）
      "1", // 模型选择
      "", // 设为默认 [Y/n]
    ]);
    const res = await runProviderSetupWizard(io, config, deps, { presetId: "deepseek" });
    expect(res.providerId).toBe("deepseek");
    // 唯一的网络请求是 GET /models（fetch 默认 method 即 GET）
    expect(calls).toEqual([{ url: "https://api.corp.test/v1/models", method: "GET" }]);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.entry.models?.m1).toBeDefined();
  });

  it("/models 返回 401：提示密钥可能无效，退回手动输入并照常保存", async () => {
    const calls = stubFetch(() => jsonRes({ error: "bad key" }, 401));
    const { config, saved } = makeConfig("memory");
    const { io, printed } = scriptedIo([
      "", // 名称
      "sk-bad", // API Key
      "manual-model", // 手动输入模型 id
      "", // 设为默认
    ]);
    await runProviderSetupWizard(io, config, deps, { presetId: "deepseek" });
    expect(printed.some((l) => l.includes("密钥可能无效"))).toBe(true);
    expect(printed.some((l) => l.includes("手动输入"))).toBe(true);
    // 流程不被阻塞：条目按手动输入的模型保存
    expect(saved).toHaveLength(1);
    expect(saved[0]?.entry.models && "manual-model" in saved[0].entry.models).toBe(true);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("/models 返回 404 或网络错误：退回手动输入并照常保存", async () => {
    const { config, saved } = makeConfig("none");
    for (const handler of [
      () => jsonRes({}, 404),
      () => Promise.reject(new TypeError("fetch failed")),
    ]) {
      stubFetch(handler);
      const { io, printed } = scriptedIo([
        "", // 名称
        "", // 凭据环境变量名（backend=none）
        "typed-id", // 手动输入模型 id
        "", // 设为默认
      ]);
      await runProviderSetupWizard(io, config, deps, { presetId: "deepseek" });
      expect(printed.some((l) => l.includes("模型列表获取失败"))).toBe(true);
      expect(printed.some((l) => l.includes("密钥可能无效"))).toBe(false);
      vi.unstubAllGlobals();
    }
    expect(saved).toHaveLength(2);
  });

  it("/provider key：保存新密钥后不发任何网络请求", async () => {
    const calls = stubFetch(() => jsonRes({}));
    const { config, creds } = makeConfig("memory");
    config.base.providers.push({
      id: "deepseek",
      type: "openai-compatible",
      baseURL: "https://api.corp.test/v1",
    });
    const { io } = scriptedIo(["sk-new-key"]);
    await runProviderKeyWizard(io, config, "deepseek");
    expect(creds).toEqual([{ providerId: "deepseek", key: "sk-new-key" }]);
    expect(calls).toHaveLength(0);
  });
});
