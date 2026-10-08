/**
 * 设置区常规 / 模型 / 外观页测试（假服务端）：各页分组、单值项立即保存与失败回滚、
 * 覆盖标黄、默认模型与档位成对保存、模型角色、审查器密钥按 password 处理、主题卡片、
 * 写成功后通知桌面端协调其他后台。
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcClient } from "@nocturne/rpc/client";

import { SettingsPage, type SettingsPageSection, type ThemePref } from "../src/SettingsPage";
import type { SettingItem } from "../src/rpc-types";
import type { CheckResult } from "../src/updater";
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
  overrides?: {
    section?: SettingsPageSection;
    theme?: ThemePref;
    onThemeChange?: (t: ThemePref) => boolean;
    fileOpener?: "system" | "vscode" | "cursor";
    editors?: { vscode: boolean; cursor: boolean };
    onFileOpenerChange?: (o: "system" | "vscode" | "cursor") => boolean;
    onConfigSaved?: () => void;
    onOpenProviders?: () => void;
    update?: {
      autoUpdate: boolean;
      onAutoUpdateChange: (enabled: boolean) => boolean;
      onCheck: () => Promise<CheckResult>;
    };
  },
) {
  return {
    section: overrides?.section ?? ("general" as const),
    client,
    theme: overrides?.theme ?? ("system" as const),
    workspace: "C:\\Users\\me\\Nocturne",
    defaultWorkspace: "C:\\Users\\me\\Nocturne",
    workspaceOverridden: false,
    ...(overrides?.update !== undefined ? { update: overrides.update } : {}),
    onThemeChange: overrides?.onThemeChange ?? (() => true),
    fileOpener: overrides?.fileOpener ?? ("system" as const),
    editors: overrides?.editors ?? { vscode: true, cursor: false },
    onFileOpenerChange: overrides?.onFileOpenerChange ?? (() => true),
    onWorkspaceChange: () => Promise.resolve(undefined),
    pickFolder: () => Promise.resolve(null),
    providersVersion: 0,
    onConfigSaved: overrides?.onConfigSaved ?? noop,
    onOpenProviders: overrides?.onOpenProviders ?? noop,
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
    const onConfigSaved = vi.fn();
    render(<SettingsPage {...props(server.client, { onConfigSaved })} />);
    const trigger = await screen.findByRole("combobox", { name: "默认权限预设" });
    expect(trigger.textContent).toContain("跟随默认");
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("option", { name: /^read-only/ }));
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toBe("✓已保存 默认权限预设 = read-only");
    });
    expect(trigger.textContent).toContain("read-only");
    expect(onConfigSaved).toHaveBeenCalledTimes(1);

    fail = true;
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("option", { name: /^bypass/ }));
    await screen.findByText(/保存失败：磁盘只读/);
    expect(trigger.textContent).toContain("read-only");
    expect(row("默认权限预设").className).toContain("bad");
    expect(onConfigSaved).toHaveBeenCalledTimes(1);
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
    const onConfigSaved = vi.fn();
    render(<SettingsPage {...props(server.client, { section: "models", onConfigSaved })} />);
    const primary = await screen.findByText("gpt-5 · high");
    expect(primary.className).toBe("model-primary");
    expect(primary.parentElement?.title).toBe("openrouter · gpt-5");
    expect(primary.parentElement?.querySelector(".model-provider")?.textContent).toBe("openrouter");
    expect(primary.closest(".s3")?.classList.contains("model-setting")).toBe(true);
    fireEvent.click(row("默认模型与档位").querySelector("button") ?? document.body);
    await screen.findByRole("dialog", { name: "默认模型与档位" });
    fireEvent.click(screen.getByRole("button", { name: "medium" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => {
      const call = server.calls.find((c) => c.method === "runtime.setDefaultModel");
      expect(call?.params).toEqual({ model: "openrouter/gpt-5", reasoningEffort: "medium" });
    });
    await waitFor(() => {
      expect(onConfigSaved).toHaveBeenCalledTimes(1);
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

  it("模型角色先显示完整模型名，服务商单独展示", async () => {
    const value = "opencode-go/deepseek-v4.1-flash";
    const server = fakeServer(
      handlers({
        "runtime.describeSettings": ITEMS.map((item) =>
          item.key === "modelRoles.vision" ? { ...item, effective: value } : item,
        ),
      }),
    );
    await server.initialize();
    render(<SettingsPage {...props(server.client, { section: "models" })} />);
    const primary = await screen.findByText("deepseek-v4.1-flash");
    expect(primary.className).toBe("model-primary");
    expect(primary.parentElement?.querySelector(".model-provider")?.textContent).toBe(
      "opencode-go",
    );
    expect(primary.parentElement?.title).toBe("opencode-go · deepseek-v4.1-flash");
    expect(primary.closest(".s3")?.classList.contains("model-setting")).toBe(true);
    server.close();
  });

  it("看图模型只列支持图片输入的模型；取消不写", async () => {
    const server = fakeServer(handlers());
    await server.initialize();
    render(<SettingsPage {...props(server.client, { section: "models" })} />);
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
    render(<SettingsPage {...props(server.client, { section: "appearance", onThemeChange })} />);
    const dark = await screen.findByRole("radio", { name: /月之暗面/ });
    expect(screen.getByRole("radio", { name: "跟随系统" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    fireEvent.click(dark);
    expect(onThemeChange).toHaveBeenCalledWith("dark");
    expect((await screen.findByRole("status")).textContent).toBe("✓已保存 主题 = 月之暗面");
    expect(server.calls.some((c) => c.method === "runtime.updateSettings")).toBe(false);
    server.close();
  });

  it("主题卡片同时显示新名与浅色/深色小字", async () => {
    const server = fakeServer(handlers());
    await server.initialize();
    render(<SettingsPage {...props(server.client, { section: "appearance" })} />);
    const light = await screen.findByRole("radio", { name: /月之亮面/ });
    const dark = await screen.findByRole("radio", { name: /月之暗面/ });
    expect(light.textContent).toContain("月之亮面");
    expect(light.querySelector(".tsub")?.textContent).toBe("浅色");
    expect(dark.textContent).toContain("月之暗面");
    expect(dark.querySelector(".tsub")?.textContent).toBe("深色");
    server.close();
  });

  it("各页只显示自己的分组；模型页尾的链接进入服务商", async () => {
    const server = fakeServer(handlers());
    await server.initialize();
    const onOpenProviders = vi.fn();
    const view = render(<SettingsPage {...props(server.client)} />);
    await screen.findByText("默认权限预设");
    const groups = () => [...document.querySelectorAll("h5")].map((h) => h.textContent);
    expect(groups()).toEqual(["权限", "执行", "普通对话", "文件"]);
    expect(screen.getByRole("heading", { name: "常规" })).toBeTruthy();
    expect(screen.queryByText("看图模型")).toBeNull();

    view.rerender(
      <SettingsPage {...props(server.client, { section: "models", onOpenProviders })} />,
    );
    expect(groups()).toEqual(["默认", "模型角色"]);
    expect(screen.queryByText("默认权限预设")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "服务商 › 模型表" }));
    expect(onOpenProviders).toHaveBeenCalledTimes(1);

    view.rerender(<SettingsPage {...props(server.client, { section: "appearance" })} />);
    expect(groups()).toEqual(["主题"]);
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    server.close();
  });

  it("自动更新开关：点击切换并写本机；写不进去时该行报错", async () => {
    const server = fakeServer(handlers());
    await server.initialize();
    const changes: boolean[] = [];
    const update = {
      autoUpdate: true,
      onAutoUpdateChange: (enabled: boolean) => {
        changes.push(enabled);
        return false; // 模拟本机存储不可写
      },
      onCheck: () => Promise.resolve<CheckResult>({ kind: "latest" }),
    };
    render(<SettingsPage {...props(server.client, { update })} />);
    const toggle = await screen.findByRole("switch", { name: "自动检查更新" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(changes).toEqual([false]);
    await waitFor(() => expect(row("自动检查更新").textContent).toContain("本机存储不可写"));
    server.close();
  });

  it("手动检查更新：失败在行内显示原因；已是最新给提示", async () => {
    const server = fakeServer(handlers());
    await server.initialize();
    let result: CheckResult = {
      kind: "error",
      message: "Network error: error sending request for url",
    };
    const update = {
      autoUpdate: true,
      onAutoUpdateChange: () => true,
      onCheck: () => Promise.resolve(result),
    };
    render(<SettingsPage {...props(server.client, { update })} />);
    const button = await screen.findByRole("button", { name: "检查更新" });
    fireEvent.click(button);
    await waitFor(() =>
      expect(row("检查更新").textContent).toContain("下载失败，请检查网络后重试"),
    );

    result = { kind: "latest" };
    fireEvent.click(button);
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain("已是最新版本");
    });
    expect(row("检查更新").textContent).not.toContain("下载失败");
    server.close();
  });
});

it("打开文件用：只列检测到的编辑器，选择写本机 prefs", async () => {
  const server = fakeServer(handlers());
  await server.initialize();
  const onFileOpenerChange = vi.fn(() => true);
  render(
    <SettingsPage
      {...props(server.client, {
        fileOpener: "system",
        editors: { vscode: true, cursor: false },
        onFileOpenerChange,
      })}
    />,
  );
  await screen.findByText("默认权限预设");
  const trigger = screen.getByRole("combobox", { name: "打开文件用" });
  fireEvent.click(trigger);
  expect(screen.getByRole("option", { name: /VS Code/ })).toBeTruthy();
  expect(screen.queryByRole("option", { name: /Cursor/ })).toBeNull();
  fireEvent.click(screen.getByRole("option", { name: /VS Code/ }));
  expect(onFileOpenerChange).toHaveBeenCalledWith("vscode");
  expect(await screen.findByRole("status")).toHaveProperty(
    "textContent",
    "✓已保存 打开文件用 = vscode",
  );
  server.close();
});
