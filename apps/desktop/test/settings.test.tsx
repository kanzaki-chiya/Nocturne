/**
 * 设置区常规 / 模型 / 外观页测试（假服务端）：各页分组、单值项立即保存与失败回滚、
 * 覆盖标黄、默认模型与档位成对保存、模型角色、审查器密钥按 password 处理、主题卡片、
 * 写成功后通知桌面端协调其他后台。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    "runtime.listShells": [
      { kind: "pwsh", name: "PowerShell 7", available: true, executable: "C:/pwsh.exe" },
      { kind: "bash", name: "Git Bash", available: true, executable: "C:/bash.exe" },
      { kind: "sh", name: "sh", available: false },
    ],
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
    onOpenSubagents?: () => void;
    notifications?: {
      sendTest: () => Promise<{ shown: boolean; reason?: "disabled" | "unsupported" | "error" }>;
    };
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
    notifications: overrides?.notifications ?? { sendTest: () => Promise.resolve({ shown: true }) },
    onConfigSaved: overrides?.onConfigSaved ?? noop,
    onOpenProviders: overrides?.onOpenProviders ?? noop,
    onOpenSubagents: overrides?.onOpenSubagents ?? noop,
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
  it("Shell 下拉复用探测选项，不可用置灰；保存刷新，失败保持值并显示原文", async () => {
    let fail = false;
    const server = fakeServer(
      handlers({
        "runtime.setShellSetting": (p: Record<string, unknown>) =>
          fail
            ? new RpcFail(-32000, "目标不可用")
            : ITEMS.map((item) =>
                item.key === "shell"
                  ? { ...item, saved: p.kind, effective: p.kind, source: "settings" }
                  : item,
              ),
      }),
    );
    await server.initialize();
    render(<SettingsPage {...props(server.client)} />);
    const trigger = await screen.findByRole("button", { name: "Shell" });
    fireEvent.click(trigger);
    const automatic = await screen.findByRole("menuitemradio", { name: /自动/ });
    expect(automatic.textContent).toContain("当前为 pwsh");
    expect(screen.getByRole<HTMLButtonElement>("menuitemradio", { name: /^sh/ }).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole("menuitemradio", { name: /bash/ }));
    await waitFor(() => expect(trigger.textContent).toContain("bash"));
    fail = true;
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /pwsh/ }));
    await screen.findByText("目标不可用");
    expect(trigger.textContent).toContain("bash");
    expect(
      server.calls.filter((r) => r.method === "runtime.setShellSetting").map((r) => r.params),
    ).toEqual([{ kind: "bash" }, { kind: "pwsh" }]);
    server.client.close();
  });

  it.each(["env", "user", "project"] as const)("Shell 被 %s 覆盖保持只读无下拉", async (source) => {
    const server = fakeServer(
      handlers({
        "runtime.describeSettings": ITEMS.map((item) =>
          item.key === "shell" ? { ...item, source } : item,
        ),
      }),
    );
    await server.initialize();
    render(<SettingsPage {...props(server.client)} />);
    await screen.findByText(
      source === "env"
        ? "由环境变量 NOCTURNE_SHELL 指定"
        : source === "user"
          ? "由config.json指定"
          : "由项目配置指定",
    );
    expect(screen.queryByRole("button", { name: "Shell" })).toBeNull();
    server.client.close();
  });
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

  describe("安全审查：追加规则与样例检查（ADR-0057）", () => {
    const MODEL_REVIEWER = {
      backend: "model",
      model: { provider: "openrouter", model: "gpt-5" },
    } as const;
    const itemsWith = (reviewer: unknown, rules?: unknown): SettingItem[] => [
      ...ITEMS.filter((item) => item.key !== "permission.reviewer"),
      {
        key: "permission.reviewer",
        effective: undefined,
        source: "settings",
        saved: undefined,
        overridden: false,
        reviewer: { effective: reviewer, saved: reviewer },
      } as SettingItem,
      {
        key: "permission.reviewerRules",
        effective: undefined,
        source: "settings",
        saved: undefined,
        overridden: false,
        reviewerRules: { effective: rules, saved: rules },
      } as SettingItem,
    ];
    const SAMPLES = [
      { id: "s1", title: "没有被要求就推送", expect: "ask" },
      { id: "s2", title: "用户要求后推送", expect: "allow" },
      { id: "s3", title: "读取 .env", expect: "ask" },
    ];
    const RESULTS: Record<string, unknown> = {
      s1: {
        id: "s1",
        title: "没有被要求就推送",
        expected: "ask",
        actual: "ask",
        match: true,
        durationMs: 800,
        reason: "会推送",
      },
      s2: {
        id: "s2",
        title: "用户要求后推送",
        expected: "allow",
        actual: "ask",
        match: false,
        durationMs: 1200,
        reason: "审查输出格式错误",
      },
      s3: {
        id: "s3",
        title: "读取 .env",
        expected: "ask",
        actual: "ask",
        match: true,
        durationMs: 500,
        reason: "会读取凭据",
      },
    };
    async function openDialog(extra: Record<string, unknown>, items: SettingItem[]) {
      const server = fakeServer(handlers({ "runtime.describeSettings": items, ...extra }));
      await server.initialize();
      render(<SettingsPage {...props(server.client)} />);
      await screen.findByText("安全审查");
      fireEvent.click(row("安全审查").querySelector("button") ?? document.body);
      await screen.findByRole("dialog", { name: "安全审查" });
      return server;
    }

    it("设置行副标题说明 smart 下除只读命令外先交给它判断", async () => {
      const server = fakeServer(handlers());
      await server.initialize();
      render(<SettingsPage {...props(server.client)} />);
      await screen.findByText("安全审查");
      expect(row("安全审查").textContent).toContain("smart 下除只读命令外的操作先交给它判断");
      expect(row("安全审查").textContent).not.toContain("规则拦下的操作");
      server.close();
    });

    it("对话框带两个多行输入框和示例占位，保存走 permission.reviewerRules", async () => {
      const server = await openDialog(
        { "runtime.updateSettings": ITEMS },
        itemsWith(undefined, { ask: "任何 ssh 命令" }),
      );
      const ask = screen.getByLabelText("额外交人");
      const allow = screen.getByLabelText("额外放行");
      expect(ask.tagName).toBe("TEXTAREA");
      expect(allow.tagName).toBe("TEXTAREA");
      expect(ask.getAttribute("placeholder")).toMatch(/^例如：/);
      expect(allow.getAttribute("placeholder")).toMatch(/^例如：/);
      expect(ask).toHaveProperty("value", "任何 ssh 命令");
      fireEvent.change(ask, { target: { value: "  任何 docker 命令  " } });
      fireEvent.change(allow, { target: { value: "运行 pnpm test" } });
      fireEvent.click(screen.getByRole("button", { name: "保存" }));
      await waitFor(() => {
        const call = server.calls.find((c) => c.method === "runtime.updateSettings");
        expect(call?.params.patch).toEqual({
          "permission.reviewer": { backend: "off" },
          "permission.reviewerRules": { ask: "任何 docker 命令", allow: "运行 pnpm test" },
        });
      });
      server.close();
    });

    it("两段都清空保存为 null（删除 permission.reviewerRules）", async () => {
      const server = await openDialog(
        { "runtime.updateSettings": ITEMS },
        itemsWith(undefined, { ask: "任何 ssh 命令" }),
      );
      fireEvent.change(screen.getByLabelText("额外交人"), { target: { value: "" } });
      fireEvent.click(screen.getByRole("button", { name: "保存" }));
      await waitFor(() => {
        const call = server.calls.find((c) => c.method === "runtime.updateSettings");
        expect(
          (call?.params.patch as Record<string, unknown>)["permission.reviewerRules"],
        ).toBeNull();
      });
      server.close();
    });

    it("测试按钮：逐行显示说明/期望/实际/用时，不一致的行标红，末尾给出命中率", async () => {
      const server = await openDialog(
        {
          "runtime.listReviewerSamples": SAMPLES,
          "runtime.testReviewerSample": (p: Record<string, unknown>) => RESULTS[String(p.sampleId)],
        },
        itemsWith(MODEL_REVIEWER),
      );
      fireEvent.click(screen.getByRole("button", { name: "测试" }));
      const status = await screen.findByRole("status");
      expect(status.textContent).toBe("命中率 2/3（67%）");
      const rows = [...document.querySelectorAll(".stable tbody tr")];
      expect(rows.map((r) => [...r.querySelectorAll("td")].map((td) => td.textContent))).toEqual([
        ["没有被要求就推送", "交人", "交人", "0.8s"],
        ["用户要求后推送", "放行", "交人 ✗", "1.2s"],
        ["读取 .env", "交人", "交人", "0.5s"],
      ]);
      expect(rows.map((r) => r.classList.contains("bad"))).toEqual([false, true, false]);
      expect(server.calls.filter((c) => c.method === "runtime.testReviewerSample")).toHaveLength(3);
      server.close();
    });

    it("审查器为 off（或未配置）时测试按钮不可用", async () => {
      const off = await openDialog({}, itemsWith({ backend: "off" }));
      expect(screen.getByRole("button", { name: "测试" })).toHaveProperty("disabled", true);
      off.close();
      cleanup();
      const none = await openDialog({}, itemsWith(undefined));
      expect(screen.getByRole("button", { name: "测试" })).toHaveProperty("disabled", true);
      none.close();
    });

    it("运行中可取消：不再请求后续样例，丢弃在途结果，显示已取消和已有命中率", async () => {
      let release: (value: unknown) => void = noop;
      const server = await openDialog(
        {
          "runtime.listReviewerSamples": SAMPLES,
          "runtime.testReviewerSample": (p: Record<string, unknown>) =>
            p.sampleId === "s1"
              ? RESULTS.s1
              : new Promise((resolve) => {
                  release = resolve;
                }),
        },
        itemsWith(MODEL_REVIEWER),
      );
      fireEvent.click(screen.getByRole("button", { name: "测试" }));
      await waitFor(() => {
        expect(document.querySelectorAll(".stable tbody tr")).toHaveLength(1);
      });
      fireEvent.click(await screen.findByRole("button", { name: "取消测试" }));
      release(RESULTS.s2);
      const status = await screen.findByRole("status");
      expect(status.textContent).toBe("已取消，已跑 1/3 条 · 命中率 1/1（100%）");
      expect(screen.getByRole("button", { name: "测试" })).toHaveProperty("disabled", false);
      expect(document.querySelectorAll(".stable tbody tr")).toHaveLength(1);
      expect(
        server.calls
          .filter((c) => c.method === "runtime.testReviewerSample")
          .map((c) => c.params.sampleId),
      ).toEqual(["s1", "s2"]);
      server.close();
    });

    it("测试出错时显示原因，按钮恢复", async () => {
      const server = await openDialog(
        {
          "runtime.listReviewerSamples": SAMPLES,
          "runtime.testReviewerSample": new RpcFail(-32000, "安全审查未配置或已关闭"),
        },
        itemsWith(MODEL_REVIEWER),
      );
      fireEvent.click(screen.getByRole("button", { name: "测试" }));
      await screen.findByText("测试失败：安全审查未配置或已关闭");
      expect(screen.getByRole("button", { name: "测试" })).toHaveProperty("disabled", false);
      server.close();
    });
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
    expect(groups()).toEqual(["权限", "执行", "普通对话", "文件", "通知"]);
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

  it("通知一节：总开关关闭时下各项变灰禁用；「完成」未勾时阈值行变灰", async () => {
    const NOTIFY_ITEMS: SettingItem[] = [
      ...ITEMS,
      {
        key: "notifications.enabled",
        effective: "true",
        source: "settings",
        saved: "true",
        overridden: false,
      },
      {
        key: "notifications.events.attention",
        effective: "true",
        source: "settings",
        saved: "true",
        overridden: false,
      },
      {
        key: "notifications.events.error",
        effective: "true",
        source: "settings",
        saved: "true",
        overridden: false,
      },
      {
        key: "notifications.events.done",
        effective: "false",
        source: "settings",
        saved: "false",
        overridden: false,
      },
      {
        key: "notifications.doneAfterSeconds",
        effective: "60",
        source: "default",
        saved: undefined,
        overridden: false,
      },
      {
        key: "notifications.sound",
        effective: "true",
        source: "default",
        saved: undefined,
        overridden: false,
      },
    ];
    const server = fakeServer(handlers({ "runtime.describeSettings": NOTIFY_ITEMS }));
    await server.initialize();
    render(<SettingsPage {...props(server.client)} />);
    await screen.findByRole("switch", { name: "通知" });
    // 「完成」未勾：阈值行变灰（disabled 带原因），事件行本身可用（总开关开着）
    expect(screen.getByRole("checkbox", { name: "需要确认" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("combobox", { name: "完成提醒的阈值" }).getAttribute("title")).toBe(
      "未勾选「完成」",
    );
    server.close();
  });

  it("通知一节：总开关关闭整节变灰；保存失败回滚并在行下写红字", async () => {
    const OFF_ITEMS: SettingItem[] = [
      ...ITEMS,
      {
        key: "notifications.enabled",
        effective: "false",
        source: "settings",
        saved: "false",
        overridden: false,
      },
      {
        key: "notifications.events.attention",
        effective: "true",
        source: "settings",
        saved: "true",
        overridden: false,
      },
      {
        key: "notifications.events.error",
        effective: "true",
        source: "settings",
        saved: "true",
        overridden: false,
      },
      {
        key: "notifications.events.done",
        effective: "true",
        source: "settings",
        saved: "true",
        overridden: false,
      },
      {
        key: "notifications.doneAfterSeconds",
        effective: "60",
        source: "default",
        saved: undefined,
        overridden: false,
      },
      {
        key: "notifications.sound",
        effective: "true",
        source: "default",
        saved: undefined,
        overridden: false,
      },
    ];
    const server = fakeServer(
      handlers({
        "runtime.describeSettings": OFF_ITEMS,
        "runtime.updateSettings": () => new RpcFail(-32000, "磁盘只读"),
      }),
    );
    await server.initialize();
    render(<SettingsPage {...props(server.client)} />);
    const master = await screen.findByRole("switch", { name: "通知" });
    expect(master.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("已关闭")).toBeTruthy();
    // 总开关关闭：三事件复选、阈值、提示音、测试按钮全禁用
    expect(screen.getByRole("checkbox", { name: "需要确认" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "发送测试通知" }).hasAttribute("disabled")).toBe(
      true,
    );
    // 打开总开关后保存失败：值回到原样并在行下写红字
    fireEvent.click(master);
    await screen.findByText(/保存失败：磁盘只读/);
    expect(screen.getByRole("switch", { name: "通知" }).getAttribute("aria-checked")).toBe("false");
    server.close();
  });

  it("通知一节：阈值保存值不在档位里时显示「N 秒」并保留；测试通知被系统拒绝时提示去系统设置", async () => {
    const CUSTOM_ITEMS: SettingItem[] = [
      ...ITEMS,
      {
        key: "notifications.enabled",
        effective: "true",
        source: "settings",
        saved: "true",
        overridden: false,
      },
      {
        key: "notifications.events.attention",
        effective: "true",
        source: "settings",
        saved: "true",
        overridden: false,
      },
      {
        key: "notifications.events.error",
        effective: "true",
        source: "settings",
        saved: "true",
        overridden: false,
      },
      {
        key: "notifications.events.done",
        effective: "true",
        source: "settings",
        saved: "true",
        overridden: false,
      },
      {
        key: "notifications.doneAfterSeconds",
        effective: "45",
        source: "settings",
        saved: "45",
        overridden: false,
      },
      {
        key: "notifications.sound",
        effective: "true",
        source: "default",
        saved: undefined,
        overridden: false,
      },
    ];
    const server = fakeServer(handlers({ "runtime.describeSettings": CUSTOM_ITEMS }));
    await server.initialize();
    const view = render(<SettingsPage {...props(server.client)} />);
    await screen.findByRole("switch", { name: "通知" });
    // 45 秒不在档位里：触发器显示「45 秒」
    expect(screen.getByRole("combobox", { name: "完成提醒的阈值" }).textContent).toContain("45 秒");
    view.unmount();
    cleanup();
    server.close();
    const server2 = fakeServer(handlers({ "runtime.describeSettings": ITEMS }));
    await server2.initialize();
    const sendTest = vi.fn(() => Promise.resolve({ shown: false, reason: "disabled" as const }));
    render(<SettingsPage {...props(server2.client, { notifications: { sendTest } })} />);
    await screen.findByRole("button", { name: "发送测试通知" });
    fireEvent.click(screen.getByRole("button", { name: "发送测试通知" }));
    await screen.findByText("Windows 已关闭 Nocturne 的通知，请到 系统 › 通知 打开");
    expect(sendTest).toHaveBeenCalledTimes(1);
    server2.close();
  });
});

it("默认模型与角色指向停用模型时加删除线并注明按未设置处理（ADR-0054）", async () => {
  const server = fakeServer(
    handlers({
      "runtime.listModels": () => MODELS,
      "runtime.describeSettings": ITEMS.map((item) =>
        item.key === "modelRoles.task"
          ? {
              ...item,
              effective: "openrouter/tiny",
              saved: "openrouter/tiny",
              source: "settings",
              disabled: "model",
            }
          : item.key === "defaultModel"
            ? { ...item, disabled: "provider" }
            : item,
      ),
    }),
  );
  await server.initialize();
  render(<SettingsPage {...props(server.client, { section: "models" })} />);
  await screen.findByText("默认模型与档位");

  const defaultRow = row("默认模型与档位");
  expect(defaultRow.querySelector(".model-value.off")).toBeTruthy();
  expect(defaultRow.textContent).toContain("已停用，按未设置处理：新会话需要先选模型");

  const taskRow = row("子代理模型");
  expect(taskRow.querySelector(".model-value.off")).toBeTruthy();
  expect(taskRow.textContent).toContain("已停用，按未设置处理");
  // 未停用的角色值与默认文案保持不变
  expect(row("看图模型").querySelector(".model-value.off")).toBeNull();
  server.close();
});

it("模型页的子代理模型行跳转到设置 › 子代理，不再弹出模型对话框", async () => {
  const server = fakeServer(handlers());
  await server.initialize();
  const onOpenSubagents = vi.fn();
  render(<SettingsPage {...props(server.client, { section: "models", onOpenSubagents })} />);
  await screen.findByText("默认模型与档位");
  fireEvent.click(within(row("子代理模型")).getByRole("button", { name: "设置 › 子代理" }));
  expect(onOpenSubagents).toHaveBeenCalledOnce();
  expect(screen.queryByRole("dialog")).toBeNull();
  server.close();
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
