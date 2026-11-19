import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  HookOverview,
  HooksDescription,
  PluginOverview,
  PluginsDescription,
} from "@nocturne/core/protocol";
import { HooksPage } from "../src/HooksPage";
import { PluginsPage } from "../src/PluginsPage";
import { fakeServer, withInit } from "./fake-server";

afterEach(cleanup);

const desc = (hooks: HookOverview[], warnings: string[] = []): HooksDescription => ({
  hooks,
  warnings,
});

const pluginsDesc = (plugins: PluginOverview[], warnings: string[] = []): PluginsDescription => ({
  plugins,
  warnings,
});

const TINY_PNG_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const samplePlugin = (overrides: Partial<PluginOverview> = {}): PluginOverview => ({
  id: "codex:ponytail@openai-curated",
  host: "codex",
  name: "ponytail",
  marketplace: "openai-curated",
  version: "5.3.3",
  root: "C:/codex/plugins/cache/openai-curated/ponytail/5.3.3",
  displayName: "Ponytail",
  description: "Session hooks",
  icon: TINY_PNG_URI,
  state: "on",
  hooks: [
    { point: "SessionStart", command: "node ./start.mjs" },
    { point: "SubagentStart", command: "node ./sub.mjs" },
    { point: "UserPromptSubmit", command: "node ./prompt.mjs" },
  ],
  unsupported: [{ point: "PreToolUse", reason: "point" }],
  skills: [],
  mcpServers: [],
  warnings: [],
  ...overrides,
});

