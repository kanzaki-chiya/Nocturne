import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PluginOverview, PluginsDescription } from "@nocturne/core/protocol";
import { PluginsPage } from "../src/PluginsPage";
import { fakeServer, RpcFail, withInit } from "./fake-server";

afterEach(cleanup);

const plugin = (overrides: Partial<PluginOverview> = {}): PluginOverview => ({
  id: "codex:helper@openai-curated",
  host: "codex",
  name: "helper",
  marketplace: "openai-curated",
  version: "1.2.0",
  root: "C:/codex/plugins/cache/openai-curated/helper/1.2.0",
  displayName: "Helper Plugin",
  description: "提供会话初始化上下文与技能",
  state: "off",
  hooks: [
    {
      point: "SessionStart",
      matcher: "startup|resume",
      command: "node ${PLUGIN_ROOT}/scripts/start.mjs --verbose",
    },
  ],
  unsupported: [{ point: "PreToolUse", reason: "point" }],
  skills: ["review-diff"],
  warnings: [],
  ...overrides,
});

const desc = (plugins: PluginOverview[], warnings: string[] = []): PluginsDescription => ({
  plugins,
  warnings,
});

it("按宿主分组渲染，空组不显示，changed 行显示「已更改」与「重新确认」", async () => {
  const codexOn = plugin({
    id: "codex:active@mkt",
    name: "active",
    displayName: undefined,
    description: undefined,
    version: "0.9.0",
    state: "on",
  });
  const codexChanged = plugin({
    id: "codex:changed@mkt",
    name: "changed",
    displayName: "Changed Codex",
    state: "changed",
  });
  const claudeOff = plugin({
    id: "claude:lint@claude-plugins-official",
    host: "claude",
    name: "lint",
    marketplace: "claude-plugins-official",
    version: "",
    displayName: "Claude Lint",
    description: "代码检查",
    state: "off",
  });

  const f = fakeServer(
    withInit({
      "plugins.describePlugins": desc([codexOn, codexChanged, claudeOff]),
    }),
  );
  await f.initialize();
  render(<PluginsPage client={f.client} version={0} openDirectory={vi.fn()} />);

  const codexRegion = await screen.findByRole("region", { name: "Codex · 2" });
  const claudeRegion = screen.getByRole("region", { name: "Claude Code · 1" });

  expect(within(codexRegion).getByText("active")).toBeTruthy();
  expect(within(codexRegion).getByText("0.9.0")).toBeTruthy();
  expect(
    within(codexRegion).getByRole("switch", { name: "启用 active" }).getAttribute("aria-checked"),
  ).toBe("true");

  expect(within(codexRegion).getByText("Changed Codex")).toBeTruthy();
  expect(within(codexRegion).getByText("已更改")).toBeTruthy();
  expect(within(codexRegion).getByRole("button", { name: "重新确认" })).toBeTruthy();
  expect(
    within(codexRegion)
      .getByRole("switch", { name: "启用 Changed Codex" })
      .getAttribute("aria-checked"),
  ).toBe("false");

  expect(within(claudeRegion).getByText("Claude Lint")).toBeTruthy();
  expect(within(claudeRegion).getByText("代码检查")).toBeTruthy();
  expect(
    within(claudeRegion)
      .getByRole("switch", { name: "启用 Claude Lint" })
      .getAttribute("aria-checked"),
  ).toBe("false");

  f.close();
});

it("只有一组有插件时只显示该组，空列表显示「没有插件」", async () => {
  let current = desc([
    plugin({ host: "claude", id: "claude:only@mkt", displayName: "Only Claude" }),
  ]);
  const f = fakeServer(
    withInit({
      "plugins.describePlugins": () => current,
    }),
  );
  await f.initialize();
  const view = render(<PluginsPage client={f.client} version={0} openDirectory={vi.fn()} />);

  await screen.findByRole("region", { name: "Claude Code · 1" });
  expect(screen.queryByRole("region", { name: /^Codex/ })).toBeNull();

  current = desc([]);
  view.rerender(<PluginsPage client={f.client} version={1} openDirectory={vi.fn()} />);
  expect(await screen.findByText("没有插件")).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();

  f.close();
});

