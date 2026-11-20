import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  PluginOverview,
  PluginsDescription,
  SkillOverview,
  SkillsDescription,
} from "@nocturne/core/protocol";
import { Composer } from "../src/Composer";
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
  mcpServers: [],
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

it("插件列表行与详情页头部同时支持图标 img 与统一默认插件图标（无替代文字）", async () => {
  const iconUri =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const withIcon = plugin({
    id: "codex:with-icon@mkt",
    name: "with-icon",
    displayName: "With Icon",
    icon: iconUri,
    state: "on",
  });
  const withoutIcon = plugin({
    id: "claude:no-icon@mkt",
    host: "claude",
    name: "no-icon",
    displayName: "No Icon",
    icon: undefined,
    state: "on",
  });

  const f = fakeServer(
    withInit({
      "plugins.describePlugins": desc([withIcon, withoutIcon]),
    }),
  );
  await f.initialize();
  render(<PluginsPage client={f.client} version={0} openDirectory={vi.fn()} />);

  const codexRegion = await screen.findByRole("region", { name: "Codex · 1" });
  const claudeRegion = screen.getByRole("region", { name: "Claude Code · 1" });

  await waitFor(() => {
    const listImg = codexRegion.querySelector("img.plugin-icon-img");
    expect(listImg?.getAttribute("src")).toBe(iconUri);
  });

  expect(claudeRegion.querySelector("img")).toBeNull();
  const fallback = claudeRegion.querySelector(".plugin-icon.fallback");
  expect(fallback?.querySelector("svg")).toBeTruthy();
  expect(fallback?.textContent).toBe("");

  // 进入带图标插件详情，页头去掉小图标，hero 渲染 48px 大图标，名称只出现一次
  fireEvent.click(within(codexRegion).getByText("With Icon"));
  await screen.findByRole("button", { name: "插件" });
  expect(document.querySelector(".phead .plugin-icon")).toBeNull();
  expect(screen.getAllByText("With Icon")).toHaveLength(1);
  await waitFor(() => {
    const heroImg = document.querySelector(
      ".plugin-detail-hero .plugin-icon-lg img.plugin-icon-img",
    );
    expect(heroImg?.getAttribute("src")).toBe(iconUri);
  });

  f.close();
});

it("在支持 URL.createObjectURL 的环境下将图标 data URI 转为 blob URL 并在卸载时释放", async () => {
  const createSpy = vi.fn(() => "blob:plugin-icon-1");
  const revokeSpy = vi.fn();
  const origCreate = URL.createObjectURL;
  const origRevoke = URL.revokeObjectURL;
  Object.defineProperty(URL, "createObjectURL", { value: createSpy, configurable: true });
  Object.defineProperty(URL, "revokeObjectURL", { value: revokeSpy, configurable: true });
  try {
    const iconUri =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const f = fakeServer(
      withInit({
        "plugins.describePlugins": desc([plugin({ icon: iconUri, state: "on" })]),
      }),
    );
    await f.initialize();
    const view = render(<PluginsPage client={f.client} version={0} openDirectory={vi.fn()} />);

    const codexRegion = await screen.findByRole("region", { name: "Codex · 1" });
    await waitFor(() => {
      expect(codexRegion.querySelector("img.plugin-icon-img")?.getAttribute("src")).toBe(
        "blob:plugin-icon-1",
      );
    });
    expect(createSpy).toHaveBeenCalledTimes(1);

    view.unmount();
    expect(revokeSpy).toHaveBeenCalledWith("blob:plugin-icon-1");
    f.close();
  } finally {
    Object.defineProperty(URL, "createObjectURL", { value: origCreate, configurable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: origRevoke, configurable: true });
  }
});

