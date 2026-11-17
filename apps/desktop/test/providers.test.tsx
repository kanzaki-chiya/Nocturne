/**
 * 服务商页测试（假服务端）：列表渲染、获取前置灰、字段错误、草稿释放、取消获取、
 * 内联重新登录与取消、删除置灰、模型设置保存/取消。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcClient } from "@nocturne/rpc/client";

import { ProvidersPage } from "../src/ProvidersPage";
import type { ProviderOverview, ProviderPreset } from "../src/rpc-types";
import { fakeServer, RpcFail, withInit } from "./fake-server";

const noop = () => undefined;

const PROVIDER: ProviderOverview = {
  id: "openrouter",
  type: "openai-compatible",
  host: "openrouter.ai",
  baseURL: "https://openrouter.ai/api/v1",
  auth: "API Key · 凭据存储",
  credentialStatus: "valid",
  credentialStorage: "system",
  authKind: "apiKey",
  keySource: "credential",
  origin: "setup",
  overridden: false,
  modelCount: 2,
  enabled: true,
  enabledModelCount: 2,
  managed: true,
};

const EXPIRED: ProviderOverview = {
  id: "chatgpt",
  type: "openai-compatible",
  host: "chatgpt.com",
  baseURL: "https://chatgpt.com/backend-api/codex",
  auth: "ChatGPT 账号",
  credentialStatus: "expired",
  credentialStorage: "system",
  authKind: "account",
  keySource: "credential",
  origin: "setup",
  overridden: false,
  modelCount: 1,
  enabled: true,
  enabledModelCount: 1,
  managed: true,
};

/** 自定义预设：defaultName 为空，已配置任何服务商时也始终在「可添加」里 */
const PRESET: ProviderPreset = {
  id: "openai-compatible",
  label: "自定义 OpenAI 兼容",
  type: "openai-compatible",
  defaultName: "",
  fetchableModels: true,
};

const OPENROUTER_PRESET: ProviderPreset = {
  id: "openrouter",
  label: "OpenRouter",
  type: "openai-compatible",
  defaultName: "openrouter",
  baseURL: "https://openrouter.ai/api",
  fetchableModels: true,
};

const SETUP = {
  presetId: "openai-compatible",
  label: "自定义 OpenAI 兼容",
  type: "openai-compatible",
  fields: [
    { key: "name", prompt: "名称：", hint: "服务商 ID（回车确认）", required: true },
    { key: "baseURL", prompt: "Base URL：", hint: "服务地址", required: false },
  ],
  credential: {
    backend: { kind: "dpapi", available: true, label: "系统凭据" },
    methods: [
      {
        kind: "apiKey",
        label: "API Key",
        available: true,
        prompt: "API Key：",
        hint: "输入不回显",
      },
      {
        kind: "env",
        label: "环境变量",
        available: true,
        prompt: "变量名：",
        hint: "读取已有环境变量",
        defaultName: "OPENAI_API_KEY",
      },
    ],
  },
  fetchableModels: true,
};

const MODEL_SETTINGS = [
  {
    providerId: "openrouter",
    modelId: "anthropic/claude-sonnet-4",
    fields: {
      displayName: { value: "Claude Sonnet 4", editable: true, source: { kind: "upstream" } },
      contextWindow: { value: 200000, editable: true, source: { kind: "upstream" } },
      maxOutputTokens: { value: 64000, editable: true, source: { kind: "upstream" } },
      imageInput: { value: true, editable: true, source: { kind: "upstream" } },
      reasoning: { value: "visible", editable: true, source: { kind: "upstream" } },
      reasoningEffort: {
        value: ["low", "medium", "high"],
        editable: true,
        source: { kind: "derived" },
      },
      protocol: { value: "openai-compatible", editable: true, source: { kind: "entryType" } },
      editTool: { value: "edit", editable: true, source: { kind: "default" } },
      baseURL: {
        value: "https://api.test/v1",
        lowerValue: "https://api.test/v1",
        editable: true,
        source: { kind: "default" },
      },
    },
  },
  {
    providerId: "openrouter",
    modelId: "openai/gpt-5",
    fields: {
      displayName: {
        value: "GPT 5 Pro",
        userValue: "GPT 5 Pro",
        editable: true,
        source: { kind: "user" },
      },
      contextWindow: {
        value: 400000,
        editable: true,
        source: { kind: "user" },
        userValue: 400000,
      },
      maxOutputTokens: { value: 128000, editable: true, source: { kind: "upstream" } },
      imageInput: { value: true, editable: true, source: { kind: "upstream" } },
      reasoning: { value: "visible", editable: true, source: { kind: "upstream" } },
      reasoningEffort: {
        value: ["minimal", "low", "medium", "high", "xhigh"],
        editable: true,
        source: { kind: "upstream" },
      },
      protocol: { value: "openai-responses", editable: true, source: { kind: "entryType" } },
      editTool: { value: "edit", editable: true, source: { kind: "default" } },
      baseURL: {
        value: "https://api.test/v1",
        lowerValue: "https://api.test/v1",
        editable: true,
        source: { kind: "default" },
      },
    },
  },
];

const PREPARED = {
  draftId: "draft-1",
  modelCount: 120,
  models: Array.from({ length: 120 }, (_, i) => ({
    id: `vendor/model-${String(i + 1)}`,
    contextWindow: 128_000,
    ...(i === 0 ? { reasoning: "visible" as const, imageInput: true } : {}),
  })),
  needsManualModel: false,
  notices: [],
  steps: ["已获取模型列表"],
};

function pageProps(overrides?: {
  client?: RpcClient | undefined;
  currentProvider?: string;
  currentModel?: string;
  inUse?: ReadonlySet<string>;
  openUrl?: (url: string) => void;
}) {
  return {
    client: overrides?.client,
    currentProvider: overrides?.currentProvider,
    currentModel: overrides?.currentModel,
    inUse: overrides?.inUse,
    openUrl: overrides?.openUrl ?? noop,
    providersVersion: 0,
  };
}

/** 打开「添加 自定义 OpenAI 兼容」表单，填名称和密钥 */
async function openForm(name = "test-provider") {
  const addBtn = screen.queryByRole("button", { name: "添加服务商" });
  if (screen.queryByRole("heading", { level: 2, name: "添加服务商" }) === null && addBtn !== null) {
    fireEvent.click(addBtn);
  }
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(PRESET.label) }));
  await screen.findByText(`添加 ${PRESET.label}`);
  fireEvent.change(screen.getByLabelText("名称"), { target: { value: name } });
  fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "sk-test" } });
}

function button(name: string): HTMLButtonElement {
  const el = screen.getByRole("button", { name });
  if (!(el instanceof HTMLButtonElement)) throw new Error(`${name} 不是按钮`);
  return el;
}

function called(
  server: ReturnType<typeof fakeServer>,
  method: string,
  key: string,
  value: unknown,
): boolean {
  return server.calls.some((c) => c.method === method && c.params[key] === value);
}

afterEach(cleanup);

