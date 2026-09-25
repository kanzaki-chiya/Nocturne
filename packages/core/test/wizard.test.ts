/**
 * 向导编排测试（provider-setup.md 第 1 节）：
 * 向导不发送模型请求——全程只允许 GET /models；密钥/地址的
 * 有效性由首次真实请求检验（agent/turn.ts 的 providerFailureHint）。
 * v0.3 起向导不再询问模型与"设为默认"（ADR-0019 第 3 条）：
 * 上游列表只写回条目 models，模型选择统一走 /model。
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

const CUSTOM_PRESET: WizardPreset = {
  id: "custom-openai",
  label: "其他 OpenAI 兼容服务",
  type: "openai-compatible",
  defaultName: "",
  fetchableModels: true,
};

/**
 * 脚本化 WizardIo：answers 依次应答 ask/askSecret（string）与
 * chooseMulti（number[]，选中下标）；print/busy/step 记入 printed
 */
function scriptedIo(answers: (string | number[])[]): { io: WizardIo; printed: string[] } {
  const printed: string[] = [];
  const queue = [...answers];
  const take = (prompt: string): Promise<string> => {
    printed.push(prompt);
    const a = queue.shift();
    if (a === undefined || Array.isArray(a)) return Promise.reject(new WizardAbort());
    return Promise.resolve(a);
  };
  const takeMulti = (prompt: string): Promise<number[]> => {
    printed.push(prompt);
    const a = queue.shift();
    if (a === undefined || !Array.isArray(a)) return Promise.reject(new WizardAbort());
    return Promise.resolve(a);
  };
  return {
    printed,
    io: {
      ask: take,
      askSecret: take,
      chooseMulti: takeMulti,
      busy: (t) => printed.push(t),
      step: (t) => printed.push(t),
      print: (t) => printed.push(t),
    },
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
  presets: () => [PRESET, CUSTOM_PRESET],
  fetchModels: (req, key) => fetchModels(req, key),
  env: () => undefined,
};

describe("provider 向导（无连接测试，v0.3 不选模型）", () => {
  it("全程只发 GET /models：不问名称/模型/默认，结果带 modelCount", async () => {
    const calls = stubFetch(() => jsonRes({ data: [{ id: "m1" }, { id: "m2" }] }));
    const { config, saved } = makeConfig("memory");
    const { io, printed } = scriptedIo([
      "sk-test", // API Key（askSecret）
      [0], // 上游未声明思考能力 → 单步多选勾选第一项"不支持思考强度"
    ]);
    const res = await runProviderSetupWizard(io, config, deps, { presetId: "deepseek" });
    expect(res).toEqual({ providerId: "deepseek", modelCount: 2 });
    // 唯一的网络请求是 GET /models（fetch 默认 method 即 GET）
    expect(calls).toEqual([{ url: "https://api.corp.test/v1/models", method: "GET" }]);
    // v0.3：内置预设不问名称，全程不出现模型选择/设为默认/是非提问
    expect(printed.some((l) => l.includes("名称："))).toBe(false);
    expect(printed.some((l) => l.includes("模型 id"))).toBe(false);
    expect(printed.some((l) => l.includes("设为默认"))).toBe(false);
    expect(printed.some((l) => l.includes("[y/N]"))).toBe(false);
    // 完成步骤折叠为摘要行（step）：取模型结果覆盖"正在获取…"
    expect(printed.some((l) => l === "已获取 2 个模型")).toBe(true);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.entry.id).toBe("deepseek");
    expect(saved[0]?.entry.models?.m1).toBeDefined();
    expect(saved[0]?.entry.models?.m2).toBeDefined();
    // 向导不再传 defaultModel
    expect((saved[0]?.opts as Record<string, unknown>)?.defaultModel).toBeUndefined();
    expect(printed.some((l) => l.includes("已保存 deepseek，2 个模型"))).toBe(true);
  });

  it("自定义预设问名称与服务地址；openai 兼容地址必填", async () => {
    const calls = stubFetch(() => jsonRes({ data: [{ id: "m1" }] }));
    const { config, saved } = makeConfig("memory");
    const { io, printed } = scriptedIo([
      "commandcode", // 名称（必填）
      "https://gw.example.com/v1", // 服务地址
      "", // API Key 留空 → 走环境变量
      "MY_GATEWAY_KEY", // 凭据环境变量名
      [0], // 思考档位单步：勾第一项 = 不支持
    ]);
    const res = await runProviderSetupWizard(io, config, deps, { presetId: "custom-openai" });
    expect(res.providerId).toBe("commandcode");
    expect(calls).toEqual([{ url: "https://gw.example.com/v1/models", method: "GET" }]);
    expect(saved[0]?.entry.id).toBe("commandcode");
    expect(saved[0]?.entry.baseURL).toBe("https://gw.example.com/v1");
    expect(saved[0]?.entry.apiKeyEnv).toBe("MY_GATEWAY_KEY");
    expect(printed.some((l) => l.includes("名称"))).toBe(true);
    // 步骤摘要记录名称/地址/密钥来源
    expect(printed.some((l) => l === "名称 commandcode")).toBe(true);
    expect(printed.some((l) => l === "地址 https://gw.example.com/v1")).toBe(true);
    expect(printed.some((l) => l === "密钥来源：环境变量 MY_GATEWAY_KEY")).toBe(true);
  });

  it("/models 返回 401：提示密钥可能无效，条目仍保存（空 models）", async () => {
    const calls = stubFetch(() => jsonRes({ error: "bad key" }, 401));
    const { config, saved } = makeConfig("memory");
    const { io, printed } = scriptedIo([
      "sk-bad", // API Key
      [0], // 思考档位单步：不支持
    ]);
    const res = await runProviderSetupWizard(io, config, deps, { presetId: "deepseek" });
    expect(printed.some((l) => l.includes("密钥可能无效"))).toBe(true);
    expect(printed.some((l) => l.includes("/provider refresh"))).toBe(true);
    // 流程不被阻塞：条目照常保存（无上游模型）
    expect(res).toEqual({ providerId: "deepseek", modelCount: 0 });
    expect(saved).toHaveLength(1);
    expect(Object.keys(saved[0]?.entry.models ?? {})).toHaveLength(0);
    expect(printed.some((l) => l === "已保存 deepseek")).toBe(true);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("/models 返回 404 或网络错误：提示后照常保存", async () => {
    const { config, saved } = makeConfig("none");
    for (const handler of [
      () => jsonRes({}, 404),
      () => Promise.reject(new TypeError("fetch failed")),
    ]) {
      stubFetch(handler);
      const { io, printed } = scriptedIo([
        "", // 凭据环境变量名（backend=none）
        [0], // 思考档位单步：不支持
      ]);
      await runProviderSetupWizard(io, config, deps, { presetId: "deepseek" });
      expect(printed.some((l) => l.includes("获取模型列表失败"))).toBe(true);
      expect(printed.some((l) => l.includes("模型将手动填写"))).toBe(true);
      expect(printed.some((l) => l.includes("密钥可能无效"))).toBe(false);
      vi.unstubAllGlobals();
    }
    expect(saved).toHaveLength(2);
  });

  it("上游未声明思考能力：单步勾选档位写入 thinking.levels（source=user）", async () => {
    stubFetch(() => jsonRes({ data: [{ id: "m1" }] }));
    const { config, saved } = makeConfig("memory");
    const { io, printed } = scriptedIo([
      "sk-test", // API Key
      [1, 3, 6], // 勾选 minimal / medium / max（选项 0 为"不支持"占位）
    ]);
    await runProviderSetupWizard(io, config, deps, { presetId: "deepseek" });
    expect(saved[0]?.entry.thinking?.levels).toEqual(["minimal", "medium", "max"]);
    expect(saved[0]?.entry.thinking?.source).toBe("user");
    // 步骤摘要记录所选档位
    expect(printed.some((l) => l === "思考档位 minimal / medium / max")).toBe(true);
  });

  it("勾选「不支持」与档位混选时按不支持处理（互斥兜底）", async () => {
    stubFetch(() => jsonRes({ data: [{ id: "m1" }] }));
    const { config, saved } = makeConfig("memory");
    const { io } = scriptedIo([
      "sk-test", // API Key
      [0, 2], // 实现层兜底：互斥项一旦勾上即判不支持（UI 层本就互斥）
    ]);
    await runProviderSetupWizard(io, config, deps, { presetId: "deepseek" });
    expect(saved[0]?.entry.thinking?.levels).toBeUndefined();
  });

  it("上游已声明思考能力：不追问思考强度", async () => {
    stubFetch(() =>
      jsonRes({
        data: [{ id: "m1", supported_parameters: ["tools", "reasoning"] }],
      }),
    );
    const { config, saved } = makeConfig("memory");
    const { io, printed } = scriptedIo([
      "sk-test", // API Key（之后不应再有任何提问）
    ]);
    await runProviderSetupWizard(io, config, deps, { presetId: "deepseek" });
    expect(printed.some((l) => l.includes("思考强度"))).toBe(false);
    expect(saved[0]?.entry.thinking?.levels).toBeUndefined();
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