it("打开 Switch 先弹确认对话框并列出 hook、技能与不运行项；点「取消」不调 RPC，点「启用」才调", async () => {
  const target = plugin({
    unsupported: [
      { point: "PreToolUse", reason: "point" },
      { point: "UserPromptSubmit", reason: "type" },
      { point: "SessionStart", reason: "async" },
      { point: "SubagentStart", reason: "user_config" },
    ],
  });
  let state: PluginOverview["state"] = "off";
  const f = fakeServer(
    withInit({
      "plugins.describePlugins": () => desc([{ ...target, state }]),
      "plugins.setPluginEnabled": (p: Record<string, unknown>) => {
        state = p.enabled === true ? "on" : "off";
        return { affectedSessions: 1 };
      },
    }),
  );
  await f.initialize();
  render(<PluginsPage client={f.client} version={0} openDirectory={vi.fn()} />);

  fireEvent.click(await screen.findByRole("switch", { name: "启用 Helper Plugin" }));

  const dlg = screen.getByRole("dialog", { name: "启用 Helper Plugin" });
  expect(within(dlg).getAllByText("SessionStart")).toHaveLength(2);
  expect(within(dlg).getByText("startup|resume")).toBeTruthy();
  expect(within(dlg).getByText("node ${PLUGIN_ROOT}/scripts/start.mjs --verbose")).toBeTruthy();
  expect(within(dlg).getByText("review-diff")).toBeTruthy();
  expect(within(dlg).getByText("不支持的点位")).toBeTruthy();
  expect(within(dlg).getByText("不支持的类型")).toBeTruthy();
  expect(within(dlg).getByText("异步")).toBeTruthy();
  expect(within(dlg).getByText("需要用户配置")).toBeTruthy();

  fireEvent.click(within(dlg).getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(f.calls.filter((c) => c.method === "plugins.setPluginEnabled")).toHaveLength(0);

  fireEvent.click(screen.getByRole("switch", { name: "启用 Helper Plugin" }));
  const dlg2 = screen.getByRole("dialog", { name: "启用 Helper Plugin" });
  fireEvent.click(within(dlg2).getByRole("button", { name: "启用" }));

  expect(await screen.findByRole("status")).toHaveProperty("textContent", "✓ 已启用 Helper Plugin");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(f.calls.find((c) => c.method === "plugins.setPluginEnabled")?.params).toEqual({
    id: target.id,
    enabled: true,
  });
  await waitFor(() => {
    expect(
      screen.getByRole("switch", { name: "启用 Helper Plugin" }).getAttribute("aria-checked"),
    ).toBe("true");
  });

  f.close();
});

it("点「重新确认」弹出启用对话框并重新信任，关闭 Switch 不弹对话框直接停用", async () => {
  let state: PluginOverview["state"] = "changed";
  const target = plugin({ state: "changed" });
  const f = fakeServer(
    withInit({
      "plugins.describePlugins": () => desc([{ ...target, state }]),
      "plugins.setPluginEnabled": (p: Record<string, unknown>) => {
        state = p.enabled === true ? "on" : "off";
        return { affectedSessions: 0 };
      },
    }),
  );
  await f.initialize();
  render(<PluginsPage client={f.client} version={0} openDirectory={vi.fn()} />);

  fireEvent.click(await screen.findByRole("button", { name: "重新确认" }));
  const dlg = screen.getByRole("dialog", { name: "启用 Helper Plugin" });
  fireEvent.click(within(dlg).getByRole("button", { name: "启用" }));
  expect(await screen.findByRole("status")).toHaveProperty("textContent", "✓ 已启用 Helper Plugin");

  await waitFor(() => {
    expect(screen.queryByRole("button", { name: "重新确认" })).toBeNull();
  });

  fireEvent.click(screen.getByRole("switch", { name: "启用 Helper Plugin" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(await screen.findByRole("status")).toHaveProperty("textContent", "✓ 已停用 Helper Plugin");
  expect(
    f.calls.filter((c) => c.method === "plugins.setPluginEnabled").map((c) => c.params),
  ).toEqual([
    { id: target.id, enabled: true },
    { id: target.id, enabled: false },
  ]);

  f.close();
});

it("点击行进入详情页展示概况、Hook、技能、不运行与警告，点目录和面包屑有效", async () => {
  const item = plugin({
    host: "claude",
    id: "claude:helper@claude-plugins-official",
    marketplace: "claude-plugins-official",
    warnings: ["plugin helper@claude-plugins-official：hooks 文件不是合法 JSON"],
  });
  const openDirectory = vi.fn().mockResolvedValue(undefined);
  const f = fakeServer(
    withInit({
      "plugins.describePlugins": desc([item]),
    }),
  );
  await f.initialize();
  render(<PluginsPage client={f.client} version={0} openDirectory={openDirectory} />);

  fireEvent.click(await screen.findByText("Helper Plugin"));
  expect(await screen.findByRole("button", { name: "插件" })).toBeTruthy();

  const summary = screen.getByRole("region", { name: "概况" });
  expect(summary.textContent).toContain(item.root);
  expect(summary.textContent).toContain("1.2.0");
  expect(summary.textContent).toContain("Claude Code");
  expect(summary.textContent).toContain("claude-plugins-official");

  expect(screen.getByRole("region", { name: "Hook · 1" }).textContent).toContain(
    "node ${PLUGIN_ROOT}/scripts/start.mjs --verbose",
  );
  expect(screen.getByRole("region", { name: "技能 · 1" }).textContent).toContain("review-diff");
  expect(screen.getByRole("region", { name: "不运行 · 1" }).textContent).toContain("不支持的点位");
  expect(screen.getByText("1 条警告，查看")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "在资源管理器中打开" }));
  expect(openDirectory).toHaveBeenCalledWith(item.root);

  fireEvent.click(screen.getByRole("button", { name: "插件" }));
  await screen.findByRole("region", { name: "Claude Code · 1" });

  f.close();
});

it("setPluginEnabled 抛错时关闭对话框并在页面 errt 显示错误原文", async () => {
  const f = fakeServer(
    withInit({
      "plugins.describePlugins": desc([plugin()]),
      "plugins.setPluginEnabled": new RpcFail(-32602, "插件目录包含符号链接，禁止启用", {
        code: "invalid_command",
      }),
    }),
  );
  await f.initialize();
  render(<PluginsPage client={f.client} version={0} openDirectory={vi.fn()} />);

  fireEvent.click(await screen.findByRole("switch", { name: "启用 Helper Plugin" }));
  const dlg = screen.getByRole("dialog", { name: "启用 Helper Plugin" });
  fireEvent.click(within(dlg).getByRole("button", { name: "启用" }));

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe("插件目录包含符号链接，禁止启用");
  expect(screen.queryByRole("dialog")).toBeNull();

  f.close();
});

it("runtime.providersChanged 触发刷新且迟到响应不覆盖新快照", async () => {
  let callIndex = 0;
  let releaseFirst!: (value: PluginsDescription) => void;
  const f = fakeServer(
    withInit({
      "plugins.describePlugins": () => {
        callIndex++;
        if (callIndex === 1) {
          return new Promise<PluginsDescription>((resolve) => {
            releaseFirst = resolve;
          });
        }
        return desc([plugin({ displayName: "Fresh Plugin" })]);
      },
    }),
  );
  await f.initialize();
  render(<PluginsPage client={f.client} version={0} openDirectory={vi.fn()} />);

  await waitFor(() => {
    expect(callIndex).toBe(1);
  });

  act(() => {
    f.notify("runtime.providersChanged", {});
  });
  await screen.findByText("Fresh Plugin");

  await act(async () => {
    releaseFirst(desc([plugin({ displayName: "Stale Plugin" })]));
  });
  expect(screen.getByText("Fresh Plugin")).toBeTruthy();
  expect(screen.queryByText("Stale Plugin")).toBeNull();

  f.close();
});
