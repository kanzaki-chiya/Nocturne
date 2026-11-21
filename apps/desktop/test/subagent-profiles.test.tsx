import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { SettingItem, SettingsPatch, ModelInfo } from "../src/rpc-types";
import {
  REASONING_EFFORT_ORDER,
  subagentSelectionTable,
  type ExternalAgentOverview,
  type PluginOverview,
  type SubagentProfileConfig,
} from "@nocturne/core/protocol";
import { ExternalAgentsPage } from "../src/ExternalAgentsPage";
import { fakeServer, RpcFail, withInit } from "./fake-server";

afterEach(cleanup);
const model: ModelInfo = {
  ref: { provider: "p", model: "cheap" },
  displayName: "cheap",
  contextWindow: 10000,
  maxOutputTokens: 1000,
  capabilities: {
    toolCalls: true,
    parallelToolCalls: false,
    reasoning: "hidden",
    reasoningEffort: ["low"],
    imageInput: false,
    promptCache: false,
    editTool: "edit",
  },
};

const strong: ModelInfo = {
  ...model,
  ref: { provider: "p", model: "strong" },
  displayName: "strong",
  capabilities: { ...model.capabilities, reasoningEffort: ["low", "medium", "high"] },
};

function settingItem(key: string, value: unknown): SettingItem {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return {
    key: key as SettingItem["key"],
    effective: text,
    saved: text,
    source: "settings",
    overridden: false,
  };
}

/** 设置项随 updateSettings 补丁就地更新；返回收到的补丁序列 */
function profileServer(
  initial: SettingItem[],
  agents: ExternalAgentOverview[] = [],
  plugins: PluginOverview[] = [],
) {
  let items = initial;
  const patches: SettingsPatch[] = [];
  const server = fakeServer(
    withInit({
      "runtime.describeSettings": () => items,
      "runtime.listModels": [model, strong],
      "skills.describeSkills": { skills: [], warnings: [] },
      "agents.describeExternalAgents": { agents, warnings: [] },
      "plugins.describePlugins": { plugins, warnings: [] },
      "runtime.updateSettings": (params: Record<string, unknown>) => {
        const patch = params.patch as SettingsPatch;
        patches.push(patch);
        for (const [key, value] of Object.entries(patch)) {
          items = items.filter((item) => item.key !== key);
          if (value != null) items.push(settingItem(key, value));
        }
        return items;
      },
    }),
  );
  return { server, patches, getItems: () => items };
}

const effortOptionLabels = () => {
  fireEvent.click(screen.getByRole("combobox", { name: "思考档位" }));
  const labels = within(screen.getByRole("listbox"))
    .getAllByRole("option")
    .map((opt) => opt.textContent?.replace(/^✓/, "") ?? "");
  fireEvent.keyDown(screen.getByRole("combobox", { name: "思考档位" }), { key: "Escape" });
  return labels;
};