describe("Hook 设置页（只读）", () => {
  it("按事件点分组并保留配置顺序，显示命令、matcher、超时、来源与未信任状态", async () => {
    const f = fakeServer(
      withInit({
        "hooks.describeHooks": desc([
          {
            point: "PreToolUse",
            matcher: "shell|edit",
            command: "node",
            args: ["./hooks/guard.mjs", "--strict"],
            timeoutMs: 10000,
            origin: "user",
            path: "C:/home/.nocturne/config.json",
            trusted: true,
          },
          {
            point: "PreToolUse",
            command: "node",
            args: ["./hooks/project-check.mjs"],
            timeoutMs: 5000,
            origin: "project",
            path: "Z:/demo/.nocturne/config.json",
            trusted: false,
          },
          {
            point: "TurnEnd",
            matcher: "should-not-render",
            command: "python3",
            args: ["audit.py"],
            timeoutMs: 5000,
            origin: "user",
            path: "C:/home/.nocturne/config.json",
            trusted: true,
          },
        ]),
        "plugins.describePlugins": pluginsDesc([]),
      }),
    );
    await f.initialize();

    render(<HooksPage client={f.client} workspaceRoot="Z:/demo" version={0} />);

    const preRegion = await screen.findByRole("region", { name: "PreToolUse · 2" });
    const turnEndRegion = screen.getByRole("region", { name: "TurnEnd · 1" });

    const preRows = [...preRegion.querySelectorAll(".hook-item")];
    expect(preRows).toHaveLength(2);
    expect(preRows[0]?.querySelector(".hook-cmd")?.textContent).toBe(
      "node ./hooks/guard.mjs --strict",
    );
    expect(within(preRows[0] as HTMLElement).getByText("shell|edit")).toBeTruthy();
    expect(within(preRows[0] as HTMLElement).getByText("10 秒")).toBeTruthy();
    expect(
      within(preRows[0] as HTMLElement).getByText("C:/home/.nocturne/config.json"),
    ).toBeTruthy();
    expect(preRows[0]?.className).not.toContain("untrusted");

    expect(preRows[1]?.querySelector(".hook-cmd")?.textContent).toBe(
      "node ./hooks/project-check.mjs",
    );
    expect(within(preRows[1] as HTMLElement).getByText("未信任")).toBeTruthy();
    expect(within(preRows[1] as HTMLElement).getByText("5 秒")).toBeTruthy();
    expect(
      within(preRows[1] as HTMLElement).getByText("Z:/demo/.nocturne/config.json"),
    ).toBeTruthy();
    expect(preRows[1]?.className).toContain("untrusted");

    expect(within(turnEndRegion).queryByText("should-not-render")).toBeNull();
    expect(turnEndRegion.querySelector(".hook-cmd")?.textContent).toBe("python3 audit.py");

    // 无插件 Hook 时只读且不渲染「来自插件」分组
    const page = screen.getByRole("region", { name: "Hook" });
    expect(within(page).queryAllByRole("button")).toHaveLength(0);
    expect(within(page).queryAllByRole("switch")).toHaveLength(0);
    expect(screen.queryByRole("region", { name: /^来自插件/ })).toBeNull();

    expect(f.calls.find((c) => c.method === "hooks.describeHooks")?.params).toEqual({
      workspaceRoot: "Z:/demo",
    });
    f.close();
  });

  it("同时有配置 Hook 与已启用插件时两部分都显示，且只列 on 且含受支持 Hook 的插件", async () => {
    const enabled = samplePlugin();
    const offPlugin = samplePlugin({
      id: "codex:disabled@mkt",
      name: "disabled",
      displayName: "Off Plugin",
      state: "off",
    });
    const changedPlugin = samplePlugin({
      id: "codex:changed@mkt",
      name: "changed",
      displayName: "Changed Plugin",
      state: "changed",
    });
    const noSupportedHooks = samplePlugin({
      id: "claude:unsupported-only@mkt",
      host: "claude",
      name: "unsupported-only",
      displayName: "Unsupported Only",
      state: "on",
      hooks: [],
      unsupported: [{ point: "PreToolUse", reason: "point" }],
    });

    const f = fakeServer(
      withInit({
        "hooks.describeHooks": desc([
          {
            point: "SessionStart",
            command: "node",
            args: ["./init.mjs"],
            timeoutMs: 5000,
            origin: "user",
            path: "C:/home/.nocturne/config.json",
            trusted: true,
          },
        ]),
        "plugins.describePlugins": pluginsDesc([
          enabled,
          offPlugin,
          changedPlugin,
          noSupportedHooks,
        ]),
      }),
    );
    await f.initialize();

    render(<HooksPage client={f.client} workspaceRoot="Z:/demo" version={0} />);

    const configRegion = await screen.findByRole("region", { name: "SessionStart · 1" });
    const pluginRegion = await screen.findByRole("region", { name: "来自插件 · 1" });
    expect(
      configRegion.compareDocumentPosition(pluginRegion) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    expect(within(pluginRegion).getByText("Ponytail")).toBeTruthy();
    expect(within(pluginRegion).getByText("3 个 Hook")).toBeTruthy();
    await waitFor(() => {
      const img = pluginRegion.querySelector("img.plugin-icon-img");
      expect(img?.getAttribute("src")).toBe(TINY_PNG_URI);
    });

    expect(screen.queryByText("Off Plugin")).toBeNull();
    expect(screen.queryByText("Changed Plugin")).toBeNull();
    expect(screen.queryByText("Unsupported Only")).toBeNull();
    expect(screen.queryByText("没有 Hook")).toBeNull();
    f.close();
  });

  it("只有插件 Hook 时不显示「没有 Hook」，无图标插件渲染默认图标", async () => {
    const claudeOn = samplePlugin({
      id: "claude:guard@mkt",
      host: "claude",
      name: "guard",
      displayName: "Claude Guard",
      icon: undefined,
      hooks: [{ point: "SessionStart", command: "node ./guard.mjs" }],
    });
    const f = fakeServer(
      withInit({
        "hooks.describeHooks": desc([]),
        "plugins.describePlugins": pluginsDesc([claudeOn]),
      }),
    );
    await f.initialize();

    render(<HooksPage client={f.client} workspaceRoot={undefined} version={0} />);

    const pluginRegion = await screen.findByRole("region", { name: "来自插件 · 1" });
    expect(within(pluginRegion).getByText("Claude Guard")).toBeTruthy();
    expect(within(pluginRegion).getByText("1 个 Hook")).toBeTruthy();
    expect(pluginRegion.querySelector("img")).toBeNull();
    expect(pluginRegion.querySelector(".plugin-icon.fallback svg")).toBeTruthy();
    expect(screen.queryByText("没有 Hook")).toBeNull();
    f.close();
  });

  it("点击插件行后进入该插件详情，从详情返回时回到插件列表", async () => {
    const enabled = samplePlugin();
    const f = fakeServer(
      withInit({
        "hooks.describeHooks": desc([]),
        "plugins.describePlugins": pluginsDesc([enabled]),
      }),
    );
    await f.initialize();

    function SettingsHarness() {
      const [tab, setTab] = useState<"hooks" | "plugins">("hooks");
      const [jump, setJump] = useState<{ id: string; seq: number }>();
      return tab === "hooks" ? (
        <HooksPage
          client={f.client}
          workspaceRoot="Z:/demo"
          version={0}
          onOpenPlugin={(id) => {
            setJump((prev) => ({ id, seq: (prev?.seq ?? 0) + 1 }));
            setTab("plugins");
          }}
        />
      ) : (
        <PluginsPage
          client={f.client}
          version={0}
          openPlugin={jump}
          openDirectory={vi.fn().mockResolvedValue(undefined)}
        />
      );
    }

    render(<SettingsHarness />);

    fireEvent.click(await screen.findByText("Ponytail"));

    // 进入插件详情页：页头面包屑「插件」与概况可见
    const backBtn = await screen.findByRole("button", { name: "插件" });
    expect(screen.getByRole("region", { name: "概况" }).textContent).toContain("5.3.3");
    expect(screen.getByRole("region", { name: "Hook · 3" })).toBeTruthy();

    // 从详情返回时回到插件列表
    fireEvent.click(backBtn);
    await screen.findByRole("region", { name: "Codex · 1" });
    f.close();
  });

  it("配置 Hook 和插件 Hook 都没有时显示「没有 Hook」", async () => {
    const f = fakeServer(
      withInit({
        "hooks.describeHooks": desc([]),
        "plugins.describePlugins": pluginsDesc([
          samplePlugin({ id: "codex:off@mkt", state: "off" }),
        ]),
      }),
    );
    await f.initialize();

    render(<HooksPage client={f.client} workspaceRoot={undefined} version={0} />);

    expect(await screen.findByText("没有 Hook")).toBeTruthy();
    const page = screen.getByRole("region", { name: "Hook" });
    expect(within(page).queryAllByRole("button")).toHaveLength(0);
    f.close();
  });

  it("收到 grants.changed 通知后重新拉取 Hook 列表", async () => {
    let trusted = false;
    const f = fakeServer(
      withInit({
        "hooks.describeHooks": () =>
          desc([
            {
              point: "SessionStart",
              command: "node",
              args: ["./init.mjs"],
              timeoutMs: 5000,
              origin: "project",
              path: "Z:/demo/.nocturne/config.json",
              trusted,
            },
          ]),
        "plugins.describePlugins": pluginsDesc([]),
      }),
    );
    await f.initialize();

    render(<HooksPage client={f.client} workspaceRoot="Z:/demo" version={0} />);

    expect(await screen.findByText("未信任")).toBeTruthy();

    trusted = true;
    act(() => {
      f.notify("grants.changed", { workspace: "Z:/demo" });
    });

    await waitFor(() => {
      expect(screen.getByText("已信任")).toBeTruthy();
    });
    f.close();
  });

  it("「来自插件」照常列出带 Hook 的自有插件", async () => {
    const nativePlugin = samplePlugin({
      id: "nocturne:guard@builtin",
      host: "nocturne",
      name: "guard",
      marketplace: "builtin",
      displayName: "Guard Native",
      state: "on",
      hooks: [{ point: "PreToolUse", matcher: "shell", command: "${NOCTURNE_NODE} ./guard.mjs" }],
      unsupported: [],
    });
    const f = fakeServer(
      withInit({
        "hooks.describeHooks": desc([]),
        "plugins.describePlugins": pluginsDesc([nativePlugin]),
      }),
    );
    await f.initialize();

    render(<HooksPage client={f.client} workspaceRoot={undefined} version={0} />);

    const region = await screen.findByRole("region", { name: "来自插件 · 1" });
    expect(within(region).getByText("Guard Native")).toBeTruthy();
    expect(within(region).getByText("1 个 Hook")).toBeTruthy();
    f.close();
  });
});