it("按来源将内置插件单独分组，标题只写来源名；内置插件开关直接启停不弹指纹确认框", async () => {
  let state: PluginOverview["state"] = "on";
  const builtinPlugin = plugin({
    id: "nocturne:office@builtin",
    host: "nocturne",
    name: "office",
    marketplace: "builtin",
    version: "0.1.0",
    displayName: "Office 文档",
    description: "文档转换与读取",
    state: "on",
    hooks: [],
    unsupported: [],
    skills: ["office-docs"],
    mcpServers: [{ id: "office", command: "${NOCTURNE_NODE} ${PLUGIN_ROOT}/server.mjs" }],
  });
  const localPlugin = plugin({
    id: "nocturne:my-tool@local",
    host: "nocturne",
    name: "my-tool",
    marketplace: "local",
    version: "1.0.0",
    displayName: "Local Tool",
    state: "off",
    hooks: [],
    unsupported: [],
    skills: ["local-skill"],
    mcpServers: [],
  });
  const f = fakeServer(
    withInit({
      "plugins.describePlugins": () => desc([{ ...builtinPlugin, state }, localPlugin]),
      "plugins.setPluginEnabled": (p: Record<string, unknown>) => {
        if (p.id === builtinPlugin.id) state = p.enabled ? "on" : "off";
        return { affectedSessions: 0 };
      },
    }),
  );
  await f.initialize();
  render(<PluginsPage client={f.client} version={0} openDirectory={vi.fn()} />);

  const builtinRegion = await screen.findByRole("region", { name: "内置 · 1" });
  expect(within(builtinRegion).getByText("Office 文档")).toBeTruthy();
  const nocturneRegion = await screen.findByRole("region", { name: "Nocturne · 1" });
  expect(within(nocturneRegion).getByText("Local Tool")).toBeTruthy();

  // 关闭内置插件再开启：直接调 setPluginEnabled，不弹确认对话框
  const toggle = within(builtinRegion).getByRole("switch", { name: "启用 Office 文档" });
  fireEvent.click(toggle);
  await waitFor(() => {
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });
  fireEvent.click(toggle);
  await waitFor(() => {
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(
    f.calls.filter((c) => c.method === "plugins.setPluginEnabled").map((c) => c.params),
  ).toEqual([
    { id: "nocturne:office@builtin", enabled: false },
    { id: "nocturne:office@builtin", enabled: true },
  ]);

  f.close();
});

it("插件详情在技能、Hook 之后显示「MCP 服务器」一节，列 id、命令与跳过原因", async () => {
  const item = plugin({
    id: "nocturne:kit@builtin",
    host: "nocturne",
    name: "kit",
    marketplace: "builtin",
    version: "1.0.0",
    displayName: "Toolkit",
    state: "on",
    hooks: [{ point: "PreToolUse", matcher: "shell", command: "${NOCTURNE_NODE} ./guard.mjs" }],
    unsupported: [{ point: "mcp:remote", reason: "type" }],
    skills: ["kit-skill"],
    mcpServers: [
      { id: "local-mcp", command: "${NOCTURNE_NODE} ${PLUGIN_ROOT}/mcp.mjs" },
      {
        id: "dup-mcp",
        command: "${NOCTURNE_NODE} ./dup.mjs",
        skipped: true,
        skipReason: "conflict",
      },
      { id: "remote", command: "https://example.com/mcp", skipped: true, skipReason: "http" },
    ],
  });
  const f = fakeServer(
    withInit({
      "plugins.describePlugins": desc([item]),
    }),
  );
  await f.initialize();
  render(<PluginsPage client={f.client} version={0} openDirectory={vi.fn()} />);

  fireEvent.click(await screen.findByText("Toolkit"));
  const mcpRegion = await screen.findByRole("region", { name: "MCP 服务器 · 3" });
  expect(within(mcpRegion).getByText("local-mcp")).toBeTruthy();
  expect(within(mcpRegion).getByText("${NOCTURNE_NODE} ${PLUGIN_ROOT}/mcp.mjs")).toBeTruthy();
  expect(within(mcpRegion).getByText("dup-mcp")).toBeTruthy();
  expect(within(mcpRegion).getByText("与配置同名")).toBeTruthy();
  expect(within(mcpRegion).getByText("remote")).toBeTruthy();
  expect(within(mcpRegion).getByText("不支持 HTTP")).toBeTruthy();

  f.close();
});

const skillOverview = (overrides: Partial<SkillOverview> = {}): SkillOverview => ({
  name: "docx",
  layer: "user",
  source: "plugin",
  plugin: "docx@builtin",
  entryPath: "/plugins/docx/skills/docx/SKILL.md",
  realPath: "/plugins/docx/skills/docx/SKILL.md",
  otherEntries: [],
  description: "Word 文档",
  displayedDescriptionLength: 7,
  invocation: "both",
  catalogStatus: "full",
  enabled: true,
  commandConflict: false,
  missingDescription: false,
  fields: {},
  unknownFields: {},
  ignored: [],
  bodyLines: 10,
  bodyPreview: "",
  files: [],
  size: 100,
  ...overrides,
});

const skillsDesc = (skills: SkillOverview[]): SkillsDescription => ({
  skills,
  warnings: [],
  budget: {
    usedTokens: 0,
    limitTokens: 1000,
    fullCount: skills.length,
    nameCount: 0,
    disabledCount: 0,
    basis: "fallback",
  },
  scannedDirs: [],
  homeDir: "/home/.nocturne/skills",
});

it("安装插件按钮流程：不支持选文件夹时隐藏；取消不调 RPC；成功刷新并进入详情；失败显示在 errt", async () => {
  const installed = plugin({
    id: "nocturne:my-local@local",
    host: "nocturne",
    name: "my-local",
    marketplace: "local",
    version: "1.0.0",
    displayName: "本地测试插件",
    description: "本地安装说明",
    state: "off",
    hooks: [],
    unsupported: [],
    skills: ["hello"],
  });
  let current: PluginOverview[] = [];
  let shouldFail = false;

  const f = fakeServer(
    withInit({
      "plugins.describePlugins": () => desc(current),
      "skills.describeSkills": () => skillsDesc([]),
      "plugins.installLocalPlugin": () => {
        if (shouldFail) {
          return new RpcFail(-32001, "清单无效：未找到 plugin.json", { code: "invalid_command" });
        }
        current = [installed];
        return installed;
      },
    }),
  );
  await f.initialize();

  // 未传 pickFolder 时不显示安装按钮
  const view = render(<PluginsPage client={f.client} version={0} openDirectory={vi.fn()} />);
  await screen.findByText("没有插件");
  expect(screen.queryByRole("button", { name: "安装插件…" })).toBeNull();

  // 取消选择：什么都不做
  const pickFolder = vi.fn<() => Promise<string | null>>().mockResolvedValueOnce(null);
  view.rerender(
    <PluginsPage client={f.client} version={0} openDirectory={vi.fn()} pickFolder={pickFolder} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "安装插件…" }));
  await waitFor(() => {
    expect(pickFolder).toHaveBeenCalledTimes(1);
  });
  expect(f.calls.filter((c) => c.method === "plugins.installLocalPlugin")).toHaveLength(0);

  // 失败：在 errt 显示错误
  shouldFail = true;
  pickFolder.mockResolvedValueOnce("C:/tmp/bad-plugin");
  fireEvent.click(screen.getByRole("button", { name: "安装插件…" }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "清单无效：未找到 plugin.json",
  );

  // 成功：刷新列表、toast 提示并进入该插件详情页
  shouldFail = false;
  pickFolder.mockResolvedValueOnce("C:/tmp/my-local");
  fireEvent.click(screen.getByRole("button", { name: "安装插件…" }));
  expect(await screen.findByRole("status")).toHaveProperty("textContent", "✓ 已安装 本地测试插件");
  expect(await screen.findByRole("button", { name: "插件" })).toBeTruthy();
  expect(screen.getAllByText("本地测试插件")).toHaveLength(1);
  expect(screen.getByText("本地安装说明")).toBeTruthy();

  f.close();
});

it("立即试用按钮显示条件：仅状态为 on 且存在可调用技能时显示，否则隐藏", async () => {
  const docxOn = plugin({
    id: "nocturne:docx@builtin",
    host: "nocturne",
    name: "docx",
    marketplace: "builtin",
    displayName: "Word 文档",
    description: "创建、读取与编辑 Word 文档",
    state: "on",
    hooks: [],
    unsupported: [],
    skills: ["docx"],
  });
  const docxOff = plugin({
    id: "nocturne:off-doc@local",
    host: "nocturne",
    name: "off-doc",
    marketplace: "local",
    displayName: "未启用插件",
    state: "off",
    hooks: [],
    unsupported: [],
    skills: ["off-skill"],
  });
  const blocked = plugin({
    id: "nocturne:blocked@local",
    host: "nocturne",
    name: "blocked",
    marketplace: "local",
    displayName: "不可调用插件",
    state: "on",
    hooks: [],
    unsupported: [],
    skills: ["s-disabled", "s-shadowed", "s-model", "s-conflict"],
  });

  const f = fakeServer(
    withInit({
      "plugins.describePlugins": desc([docxOn, docxOff, blocked]),
      "skills.describeSkills": skillsDesc([
        skillOverview({ name: "docx", plugin: "docx@builtin" }),
        skillOverview({ name: "off-skill", plugin: "off-doc@local" }),
        skillOverview({ name: "s-disabled", plugin: "blocked@local", enabled: false }),
        skillOverview({
          name: "s-shadowed",
          plugin: "blocked@local",
          shadowedBy: "/user/skills/s-shadowed/SKILL.md",
        }),
        skillOverview({ name: "s-model", plugin: "blocked@local", invocation: "model" }),
        skillOverview({ name: "s-conflict", plugin: "blocked@local", commandConflict: true }),
      ]),
    }),
  );
  await f.initialize();
  const onTrySkill = vi.fn();
  render(
    <PluginsPage client={f.client} version={0} openDirectory={vi.fn()} onTrySkill={onTrySkill} />,
  );

  // 1. on + 可调用技能：显示「立即试用」，点击直接触发
  fireEvent.click(await screen.findByText("Word 文档"));
  const tryBtn = await screen.findByRole("button", { name: "立即试用" });
  fireEvent.click(tryBtn);
  expect(onTrySkill).toHaveBeenCalledWith("docx");

  // 2. off：不显示「立即试用」
  fireEvent.click(screen.getByRole("button", { name: "插件" }));
  fireEvent.click(await screen.findByText("未启用插件"));
  await screen.findByRole("region", { name: "概况" });
  expect(screen.queryByRole("button", { name: "立即试用" })).toBeNull();

  // 3. on 但全部技能不可调用（disabled / shadowedBy / model / commandConflict）：不显示
  fireEvent.click(screen.getByRole("button", { name: "插件" }));
  fireEvent.click(await screen.findByText("不可调用插件"));
  await screen.findByRole("region", { name: "概况" });
  expect(screen.queryByRole("button", { name: "立即试用" })).toBeNull();

  f.close();
});

it("多技能插件点「立即试用」弹出菜单列可调用技能，选定后触发回调", async () => {
  const multi = plugin({
    id: "nocturne:suite@local",
    host: "nocturne",
    name: "suite",
    marketplace: "local",
    displayName: "多技能套件",
    state: "on",
    hooks: [],
    unsupported: [],
    skills: ["alpha", "beta", "hidden-model"],
  });
  const f = fakeServer(
    withInit({
      "plugins.describePlugins": desc([multi]),
      "skills.describeSkills": skillsDesc([
        skillOverview({ name: "alpha", plugin: "suite@local", invocation: "both" }),
        skillOverview({ name: "beta", plugin: "suite@local", invocation: "user" }),
        skillOverview({ name: "hidden-model", plugin: "suite@local", invocation: "model" }),
      ]),
    }),
  );
  await f.initialize();
  const onTrySkill = vi.fn();
  render(
    <PluginsPage client={f.client} version={0} openDirectory={vi.fn()} onTrySkill={onTrySkill} />,
  );

  fireEvent.click(await screen.findByText("多技能套件"));
  fireEvent.click(await screen.findByRole("button", { name: "立即试用" }));

  const menu = await screen.findByRole("menu", { name: "选择技能" });
  expect(within(menu).getByRole("menuitem", { name: "alpha" })).toBeTruthy();
  expect(within(menu).getByRole("menuitem", { name: "beta" })).toBeTruthy();
  expect(within(menu).queryByRole("menuitem", { name: "hidden-model" })).toBeNull();

  fireEvent.click(within(menu).getByRole("menuitem", { name: "beta" }));
  expect(onTrySkill).toHaveBeenCalledWith("beta");
  expect(screen.queryByRole("menu")).toBeNull();

  f.close();
});

it("本地插件卸载确认流程：仅 local 显示卸载；取消不调 RPC；确认后卸载并回列表提示；非 local 不显示", async () => {
  const localItem = plugin({
    id: "nocturne:local-kit@local",
    host: "nocturne",
    name: "local-kit",
    marketplace: "local",
    displayName: "本地工具箱",
    state: "off",
    hooks: [],
    unsupported: [],
    skills: ["kit"],
  });
  const builtinItem = plugin({
    id: "nocturne:docx@builtin",
    host: "nocturne",
    name: "docx",
    marketplace: "builtin",
    displayName: "Word 文档",
    state: "on",
    hooks: [],
    unsupported: [],
    skills: ["docx"],
  });
  let current: PluginOverview[] = [builtinItem, localItem];
  const f = fakeServer(
    withInit({
      "plugins.describePlugins": () => desc(current),
      "skills.describeSkills": () => skillsDesc([]),
      "plugins.uninstallPlugin": (p: Record<string, unknown>) => {
        current = current.filter((item) => item.id !== p.id);
        return { affectedSessions: 0 };
      },
    }),
  );
  await f.initialize();
  render(<PluginsPage client={f.client} version={0} openDirectory={vi.fn()} />);

  // 内置插件详情页不显示「卸载」
  fireEvent.click(await screen.findByText("Word 文档"));
  await screen.findByRole("region", { name: "概况" });
  expect(screen.queryByRole("button", { name: "卸载" })).toBeNull();

  // 返回列表进入本地插件详情页：显示「卸载」
  fireEvent.click(screen.getByRole("button", { name: "插件" }));
  fireEvent.click(await screen.findByText("本地工具箱"));
  fireEvent.click(await screen.findByRole("button", { name: "卸载" }));

  const dlg = screen.getByRole("dialog", { name: "卸载 本地工具箱？" });
  expect(dlg.querySelector(".db")).toBeNull();
  fireEvent.click(within(dlg).getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(f.calls.filter((c) => c.method === "plugins.uninstallPlugin")).toHaveLength(0);

  // 确认卸载：调 RPC、回到列表、显示 toast
  fireEvent.click(screen.getByRole("button", { name: "卸载" }));
  const dlg2 = screen.getByRole("dialog", { name: "卸载 本地工具箱？" });
  fireEvent.click(within(dlg2).getByRole("button", { name: "卸载" }));

  expect(await screen.findByRole("status")).toHaveProperty("textContent", "✓ 已卸载 本地工具箱");
  expect(f.calls.find((c) => c.method === "plugins.uninstallPlugin")?.params).toEqual({
    id: localItem.id,
  });
  await waitFor(() => {
    expect(screen.queryByText("本地工具箱")).toBeNull();
  });

  f.close();
});

it("Composer 预填草稿（prefillDraft）：填入 /docx 、光标在末尾并聚焦、无错误且不自动发送", async () => {
  const onSubmit = vi.fn().mockResolvedValue(true);
  const onUsed = vi.fn();
  render(
    <Composer
      variant="draft"
      running={false}
      onSubmit={onSubmit}
      onInterrupt={() => undefined}
      fileRefs={null}
      pickImages={() => Promise.resolve([])}
      onSlash={() => Promise.resolve(false)}
      prefillDraft={{ text: "/docx ", seq: 1 }}
      onPrefillDraftUsed={onUsed}
    />,
  );

  const box = screen.getByRole("textbox") as HTMLTextAreaElement;
  await waitFor(() => {
    expect(box.value).toBe("/docx ");
  });
  expect(document.activeElement).toBe(box);
  expect(box.selectionStart).toBe(6);
  expect(box.selectionEnd).toBe(6);
  expect(onUsed).toHaveBeenCalledTimes(1);
  expect(onSubmit).not.toHaveBeenCalled();
  expect(screen.queryByRole("alert")).toBeNull();
});