it("default 不能删除停用；新增档位、详情即时保存、预览和更多菜单删除回列表", async () => {
  const { server, patches, getItems } = profileServer([]);
  await server.initialize();
  render(<ExternalAgentsPage client={server.client} workspaceRoot={undefined} version={0} />);
  await screen.findByRole("heading", { level: 1, name: "子代理" });

  // 列表页 default 行显示默认且无开关
  const defaultBtn = screen.getByRole("button", { name: /default/ });
  expect(defaultBtn.closest(".slist-row")?.querySelector('[role="switch"]')).toBeNull();
  fireEvent.click(defaultBtn);
  await screen.findByRole("heading", { level: 1, name: /default/ });
  expect(screen.queryByRole("button", { name: "更多" })).toBeNull();
  expect((screen.getByRole("switch", { name: "启用" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText("只读", { selector: ".badge" })).toBeTruthy();

  // 返回列表点「添加档位」
  fireEvent.click(screen.getByRole("button", { name: "子代理" }));
  await screen.findByRole("heading", { level: 1, name: "子代理" });
  fireEvent.click(screen.getByRole("button", { name: "添加档位" }));
  await screen.findByRole("heading", { level: 1, name: /添加档位/ });
  expect((screen.getByRole("textbox", { name: "档位名称" }) as HTMLInputElement).value).toBe("");
  fireEvent.change(screen.getByRole("textbox", { name: "档位名称" }), {
    target: { value: "quick" },
  });
  fireEvent.click(screen.getByRole("radio", { name: "只读" }));
  expect(
    screen.getByRole("textbox", { name: "描述" }).classList.contains("profile-description"),
  ).toBe(true);
  fireEvent.change(screen.getByRole("textbox", { name: "描述" }), {
    target: { value: "查找调用点" },
  });
  fireEvent.click(screen.getByRole("combobox", { name: "档位模型" }));
  fireEvent.click(screen.getByRole("option", { name: /cheap/ }));
  expect(effortOptionLabels()).toEqual(["跟随会话", "off", "low"]);
  fireEvent.click(screen.getByRole("combobox", { name: "思考档位" }));
  fireEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name: "low" }));
  fireEvent.click(screen.getByRole("button", { name: "保存" }));

  // 保存后进入新档位详情
  await screen.findByRole("heading", { level: 1, name: /quick/ });
  const config = JSON.parse(getItems()[0]?.effective ?? "null") as SubagentProfileConfig;
  expect(config).toMatchObject({
    model: "p/cheap",
    tools: "explore",
    effort: "low",
    enabled: true,
  });
  expect(document.querySelector(".profile-preview pre")?.textContent).toBe(
    subagentSelectionTable([{ ...config, name: "quick" }]),
  );

  // 详情无取消/保存按钮，改描述 blur 即时保存并弹出 toast
  expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
  const desc = screen.getByRole("textbox", { name: "描述" }) as HTMLTextAreaElement;
  fireEvent.change(desc, { target: { value: "读取文件" } });
  fireEvent.blur(desc);
  await waitFor(() => expect(getItems()[0]?.effective).toContain("读取文件"));
  expect(screen.getByRole("status").textContent).toContain("已保存 quick");

  // 空描述 blur 不保存且还原
  const countBeforeEmpty = patches.length;
  fireEvent.change(desc, { target: { value: "   " } });
  fireEvent.blur(desc);
  expect(desc.value).toBe("读取文件");
  expect(patches.length).toBe(countBeforeEmpty);

  // 启用开关即时保存
  fireEvent.click(screen.getByRole("switch", { name: "启用" }));
  await waitFor(() =>
    expect(JSON.parse(getItems()[0]?.effective ?? "null")).toMatchObject({
      enabled: false,
      description: "读取文件",
    }),
  );

  // 更多菜单删除确认后返回列表
  fireEvent.click(screen.getByRole("button", { name: "更多" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
  const dialog = screen.getByRole("dialog", { name: "删除档位 quick？" });
  expect(dialog.textContent).not.toContain("不能再选这个档位");
  fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
  await screen.findByRole("heading", { level: 1, name: "子代理" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(getItems()).toEqual([]);
  server.close();
});

it("档位详情：模型/思考档位/工具集上限/默认超时每改各 updateSettings 一次且键一致；Enter 后 blur 不重复提交", async () => {
  const quick: SubagentProfileConfig = {
    description: "查找",
    model: "p/strong",
    effort: "high",
    tools: "general",
    enabled: true,
  };
  const { server, patches } = profileServer([settingItem("subagents.profiles.quick", quick)]);
  await server.initialize();
  render(<ExternalAgentsPage client={server.client} workspaceRoot={undefined} version={0} />);
  await screen.findByRole("heading", { level: 1, name: "子代理" });
  fireEvent.click(screen.getByRole("button", { name: /quick/ }));
  await screen.findByRole("heading", { level: 1, name: /quick/ });

  // 1. 改模型：立即存且清空 effort
  fireEvent.click(screen.getByRole("combobox", { name: "档位模型" }));
  fireEvent.click(screen.getByRole("option", { name: /cheap/ }));
  await waitFor(() => expect(patches).toHaveLength(1));
  expect(patches[0]).toEqual({
    "subagents.profiles.quick": {
      description: "查找",
      model: "p/cheap",
      tools: "general",
      enabled: true,
    },
  });

  // 2. 改思考档位
  fireEvent.click(screen.getByRole("combobox", { name: "思考档位" }));
  fireEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name: "low" }));
  await waitFor(() => expect(patches).toHaveLength(2));
  expect(patches[1]).toEqual({
    "subagents.profiles.quick": {
      description: "查找",
      model: "p/cheap",
      effort: "low",
      tools: "general",
      enabled: true,
    },
  });

  // 3. 改工具集上限
  fireEvent.click(screen.getByRole("radio", { name: "只读" }));
  await waitFor(() => expect(patches).toHaveLength(3));
  expect(patches[2]).toEqual({
    "subagents.profiles.quick": {
      description: "查找",
      model: "p/cheap",
      effort: "low",
      tools: "explore",
      enabled: true,
    },
  });

  // 4. 改默认超时：Enter 保存，随后的 blur 不重复调用；清空 blur 变为 unset
  const timeout = screen.getByRole("spinbutton", { name: "默认超时" }) as HTMLInputElement;
  fireEvent.change(timeout, { target: { value: "45" } });
  fireEvent.keyDown(timeout, { key: "Enter" });
  await waitFor(() => expect(patches).toHaveLength(4));
  expect(patches[3]).toEqual({
    "subagents.profiles.quick": {
      description: "查找",
      model: "p/cheap",
      effort: "low",
      tools: "explore",
      timeoutMs: 45000,
      enabled: true,
    },
  });
  fireEvent.blur(timeout);
  // blur 不再重复保存：把这一拍的 promise 链跑完（setImmediate 在微任务清空后执行），仍只有 4 次
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(patches).toHaveLength(4);

  fireEvent.change(timeout, { target: { value: "" } });
  fireEvent.blur(timeout);
  await waitFor(() => expect(patches).toHaveLength(5));
  expect(patches[4]).toEqual({
    "subagents.profiles.quick": {
      description: "查找",
      model: "p/cheap",
      effort: "low",
      tools: "explore",
      enabled: true,
    },
  });
  server.close();
});

it("列表行 switch 切换不进入详情；保存失败显示错误并恢复已保存值", async () => {
  const quick: SubagentProfileConfig = { description: "查找", tools: "explore", enabled: true };
  let failSave = false;
  let items = [settingItem("subagents.profiles.quick", quick)];
  const server = fakeServer(
    withInit({
      "runtime.describeSettings": () => items,
      "runtime.listModels": [model, strong],
      "skills.describeSkills": { skills: [], warnings: [] },
      "agents.describeExternalAgents": { agents: [], warnings: [] },
      "runtime.updateSettings": (params: Record<string, unknown>) => {
        if (failSave) return new RpcFail(-32000, "写入失败");
        const patch = params.patch as SettingsPatch;
        for (const [key, value] of Object.entries(patch)) {
          items = items.filter((item) => item.key !== key);
          if (value != null) items.push(settingItem(key, value));
        }
        return items;
      },
    }),
  );
  await server.initialize();
  render(<ExternalAgentsPage client={server.client} workspaceRoot={undefined} version={0} />);
  await screen.findByRole("heading", { level: 1, name: "子代理" });

  // 列表行内 switch 不跳转
  fireEvent.click(screen.getByRole("switch", { name: "启用 quick" }));
  await waitFor(() =>
    expect(JSON.parse(items[0]?.effective ?? "null")).toMatchObject({ enabled: false }),
  );
  expect(screen.getByRole("heading", { level: 1, name: "子代理" })).toBeTruthy();

  // 进入详情后模拟保存失败：错误提示并恢复已保存值
  fireEvent.click(screen.getByRole("button", { name: /quick/ }));
  await screen.findByRole("heading", { level: 1, name: /quick/ });
  failSave = true;
  fireEvent.click(screen.getByRole("radio", { name: "全部" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("写入失败");
  expect(screen.getByRole("radio", { name: "只读" }).getAttribute("aria-checked")).toBe("true");
  server.close();
});

it("删除档位用应用内确认框：默认焦点在取消，取消和 Esc 都不删除", async () => {
  const quick: SubagentProfileConfig = { description: "查找", tools: "explore", enabled: true };
  const { server, patches } = profileServer([settingItem("subagents.profiles.quick", quick)]);
  await server.initialize();
  render(<ExternalAgentsPage client={server.client} workspaceRoot={undefined} version={0} />);
  await screen.findByRole("heading", { level: 1, name: "子代理" });
  fireEvent.click(screen.getByRole("button", { name: /quick/ }));
  await screen.findByRole("heading", { level: 1, name: /quick/ });

  const openDelete = () => {
    fireEvent.click(screen.getByRole("button", { name: "更多" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
  };

  openDelete();
  let dialog = screen.getByRole("dialog", { name: "删除档位 quick？" });
  const cancel = within(dialog).getByRole("button", { name: "取消" });
  expect(document.activeElement).toBe(cancel);
  fireEvent.click(cancel);
  expect(screen.queryByRole("dialog")).toBeNull();

  openDelete();
  dialog = screen.getByRole("dialog", { name: "删除档位 quick？" });
  // Esc 被对话框消费（defaultPrevented），设置区的「Esc = 返回」不会跟着退出
  expect(fireEvent.keyDown(document.activeElement ?? dialog, { key: "Escape" })).toBe(false);
  expect(screen.queryByRole("dialog")).toBeNull();

  // 取消与 Esc 都不该保存：把这一拍的 promise 链跑完（setImmediate 在微任务清空后执行）仍没有补丁
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(patches).toEqual([]);

  openDelete();
  dialog = screen.getByRole("dialog", { name: "删除档位 quick？" });
  fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
  await waitFor(() => expect(patches).toEqual([{ "subagents.profiles.quick": null }]));
  await screen.findByRole("heading", { level: 1, name: "子代理" });
  server.close();
});

it.each(["project", "user"] as const)(
  "%s 层子代理只显示只读徽标，启用开关禁用，无更多菜单",
  async (source) => {
    const item = {
      ...settingItem("subagents.profiles.locked", { description: "只读档位", enabled: true }),
      source,
    };
    const { server } = profileServer([item]);
    await server.initialize();
    render(<ExternalAgentsPage client={server.client} workspaceRoot={undefined} version={0} />);
    await screen.findByRole("heading", { level: 1, name: "子代理" });
    expect(
      (screen.getByRole("switch", { name: "启用 locked" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /locked/ }));
    await screen.findByRole("heading", { level: 1, name: /locked/ });
    expect((screen.getByRole("switch", { name: "启用" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("只读", { selector: ".badge" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "更多" })).toBeNull();
    expect(document.body.textContent).not.toMatch(/\.json|项目配置/);
    server.close();
  },
);

it("思考档位选项跟随所选模型：跟随当前模型列全部档位，选定模型只列它支持的，换模型清空已选强度", async () => {
  const { server } = profileServer([]);
  await server.initialize();
  render(<ExternalAgentsPage client={server.client} workspaceRoot={undefined} version={0} />);
  await screen.findByRole("heading", { level: 1, name: "子代理" });
  fireEvent.click(screen.getByRole("button", { name: "添加档位" }));
  expect(effortOptionLabels()).toEqual(["跟随会话", ...REASONING_EFFORT_ORDER]);
  fireEvent.click(screen.getByRole("combobox", { name: "档位模型" }));
  fireEvent.click(screen.getByRole("option", { name: /strong/ }));
  expect(effortOptionLabels()).toEqual(["跟随会话", "off", "low", "medium", "high"]);
  fireEvent.click(screen.getByRole("combobox", { name: "思考档位" }));
  fireEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name: "high" }));
  fireEvent.click(screen.getByRole("combobox", { name: "档位模型" }));
  fireEvent.click(screen.getByRole("option", { name: /cheap/ }));
  expect(effortOptionLabels()).toEqual(["跟随会话", "off", "low"]);
  expect(screen.getByRole("combobox", { name: "思考档位" }).textContent).toBe("跟随会话");
  server.close();
});

it("default 档位的模型写 modelRoles.task；预览与 Core 生成函数逐字一致（含外部 agent）", async () => {
  const quick: SubagentProfileConfig = {
    description: "查找",
    tools: "explore",
    effort: "low",
    enabled: true,
  };
  const agent: ExternalAgentOverview = {
    name: "offline",
    description: "离线外部代理",
    command: "offline",
    args: [],
    enabled: true,
    origin: "app",
    editable: true,
    path: "home/external-agents.json",
  };
  const { server, patches } = profileServer(
    [settingItem("modelRoles.task", "p/strong"), settingItem("subagents.profiles.quick", quick)],
    [agent],
  );
  await server.initialize();
  render(<ExternalAgentsPage client={server.client} workspaceRoot={undefined} version={0} />);
  await screen.findByRole("heading", { level: 1, name: "子代理" });
  fireEvent.click(screen.getByRole("button", { name: /default/ }));
  await screen.findByRole("heading", { level: 1, name: /default/ });
  const preview = () => document.querySelector(".profile-preview pre")?.textContent;
  expect(preview()).toBe(
    subagentSelectionTable([{ ...quick, name: "quick" }], [agent], "p/strong"),
  );
  expect(screen.getByText("跟随会话")).toBeTruthy();
  expect(screen.getByText("全部")).toBeTruthy();
  expect(screen.getByText("—")).toBeTruthy();
  fireEvent.click(screen.getByRole("combobox", { name: "档位模型" }));
  fireEvent.click(screen.getByRole("option", { name: /cheap/ }));
  await waitFor(() => expect(patches).toEqual([{ "modelRoles.task": "p/cheap" }]));
  await waitFor(() =>
    expect(preview()).toBe(
      subagentSelectionTable([{ ...quick, name: "quick" }], [agent], "p/cheap"),
    ),
  );
  server.close();
});

it("插件子代理按已启用插件分组，行内改模型即时写入，详情页除模型外只读", async () => {
  const pptxPlugin: PluginOverview = {
    id: "nocturne:pptx@builtin",
    host: "nocturne",
    name: "pptx",
    marketplace: "builtin",
    version: "0.57.0",
    root: "/builtin/pptx",
    displayName: "演示文档",
    description: "演示文稿处理",
    icon: "data:image/svg+xml;base64,PHN2Zy8+",
    state: "on",
    hooks: [],
    unsupported: [],
    skills: ["pptx"],
    mcpServers: [],
    agents: [
      {
        id: "pptx:visual-judge",
        name: "visual-judge",
        description: "逐页渲染演示文稿并检查视觉排版、文字溢出与字号可读性",
        tools: ["read", "mcp__slides__render"],
      },
    ],
    warnings: [],
  };
  const pdfPlugin: PluginOverview = {
    ...pptxPlugin,
    id: "nocturne:pdf@builtin",
    name: "pdf",
    root: "/builtin/pdf",
    displayName: "PDF",
    agents: [
      {
        id: "pdf:visual-judge",
        name: "visual-judge",
        description: "逐页渲染 PDF 检查越界、分栏与分页问题",
        tools: ["read", "mcp__pdf__render"],
      },
    ],
  };
  const disabledPlugin: PluginOverview = {
    ...pptxPlugin,
    id: "nocturne:docx@builtin",
    name: "docx",
    root: "/builtin/docx",
    displayName: "Word 文档",
    state: "off",
    agents: [
      {
        id: "docx:visual-judge",
        name: "visual-judge",
        description: "停用插件不应出现",
        tools: ["read", "mcp__word__render"],
      },
    ],
  };
  const extAgent: ExternalAgentOverview = {
    name: "offline",
    description: "离线外部代理",
    command: "offline",
    args: [],
    enabled: true,
    origin: "app",
    editable: true,
    path: "home/external-agents.json",
  };

  const { server, patches } = profileServer(
    [],
    [extAgent],
    [pptxPlugin, pdfPlugin, disabledPlugin],
  );
  await server.initialize();
  render(<ExternalAgentsPage client={server.client} workspaceRoot={undefined} version={0} />);
  await screen.findByRole("heading", { level: 1, name: "子代理" });

  // 1. 仅已启用插件出现，分组顺序位于「内置档位」与「外部 Agent」之间，标题与计数正确
  const regions = await screen.findAllByRole("region");
  const regionLabels = regions.map((r) => r.getAttribute("aria-label"));
  expect(regionLabels).toEqual(["内置档位 · 1", "演示文档 · 1", "PDF · 1", "外部 Agent · 1"]);
  expect(screen.queryByRole("region", { name: /^Word 文档/ })).toBeNull();

  // 2. 行上无前缀子代理名、「2 个工具」、无启用开关、模型下拉首项「跟随默认」
  const pptxRegion = screen.getByRole("region", { name: "演示文档 · 1" });
  const rowBtn = within(pptxRegion).getByRole("button", { name: /visual-judge/ });
  expect(rowBtn.textContent).not.toContain("pptx:visual-judge");
  expect(within(pptxRegion).getByText("2 个工具")).toBeTruthy();
  expect(pptxRegion.querySelector('[role="switch"]')).toBeNull();

  const rowDropdown = within(pptxRegion).getByRole("combobox", { name: "visual-judge 模型" });
  expect(rowDropdown.textContent).toContain("跟随默认");

  // 3. 列表行改模型后即时写入用户设置
  fireEvent.click(rowDropdown);
  const listbox = screen.getByRole("listbox");
  const optionLabels = within(listbox)
    .getAllByRole("option")
    .map((o) => o.textContent?.replace(/^✓/, "") ?? "");
  expect(optionLabels[0]).toBe("跟随默认");
  fireEvent.click(within(listbox).getByRole("option", { name: /strong/ }));
  await waitFor(() =>
    expect(patches).toEqual([{ "subagents.pluginModels.pptx:visual-judge": "p/strong" }]),
  );

  // 4. 点行进入只读详情页：展示名称、描述、来源插件、工具清单与可改模型，无其他输入或删除操作
  fireEvent.click(rowBtn);
  await screen.findByRole("heading", { level: 1, name: /visual-judge/ });
  expect(screen.getByText("pptx:visual-judge")).toBeTruthy();
  expect(screen.getByText("演示文档")).toBeTruthy();
  expect(screen.getByText("read")).toBeTruthy();
  expect(screen.getByText("mcp__slides__render")).toBeTruthy();
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByRole("switch")).toBeNull();
  expect(screen.queryByRole("button", { name: "删除" })).toBeNull();
  expect(screen.queryByRole("button", { name: "保存" })).toBeNull();

  // 5. 详情页可改模型回「跟随默认」
  fireEvent.click(screen.getByRole("combobox", { name: "模型" }));
  fireEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name: "跟随默认" }));
  await waitFor(() =>
    expect(patches).toEqual([
      { "subagents.pluginModels.pptx:visual-judge": "p/strong" },
      { "subagents.pluginModels.pptx:visual-judge": null },
    ]),
  );

  server.close();
});
