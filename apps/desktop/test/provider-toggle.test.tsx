/**
 * 服务商与模型启停（ADR-0054 §4，假服务端）：详情标题行的启用开关与停用横幅、
 * 模型逐个开关与「全部启用 / 全部停用」（有搜索词时只作用于筛选结果）、
 * 停用对象正被使用时先弹页内确认、换模型卡片的停用文案与「重新启用」按钮。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcClient } from "@nocturne/rpc/client";

import { ModelRecoveryCard } from "../src/ModelRecoveryCard";
import { ProvidersPage } from "../src/ProvidersPage";
import type { ProviderOverview } from "../src/rpc-types";
import { fakeServer, withInit, type RpcCall } from "./fake-server";

const noop = () => undefined;

const overview = (enabled: boolean): ProviderOverview => ({
  id: "ocx",
  type: "openai-compatible",
  host: "127.0.0.1:8317",
  auth: "API Key · 凭据存储",
  credentialStatus: "valid",
  credentialStorage: "system",
  authKind: "apiKey",
  keySource: "credential",
  origin: "setup",
  overridden: false,
  modelCount: 3,
  managed: true,
  enabled,
  enabledModelCount: enabled ? 2 : 0,
});

const modelSettings = (id: string) => ({
  providerId: "ocx",
  modelId: id,
  fields: {
    displayName: { value: id, editable: true, source: { kind: "upstream" } },
    contextWindow: { value: 400000, editable: true, source: { kind: "upstream" } },
    maxOutputTokens: { value: 64000, editable: true, source: { kind: "upstream" } },
    imageInput: { value: true, editable: true, source: { kind: "upstream" } },
    reasoning: { value: "visible", editable: true, source: { kind: "upstream" } },
    reasoningEffort: { value: ["low"], editable: true, source: { kind: "derived" } },
    protocol: { value: "openai-compatible", editable: true, source: { kind: "entryType" } },
    editTool: { value: "edit", editable: true, source: { kind: "default" } },
  },
});

const LIST_MODELS = [
  { ref: { provider: "ocx", model: "m1" }, capabilities: {} },
  { ref: { provider: "ocx", model: "m2" }, capabilities: {}, disabled: "model" },
  { ref: { provider: "ocx", model: "m3" }, capabilities: {} },
];

const pageProps = (client: RpcClient | undefined) => ({
  client,
  currentProvider: undefined,
  currentModel: undefined,
  inUse: undefined,
  openUrl: noop,
  providersVersion: 0,
});

const last = (calls: RpcCall[], method: string) =>
  calls.filter((c) => c.method === method).at(-1)?.params;

afterEach(cleanup);

describe("ProvidersPage 启停", () => {
  it("服务商开关：无人在用时直接切换；停用后横幅、模型开关不可点、列表标已停用", async () => {
    let enabled = true;
    const server = fakeServer(
      withInit({
        "provider.describeProviders": () => ({ providers: [overview(enabled)] }),
        "provider.listProviderPresets": [],
        "runtime.defaultModel": null,
        "provider.listModelSettings": ["m1", "m2", "m3"].map(modelSettings),
        "runtime.listModels": LIST_MODELS,
        "provider.describeToggleImpact": { affectedSessions: 0, defaultModel: false, roles: [] },
        "provider.setProviderEnabled": (params: Record<string, unknown>) => {
          enabled = params.enabled === true;
          return null;
        },
      }),
    );
    await server.initialize();
    render(<ProvidersPage {...pageProps(server.client)} />);

    const sw = await screen.findByRole("switch", { name: "启用服务商 ocx" });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(sw.textContent).toContain("已启用");
    // 有模型被停用时写「已启用 N / 总数」
    expect(await screen.findByText("已启用 2 / 3")).toBeTruthy();

    fireEvent.click(sw);
    await waitFor(() =>
      expect(last(server.calls, "provider.setProviderEnabled")).toEqual({
        provider: "ocx",
        enabled: false,
      }),
    );
    // 停用横幅 + 「重新启用」；模型开关保留但不可点
    await screen.findByRole("button", { name: "重新启用" });
    const modelSwitch = screen.getByRole("switch", { name: "启用 m1" }) as HTMLButtonElement;
    expect(modelSwitch.disabled).toBe(true);
    // 逐个开关保留状态（Core 的 disabled 个别优先报 "model"）：m1 仍为启用，
    // 表头计数写「逐个设置保留」（ADR-0054 §4「开关保留状态」）
    expect(modelSwitch.getAttribute("aria-checked")).toBe("true");
    expect((await screen.findByText("服务商已停用")).textContent).toBe(
      "服务商已停用逐个设置保留 2 / 3",
    );
    // 左侧列表：空心点、名字变淡、标「已停用」
    await waitFor(() => {
      expect(document.querySelector(".plist .tagm")?.textContent).toBe("已停用");
    });
    expect(document.querySelector(".plist .dot.off")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "重新启用" }));
    await waitFor(() =>
      expect(
        server.calls
          .filter((c) => c.method === "provider.setProviderEnabled")
          .map((c) => c.params.enabled),
      ).toEqual([false, true]),
    );
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "重新启用" })).toBeNull();
    });
  });

  it("停用正被使用的服务商：先弹页内确认并列出影响，确认后才写设置", async () => {
    const server = fakeServer(
      withInit({
        "provider.describeProviders": { providers: [overview(true)] },
        "provider.listProviderPresets": [],
        "runtime.defaultModel": { provider: "ocx", model: "m1" },
        "provider.listModelSettings": ["m1", "m2", "m3"].map(modelSettings),
        "runtime.listModels": LIST_MODELS,
        "provider.describeToggleImpact": {
          affectedSessions: 2,
          defaultModel: true,
          roles: ["task"],
        },
        "provider.setProviderEnabled": null,
      }),
    );
    await server.initialize();
    render(<ProvidersPage {...pageProps(server.client)} />);

    fireEvent.click(await screen.findByRole("switch", { name: "启用服务商 ocx" }));
    const dialog = await screen.findByRole("dialog", { name: "停用 ocx？" });
    expect(within(dialog).getByText(/2 个打开的会话正在用 ocx 的模型/)).toBeTruthy();
    expect(within(dialog).getByText(/默认模型是 ocx 的模型/)).toBeTruthy();
    expect(within(dialog).getByText(/子代理模型是 ocx 的模型/)).toBeTruthy();
    // 未确认前不写设置
    expect(server.calls.some((c) => c.method === "provider.setProviderEnabled")).toBe(false);

    fireEvent.click(within(dialog).getByRole("button", { name: "停用" }));
    await waitFor(() =>
      expect(last(server.calls, "provider.setProviderEnabled")).toEqual({
        provider: "ocx",
        enabled: false,
      }),
    );
  });

  it("模型开关与全部启用 / 停用；有搜索词时只作用于筛选结果", async () => {
    // 逐个模型的停用状态随开关变化（与 Core 一致：listModels 的 disabled 反映最新设置）
    const off = new Set<string>(["m2"]);
    const server = fakeServer(
      withInit({
        "provider.describeProviders": { providers: [overview(true)] },
        "provider.listProviderPresets": [],
        "runtime.defaultModel": null,
        "provider.listModelSettings": ["m1", "m2", "m3"].map(modelSettings),
        "runtime.listModels": () =>
          ["m1", "m2", "m3"].map((id) => ({
            ref: { provider: "ocx", model: id },
            capabilities: {},
            ...(off.has(id) ? { disabled: "model" } : {}),
          })),
        "provider.describeToggleImpact": { affectedSessions: 0, defaultModel: false, roles: [] },
        "provider.setModelsEnabled": (params: Record<string, unknown>) => {
          for (const id of params.models as string[]) {
            if (params.enabled === true) off.delete(id);
            else off.add(id);
          }
          return null;
        },
      }),
    );
    await server.initialize();
    render(<ProvidersPage {...pageProps(server.client)} />);

    // 逐个模型的开关状态来自 Core 的 disabled 字段（m2 已停用）
    const m2 = (await screen.findByRole("switch", { name: "启用 m2" })) as HTMLButtonElement;
    expect(m2.getAttribute("aria-checked")).toBe("false");
    expect(m2.disabled).toBe(false);

    // 全部停用：只作用于当前启用的 m1、m3
    fireEvent.click(screen.getByRole("button", { name: "全部停用" }));
    await waitFor(() =>
      expect(last(server.calls, "provider.setModelsEnabled")).toEqual({
        provider: "ocx",
        models: ["m1", "m3"],
        enabled: false,
      }),
    );

    // 全部启用：此时三个都已停用
    fireEvent.click(await screen.findByRole("button", { name: "全部启用" }));
    await waitFor(() =>
      expect(last(server.calls, "provider.setModelsEnabled")).toEqual({
        provider: "ocx",
        models: ["m1", "m2", "m3"],
        enabled: true,
      }),
    );

    // 单个模型开关：停用 m2
    await waitFor(() => {
      expect(
        screen
          .getByRole<HTMLButtonElement>("switch", { name: "启用 m2" })
          .getAttribute("aria-checked"),
      ).toBe("true");
    });
    fireEvent.click(screen.getByRole("switch", { name: "启用 m2" }));
    await waitFor(() =>
      expect(last(server.calls, "provider.setModelsEnabled")).toEqual({
        provider: "ocx",
        models: ["m2"],
        enabled: false,
      }),
    );

    // 搜索：按钮改为「启用筛选结果 / 停用筛选结果」，只作用于筛出的 m2
    fireEvent.change(screen.getByLabelText("搜索模型"), { target: { value: "m2" } });
    fireEvent.click(await screen.findByRole("button", { name: "启用筛选结果" }));
    await waitFor(() =>
      expect(last(server.calls, "provider.setModelsEnabled")).toEqual({
        provider: "ocx",
        models: ["m2"],
        enabled: true,
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "停用筛选结果" }));
    await waitFor(() =>
      expect(last(server.calls, "provider.setModelsEnabled")).toEqual({
        provider: "ocx",
        models: ["m2"],
        enabled: false,
      }),
    );
  });

  it("停用正被使用的模型：先弹确认，未确认不写设置", async () => {
    const server = fakeServer(
      withInit({
        "provider.describeProviders": { providers: [overview(true)] },
        "provider.listProviderPresets": [],
        "runtime.defaultModel": null,
        "provider.listModelSettings": ["m1", "m2", "m3"].map(modelSettings),
        "runtime.listModels": LIST_MODELS,
        "provider.describeToggleImpact": { affectedSessions: 1, defaultModel: false, roles: [] },
        "provider.setModelsEnabled": null,
      }),
    );
    await server.initialize();
    render(<ProvidersPage {...pageProps(server.client)} />);

    fireEvent.click(await screen.findByRole("switch", { name: "启用 m1" }));
    const dialog = await screen.findByRole("dialog", { name: "停用 1 个模型？" });
    expect(within(dialog).getByText(/1 个打开的会话正在用 ocx\/m1/)).toBeTruthy();
    expect(server.calls.some((c) => c.method === "provider.setModelsEnabled")).toBe(false);

    fireEvent.click(within(dialog).getByRole("button", { name: "停用" }));
    await waitFor(() =>
      expect(last(server.calls, "provider.setModelsEnabled")).toEqual({
        provider: "ocx",
        models: ["m1"],
        enabled: false,
      }),
    );
  });
});

describe("ModelRecoveryCard 停用文案", () => {
  const handlers = withInit({
    "runtime.listModels": [{ ref: { provider: "ocx", model: "keep" }, capabilities: {} }],
    "runtime.listRecentModels": [],
    "runtime.defaultModel": null,
  });

  it("停用的服务商：标题「已停用」+ 次按钮「重新启用 服务商」", async () => {
    const server = fakeServer(handlers);
    await server.initialize();
    const onReenable = vi.fn();
    render(
      <ModelRecoveryCard
        runtime={server.client.runtime}
        workspace="ws"
        error="服务商 ocx 已停用（可在 设置 › 服务商 或 /provider 重新启用）"
        disabled="provider"
        disabledModel={{ provider: "ocx", model: "gone" }}
        providersVersion={0}
        onContinue={noop}
        onOpenProviders={noop}
        onReenable={onReenable}
      />,
    );
    await screen.findByText("这个会话用的模型已停用");
    expect(screen.queryByRole("button", { name: "去配置服务商" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "重新启用 ocx" }));
    expect(onReenable).toHaveBeenCalledTimes(1);
  });

  it("逐个停用的模型：按钮写「重新启用 服务商/模型」；无停用信息时是原来的文案", async () => {
    const server = fakeServer(handlers);
    await server.initialize();
    const { unmount } = render(
      <ModelRecoveryCard
        runtime={server.client.runtime}
        workspace="ws"
        error="模型 ocx/m2 已停用"
        disabled="model"
        disabledModel={{ provider: "ocx", model: "m2" }}
        providersVersion={0}
        onContinue={noop}
        onOpenProviders={noop}
        onReenable={noop}
      />,
    );
    await screen.findByText("这个会话用的模型已停用");
    expect(screen.getByRole("button", { name: "重新启用 ocx/m2" })).toBeTruthy();
    unmount();

    render(
      <ModelRecoveryCard
        runtime={server.client.runtime}
        workspace="ws"
        error="未配置的 Provider: command"
        providersVersion={0}
        onContinue={noop}
        onOpenProviders={noop}
      />,
    );
    await screen.findByText("这个会话用的模型已不可用");
    expect(screen.getByRole("button", { name: "去配置服务商" })).toBeTruthy();
  });
});