describe("ProvidersPage 列表与详情", () => {
  it("左栏只渲染已配置分组，不写当前/已失效/模型数文字，失效只保留警告色状态点", async () => {
    const server = fakeServer(
      withInit({
        "provider.describeProviders": { providers: [PROVIDER, EXPIRED] },
        "provider.listProviderPresets": [PRESET, OPENROUTER_PRESET],
        "runtime.defaultModel": { provider: "openrouter", model: "anthropic/claude-sonnet-4" },
        "provider.listModelSettings": MODEL_SETTINGS,
      }),
    );
    await server.initialize();
    render(
      <ProvidersPage {...pageProps({ client: server.client, currentProvider: "openrouter" })} />,
    );
    await screen.findByText(/已配置 ·/);
    const list = screen.getByRole("navigation", { name: "服务商列表" });
    const row = (text: string) =>
      within(list)
        .queryAllByRole("button")
        .find((a) => a.textContent?.startsWith(text));
    await waitFor(() => expect(row("openrouter")).toBeDefined());
    expect(row("openrouter")?.textContent).toBe("openrouter");
    expect(row("openrouter")?.textContent).not.toContain("当前");
    expect(row("openrouter")?.textContent).not.toContain("个模型");
    expect(row("chatgpt")?.textContent).toBe("chatgpt");
    expect(row("chatgpt")?.textContent).not.toContain("已失效");
    expect(row("chatgpt")?.querySelector(".dot.warn")).not.toBeNull();

    const page = screen.getByTestId("providers-page");
    expect(page.textContent).not.toContain("可添加");
    expect(screen.getByRole("button", { name: "添加服务商" })).toBeTruthy();
    const heading = within(page).getByRole("heading", { level: 2, name: "openrouter" });
    expect(heading.textContent).toBe("openrouter");
    expect(within(heading).queryByRole("button")).toBeNull();
    expect(screen.queryByText("当前")).toBeNull();
    expect(screen.queryByText("已失效")).toBeNull();
    expect(screen.queryByText("已停用")).toBeNull();
    expect(screen.queryByRole("button", { name: "编辑" })).toBeNull();
    expect(screen.queryByRole("button", { name: "换密钥" })).toBeNull();
    expect(screen.queryByRole("button", { name: "更多" })).toBeNull();
    expect(button("刷新")).toBeTruthy();
    expect(button("删除")).toBeTruthy();

    await screen.findByText("Claude Sonnet 4");
    expect(
      within(screen.getByRole("table", { name: "模型" }))
        .getAllByRole("row")
        .map(
          (r) => within(r).queryAllByRole("cell")[3] ?? within(r).getAllByRole("columnheader")[3],
        ),
    ).toHaveLength(3);
    expect(
      within(screen.getByRole("table", { name: "模型" }))
        .getAllByRole("row")
        .map(
          (r) => within(r).queryAllByRole("cell")[4] ?? within(r).getAllByRole("columnheader")[4],
        ),
    ).toHaveLength(3);
    expect(
      within(screen.getByRole("table", { name: "模型" })).getByRole("columnheader", {
        name: "模型",
      }),
    ).not.toBeNull();
    expect(
      within(screen.getByRole("table", { name: "模型" })).getByRole("columnheader", {
        name: "能力",
      }),
    ).not.toBeNull();
    expect(page.textContent).not.toContain("停用的模型不出现在模型菜单里");
    // 左栏只列已配置，不列预设
    expect(row("OpenRouter")).toBeUndefined();
    expect(row(PRESET.label)).toBeUndefined();
    // 切到 chatgpt（账号类、已失效）：内联重新登录横幅只留「账号登录已失效」和「重新登录」，无密钥输入框
    const chatgpt = row("chatgpt");
    if (chatgpt === undefined) throw new Error("缺少 chatgpt 行");
    fireEvent.click(chatgpt);
    await screen.findByText("账号登录已失效");
    expect(page.textContent).not.toContain("需要重新登录才能继续调用");
    expect(screen.getByRole("button", { name: "重新登录" })).toBeTruthy();
    expect(screen.queryByLabelText("API Key")).toBeNull();
    server.close();
  });

  it("没有打开的会话时默认选中默认模型的服务商，但不显示「当前」", async () => {
    const server = fakeServer(
      withInit({
        "provider.describeProviders": { providers: [EXPIRED, PROVIDER] },
        "provider.listProviderPresets": [PRESET, OPENROUTER_PRESET],
        "runtime.defaultModel": { provider: "openrouter", model: "anthropic/claude-sonnet-4" },
        "provider.listModelSettings": MODEL_SETTINGS,
      }),
    );
    await server.initialize();
    render(<ProvidersPage {...pageProps({ client: server.client })} />);
    const list = await screen.findByRole("navigation", { name: "服务商列表" });
    await waitFor(() => {
      expect(within(list).getByRole("button", { current: true }).textContent).toBe("openrouter");
    });
    expect(screen.queryByText("当前")).toBeNull();
    server.close();
  });

  it("内置预设 API key 类：协议与地址只读、可改密钥、刷新/删除与模型搜索可用", async () => {
    const server = fakeServer(
      withInit({
        "provider.describeProviders": { providers: [PROVIDER] },
        "provider.listProviderPresets": [OPENROUTER_PRESET],
        "runtime.defaultModel": { provider: "openrouter", model: "anthropic/claude-sonnet-4" },
        "provider.listModelSettings": MODEL_SETTINGS,
      }),
    );
    await server.initialize();
    render(<ProvidersPage {...pageProps({ client: server.client })} />);
    await screen.findByText("Claude Sonnet 4");
    expect(button("刷新")).toBeTruthy();
    const delBtn = button("删除");
    expect(delBtn.disabled).toBe(false);
    expect(delBtn.classList.contains("btn-danger")).toBe(true);
    expect((screen.getByLabelText("协议") as HTMLInputElement).readOnly).toBe(true);
    const urlInput = screen.getByLabelText("服务地址") as HTMLInputElement;
    expect(urlInput.readOnly).toBe(true);
    expect(urlInput.value).toBe("https://openrouter.ai/api/v1");
    expect(screen.queryByLabelText("显示名称")).toBeNull();
    expect(screen.queryByLabelText("会话标识请求头")).toBeNull();
    const keyInput = screen.getByLabelText("API Key") as HTMLInputElement;
    expect(keyInput.type).toBe("password");
    expect(keyInput.placeholder).toBe("••••••••");
    expect(button("取消").disabled).toBe(true);
    expect(button("保存").disabled).toBe(true);

    expect(within(screen.getByRole("table", { name: "模型" })).getByText("默认")).toBeTruthy();
    expect(screen.queryByText("已编辑")).toBeNull();
    expect(screen.getByText("200,000")).toBeTruthy();
    expect(screen.getByText("64K")).toBeTruthy();
    // 搜索过滤
    fireEvent.change(screen.getByLabelText("搜索模型"), { target: { value: "gpt" } });
    expect(screen.queryByText("Claude Sonnet 4")).toBeNull();
    expect(screen.getByText("GPT 5 Pro")).toBeTruthy();
    // 行尾「设置」打开模型设置对话框
    fireEvent.click(screen.getByRole("button", { name: "设置 openai/gpt-5" }));
    expect(await screen.findByRole("dialog", { name: "模型设置 · openai/gpt-5" })).toBeTruthy();
    server.close();
  });

  it("只改密钥只调 setCredential，保存后清空输入框并恢复置灰", async () => {
    const server = fakeServer(
      withInit({
        "provider.describeProviders": { providers: [PROVIDER] },
        "provider.listProviderPresets": [OPENROUTER_PRESET],
        "runtime.defaultModel": null,
        "provider.listModelSettings": MODEL_SETTINGS,
        "provider.setCredential": null,
      }),
    );
    await server.initialize();
    render(<ProvidersPage {...pageProps({ client: server.client })} />);
    await screen.findByText("Claude Sonnet 4");
    const input = screen.getByLabelText("API Key") as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(button("取消").disabled).toBe(true);
    expect(button("保存").disabled).toBe(true);
    fireEvent.change(input, { target: { value: "sk-new" } });
    expect(button("取消").disabled).toBe(false);
    expect(button("保存").disabled).toBe(false);
    fireEvent.click(button("保存"));
    await waitFor(() => {
      expect(server.calls.some((c) => c.method === "provider.setCredential")).toBe(true);
    });
    expect(server.calls.some((c) => c.method === "provider.updateSetupProvider")).toBe(false);
    expect(server.calls.some((c) => c.method === "provider.probeSetupProviderModels")).toBe(false);
    await waitFor(() => {
      expect(input.value).toBe("");
      expect(button("取消").disabled).toBe(true);
      expect(button("保存").disabled).toBe(true);
    });
    server.close();
  });

  it("删除：会话在用时置灰并说明原因；外部配置的条目只读且地址显示完整 URL", async () => {
    const READONLY: ProviderOverview = {
      ...PROVIDER,
      id: "local",
      origin: "user",
      managed: false,
      baseURL: "http://127.0.0.1:8080/v1",
    };
    const server = fakeServer(
      withInit({
        "provider.describeProviders": { providers: [PROVIDER, READONLY] },
        "provider.listProviderPresets": [OPENROUTER_PRESET],
        "runtime.defaultModel": null,
        "provider.listModelSettings": [],
      }),
    );
    await server.initialize();
    render(
      <ProvidersPage {...pageProps({ client: server.client, inUse: new Set(["openrouter"]) })} />,
    );
    await screen.findByText("没有模型");
    let delBtn = button("删除");
    expect(delBtn.disabled).toBe(true);
    expect(delBtn.getAttribute("title")).toBe("当前会话正在使用，不能删除");
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "服务商列表" })).getByRole("button", {
        name: /^local/,
      }),
    );
    await waitFor(() => {
      expect(screen.getByText("只读").getAttribute("title")).toBe("来自 config.json，请修改该文件");
    });
    delBtn = button("删除");
    expect(delBtn.getAttribute("title")).toBe("来自 config.json，请修改该文件");
    expect(delBtn.disabled).toBe(true);
    expect((screen.getByLabelText("协议") as HTMLInputElement).readOnly).toBe(true);
    const urlInput = screen.getByLabelText("服务地址") as HTMLInputElement;
    expect(urlInput.readOnly).toBe(true);
    expect(urlInput.value).toBe("http://127.0.0.1:8080/v1");
    expect(screen.queryByLabelText("API Key")).toBeNull();
    expect(screen.queryByLabelText("显示名称")).toBeNull();
    expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
    expect(screen.queryByRole("button", { name: "取消" })).toBeNull();
    server.close();
  });

  it("页头「删除」按钮调用 removeSetupProvider", async () => {
    const server = fakeServer(
      withInit({
        "provider.describeProviders": { providers: [PROVIDER] },
        "provider.listProviderPresets": [OPENROUTER_PRESET],
        "runtime.defaultModel": null,
        "provider.listModelSettings": [],
        "provider.removeSetupProvider": null,
      }),
    );
    await server.initialize();
    render(<ProvidersPage {...pageProps({ client: server.client })} />);
    await screen.findByText("没有模型");
    fireEvent.click(button("删除"));
    const dlg = await screen.findByRole("dialog", { name: "删除 openrouter？" });
    fireEvent.click(within(dlg).getByRole("button", { name: "删除" }));
    await waitFor(() => {
      expect(called(server, "provider.removeSetupProvider", "providerId", "openrouter")).toBe(true);
    });
    server.close();
  });
});

