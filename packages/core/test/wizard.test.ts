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
  runProviderModelWizard,
  runProviderSetupWizard,
  WizardAbort,
  type ModelField,
  type ModelSettingsPatch,
  type ModelSettingsView,
  type ProviderEntryConfig,
  type ReasoningEffortLevel,
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
    refreshModelsDev: async () => undefined,
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
      ]);
      await runProviderSetupWizard(io, config, deps, { presetId: "deepseek" });
      expect(printed.some((l) => l.includes("获取模型列表失败"))).toBe(true);
      expect(printed.some((l) => l.includes("模型将手动填写"))).toBe(true);
      expect(printed.some((l) => l.includes("密钥可能无效"))).toBe(false);
      vi.unstubAllGlobals();
    }
    expect(saved).toHaveLength(2);
  });

  it("上游未声明思考能力：不再询问服务商级档位", async () => {
    stubFetch(() => jsonRes({ data: [{ id: "m1" }] }));
    const { config, saved } = makeConfig("memory");
    const { io, printed } = scriptedIo([
      "sk-test", // API Key
    ]);
    await runProviderSetupWizard(io, config, deps, { presetId: "deepseek" });
    expect(saved[0]?.entry.thinking?.levels).toBeUndefined();
    expect(printed.some((l) => l.includes("思考档位"))).toBe(false);
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

// ── /provider model 行式问答（ADR-0024 第 4 节）─────────

describe("runProviderModelWizard", () => {
  const field = <T>(
    value: T,
    source: ModelSettingsView["fields"]["displayName"]["source"],
    editable = true,
    userValue?: T,
  ): ModelField<T> => ({
    value,
    source,
    editable,
    ...(userValue !== undefined ? { userValue } : {}),
  });

  const baseView = (over?: Partial<ModelSettingsView["fields"]>): ModelSettingsView => ({
    providerId: "corp",
    modelId: "m1",
    readonly: false,
    fields: {
      displayName: field<string | undefined>(undefined, { kind: "upstream" }),
      contextWindow: field<number | undefined>(100_000, { kind: "upstream" }),
      maxOutputTokens: field<number | undefined>(8_000, { kind: "upstream" }),
      reasoning: field<"none" | "hidden" | "visible">("visible", { kind: "upstream" }),
      imageInput: field<boolean | undefined>(false, { kind: "default" }),
      reasoningEffort: field<("low" | "high")[] | undefined>(["low", "high"], {
        kind: "derived",
      }),
      protocol: field<"openai-compatible" | "anthropic" | undefined>("openai-compatible", {
        kind: "entryType",
      }),
      ...over,
    } as ModelSettingsView["fields"],
  });

  const makeConfig = (views: ModelSettingsView[]) => {
    const saved: { p: string; m: string; patch: ModelSettingsPatch }[] = [];
    const config = {
      listModelSettings: async () => views,
      saveModelSettings: async (p: string, m: string, patch: ModelSettingsPatch) => {
        saved.push({ p, m, patch });
      },
    } as unknown as RuntimeConfig;
    return { config, saved };
  };

  it("回车保留：patch 为空对象；打印当前值（来源）与「已保存」", async () => {
    const { config, saved } = makeConfig([baseView()]);
    const { io, printed } = scriptedIo(["", "", "", "", "", "", ""]);
    await runProviderModelWizard(io, config, "corp", "m1");
    expect(saved).toEqual([{ p: "corp", m: "m1", patch: {} }]);
    expect(printed.some((l) => l.includes("100000") && l.includes("上游"))).toBe(true);
    expect(printed.at(-1)).toContain("已保存 corp/m1");
  });

  it("正常值解析：正整数 / y / 逗号档位 / none=空数组", async () => {
    const { config, saved } = makeConfig([baseView()]);
    const { io } = scriptedIo(["命名", "128000", "4096", "y", "y", "low,high", ""]);
    await runProviderModelWizard(io, config, "corp", "m1");
    expect(saved[0]?.patch).toEqual({
      displayName: "命名",
      contextWindow: 128000,
      maxOutputTokens: 4096,
      reasoning: "visible",
      imageInput: true,
      reasoningEffort: ["low", "high"],
    });
    const { config: c2, saved: s2 } = makeConfig([baseView()]);
    const { io: io2 } = scriptedIo(["", "", "", "", "", "none", ""]);
    await runProviderModelWizard(io2, c2, "corp", "m1");
    expect(s2[0]?.patch).toEqual({ reasoningEffort: [] });
  });

  it("「-」清除用户编辑 → patch 写 null", async () => {
    const { config, saved } = makeConfig([baseView()]);
    const { io } = scriptedIo(["-", "-", "", "", "", "", ""]);
    await runProviderModelWizard(io, config, "corp", "m1");
    expect(saved[0]?.patch).toEqual({ displayName: null, contextWindow: null });
  });

  it("config 来源的只读字段只显示不提问", async () => {
    const view = baseView({
      contextWindow: field<number>(
        42_000,
        { kind: "config", layer: "user", path: "/tmp/config.json" },
        false,
      ),
    });
    const { config } = makeConfig([view]);
    let asks = 0;
    const { io, printed } = scriptedIo(["", "", "", "", "", ""]);
    const spyIo: WizardIo = { ...io, ask: async (p, o) => ((asks += 1), io.ask(p, o)) };
    await runProviderModelWizard(spyIo, config, "corp", "m1");
    // 7 字段中 contextWindow 只读 → 只问 6 次；显示行含「由 … 决定」
    expect(asks).toBe(6);
    expect(
      printed.some((l) => l.includes("上下文长度") && l.includes("由 /tmp/config.json 决定")),
    ).toBe(true);
  });

  it("推理为否时隐藏档位行", async () => {
    const view = baseView({
      reasoning: field<"none" | "hidden" | "visible">("none", { kind: "user" }, true, "none"),
      reasoningEffort: field<ReasoningEffortLevel[]>([], { kind: "default" }, false),
    });
    const { config } = makeConfig([view]);
    let asks = 0;
    const { io, printed } = scriptedIo(["", "", "", "", "", ""]);
    const spyIo: WizardIo = { ...io, ask: async (p, o) => ((asks += 1), io.ask(p, o)) };
    await runProviderModelWizard(spyIo, config, "corp", "m1");
    expect(asks).toBe(6);
    expect(printed.some((l) => l.includes("思考档位"))).toBe(false);
  });

  it("保存失败打印原因不保存；无效输入不写文件", async () => {
    const view = baseView();
    const config = {
      listModelSettings: async () => [view],
      saveModelSettings: async () => {
        throw new Error("最大输出超过上下文长度");
      },
    } as unknown as RuntimeConfig;
    const { io, printed } = scriptedIo(["", "", "", "", "", "", ""]);
    await runProviderModelWizard(io, config, "corp", "m1");
    expect(printed.some((l) => l.includes("保存失败") && l.includes("最大输出"))).toBe(true);

    const { config: c2, saved: s2 } = makeConfig([view]);
    const { io: io2, printed: p2 } = scriptedIo(["", "abc"]);
    await runProviderModelWizard(io2, c2, "corp", "m1");
    expect(s2).toHaveLength(0);
    expect(p2.some((l) => l.includes("无效"))).toBe(true);
  });

  it("只读服务商：逐行显示字段与 hint，不提问不保存", async () => {
    const view: ModelSettingsView = {
      ...baseView(),
      readonly: true,
      readonlyHint: "服务商 corp 定义在 /tmp/config.json，请编辑该处配置",
    };
    const { config, saved } = makeConfig([view]);
    let asks = 0;
    const { io, printed } = scriptedIo([]);
    const spyIo: WizardIo = { ...io, ask: async (p, o) => ((asks += 1), io.ask(p, o)) };
    await runProviderModelWizard(spyIo, config, "corp", "m1");
    expect(asks).toBe(0);
    expect(saved).toHaveLength(0);
    expect(printed.some((l) => l.includes("请编辑该处配置"))).toBe(true);
  });

  it("模型不在清单 → 提示且不提问", async () => {
    const { config } = makeConfig([baseView()]);
    const { io, printed } = scriptedIo([]);
    await runProviderModelWizard(io, config, "corp", "ghost");
    expect(printed.some((l) => l.includes('"ghost" 不在'))).toBe(true);
  });
});
