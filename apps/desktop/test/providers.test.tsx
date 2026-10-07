/**
 * 服务商页测试（假服务端）：列表渲染、获取前置灰、字段错误、草稿释放、取消获取、
 * 内联重新登录与取消、删除置灰、模型设置保存/取消。
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  auth: "API Key · 凭据存储",
  credentialStatus: "valid",
  credentialStorage: "system",
  authKind: "apiKey",
  keySource: "credential",
  origin: "setup",
  overridden: false,
  modelCount: 2,
  managed: true,
};

const EXPIRED: ProviderOverview = {
  id: "chatgpt",
  type: "openai-compatible",
  host: "chatgpt.com",
  auth: "ChatGPT 账号",
  credentialStatus: "expired",
  credentialStorage: "system",
  authKind: "account",
  keySource: "credential",
  origin: "setup",
  overridden: false,
  modelCount: 1,
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
  await screen.findByText("可添加");
  fireEvent.click(screen.getByText(PRESET.label, { selector: "nav.plist .nm" }));
  await screen.findByText(`添加 ${PRESET.label}`);
  fireEvent.change(screen.getByLabelText("名称"), { target: { value: name } });
  fireEvent.change(screen.getByPlaceholderText("粘贴密钥"), { target: { value: "sk-test" } });
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
  it("渲染已配置/可添加两组、当前标记、模型数与失效标黄", async () => {
    const server = fakeServer(
      withInit({
        "provider.describeProviders": { providers: [PROVIDER, EXPIRED] },
        "provider.listProviderPresets": [PRESET, OPENROUTER_PRESET],
        "runtime.defaultModel": { provider: "openrouter", model: "anthropic/claude-sonnet-4" },
        "provider.listModelSettings": MODEL_SETTINGS,
      }),
    );
    await server.initialize();
    const onOpenModels = vi.fn();
    render(
      <ProvidersPage
        {...pageProps({ client: server.client, currentProvider: "openrouter" })}
        onOpenModels={onOpenModels}
      />,
    );
    await screen.findByText("已配置");
    const list = screen.getByRole("navigation", { name: "服务商列表" });
    const row = (text: string) =>
      [...list.querySelectorAll("a")].find((a) => a.querySelector(".nm")?.textContent === text);
    await waitFor(() => expect(row("openrouter")).toBeDefined());
    expect(row("openrouter")?.textContent).toContain("当前");
    expect(row("openrouter")?.textContent).toContain("2 个模型");
    const page = screen.getByTestId("providers-page");
    const heading = page.querySelector(".provider-heading");
    expect(heading?.querySelector("h3")?.textContent).toBe("openrouter");
    expect(heading?.querySelector(".tagc")?.textContent).toBe("当前");
    expect(heading?.querySelector(".acts")).toBeNull();
    expect(page.querySelector(".t1 > .acts")).not.toBeNull();
    await screen.findByText("Claude Sonnet 4");
    expect(page.querySelectorAll(".mr .model-context")).toHaveLength(3);
    expect(page.querySelectorAll(".mr .model-output")).toHaveLength(3);
    expect(page.querySelector(".mr .m")).not.toBeNull();
    expect(page.querySelector(".mr .cap")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "模型" }));
    expect(onOpenModels).toHaveBeenCalledTimes(1);
    expect(row("chatgpt")?.querySelector(".r.warn")?.textContent).toContain("已失效");
    // 已配置的 openrouter 不再出现在「可添加」；自定义预设始终可添加
    expect(row("OpenRouter")).toBeUndefined();
    expect(row(PRESET.label)).toBeDefined();
    // 切到 chatgpt（账号类、已失效）：内联重新登录横幅，无「换密钥」
    const chatgpt = row("chatgpt");
    if (chatgpt === undefined) throw new Error("缺少 chatgpt 行");
    fireEvent.click(chatgpt);
    await screen.findByText("账号登录已失效");
    expect(screen.getByRole("button", { name: "重新登录" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "换密钥" })).toBeNull();
    server.close();
  });

  it("没有打开的会话时，「当前」落到默认模型的服务商，并默认选中它", async () => {
    const server = fakeServer(
      withInit({
        "provider.describeProviders": { providers: [EXPIRED, PROVIDER] },
        "provider.listProviderPresets": [PRESET],
        "runtime.defaultModel": { provider: "openrouter", model: "anthropic/claude-sonnet-4" },
        "provider.listModelSettings": MODEL_SETTINGS,
      }),
    );
    await server.initialize();
    render(<ProvidersPage {...pageProps({ client: server.client })} />);
    const list = await screen.findByRole("navigation", { name: "服务商列表" });
    await waitFor(() => {
      expect(list.querySelector("a.on .nm")?.textContent).toBe("openrouter");
    });
    expect(list.querySelector("a.on")?.textContent).toContain("当前");
    server.close();
  });

  it("API key 类：换密钥 / 刷新 / 删除；模型列表的默认、已编辑、能力列、搜索与「设置」入口", async () => {
    const server = fakeServer(
      withInit({
        "provider.describeProviders": { providers: [PROVIDER] },
        "provider.listProviderPresets": [],
        "runtime.defaultModel": { provider: "openrouter", model: "anthropic/claude-sonnet-4" },
        "provider.listModelSettings": MODEL_SETTINGS,
      }),
    );
    await server.initialize();
    render(<ProvidersPage {...pageProps({ client: server.client })} />);
    await screen.findByText("Claude Sonnet 4");
    expect(button("换密钥")).toBeTruthy();
    expect(button("刷新模型列表")).toBeTruthy();
    expect(button("删除").disabled).toBe(false);
    expect(screen.getByText("默认", { selector: ".dflt" })).toBeTruthy();
    expect(screen.getByText("已编辑")).toBeTruthy();
    expect(screen.getByText("200,000")).toBeTruthy();
    expect(screen.getByText("64K")).toBeTruthy();
    // 搜索过滤
    fireEvent.change(screen.getByLabelText("搜索模型"), { target: { value: "gpt" } });
    expect(screen.queryByText("Claude Sonnet 4")).toBeNull();
    expect(screen.getByText("GPT 5 Pro")).toBeTruthy();
    // 行尾「设置」打开模型设置对话框
    fireEvent.click(screen.getByText("设置", { selector: "a.lnk" }));
    expect(await screen.findByRole("dialog", { name: "模型设置 · openai/gpt-5" })).toBeTruthy();
    server.close();
  });

  it("换密钥：password 输入，提交 setCredential", async () => {
    const server = fakeServer(
      withInit({
        "provider.describeProviders": { providers: [PROVIDER] },
        "provider.listProviderPresets": [],
        "runtime.defaultModel": null,
        "provider.listModelSettings": MODEL_SETTINGS,
        "provider.setCredential": null,
      }),
    );
    await server.initialize();
    render(<ProvidersPage {...pageProps({ client: server.client })} />);
    await screen.findByText("Claude Sonnet 4");
    fireEvent.click(button("换密钥"));
    const input = await screen.findByLabelText("新的 API Key");
    expect(input.getAttribute("type")).toBe("password");
    fireEvent.change(input, { target: { value: "sk-new" } });
    fireEvent.click(button("保存"));
    await waitFor(() => {
      expect(server.calls.some((c) => c.method === "provider.setCredential")).toBe(true);
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    server.close();
  });

  it("删除：会话在用时置灰并说明原因；外部配置的条目只读", async () => {
    const READONLY: ProviderOverview = { ...PROVIDER, id: "local", origin: "user", managed: false };
    const server = fakeServer(
      withInit({
        "provider.describeProviders": { providers: [PROVIDER, READONLY] },
        "provider.listProviderPresets": [],
        "runtime.defaultModel": null,
        "provider.listModelSettings": [],
      }),
    );
    await server.initialize();
    render(
      <ProvidersPage {...pageProps({ client: server.client, inUse: new Set(["openrouter"]) })} />,
    );
    await screen.findByText("没有模型");
    expect(button("删除").disabled).toBe(true);
    expect(button("删除").parentElement?.getAttribute("title")).toBe("当前会话正在使用，不能删除");
    fireEvent.click(screen.getByText("local", { selector: "nav.plist .nm" }));
    await waitFor(() => {
      expect(button("删除").parentElement?.getAttribute("title")).toMatch(/只读/);
    });
    expect(button("删除").disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "换密钥" })).toBeNull();
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
    expect(list.querySelectorAll(".fbody .fr")).toHaveLength(120);
    const first = list.querySelector(".fbody .fr");
    expect(first?.querySelector(".cap")?.textContent).toBe("RI");
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
    await screen.findByText(`添加 ${PRESET.label}`);
    expect(button("保存").disabled).toBe(true);
    expect(button("获取模型").disabled).toBe(true);
    await openForm();
    expect(screen.getByPlaceholderText("粘贴密钥").getAttribute("type")).toBe("password");
    fireEvent.click(button("获取模型"));
    await screen.findByText(/已获取 120 个模型/);
    expect(button("保存").disabled).toBe(false);
    const prepare = server.calls.find((c) => c.method === "provider.prepareProvider");
    expect(prepare?.params.name).toBe("test-provider");
    // 改字段 → 结果作废，保存重新置灰，草稿释放
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "test-provider-2" } });
    await waitFor(() => {
      expect(button("保存").disabled).toBe(true);
    });
    expect(screen.queryByText(/已获取 120 个模型/)).toBeNull();
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
    await screen.findByText(/已获取 120 个模型/);
    fireEvent.click(button("保存"));
    await screen.findByText("test-provider", { selector: "h3" });
    expect(called(server, "provider.commitProvider", "draftId", "draft-1")).toBe(true);
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
    expect(screen.getByPlaceholderText("粘贴密钥")).toHaveProperty("value", "sk-test");
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
    expect(screen.queryByText(/已获取/)).toBeNull();
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
    await screen.findByText(/已获取 120 个模型/);
    // 「取消」：释放草稿，表单清空
    fireEvent.click(button("取消"));
    await waitFor(() => {
      expect(called(server, "provider.discardProvider", "draftId", "draft-1")).toBe(true);
    });
    expect(screen.getByLabelText("名称")).toHaveProperty("value", "");
    // 再获取一次，然后切回已配置条目 → 卸载表单 → 释放
    await openForm();
    fireEvent.click(button("获取模型"));
    await screen.findByText(/已获取 120 个模型/);
    fireEvent.click(screen.getByText("openrouter", { selector: "nav.plist .nm" }));
    await waitFor(() => {
      expect(called(server, "provider.discardProvider", "draftId", "draft-2")).toBe(true);
    });
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
    fireEvent.click(button("取消"));
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
    const first = (await screen.findAllByText("设置", { selector: "a.lnk" }))[0];
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
    fireEvent.change(screen.getByLabelText("显示名"), { target: { value: "Sonnet 4.5" } });
    fireEvent.click(button("保存"));
    await waitFor(() => {
      expect(saved.params).toBeDefined();
    });
    expect(saved.params?.modelId).toBe("anthropic/claude-sonnet-4");
    expect((saved.params?.patch as Record<string, unknown>).displayName).toBe("Sonnet 4.5");
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
    fireEvent.click(button("取消"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(server.calls.some((c) => c.method === "provider.saveModelSettings")).toBe(false);
    server.close();
  });
});

describe("编辑服务商（U-07）", () => {
  /** 自定义条目：id 不与任何 preset.defaultName 相同 → 可编辑 */
  const CUSTOM: ProviderOverview = {
    ...PROVIDER,
    id: "corp",
    host: "api.corp.test",
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

  function openList(server: ReturnType<typeof fakeServer>) {
    void server;
    const list = screen.getByRole("navigation", { name: "服务商列表" });
    return (text: string) =>
      [...list.querySelectorAll("a")].find((a) => a.querySelector(".nm")?.textContent === text);
  }

  async function openEditDialog(server: ReturnType<typeof fakeServer>, entry: unknown = ENTRY) {
    await screen.findByText("已配置");
    const row = openList(server)("corp");
    if (row === undefined) throw new Error("缺少 corp 行");
    fireEvent.click(row);
    const edit = await screen.findByRole("button", { name: "编辑" });
    fireEvent.click(edit);
    const dialog = await screen.findByRole("dialog", { name: "编辑 corp" });
    await waitFor(() => {
      expect((screen.getByLabelText("显示名称") as HTMLInputElement).value).toBe(
        (entry as { displayName?: string } | null)?.displayName ?? "",
      );
    });
    return dialog;
  }

  it("内置预设条目没有「编辑」；自定义条目有", async () => {
    const server = fakeServer(
      withInit({
        "provider.describeProviders": { providers: [PROVIDER, CUSTOM] },
        "provider.listProviderPresets": [OPENROUTER_PRESET],
        "runtime.defaultModel": null,
        "provider.listModelSettings": [],
      }),
    );
    await server.initialize();
    render(<ProvidersPage {...pageProps({ client: server.client })} />);
    await screen.findByText("已配置");
    const row = openList(server);
    // openrouter 是内置预设条目（id === preset.defaultName）→ 只读
    const openrouter = row("openrouter");
    if (openrouter === undefined) throw new Error("缺少 openrouter 行");
    fireEvent.click(openrouter);
    await screen.findByRole("button", { name: "换密钥" });
    expect(screen.queryByRole("button", { name: "编辑" })).toBeNull();
    // corp 是自定义条目 → 可编辑
    const corp = row("corp");
    if (corp === undefined) throw new Error("缺少 corp 行");
    fireEvent.click(corp);
    await screen.findByRole("button", { name: "编辑" });
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
    const dialog = await openEditDialog(server);

    expect((screen.getByLabelText("服务商 ID") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("服务地址") as HTMLInputElement).value).toBe(
      "https://api.corp.test/v1",
    );
    expect((screen.getByLabelText("请求头 1 名称") as HTMLInputElement).value).toBe("X-Team");
    expect((screen.getByLabelText("请求头 1 值") as HTMLInputElement).value).toBe("core");
    expect((screen.getByLabelText("会话标识请求头") as HTMLInputElement).value).toBe("X-Session");
    expect(dialog.textContent).toContain("密钥在详情页「换密钥」修改");
    expect(dialog.textContent).toContain("地址与协议未变化，模型列表保持现状");

    // 改显示名后保存（地址未变 → 不需要探测）
    fireEvent.change(screen.getByLabelText("显示名称"), { target: { value: "新名字" } });
    fireEvent.click(button("保存"));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
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

  it("地址变化必须先探测；成功后提示在用模型是否仍在、保存携带新清单", async () => {
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
    const dialog = await openEditDialog(server);

    fireEvent.change(screen.getByLabelText("服务地址"), {
      target: { value: "https://api.corp.test/v2" },
    });
    expect(dialog.textContent).toContain("保存前先按候选配置获取模型列表");
    expect(button("保存").disabled).toBe(true);

    fireEvent.click(button("获取模型"));
    await screen.findByText("✓ 2 个模型");
    // 默认模型 corp/m1：m1 在新清单里
    expect(dialog.textContent).toContain("在用的 m1 仍在列表中");
    const probe = server.calls.find((c) => c.method === "provider.probeSetupProviderModels");
    expect(probe?.params).toMatchObject({
      providerId: "corp",
      type: "openai-compatible",
      baseURL: "https://api.corp.test/v2",
      headers: { "X-Team": "core" },
    });
    expect(button("保存").disabled).toBe(false);
    fireEvent.click(button("保存"));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    const call = server.calls.find((c) => c.method === "provider.updateSetupProvider");
    expect(call?.params.patch).toMatchObject({
      baseURL: "https://api.corp.test/v2",
      models: [{ id: "m1", contextWindow: 100 }, { id: "m3" }],
    });
    server.close();
  });

  it("在用模型不在新清单里给出警告", async () => {
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
    const dialog = await openEditDialog(server);
    fireEvent.change(screen.getByLabelText("服务地址"), {
      target: { value: "https://api.corp.test/v2" },
    });
    fireEvent.click(button("获取模型"));
    await screen.findByText("✓ 1 个模型");
    expect(dialog.textContent).toContain("在用的 m1 不在新列表里");
    server.close();
  });

  it("探测失败允许「仍然保存」（不携带 models）", async () => {
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
    await openEditDialog(server);
    fireEvent.change(screen.getByLabelText("服务地址"), {
      target: { value: "https://api.corp.test/v2" },
    });
    fireEvent.click(button("获取模型"));
    await screen.findByText("✗ 获取失败：连接超时");
    fireEvent.click(button("仍然保存"));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    const call = server.calls.find((c) => c.method === "provider.updateSetupProvider");
    expect(call?.params.patch).toMatchObject({ baseURL: "https://api.corp.test/v2" });
    expect(call?.params.patch).not.toHaveProperty("models");
    server.close();
  });

  it("describeSetupProvider 返回 null：对话框给出错误且不渲染表单", async () => {
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
    await screen.findByText("已配置");
    const row = openList(server)("corp");
    if (row === undefined) throw new Error("缺少 corp 行");
    fireEvent.click(row);
    fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
    const dialog = await screen.findByRole("dialog", { name: "编辑 corp" });
    await waitFor(() => {
      expect(dialog.textContent).toContain("不是向导写入的条目");
    });
    expect(screen.queryByLabelText("服务地址")).toBeNull();
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
        "provider.updateSetupProvider": new RpcFail(-32005, "服务地址不能为空", {
          field: "baseURL",
        }),
      }),
    );
    await server.initialize();
    render(<ProvidersPage {...pageProps({ client: server.client })} />);
    await openEditDialog(server);
    fireEvent.click(button("保存"));
    await screen.findByText("服务地址不能为空");
    // 可继续编辑重试（committing 已复位）
    expect(button("保存").disabled).toBe(false);
    server.close();
  });
});