describe("添加服务商", () => {
  it("获取结果先折叠成前几个模型，展开为表格（能力、上下文、最大输出），可再收起", async () => {
    const server = fakeServer(
      withInit({
        "provider.describeProviders": { providers: [] },
        "provider.listProviderPresets": [PRESET],
        "runtime.defaultModel": null,
        "provider.describeProviderSetup": SETUP,
        "provider.prepareProvider": PREPARED,
        "provider.discardProvider": null,
      }),
    );
    await server.initialize();
    render(<ProvidersPage {...pageProps({ client: server.client })} />);
    await openForm();
    fireEvent.click(button("获取模型"));
    const peek = await screen.findByTestId("fetched-peek");
    expect(peek.textContent).toContain("vendor/model-1");
    expect(peek.textContent).toContain("vendor/model-4");
    expect(peek.textContent).not.toContain("vendor/model-5");
    expect(peek.textContent).toContain("等 116 个");

    const toggle = screen.getByRole("button", { name: /展开全部/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    const list = screen.getByTestId("fetched-list");
    expect(screen.queryByTestId("fetched-peek")).toBeNull();
    expect(within(list).getAllByRole("row").slice(1)).toHaveLength(120);
    const first = within(list).getAllByRole("row")[1];
    expect(first ? within(first).getAllByRole("cell")[1]?.textContent : undefined).toBe("RI");
    expect(first?.textContent).toContain("128,000");

    fireEvent.click(screen.getByRole("button", { name: /收起/ }));
    expect(screen.getByTestId("fetched-peek")).toBeTruthy();
    server.close();
  });

  it("获取模型前保存置灰；获取后可保存；改字段后重新置灰并释放草稿", async () => {
    const server = fakeServer(
      withInit({
        "provider.describeProviders": { providers: [] },
        "provider.listProviderPresets": [PRESET],
        "runtime.defaultModel": null,
        "provider.describeProviderSetup": SETUP,
        "provider.prepareProvider": PREPARED,
        "provider.discardProvider": null,
      }),
    );
    await server.initialize();
    render(<ProvidersPage {...pageProps({ client: server.client })} />);
    fireEvent.click(await screen.findByRole("button", { name: new RegExp(PRESET.label) }));
    await screen.findByText(`添加 ${PRESET.label}`);
    expect(button("保存").disabled).toBe(true);
    expect(button("获取模型").disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "test-provider" } });
    const keyInput = screen.getByLabelText("API Key");
    expect(keyInput.getAttribute("type")).toBe("password");
    expect(keyInput.getAttribute("placeholder")).toBeNull();
    fireEvent.change(keyInput, { target: { value: "sk-test" } });
    fireEvent.click(button("获取模型"));
    await screen.findByRole("region", { name: "模型 · 120 个" });
    expect(button("保存").disabled).toBe(false);
    const prepare = server.calls.find((c) => c.method === "provider.prepareProvider");
    expect(prepare?.params.name).toBe("test-provider");
    // 改字段 → 结果作废，保存重新置灰，草稿释放
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "test-provider-2" } });
    await waitFor(() => {
      expect(button("保存").disabled).toBe(true);
    });
    expect(screen.queryByRole("region", { name: "模型 · 120 个" })).toBeNull();
    await waitFor(() => {
      expect(called(server, "provider.discardProvider", "draftId", "draft-1")).toBe(true);
    });
    server.close();
  });

  it("保存：commitProvider 后选中新服务商", async () => {
    let providers: ProviderOverview[] = [];
    const server = fakeServer(
      withInit({
        "provider.describeProviders": () => ({ providers }),
        "provider.listProviderPresets": [PRESET],
        "runtime.defaultModel": null,
        "provider.describeProviderSetup": SETUP,
        "provider.prepareProvider": PREPARED,
        "provider.listModelSettings": [],
        "provider.commitProvider": () => {
          providers = [{ ...PROVIDER, id: "test-provider" }];
          return { providerId: "test-provider", modelCount: 120 };
        },
      }),
    );
    await server.initialize();
    render(<ProvidersPage {...pageProps({ client: server.client })} />);
    await openForm();
    fireEvent.click(button("获取模型"));
    await screen.findByRole("region", { name: "模型 · 120 个" });
    fireEvent.click(button("保存"));
    await screen.findByRole("heading", { level: 2, name: "test-provider" });
    expect(called(server, "provider.commitProvider", "draftId", "draft-1")).toBe(true);
    server.close();
  });

  it("自定义预设不显示会话标识请求头与字段说明/可选/改用环境变量/粘贴密钥，获取模型在标题行右侧", async () => {
    const server = fakeServer(
      withInit({
        "provider.describeProviders": { providers: [] },
        "provider.listProviderPresets": [PRESET],
        "runtime.defaultModel": null,
        "provider.describeProviderSetup": {
          ...SETUP,
          fields: [
            ...SETUP.fields,
            {
              key: "sessionHeader",
              prompt: "会话标识请求头（可选，回车跳过）：",
              hint: "部分网关要求每个对话带固定的会话 ID",
              required: false,
            },
          ],
          credential: {
            ...SETUP.credential,
            methods: [
              {
                kind: "apiKey",
                label: "粘贴密钥",
                available: true,
                prompt: "API Key：",
                hint: "从控制台获取；输入不回显",
              },
              ...SETUP.credential.methods.slice(1),
            ],
          },
        },
        "provider.prepareProvider": PREPARED,
      }),
    );
    await server.initialize();
    render(<ProvidersPage {...pageProps({ client: server.client })} />);
    await openForm();
    const page = screen.getByTestId("providers-page");
    expect(screen.queryByLabelText(/会话标识请求头/)).toBeNull();
    expect(page.textContent).not.toContain("改用环境变量");
    expect(page.textContent).not.toContain("从控制台获取");
    expect(page.textContent).not.toContain("可选");
    expect(page.textContent).not.toContain("服务商 ID（回车确认）");
    expect(page.textContent).not.toContain("服务地址");
    expect(page.textContent).not.toContain("输入不回显");
    expect(
      (screen.getByLabelText("Base URL") as HTMLInputElement).getAttribute("placeholder"),
    ).toBeNull();
    expect(
      (screen.getByLabelText("API Key") as HTMLInputElement).getAttribute("placeholder"),
    ).toBeNull();
    const fetchBtn = button("获取模型");
    expect(fetchBtn.getAttribute("title")).toBeNull();
    expect(fetchBtn.parentElement?.classList.contains("ghead")).toBe(true);
    expect(fetchBtn.parentElement?.querySelector("h2")?.textContent).toBe("模型");
    fireEvent.click(fetchBtn);
    await screen.findByRole("region", { name: "模型 · 120 个" });
    expect(fetchBtn.parentElement?.querySelector("h2")?.textContent).toBe("模型 · 120 个");
    expect(page.textContent).not.toContain("已获取");
    expect(page.textContent).not.toContain("重新获取");
    server.close();
  });

  it("凭据后端不可用时显示环境变量栏且没有「改用密钥」与字段说明", async () => {
    const server = fakeServer(
      withInit({
        "provider.describeProviders": { providers: [] },
        "provider.listProviderPresets": [PRESET],
        "runtime.defaultModel": null,
        "provider.describeProviderSetup": {
          ...SETUP,
          credential: {
            backend: { kind: "none", available: false, label: "系统凭据" },
            methods: [
              {
                kind: "apiKey",
                label: "粘贴密钥",
                available: false,
                prompt: "API Key：",
                hint: "输入不回显",
              },
              {
                kind: "env",
                label: "环境变量",
                available: true,
                prompt: "凭据环境变量名 [OPENAI_API_KEY]：",
                hint: "读取已有环境变量",
                defaultName: "OPENAI_API_KEY",
              },
            ],
          },
        },
      }),
    );
    await server.initialize();
    render(<ProvidersPage {...pageProps({ client: server.client })} />);
    fireEvent.click(await screen.findByRole("button", { name: new RegExp(PRESET.label) }));
    const envInput = (await screen.findByLabelText("凭据环境变量名")) as HTMLInputElement;
    expect(envInput.value).toBe("OPENAI_API_KEY");
    expect(screen.queryByLabelText("API Key")).toBeNull();
    expect(screen.queryByRole("button", { name: "改用密钥" })).toBeNull();
    expect(screen.getByTestId("providers-page").textContent).not.toContain("读取已有环境变量");
    expect(screen.getByTestId("providers-page").textContent).not.toContain("改为读取环境变量");
    server.close();
  });

  it("字段错误显示在对应字段下（-32005 data.field）", async () => {
    const server = fakeServer(
      withInit({
        "provider.describeProviders": { providers: [] },
        "provider.listProviderPresets": [PRESET],
        "runtime.defaultModel": null,
        "provider.describeProviderSetup": SETUP,
        "provider.prepareProvider": () =>
          new RpcFail(-32005, "服务商 ID 已被占用", { field: "name" }),
      }),
    );
    await server.initialize();
    render(<ProvidersPage {...pageProps({ client: server.client })} />);
    await openForm();
    fireEvent.click(button("获取模型"));
    await screen.findByText("服务商 ID 已被占用");
    expect(screen.getByLabelText("名称").className).toContain("err");
    // 字段错误只写在字段下，结果区不再重复「获取失败」
    expect(screen.queryByText("获取失败")).toBeNull();
    server.close();
  });

  it("获取失败（非字段）显示原因，输入保留", async () => {
    const server = fakeServer(
      withInit({
        "provider.describeProviders": { providers: [] },
        "provider.listProviderPresets": [PRESET],
        "runtime.defaultModel": null,
        "provider.describeProviderSetup": SETUP,
        "provider.prepareProvider": () => new RpcFail(-32000, "401 Unauthorized"),
      }),
    );
    await server.initialize();
    render(<ProvidersPage {...pageProps({ client: server.client })} />);
    await openForm();
    fireEvent.click(button("获取模型"));
    await screen.findByText("401 Unauthorized");
    expect(screen.getByLabelText("名称")).toHaveProperty("value", "test-provider");
    expect(screen.getByLabelText("API Key")).toHaveProperty("value", "sk-test");
    server.close();
  });

  it("取消获取：立即回到可编辑，输入保留；迟到的草稿被释放", async () => {
    let release: (value: unknown) => void = noop;
    const server = fakeServer(
      withInit({
        "provider.describeProviders": { providers: [] },
        "provider.listProviderPresets": [PRESET],
        "runtime.defaultModel": null,
        "provider.describeProviderSetup": SETUP,
        "provider.prepareProvider": () =>
          new Promise((resolve) => {
            release = resolve;
          }),
        "provider.discardProvider": null,
      }),
    );
    await server.initialize();
    render(<ProvidersPage {...pageProps({ client: server.client })} />);
    await openForm();
    fireEvent.click(button("获取模型"));
    fireEvent.click(await screen.findByRole("button", { name: "取消获取" }));
    expect(button("获取模型").disabled).toBe(false);
    expect(button("保存").disabled).toBe(true);
    expect(screen.getByLabelText("名称")).toHaveProperty("value", "test-provider");
    release({ ...PREPARED, draftId: "late-draft" });
    await waitFor(() => {
      expect(called(server, "provider.discardProvider", "draftId", "late-draft")).toBe(true);
    });
    expect(screen.queryByRole("region", { name: /模型 ·/ })).toBeNull();
    server.close();
  });

  it("needsManualModel：显示模型 ID 输入框，填好才能保存", async () => {
    const server = fakeServer(
      withInit({
        "provider.describeProviders": { providers: [] },
        "provider.listProviderPresets": [PRESET],
        "runtime.defaultModel": null,
        "provider.describeProviderSetup": {
          ...SETUP,
          manualModel: { prompt: "模型 ID：", hint: "上游没有模型列表时手填" },
        },
        "provider.prepareProvider": { ...PREPARED, modelCount: 0, needsManualModel: true },
      }),
    );
    await server.initialize();
    render(<ProvidersPage {...pageProps({ client: server.client })} />);
    await openForm();
    fireEvent.click(button("获取模型"));
    const modelInput = await screen.findByLabelText("模型 ID");
    expect(screen.queryByText("上游没有模型列表时手填")).toBeNull();
    expect(button("保存").disabled).toBe(true);
    fireEvent.change(modelInput, { target: { value: "my-model" } });
    expect(button("保存").disabled).toBe(false);
    server.close();
  });

  it("放弃添加与离开表单都会 discardProvider 释放草稿", async () => {
    let prepared = 0;
    const server = fakeServer(
      withInit({
        "provider.describeProviders": { providers: [PROVIDER] },
        "provider.listProviderPresets": [PRESET],
        "runtime.defaultModel": null,
        "provider.describeProviderSetup": SETUP,
        "provider.listModelSettings": MODEL_SETTINGS,
        "provider.prepareProvider": () => {
          prepared += 1;
          return { ...PREPARED, draftId: `draft-${String(prepared)}` };
        },
        "provider.discardProvider": null,
      }),
    );
    await server.initialize();
    render(<ProvidersPage {...pageProps({ client: server.client })} />);
    await screen.findByText("Claude Sonnet 4");
    await openForm();
    fireEvent.click(button("获取模型"));
    await screen.findByRole("region", { name: "模型 · 120 个" });
    // 「取消」：释放草稿，表单清空
    fireEvent.click(button("取消"));
    await waitFor(() => {
      expect(called(server, "provider.discardProvider", "draftId", "draft-1")).toBe(true);
    });
    expect(screen.getByLabelText("名称")).toHaveProperty("value", "");
    // 再获取一次，然后切回已配置条目 → 卸载表单 → 释放
    await openForm();
    fireEvent.click(button("获取模型"));
    await screen.findByRole("region", { name: "模型 · 120 个" });
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "服务商列表" })).getByRole("button", {
        name: /^openrouter/,
      }),
    );
    await waitFor(() => {
      expect(called(server, "provider.discardProvider", "draftId", "draft-2")).toBe(true);
    });
    server.close();
  });

  it("点「添加服务商」出现选择页，自定义预设排在最后，左栏与按钮无选中态", async () => {
    const DEEPSEEK_PRESET: ProviderPreset = {
      id: "deepseek",
      label: "DeepSeek",
      type: "openai-compatible",
      defaultName: "deepseek",
      baseURL: "https://api.deepseek.com",
      fetchableModels: true,
    };
    const server = fakeServer(
      withInit({
        "provider.describeProviders": { providers: [EXPIRED] },
        "provider.listProviderPresets": [PRESET, OPENROUTER_PRESET, DEEPSEEK_PRESET],
        "runtime.defaultModel": null,
        "provider.listModelSettings": [],
      }),
    );
    await server.initialize();
    render(<ProvidersPage {...pageProps({ client: server.client })} />);
    await screen.findByText(/已配置 ·/);

    const addBtn = button("添加服务商");
    fireEvent.click(addBtn);
    await screen.findByRole("heading", { level: 2, name: "添加服务商" });
    expect(addBtn.getAttribute("aria-pressed")).toBeNull();
    expect(addBtn.getAttribute("aria-current")).toBeNull();
    const list = screen.getByRole("navigation", { name: "服务商列表" });
    expect(within(list).queryByRole("button", { current: true })).toBeNull();

    const cards = Array.from(document.querySelectorAll<HTMLButtonElement>(".addgrid .addcard"));
    expect(cards.map((c) => c.querySelector(".addcard-label")?.textContent)).toEqual([
      "OpenRouter",
      "DeepSeek",
      PRESET.label,
    ]);
    expect(cards.map((c) => c.querySelector(".addcard-ic")?.textContent)).toEqual(["", "", "+"]);
    expect(cards[0]?.querySelector(".addcard-ic .brand-icon.brand-icon-lg svg")).not.toBeNull();
    expect(cards[1]?.querySelector(".addcard-ic .brand-icon.brand-icon-lg svg")).not.toBeNull();

    fireEvent.click(button("返回"));
    await screen.findByRole("heading", { level: 2, name: "chatgpt" });
    server.close();
  });

  it("点卡片进入表单，点返回回到选择页并释放草稿", async () => {
    const server = fakeServer(
      withInit({
        "provider.describeProviders": { providers: [PROVIDER] },
        "provider.listProviderPresets": [PRESET, OPENROUTER_PRESET],
        "runtime.defaultModel": null,
        "provider.describeProviderSetup": SETUP,
        "provider.listModelSettings": MODEL_SETTINGS,
        "provider.prepareProvider": PREPARED,
        "provider.discardProvider": null,
      }),
    );
    await server.initialize();
    render(<ProvidersPage {...pageProps({ client: server.client })} />);
    await screen.findByText("Claude Sonnet 4");

    await openForm();
    fireEvent.click(button("获取模型"));
    await screen.findByRole("region", { name: "模型 · 120 个" });

    fireEvent.click(button("返回"));
    await screen.findByRole("heading", { level: 2, name: "添加服务商" });
    await waitFor(() => {
      expect(called(server, "provider.discardProvider", "draftId", "draft-1")).toBe(true);
    });
    server.close();
  });

  it("没有已配置服务商时默认显示选择页", async () => {
    const server = fakeServer(
      withInit({
        "provider.describeProviders": { providers: [] },
        "provider.listProviderPresets": [PRESET, OPENROUTER_PRESET],
        "runtime.defaultModel": null,
      }),
    );
    await server.initialize();
    render(<ProvidersPage {...pageProps({ client: server.client })} />);
    await screen.findByRole("heading", { level: 2, name: "添加服务商" });
    expect(screen.getByRole("button", { name: new RegExp(OPENROUTER_PRESET.label) })).toBeTruthy();
    expect(screen.getByRole("button", { name: new RegExp(PRESET.label) })).toBeTruthy();
    server.close();
  });
});

