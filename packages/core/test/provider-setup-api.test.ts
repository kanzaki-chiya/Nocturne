/**
 * 服务商配置数据接口测试（ADR-0044 第 6 节，provider-setup.md 第 6 节）：
 * `describeProviderSetup` 的预设差异描述，`addProvider` 的校验、凭据分支与结果提示。
 * 不发送模型请求——全程只允许 GET /models，fetchModels 用 provider 层真实实现 + globalThis.fetch 桩。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  addProvider,
  describeAccountStorage,
  describeProviderSetup,
  ProviderLoginError,
  ProviderSetupError,
  setupCredentialNotice,
  setupCredentialStep,
  setupFieldStep,
  startDraftProviderLogin,
  type AddProviderOptions,
  type ProviderEntryConfig,
  type RuntimeConfig,
} from "../src/index.js";
import {
  findPendingLogin,
  registerPendingLogin,
  stagingCredentials,
  type PendingLogin,
} from "../src/provider-login/pending.js";
import { fetchModels, listProviderPresets } from "../src/provider/index.js";

type Backend = "memory" | "none" | "dpapi";

function makeConfig(backend: Backend) {
  const saved: { entry: ProviderEntryConfig; opts: unknown }[] = [];
  const stored = new Map<string, { value: string; storage?: string | undefined }>();
  const credentials = {
    backend: () => backend,
    get: (id: string) => Promise.resolve(stored.get(id)?.value),
    set: (id: string, value: string) => {
      stored.set(id, { value });
      return Promise.resolve();
    },
    setAccount: (id: string, value: string, storage?: string) => {
      stored.set(id, { value, storage });
      return Promise.resolve();
    },
    has: (id: string) => stored.has(id),
    delete: (id: string) => {
      stored.delete(id);
      return Promise.resolve();
    },
  };
  const config = {
    credentials,
    base: { providers: [] as ProviderEntryConfig[] },
    nocturneHome: "unused",
    saveSetupProvider: (entry: ProviderEntryConfig, opts?: unknown) => {
      saved.push({ entry, opts });
      return Promise.resolve();
    },
    refreshModelsDev: vi.fn(async (): Promise<string | undefined> => undefined),
  } as unknown as RuntimeConfig;
  return { config, saved, stored };
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

describe("describeProviderSetup", () => {
  it("内置预设：名称与地址写死，凭据方式依后端可用性给出 apiKey → env", () => {
    const { config } = makeConfig("memory");
    const d = describeProviderSetup(config, "deepseek");
    expect(d.label).toBe("DeepSeek");
    expect(d.fields.map((f) => [f.key, f.fixed])).toEqual([
      ["name", "deepseek"],
      ["baseURL", "https://api.deepseek.com/v1"],
    ]);
    expect(d.credential.backend).toMatchObject({ kind: "memory", available: true });
    expect(d.credential.methods.map((m) => m.kind)).toEqual(["apiKey", "env"]);
    expect(d.credential.methods[0]).toMatchObject({
      prompt: "API Key：",
      hint: "从 https://platform.deepseek.com/api_keys 获取；输入不回显；直接回车改用环境变量",
      available: true,
    });
    expect(d.credential.methods[1]).toMatchObject({
      prompt: "凭据环境变量名 [DEEPSEEK_API_KEY]：",
      defaultName: "DEEPSEEK_API_KEY",
    });
    expect(d.credential.choose).toBeUndefined();
    expect(d.credential.accountStorage).toBeUndefined();
  });

  it("无凭据后端：apiKey 标为不可用", () => {
    const { config } = makeConfig("none");
    const d = describeProviderSetup(config, "deepseek");
    expect(d.credential.backend).toMatchObject({ kind: "none", available: false });
    expect(d.credential.methods[0]).toMatchObject({ kind: "apiKey", available: false });
  });

  it("自定义预设：问名称、地址（openai 兼容必填）与可选会话头；anthropic 地址可留空", () => {
    const { config } = makeConfig("memory");
    const d = describeProviderSetup(config, "custom-openai");
    expect(d.fields.map((f) => [f.key, f.required, f.fixed])).toEqual([
      ["name", true, undefined],
      ["baseURL", true, undefined],
      ["sessionHeader", false, undefined],
    ]);
    const a = describeProviderSetup(config, "custom-anthropic");
    expect(a.fields.find((f) => f.key === "baseURL")).toMatchObject({
      required: false,
      hint: "留空使用官方端点",
    });
  });

  it("OpenRouter：先选浏览器登录或粘贴密钥", () => {
    const { config } = makeConfig("memory");
    const d = describeProviderSetup(config, "openrouter");
    expect(d.credential.choose).toEqual({
      prompt: "密钥获取方式（选择一项）：",
      options: [
        { method: "login", label: "浏览器登录" },
        { method: "apiKey", label: "粘贴密钥" },
      ],
    });
    expect(d.credential.methods.map((m) => m.kind)).toEqual(["login", "apiKey", "env"]);
  });

  it("账号型登录：无系统后端时给出保存位置选择，有后端时不给", () => {
    const none = describeProviderSetup(makeConfig("none").config, "chatgpt");
    expect(none.credential.methods).toEqual([
      { kind: "login", label: "浏览器登录", account: true },
    ]);
    expect(none.credential.accountStorage?.options.map((o) => o.value)).toEqual([
      "plaintext",
      "memory",
    ]);
    expect(none.credential.accountStorage?.notice).toContain("系统凭据后端不可用");
    expect(
      describeProviderSetup(makeConfig("dpapi").config, "grok").credential.accountStorage,
    ).toBeUndefined();
    expect(
      describeAccountStorage(makeConfig("none").config, { auth: { kind: "apiKey" } }),
    ).toBeUndefined();
  });

  it("外部登录文件：给出续期命令与手填模型 ID 的提示", () => {
    const { config } = makeConfig("memory");
    const d = describeProviderSetup(config, "grok-cli");
    expect(d.credential.methods[0]?.kind).toBe("external-file");
    expect(d.manualModel).toEqual({ prompt: "模型 ID：", hint: "服务不提供模型列表时手动填写" });
    expect(setupCredentialStep(d, { kind: "external-file" })).toMatch(
      /^凭据来源：外部登录文件；续期运行 .+/,
    );
  });

  it("未知预设按字段 preset 报错", () => {
    const { config } = makeConfig("memory");
    expect(() => describeProviderSetup(config, "nope")).toThrow(ProviderSetupError);
    expect(() => describeProviderSetup(config, "nope")).toThrow("未知预设：nope");
  });

  it("步骤与提示文案的纯函数", () => {
    const { config } = makeConfig("memory");
    const d = describeProviderSetup(config, "deepseek");
    expect(setupFieldStep("name", "x")).toBe("名称 x");
    expect(setupFieldStep("baseURL", "")).toBe("地址 官方端点");
    expect(setupFieldStep("sessionHeader", undefined)).toBe("会话头 不发送");
    expect(setupCredentialStep(d, { kind: "env", name: "K" })).toBe("密钥来源：环境变量 K");
    expect(setupCredentialStep(d, { kind: "apiKey", key: "k" })).toBe("密钥已保存（凭据存储）");
    expect(setupCredentialNotice(d, { kind: "apiKey", key: "k" })).toBe(
      "密钥已交给 memory 加密保存",
    );
    const none = describeProviderSetup(makeConfig("none").config, "deepseek");
    expect(setupCredentialNotice(none, { kind: "env", name: "K" })).toBe(
      "系统凭据后端不可用，使用环境变量方式",
    );
    expect(setupCredentialNotice(d, { kind: "env", name: "K" })).toBeUndefined();
  });
});

const realFetch: AddProviderOptions = {
  fetchModels: (req, key, signal) => fetchModels(req, key, signal),
};

describe("addProvider", () => {
  it("全程只发 GET /models：返回 modelCount 与结果行，密钥只经 saveSetupProvider 的 key 传递", async () => {
    const calls = stubFetch(() => jsonRes({ data: [{ id: "m1" }, { id: "m2" }] }));
    const { config, saved } = makeConfig("memory");
    const res = await addProvider(
      config,
      { presetId: "deepseek", credential: { kind: "apiKey", key: "sk-test" } },
      realFetch,
    );
    expect(res).toMatchObject({
      providerId: "deepseek",
      modelCount: 2,
      message: "已保存 deepseek，2 个模型",
    });
    expect(res.notices).toEqual([
      { code: "models_fetched", kind: "step", text: "已获取 2 个模型" },
    ]);
    expect(calls).toEqual([{ url: "https://api.deepseek.com/v1/models", method: "GET" }]);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.entry).toMatchObject({ id: "deepseek", source: "upstream" });
    expect(saved[0]?.entry.models?.m1).toBeDefined();
    expect(saved[0]?.opts).toEqual({ key: "sk-test" });
    expect(JSON.stringify(saved[0]?.entry)).not.toContain("sk-test");
    expect(saved[0]?.entry.apiKeyEnv).toBeUndefined();
  });

  it("env 凭据：写 apiKeyEnv；变量已设置时用它获取模型列表；名称留空取预设默认", async () => {
    const fetched: (string | undefined)[] = [];
    const { config, saved } = makeConfig("memory");
    await addProvider(
      config,
      { presetId: "deepseek", credential: { kind: "env", name: "MY_KEY" } },
      {
        env: (n) => (n === "MY_KEY" ? "from-env" : undefined),
        fetchModels: async (_req, key) => {
          fetched.push(key);
          return [];
        },
      },
    );
    expect(saved[0]?.entry.apiKeyEnv).toBe("MY_KEY");
    expect(saved[0]?.opts).toEqual({});
    await addProvider(
      config,
      { presetId: "deepseek", credential: { kind: "env", name: "" } },
      { env: () => undefined, fetchModels: async () => [] },
    );
    expect(saved[1]?.entry.apiKeyEnv).toBe("DEEPSEEK_API_KEY");
    expect(fetched).toEqual(["from-env"]);
  });

  it("自定义预设：名称、地址、会话头写入条目；会话头留空不写；内置预设的会话头来自预设", async () => {
    stubFetch(() => jsonRes({ data: [{ id: "m1" }] }));
    const { config, saved } = makeConfig("memory");
    await addProvider(
      config,
      {
        presetId: "custom-openai",
        name: "commandcode",
        baseURL: " https://gw.example.com/v1 ",
        sessionHeader: "x-opencode-session",
        credential: { kind: "env", name: "MY_GATEWAY_KEY" },
      },
      realFetch,
    );
    expect(saved[0]?.entry).toMatchObject({
      id: "commandcode",
      baseURL: "https://gw.example.com/v1",
      apiKeyEnv: "MY_GATEWAY_KEY",
      sessionHeader: "x-opencode-session",
    });
    await addProvider(
      config,
      {
        presetId: "custom-openai",
        name: "other",
        baseURL: "https://gw.example.com/v1",
        sessionHeader: "  ",
        credential: { kind: "env", name: "K" },
      },
      realFetch,
    );
    expect(saved[1]?.entry.sessionHeader).toBeUndefined();
    await addProvider(
      config,
      { presetId: "opencode-go", credential: { kind: "env", name: "" } },
      realFetch,
    );
    expect(saved[2]?.entry).toMatchObject({
      id: "opencode-go",
      baseURL: "https://opencode.ai/zen/go/v1",
      apiKeyEnv: "OPENCODE_API_KEY",
      sessionHeader: "x-opencode-session",
      modelsDevProvider: "opencode-go",
    });
    const zen = listProviderPresets().find((p) => p.id === "opencode-zen");
    expect(zen).toMatchObject({ baseURL: "https://opencode.ai/zen/v1", fetchableModels: true });
  });

  it("校验失败带字段名，且不写任何东西、不发请求", async () => {
    const calls = stubFetch(() => jsonRes({}));
    const { config, saved } = makeConfig("memory");
    const cases: [Parameters<typeof addProvider>[1], string][] = [
      [
        {
          presetId: "custom-openai",
          name: "",
          baseURL: "http://x/v1",
          credential: { kind: "env", name: "K" },
        },
        "name",
      ],
      [{ presetId: "custom-openai", name: "a", credential: { kind: "env", name: "K" } }, "baseURL"],
      [{ presetId: "deepseek", credential: { kind: "apiKey", key: "" } }, "credential"],
      [{ presetId: "deepseek", credential: { kind: "login", loginId: "missing" } }, "credential"],
      [{ presetId: "deepseek", credential: { kind: "external-file" } }, "credential"],
      [{ presetId: "chatgpt", credential: { kind: "apiKey", key: "k" } }, "credential"],
      [{ presetId: "nope", credential: { kind: "env", name: "K" } }, "preset"],
    ];
    for (const [input, field] of cases) {
      const err = await addProvider(config, input, realFetch).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderSetupError);
      expect((err as ProviderSetupError).field).toBe(field);
    }
    expect(saved).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("无凭据后端时 apiKey 凭据被拒绝（提示改用环境变量）", async () => {
    const { config } = makeConfig("none");
    await expect(
      addProvider(
        config,
        { presetId: "deepseek", credential: { kind: "apiKey", key: "k" } },
        realFetch,
      ),
    ).rejects.toMatchObject({
      field: "credential",
      message: "系统凭据后端不可用，无法保存密钥；请改用环境变量方式",
    });
  });

  it("/models 返回 401：提示密钥可能无效，条目仍保存（空 models）", async () => {
    const calls = stubFetch(() => jsonRes({ error: "bad key" }, 401));
    const { config, saved } = makeConfig("memory");
    const res = await addProvider(
      config,
      { presetId: "deepseek", credential: { kind: "apiKey", key: "sk-bad" } },
      realFetch,
    );
    expect(res).toMatchObject({
      providerId: "deepseek",
      modelCount: 0,
      message: "已保存 deepseek",
    });
    expect(res.notices).toEqual([
      {
        code: "models_unauthorized",
        kind: "step",
        text: "! 获取模型列表失败（HTTP 401）：密钥可能无效",
      },
      {
        code: "models_unauthorized",
        kind: "print",
        text: "保存后可用 /provider key 更新密钥，再 /provider refresh 重试",
      },
    ]);
    expect(saved).toHaveLength(1);
    expect(Object.keys(saved[0]?.entry.models ?? {})).toHaveLength(0);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("/models 返回 404 或网络错误：提示模型将手动填写后照常保存", async () => {
    const { config, saved } = makeConfig("none");
    for (const handler of [
      () => jsonRes({}, 404),
      () => Promise.reject(new TypeError("fetch failed")),
    ]) {
      stubFetch(handler);
      const res = await addProvider(
        config,
        { presetId: "deepseek", credential: { kind: "env", name: "" } },
        realFetch,
      );
      const step = res.notices.find((n) => n.kind === "step");
      expect(step?.text).toContain("获取模型列表失败");
      expect(step?.text).toContain("模型将手动填写");
      expect(res.notices.some((n) => n.text.includes("密钥可能无效"))).toBe(false);
      expect(res.notices.find((n) => n.kind === "print")?.text).toBe(
        "保存后可用 /provider refresh 重试",
      );
      vi.unstubAllGlobals();
    }
    expect(saved).toHaveLength(2);
  });

  it("取消信号中止获取模型列表：抛出而不保存", async () => {
    const { config, saved } = makeConfig("memory");
    const controller = new AbortController();
    const pending = addProvider(
      config,
      { presetId: "deepseek", credential: { kind: "env", name: "" } },
      {
        signal: controller.signal,
        fetchModels: (_req, _key, signal) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => {
              reject(new Error("aborted"));
            });
          }),
      },
    );
    controller.abort();
    await expect(pending).rejects.toBeDefined();
    expect(saved).toHaveLength(0);
  });

  it("models.dev 刷新警告作为 print 提示返回", async () => {
    const { config } = makeConfig("memory");
    vi.mocked(config.refreshModelsDev).mockResolvedValueOnce("models.dev 刷新失败");
    const res = await addProvider(
      config,
      { presetId: "deepseek", credential: { kind: "env", name: "" } },
      { fetchModels: async () => [] },
    );
    expect(res.notices).toContainEqual({
      code: "models_dev",
      kind: "print",
      text: "! models.dev 刷新失败",
    });
  });

  it("外部登录文件：上游无模型列表时必须手填模型 ID（字段 modelId），写入条目", async () => {
    const { config, saved } = makeConfig("memory");
    const fail = { fetchModels: () => Promise.reject(new Error("no list")) };
    await expect(
      addProvider(config, { presetId: "grok-cli", credential: { kind: "external-file" } }, fail),
    ).rejects.toMatchObject({ field: "modelId" });
    expect(saved).toHaveLength(0);
    const res = await addProvider(
      config,
      { presetId: "grok-cli", modelId: " grok-4 ", credential: { kind: "external-file" } },
      fail,
    );
    expect(res.modelCount).toBe(1);
    expect(saved[0]?.entry.models?.["grok-4"]).toBeDefined();
    expect(saved[0]?.entry.apiKeyEnv).toBeUndefined();
  });

  it("OpenRouter thinking.format 随预设写入", async () => {
    const { config, saved } = makeConfig("memory");
    await addProvider(
      config,
      { presetId: "openrouter", credential: { kind: "env", name: "" } },
      { fetchModels: async () => [] },
    );
    expect(saved[0]?.entry.thinking).toEqual({ format: "openrouter" });
  });
});

describe("草稿登录（loginId）", () => {
  function pendingFor(over: Partial<PendingLogin> = {}): PendingLogin {
    return {
      presetId: "openrouter",
      providerId: "openrouter",
      baseURL: "https://openrouter.ai/api/v1",
      account: false,
      settled: true,
      ...over,
    };
  }

  it("stagingCredentials 拦截写入，其余委托真实存储", async () => {
    const { config, stored } = makeConfig("memory");
    const pending = pendingFor();
    const staging = stagingCredentials(config.credentials, pending);
    expect(staging.backend()).toBe("memory");
    await staging.set("openrouter", "sk-login");
    await staging.setAccount?.("chatgpt", "{}", "memory");
    expect(stored.size).toBe(0);
    expect(pending.staged).toEqual({ kind: "account", value: "{}", storage: "memory" });
    await staging.set("openrouter", "sk-login");
    expect(pending.staged).toEqual({ kind: "secret", value: "sk-login" });
  });

  it("OpenRouter 登录完成后凭 loginId 提交：密钥经 saveSetupProvider 保存，用它获取模型列表", async () => {
    const { config, saved } = makeConfig("memory");
    const pending = pendingFor({ staged: { kind: "secret", value: "sk-login" } });
    const loginId = registerPendingLogin(config, pending);
    const keys: (string | undefined)[] = [];
    const res = await addProvider(
      config,
      { presetId: "openrouter", credential: { kind: "login", loginId } },
      {
        fetchModels: async (_r, key) => {
          keys.push(key);
          return [{ id: "model" }];
        },
      },
    );
    expect(res.modelCount).toBe(1);
    expect(keys).toEqual(["sk-login"]);
    expect(saved[0]?.opts).toEqual({ key: "sk-login" });
    expect(saved[0]?.entry.apiKeyEnv).toBeUndefined();
    expect(saved[0]?.entry.auth).toBeUndefined();
    // 提交后 loginId 作废
    expect(findPendingLogin(config, loginId)).toBeUndefined();
  });

  it("OpenRouter 无后端：登录流程已一次性展示密钥，条目改读预设默认环境变量", async () => {
    const { config, saved } = makeConfig("none");
    const loginId = registerPendingLogin(config, pendingFor());
    await addProvider(
      config,
      { presetId: "openrouter", credential: { kind: "login", loginId } },
      { fetchModels: async () => [] },
    );
    expect(saved[0]?.entry.apiKeyEnv).toBe("OPENROUTER_API_KEY");
  });

  it("账号型登录：先落盘账号凭据（无后端时带显式保存位置），条目不含 key", async () => {
    const { config, saved, stored } = makeConfig("none");
    const loginId = registerPendingLogin(
      config,
      pendingFor({
        presetId: "chatgpt",
        providerId: "chatgpt",
        baseURL: "https://api.openai.com/v1",
        account: true,
        staged: { kind: "account", value: '{"v":1}', storage: "plaintext" },
      }),
    );
    const res = await addProvider(
      config,
      { presetId: "chatgpt", credential: { kind: "login", loginId } },
      { fetchModels: async () => [{ id: "gpt" }] },
    );
    expect(stored.get("chatgpt")).toEqual({ value: '{"v":1}', storage: "plaintext" });
    expect(saved[0]?.opts).toEqual({});
    expect(saved[0]?.entry.models?.gpt?.protocol).toBe("openai-responses");
    expect(res.providerId).toBe("chatgpt");
  });

  it("账号型登录有系统后端：经 credentials.set 写入", async () => {
    const { config, stored } = makeConfig("dpapi");
    const loginId = registerPendingLogin(
      config,
      pendingFor({
        presetId: "grok",
        providerId: "grok",
        baseURL: "https://cli-chat-proxy.grok.com/v1",
        account: true,
        staged: { kind: "secret", value: '{"v":2}' },
      }),
    );
    await addProvider(
      config,
      { presetId: "grok", credential: { kind: "login", loginId } },
      { fetchModels: async () => [] },
    );
    expect(stored.get("grok")).toEqual({ value: '{"v":2}' });
  });

  it("loginId 与表单不一致或登录未完成：credential 字段错误，且不保存", async () => {
    const { config, saved } = makeConfig("memory");
    const mismatched = registerPendingLogin(config, pendingFor({ providerId: "other" }));
    await expect(
      addProvider(
        config,
        { presetId: "openrouter", credential: { kind: "login", loginId: mismatched } },
        { fetchModels: async () => [] },
      ),
    ).rejects.toMatchObject({ field: "credential", message: "登录与表单内容不一致，请重新登录" });
    const unsettled = registerPendingLogin(config, pendingFor({ settled: false }));
    await expect(
      addProvider(
        config,
        { presetId: "openrouter", credential: { kind: "login", loginId: unsettled } },
        { fetchModels: async () => [] },
      ),
    ).rejects.toMatchObject({ field: "credential", message: "登录尚未完成" });
    expect(saved).toHaveLength(0);
  });

  it("startDraftProviderLogin：远程模式返回 loginId，授权地址不含密钥；取消后 loginId 作废", async () => {
    const { config } = makeConfig("memory");
    const session = await startDraftProviderLogin(
      config,
      { presetId: "openrouter", name: "openrouter" },
      { remote: true },
    );
    expect(session.loginId).toMatch(/^[0-9a-f-]{36}$/);
    expect(session.manualInput).toBe("code");
    expect(findPendingLogin(config, session.loginId)?.settled).toBe(false);
    session.cancel();
    await expect(session.completion).rejects.toMatchObject({ code: "cancelled" });
    await Promise.resolve();
    expect(findPendingLogin(config, session.loginId)).toBeUndefined();
  });

  it("startDraftProviderLogin：不支持登录的预设与空名称被拒绝", async () => {
    const { config } = makeConfig("memory");
    await expect(
      startDraftProviderLogin(config, { presetId: "deepseek", name: "deepseek" }),
    ).rejects.toMatchObject({ code: "unsupported" });
    await expect(
      startDraftProviderLogin(config, { presetId: "openrouter", name: "" }),
    ).rejects.toBeInstanceOf(ProviderLoginError);
  });

  it("账号型草稿登录无系统后端且未给保存位置：授权前就以 accountStorage 拒绝", async () => {
    const { config } = makeConfig("none");
    for (const presetId of ["chatgpt", "grok"]) {
      await expect(
        startDraftProviderLogin(config, { presetId, name: presetId }),
      ).rejects.toMatchObject({ code: "accountStorage" });
    }
  });
});
