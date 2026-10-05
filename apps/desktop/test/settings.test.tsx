/**
 * 设置页测试（假服务端）：单值项立即保存与失败回滚、覆盖标黄、
 * 默认模型与档位成对保存、模型角色、审查器密钥按 password 处理、桌面端主题。
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcClient } from "@nocturne/rpc/client";

import { SettingsPage, type ThemePref } from "../src/SettingsPage";
import type { SettingItem } from "../src/rpc-types";
import { fakeServer, RpcFail, withInit } from "./fake-server";

const noop = () => undefined;

const ITEMS: SettingItem[] = [
  {
    key: "permissions.preset",
    effective: "smart",
    source: "default",
    saved: undefined,
    overridden: false,
  },
  {
    key: "permission.reviewer",
    effective: undefined,
    source: "default",
    saved: undefined,
    overridden: false,
    reviewer: { effective: undefined, saved: undefined },
  },
  {
    key: "defaultModel",
    effective: "openrouter/gpt-5",
    source: "settings",
    saved: "openrouter/gpt-5",
    overridden: false,
  },
  {
    key: "reasoningEffort",
    effective: "high",
    source: "settings",
    saved: "high",
    overridden: false,
  },
  {
    key: "shell",
    effective: "pwsh",
    source: "default",
    saved: undefined,
    overridden: false,
    readonly: true,
  },
  {
    key: "compaction.threshold",
    effective: "85%",
    source: "project",
    saved: "90%",
    overridden: true,
  },
  {
    key: "modelRoles.task",
    effective: undefined,
    source: "default",
    saved: undefined,
    overridden: false,
  },
  {
    key: "modelRoles.vision",
    effective: undefined,
    source: "default",
    saved: undefined,
    overridden: false,
  },
  {
    key: "modelRoles.smol",
    effective: undefined,
    source: "default",
    saved: undefined,
    overridden: false,
  },
];

const MODELS = [
  {
    ref: { provider: "openrouter", model: "gpt-5" },
    displayName: "GPT-5",
    capabilities: {
      reasoning: "visible",
      imageInput: true,
      reasoningEffort: ["low", "medium", "high"],
    },
  },
  {
    ref: { provider: "openrouter", model: "tiny" },
    capabilities: { reasoning: "none", imageInput: false },
  },
];

function handlers(extra: Record<string, unknown> = {}) {
  return withInit({
    "runtime.describeSettings": ITEMS,
    "runtime.listModels": MODELS,
    "runtime.listReviewerProviders": [{ id: "openrouter" }],
    "runtime.getPreference": null,
    ...extra,
  });
}

function props(
  client: RpcClient,
  overrides?: { theme?: ThemePref; onThemeChange?: (t: ThemePref) => boolean },
) {
  return {
    client,
    theme: overrides?.theme ?? ("system" as const),
    workspace: "C:\\Users\\me\\Nocturne",
    defaultWorkspace: "C:\\Users\\me\\Nocturne",
    workspaceOverridden: false,
    onThemeChange: overrides?.onThemeChange ?? (() => true),
    onWorkspaceChange: () => Promise.resolve(undefined),
    pickFolder: () => Promise.resolve(null),
    providersVersion: 0,
    onBack: noop,
  };
}

function row(label: string): HTMLElement {
  const name = screen.getByText(label, { selector: ".s3 .n, .s3 .n *" });
  const el = name.closest(".s3");
  if (!(el instanceof HTMLElement)) throw new Error(`找不到设置行 ${label}`);
  return el;
}

afterEach(cleanup);

describe("SettingsPage", () => {
  it("单值项立即保存并提示；失败回滚并在该行写红字", async () => {
    let fail = false;
    const server = fakeServer(
      handlers({
        "runtime.updateSettings": (params: Record<string, unknown>) => {
          if (fail) return new RpcFail(-32000, "磁盘只读");
          const patch = params.patch as Record<string, string>;
          return ITEMS.map((x) =>
            x.key === "permissions.preset"
              ? {
                  ...x,
                  effective: patch["permissions.preset"],
                  saved: patch["permissions.preset"],
                  source: "settings",
                }
              : x,
          );
        },
      }),
    );
    await server.initialize();
    render(<SettingsPage {...props(server.client)} />);
    const select = await screen.findByLabelText("默认权限预设");
    fireEvent.change(select, { target: { value: "read-only" } });
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toBe("✓已保存 默认权限预设 = read-only");
    });
    expect(select).toHaveProperty("value", "read-only");

    fail = true;
    fireEvent.change(select, { target: { value: "bypass" } });
    await screen.findByText(/保存失败：磁盘只读/);
    expect(select).toHaveProperty("value", "read-only");
    expect(row("默认权限预设").className).toContain("bad");
    server.close();
  });

  it("被覆盖的项标黄并写明覆盖层", async () => {
    const server = fakeServer(handlers());
    await server.initialize();
    render(<SettingsPage {...props(server.client)} />);
    const ov = await screen.findByText("已被覆盖 · 项目配置");
    expect(ov.className).toContain("ov");
    server.close();
  });

  it("默认模型与档位经 setDefaultModel 成对保存；无档位的模型传 null", async () => {
    const server = fakeServer(handlers({ "runtime.setDefaultModel": ITEMS }));
    await server.initialize();
    render(<SettingsPage {...props(server.client)} />);
    await screen.findByText("openrouter · gpt-5 · high");
    fireEvent.click(row("默认模型与档位").querySelector("button") ?? document.body);
    await screen.findByRole("dialog", { name: "默认模型与档位" });
    fireEvent.click(screen.getByRole("button", { name: "medium" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => {
      const call = server.calls.find((c) => c.method === "runtime.setDefaultModel");
      expect(call?.params).toEqual({ model: "openrouter/gpt-5", reasoningEffort: "medium" });
    });

    fireEvent.click(row("默认模型与档位").querySelector("button") ?? document.body);
    await screen.findByRole("dialog", { name: "默认模型与档位" });
    fireEvent.click(screen.getByRole("option", { name: /tiny/ }));
    expect(screen.queryByRole("group", { name: "思考档位" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => {
      const calls = server.calls.filter((c) => c.method === "runtime.setDefaultModel");
      expect(calls[1]?.params).toEqual({ model: "openrouter/tiny", reasoningEffort: null });
    });
    server.close();
  });

  it("看图模型只列支持图片输入的模型；取消不写", async () => {
    const server = fakeServer(handlers());
    await server.initialize();
    render(<SettingsPage {...props(server.client)} />);
    await screen.findByText("看图模型");
    fireEvent.click(row("看图模型").querySelector("button") ?? document.body);
    await screen.findByRole("dialog", { name: "看图模型" });
    expect(screen.getByRole("option", { name: /gpt-5/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /tiny/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(server.calls.some((c) => c.method === "runtime.updateSettings")).toBe(false);
    server.close();
  });

  it("Jev 单独密钥：password 输入，经 reviewerKey 提交；首次启用先显示外发说明", async () => {
    const server = fakeServer(
      handlers({
        "runtime.defaultReviewer": {
          backend: "jev",
          endpoint: "opencode-zen",
          model: "jev-1",
          credential: { stored: true },
        },
        "runtime.updateSettings": ITEMS,
        "runtime.setPreference": null,
      }),
    );
    await server.initialize();
    render(<SettingsPage {...props(server.client)} />);
    await screen.findByText("安全审查");
    fireEvent.click(row("安全审查").querySelector("button") ?? document.body);
    await screen.findByRole("dialog", { name: "安全审查" });
    fireEvent.click(screen.getByRole("button", { name: "Jev" }));
    await waitFor(() => {
      expect(screen.getByLabelText("模型")).toHaveProperty("value", "jev-1");
    });
    fireEvent.click(screen.getByRole("button", { name: "单独密钥" }));
    const key = screen.getByLabelText("审查器密钥");
    expect(key.getAttribute("type")).toBe("password");
    fireEvent.change(key, { target: { value: "sk-reviewer" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText("首次启用 Jev");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => {
      const call = server.calls.find((c) => c.method === "runtime.updateSettings");
      expect(call?.params.reviewerKey).toBe("sk-reviewer");
    });
    await waitFor(() => {
      expect(
        server.calls.some(
          (c) => c.method === "runtime.setPreference" && c.params.key === "jevDisclosureAccepted",
        ),
      ).toBe(true);
    });
    server.close();
  });

  it("主题只写本机 prefs：点选立即生效并提示", async () => {
    const server = fakeServer(handlers());
    await server.initialize();
    const onThemeChange = vi.fn(() => true);
    render(<SettingsPage {...props(server.client, { onThemeChange })} />);
    fireEvent.click(await screen.findByRole("button", { name: "深色" }));
    expect(onThemeChange).toHaveBeenCalledWith("dark");
    expect((await screen.findByRole("status")).textContent).toBe("✓已保存 主题 = 深色");
    expect(server.calls.some((c) => c.method === "runtime.updateSettings")).toBe(false);
    server.close();
  });
});