describe("登录", () => {
  it("重新登录：打开授权地址、等待卡片；取消调用 login.cancel", async () => {
    const server = fakeServer(
      withInit({
        "provider.describeProviders": { providers: [EXPIRED] },
        "provider.listProviderPresets": [],
        "runtime.defaultModel": null,
        "provider.listModelSettings": MODEL_SETTINGS,
        "provider.describeAccountStorage": null,
        "login.start": {
          loginId: "login-1",
          authorizeUrl: "https://chatgpt.com/authorize",
          expiresAt: Date.now() + 300_000,
          manualInput: "callback-url",
        },
        "login.cancel": null,
      }),
    );
    await server.initialize();
    const openUrl = vi.fn();
    render(<ProvidersPage {...pageProps({ client: server.client, openUrl })} />);
    fireEvent.click(await screen.findByRole("button", { name: "重新登录" }));
    await waitFor(() => {
      expect(openUrl).toHaveBeenCalledWith("https://chatgpt.com/authorize");
    });
    const card = await screen.findByTestId("login-wait");
    expect(card.textContent).toContain("等待浏览器授权");
    expect(card.textContent).toMatch(/\d:\d\d/);
    // 展开「粘贴回调地址」
    fireEvent.click(button("粘贴回调地址…"));
    expect(screen.getByLabelText("粘贴回调地址")).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: "取消" }));
    await waitFor(() => {
      expect(called(server, "login.cancel", "loginId", "login-1")).toBe(true);
    });
    await screen.findByRole("button", { name: "重新登录" });
    server.close();
  });
});

describe("模型设置对话框", () => {
  const OPEN_DIALOG = async (server: ReturnType<typeof fakeServer>) => {
    render(<ProvidersPage {...pageProps({ client: server.client })} />);
    await screen.findByText("Claude Sonnet 4");
    const first = (await screen.findAllByRole("button", { name: /^设置 / }))[0];
    if (first === undefined) throw new Error("缺少「设置」入口");
    fireEvent.click(first);
    await screen.findByRole("dialog");
  };

  it("保存：改动写 patch 调 saveModelSettings", async () => {
    const saved: { params?: Record<string, unknown> } = {};
    const server = fakeServer(
      withInit({
        "provider.describeProviders": { providers: [PROVIDER] },
        "provider.listProviderPresets": [],
        "runtime.defaultModel": null,
        "provider.listModelSettings": MODEL_SETTINGS,
        "provider.saveModelSettings": (params: Record<string, unknown>) => {
          saved.params = params;
          return null;
        },
      }),
    );
    await server.initialize();
    await OPEN_DIALOG(server);
    expect(screen.getByRole("dialog").querySelector(".marker")).toBeNull();
    expect(screen.queryByText("已编辑")).toBeNull();
    expect(screen.getByRole("dialog").textContent).not.toMatch(
      /用户编辑|models\.dev|\.json|userModels/,
    );
    fireEvent.change(screen.getByLabelText("显示名"), { target: { value: "Sonnet 4.5" } });
    const endpoint = screen.getByLabelText("接口地址") as HTMLInputElement;
    expect(endpoint.placeholder).toBe("https://api.test/v1");
    fireEvent.change(endpoint, { target: { value: "https://google.test/v1beta" } });
    fireEvent.click(button("Gemini"));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "保存" }));
    await waitFor(() => {
      expect(saved.params).toBeDefined();
    });
    expect(saved.params?.modelId).toBe("anthropic/claude-sonnet-4");
    expect((saved.params?.patch as Record<string, unknown>).displayName).toBe("Sonnet 4.5");
    expect(saved.params?.patch).toMatchObject({
      protocol: "gemini",
      baseURL: "https://google.test/v1beta",
    });
    server.close();
  });

  it("取消：不写任何内容", async () => {
    const server = fakeServer(
      withInit({
        "provider.describeProviders": { providers: [PROVIDER] },
        "provider.listProviderPresets": [],
        "runtime.defaultModel": null,
        "provider.listModelSettings": MODEL_SETTINGS,
      }),
    );
    await server.initialize();
    await OPEN_DIALOG(server);
    fireEvent.change(screen.getByLabelText("显示名"), { target: { value: "changed" } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(server.calls.some((c) => c.method === "provider.saveModelSettings")).toBe(false);
    server.close();
  });
});

describe("详情内联配置表单", () => {
  /** 自定义条目：id 不与任何 preset.defaultName 相同 → 可编辑 */
  const CUSTOM: ProviderOverview = {
    ...PROVIDER,
    id: "corp",
    host: "api.corp.test",
    baseURL: "https://api.corp.test/v1",
  };
  const ENTRY = {
    id: "corp",
    type: "openai-compatible",
    baseURL: "https://api.corp.test/v1",
    displayName: "Corp AI",
    headers: { "X-Team": "core" },
    sessionHeader: "X-Session",
    models: { m1: {}, m2: {} },
  };

  function openList() {
    const list = screen.getByRole("navigation", { name: "服务商列表" });
    return (text: string) =>
      within(list)
        .queryAllByRole("button")
        .find((a) => a.textContent?.startsWith(text));
  }

  async function selectCorp(entry: unknown = ENTRY) {
    await screen.findByText(/已配置 ·/);
    const row = openList()("corp") ?? openList()("Corp AI");
    if (row === undefined) throw new Error("缺少 corp 行");
    fireEvent.click(row);
    await waitFor(() => {
      expect((screen.getByLabelText("显示名称") as HTMLInputElement).value).toBe(
        (entry as { displayName?: string } | null)?.displayName ?? "",
      );
    });
  }

  it("内置预设条目协议与地址只读；自定义条目可编辑且无服务商 ID 栏", async () => {
    const server = fakeServer(
      withInit({
        "provider.describeProviders": { providers: [PROVIDER, CUSTOM] },
        "provider.listProviderPresets": [OPENROUTER_PRESET],
        "runtime.defaultModel": null,
        "provider.listModelSettings": [],
        "provider.describeSetupProvider": ENTRY,
      }),
    );
    await server.initialize();
    render(<ProvidersPage {...pageProps({ client: server.client })} />);
    await screen.findByText(/已配置 ·/);
    const row = openList();
    // openrouter 是内置预设条目（id === preset.defaultName）→ 协议与服务地址只读
    const openrouter = row("openrouter");
    if (openrouter === undefined) throw new Error("缺少 openrouter 行");
    fireEvent.click(openrouter);
    expect(((await screen.findByLabelText("协议")) as HTMLInputElement).readOnly).toBe(true);
    expect((screen.getByLabelText("服务地址") as HTMLInputElement).readOnly).toBe(true);
    expect(screen.queryByLabelText("显示名称")).toBeNull();
    // corp 是自定义条目 → 可编辑，且无服务商 ID 输入框
    const corp = row("corp");
    if (corp === undefined) throw new Error("缺少 corp 行");
    fireEvent.click(corp);
    await waitFor(() => {
      expect((screen.getByLabelText("显示名称") as HTMLInputElement).value).toBe("Corp AI");
    });
    expect(screen.queryByLabelText("服务商 ID")).toBeNull();
    expect((screen.getByLabelText("服务地址") as HTMLInputElement).readOnly).toBe(false);
    server.close();
  });

  it("没改动时取消/保存置灰，改动后可点，点取消恢复已保存值并重新置灰", async () => {
    const server = fakeServer(
      withInit({
        "provider.describeProviders": { providers: [CUSTOM] },
        "provider.listProviderPresets": [OPENROUTER_PRESET],
        "runtime.defaultModel": null,
        "provider.listModelSettings": [],
        "provider.describeSetupProvider": ENTRY,
      }),
    );
    await server.initialize();
    render(<ProvidersPage {...pageProps({ client: server.client })} />);
    await selectCorp();

    expect(button("取消").disabled).toBe(true);
    expect(button("保存").disabled).toBe(true);

    const nameInput = screen.getByLabelText("显示名称") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "临时名字" } });
    expect(button("取消").disabled).toBe(false);
    expect(button("保存").disabled).toBe(false);

    fireEvent.click(button("取消"));
    expect(nameInput.value).toBe("Corp AI");
    expect(button("取消").disabled).toBe(true);
    expect(button("保存").disabled).toBe(true);
    server.close();
  });

  it("预填当前值；地址未变时不探测、保存不携带 models", async () => {
    const server = fakeServer(
      withInit({
        "provider.describeProviders": { providers: [CUSTOM] },
        "provider.listProviderPresets": [OPENROUTER_PRESET],
        "runtime.defaultModel": null,
        "provider.listModelSettings": [],
        "provider.describeSetupProvider": ENTRY,
        "provider.probeSetupProviderModels": { models: [] },
        "provider.updateSetupProvider": {
          providerId: "corp",
          modelCount: 2,
          message: "已更新 corp",
        },
      }),
    );
    await server.initialize();
    render(<ProvidersPage {...pageProps({ client: server.client })} />);
    await selectCorp();

    expect((screen.getByLabelText("服务地址") as HTMLInputElement).value).toBe(
      "https://api.corp.test/v1",
    );
    expect((screen.getByLabelText("请求头 1 名称") as HTMLInputElement).value).toBe("X-Team");
    expect((screen.getByLabelText("请求头 1 值") as HTMLInputElement).value).toBe("core");
    expect((screen.getByLabelText("会话标识请求头") as HTMLInputElement).value).toBe("X-Session");
    const page = screen.getByTestId("providers-page");
    expect(page.textContent).not.toContain("必填");
    expect(page.textContent).not.toContain("地址或协议已变化");

    // 改显示名后保存（地址未变 → 不需要探测）
    fireEvent.change(screen.getByLabelText("显示名称"), { target: { value: "新名字" } });
    fireEvent.click(button("保存"));
    await waitFor(() => {
      expect(button("保存").disabled).toBe(true);
    });
    const call = server.calls.find((c) => c.method === "provider.updateSetupProvider");
    expect(call).toBeDefined();
    expect(call?.params.providerId).toBe("corp");
    expect(call?.params.patch).toMatchObject({
      displayName: "新名字",
      type: "openai-compatible",
      baseURL: "https://api.corp.test/v1",
      headers: { "X-Team": "core" },
      sessionHeader: "X-Session",
    });
    expect(call?.params.patch).not.toHaveProperty("models");
    expect(server.calls.some((c) => c.method === "provider.probeSetupProviderModels")).toBe(false);
    server.close();
  });

  it("同时改配置与密钥：先写条目再写密钥；写密钥失败保留密钥输入并显示错误", async () => {
    const server = fakeServer(
      withInit({
        "provider.describeProviders": { providers: [CUSTOM] },
        "provider.listProviderPresets": [OPENROUTER_PRESET],
        "runtime.defaultModel": null,
        "provider.listModelSettings": [],
        "provider.describeSetupProvider": ENTRY,
        "provider.updateSetupProvider": {
          providerId: "corp",
          modelCount: 2,
          message: "已更新 corp",
        },
        "provider.setCredential": new RpcFail(-32000, "凭据后端不可用"),
      }),
    );
    await server.initialize();
    render(<ProvidersPage {...pageProps({ client: server.client })} />);
    await selectCorp();

    fireEvent.change(screen.getByLabelText("显示名称"), { target: { value: "新名字" } });
    const keyInput = screen.getByLabelText("API Key") as HTMLInputElement;
    fireEvent.change(keyInput, { target: { value: "sk-next" } });
    fireEvent.click(button("保存"));

    await screen.findByText("凭据后端不可用");
    const writeMethods = server.calls
      .filter(
        (c) => c.method === "provider.updateSetupProvider" || c.method === "provider.setCredential",
      )
      .map((c) => c.method);
    expect(writeMethods).toEqual(["provider.updateSetupProvider", "provider.setCredential"]);
    expect(keyInput.value).toBe("sk-next");
    expect(button("保存").disabled).toBe(false);
    server.close();
  });

  it("地址变化时点保存自动先探测，成功后携带新清单保存", async () => {
    const server = fakeServer(
      withInit({
        "provider.describeProviders": { providers: [CUSTOM] },
        "provider.listProviderPresets": [OPENROUTER_PRESET],
        "runtime.defaultModel": { provider: "corp", model: "m1" },
        "provider.listModelSettings": [],
        "provider.describeSetupProvider": ENTRY,
        "provider.probeSetupProviderModels": {
          models: [{ id: "m1", contextWindow: 100 }, { id: "m3" }],
        },
        "provider.updateSetupProvider": {
          providerId: "corp",
          modelCount: 2,
          message: "已更新 corp，2 个模型",
        },
      }),
    );
    await server.initialize();
    render(<ProvidersPage {...pageProps({ client: server.client })} />);
    await selectCorp();

    fireEvent.change(screen.getByLabelText("服务地址"), {
      target: { value: "https://api.corp.test/v2" },
    });
    expect(button("保存").disabled).toBe(false);
    fireEvent.click(button("保存"));

    await waitFor(() => {
      expect(server.calls.some((c) => c.method === "provider.updateSetupProvider")).toBe(true);
    });
    const probe = server.calls.find((c) => c.method === "provider.probeSetupProviderModels");
    expect(probe?.params).toMatchObject({
      providerId: "corp",
      type: "openai-compatible",
      baseURL: "https://api.corp.test/v2",
      headers: { "X-Team": "core" },
    });
    const call = server.calls.find((c) => c.method === "provider.updateSetupProvider");
    expect(call?.params.patch).toMatchObject({
      baseURL: "https://api.corp.test/v2",
      models: [{ id: "m1", contextWindow: 100 }, { id: "m3" }],
    });
    server.close();
  });

  it("在用模型不在新清单里时给出警告并要求再点一次「保存」确认", async () => {
    const server = fakeServer(
      withInit({
        "provider.describeProviders": { providers: [CUSTOM] },
        "provider.listProviderPresets": [OPENROUTER_PRESET],
        "runtime.defaultModel": { provider: "corp", model: "m1" },
        "provider.listModelSettings": [],
        "provider.describeSetupProvider": ENTRY,
        "provider.probeSetupProviderModels": { models: [{ id: "m9" }] },
        "provider.updateSetupProvider": {
          providerId: "corp",
          modelCount: 1,
          message: "已更新 corp，1 个模型",
        },
      }),
    );
    await server.initialize();
    render(<ProvidersPage {...pageProps({ client: server.client })} />);
    await selectCorp();

    fireEvent.change(screen.getByLabelText("服务地址"), {
      target: { value: "https://api.corp.test/v2" },
    });
    fireEvent.click(button("保存"));
    await screen.findByText(/在用的 m1 不在新列表里，保存后需重新选择模型/);
    expect(server.calls.some((c) => c.method === "provider.updateSetupProvider")).toBe(false);

    fireEvent.click(button("保存"));
    await waitFor(() => {
      expect(server.calls.some((c) => c.method === "provider.updateSetupProvider")).toBe(true);
    });
    expect(
      server.calls.find((c) => c.method === "provider.updateSetupProvider")?.params.patch,
    ).toMatchObject({
      baseURL: "https://api.corp.test/v2",
      models: [{ id: "m9" }],
    });
    server.close();
  });

  it("探测失败错误显示在服务地址下方，按钮变为「仍然保存」（不携带 models）", async () => {
    const server = fakeServer(
      withInit({
        "provider.describeProviders": { providers: [CUSTOM] },
        "provider.listProviderPresets": [OPENROUTER_PRESET],
        "runtime.defaultModel": null,
        "provider.listModelSettings": [],
        "provider.describeSetupProvider": ENTRY,
        "provider.probeSetupProviderModels": new RpcFail(-32000, "连接超时"),
        "provider.updateSetupProvider": {
          providerId: "corp",
          modelCount: 2,
          message: "已更新 corp",
        },
      }),
    );
    await server.initialize();
    render(<ProvidersPage {...pageProps({ client: server.client })} />);
    await selectCorp();

    const urlInput = screen.getByLabelText("服务地址");
    fireEvent.change(urlInput, { target: { value: "https://api.corp.test/v2" } });
    fireEvent.click(button("保存"));
    await screen.findByText(/连接超时/);
    expect(urlInput.className).toContain("err");
    fireEvent.click(button("仍然保存"));
    await waitFor(() => {
      expect(server.calls.some((c) => c.method === "provider.updateSetupProvider")).toBe(true);
    });
    const call = server.calls.find((c) => c.method === "provider.updateSetupProvider");
    expect(call?.params.patch).toMatchObject({ baseURL: "https://api.corp.test/v2" });
    expect(call?.params.patch).not.toHaveProperty("models");
    server.close();
  });

  it("describeSetupProvider 返回 null：表单下显示错误", async () => {
    const server = fakeServer(
      withInit({
        "provider.describeProviders": { providers: [CUSTOM] },
        "provider.listProviderPresets": [OPENROUTER_PRESET],
        "runtime.defaultModel": null,
        "provider.listModelSettings": [],
        "provider.describeSetupProvider": null,
      }),
    );
    await server.initialize();
    render(<ProvidersPage {...pageProps({ client: server.client })} />);
    await screen.findByText(/不是向导写入的条目/);
    server.close();
  });

  it("服务端字段错误映射到对应输入并允许重试", async () => {
    const server = fakeServer(
      withInit({
        "provider.describeProviders": { providers: [CUSTOM] },
        "provider.listProviderPresets": [OPENROUTER_PRESET],
        "runtime.defaultModel": null,
        "provider.listModelSettings": [],
        "provider.describeSetupProvider": ENTRY,
        "provider.updateSetupProvider": new RpcFail(-32005, "请求头名称无效", {
          field: "sessionHeader",
        }),
      }),
    );
    await server.initialize();
    render(<ProvidersPage {...pageProps({ client: server.client })} />);
    await selectCorp();

    fireEvent.change(screen.getByLabelText("会话标识请求头"), { target: { value: "bad header" } });
    fireEvent.click(button("保存"));
    await screen.findByText("请求头名称无效");
    expect(screen.getByLabelText("会话标识请求头").className).toContain("err");
    expect(button("保存").disabled).toBe(false);
    server.close();
  });

  it("上游声明的最大输出 >= 上下文窗口时显示为可疑（删除线与悬停说明），手填值不受影响", async () => {
    const firstModel = MODEL_SETTINGS[0];
    if (firstModel === undefined) throw new Error("缺少 MODEL_SETTINGS[0]");
    const baseFields = firstModel.fields;
    const server = fakeServer(
      withInit({
        "provider.describeProviders": { providers: [PROVIDER] },
        "provider.listProviderPresets": [PRESET],
        "runtime.defaultModel": null,
        "provider.listModelSettings": [
          {
            providerId: "openrouter",
            modelId: "xai/grok-4.7",
            enabled: true,
            fields: {
              ...baseFields,
              displayName: { value: "Grok 4.7", editable: true, source: { kind: "upstream" } },
              contextWindow: { value: 256000, editable: true, source: { kind: "upstream" } },
              maxOutputTokens: {
                value: undefined,
                lowerValue: 500000,
                editable: true,
                source: { kind: "upstream" },
              },
            },
          },
          {
            providerId: "openrouter",
            modelId: "xai/grok-user",
            enabled: true,
            fields: {
              ...baseFields,
              displayName: { value: "Grok User", editable: true, source: { kind: "upstream" } },
              contextWindow: { value: 256000, editable: true, source: { kind: "upstream" } },
              maxOutputTokens: {
                value: 256000,
                userValue: 256000,
                lowerValue: 500000,
                editable: true,
                source: { kind: "user" },
              },
            },
          },
        ],
      }),
    );
    await server.initialize();
    render(<ProvidersPage {...pageProps({ client: server.client })} />);
    const suspicious = await screen.findByText("500K");
    expect(suspicious.classList.contains("implausible")).toBe(true);
    expect(suspicious.getAttribute("title")).toBe("上游声明的最大输出不小于上下文窗口，已忽略");

    const handFilled = await screen.findByText("250K");
    expect(handFilled.classList.contains("implausible")).toBe(false);
    expect(handFilled.getAttribute("title")).toBeNull();
    server.close();
  });

  it("左栏列表、详情标题和添加选择页渲染服务商图标，自定义预设保留 +", async () => {
    const server = fakeServer(
      withInit({
        "provider.describeProviders": { providers: [EXPIRED] },
        "provider.listProviderPresets": [OPENROUTER_PRESET, PRESET],
        "runtime.defaultModel": null,
        "provider.listModelSettings": [],
      }),
    );
    await server.initialize();
    render(<ProvidersPage {...pageProps({ client: server.client })} />);
    const list = await screen.findByRole("navigation", { name: "服务商列表" });
    await waitFor(() => expect(within(list).queryByRole("button")).not.toBeNull());
    const item = within(list).getByRole("button", { name: /chatgpt/ });
    const itemChildren = Array.from(item.children);
    expect(itemChildren[0]?.classList.contains("brand-icon")).toBe(true);
    expect(itemChildren.at(-1)?.classList.contains("dot")).toBe(true);

    const heading = screen.getByRole("heading", { level: 2, name: "chatgpt" });
    expect(heading.previousElementSibling?.classList.contains("brand-icon")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "添加服务商" }));
    const orCard = await screen.findByRole("button", { name: /OpenRouter/ });
    const customCard = screen.getByRole("button", { name: /自定义 OpenAI 兼容/ });
    expect(orCard.querySelector(".addcard-ic .brand-icon.brand-icon-lg")).not.toBeNull();
    expect(customCard.querySelector(".addcard-ic")?.textContent).toBe("+");
    server.close();
  });
});
