import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { SettingItem, SettingsPatch, ModelInfo } from "../src/rpc-types";
import {
  REASONING_EFFORT_ORDER,
  subagentSelectionTable,
  type ExternalAgentOverview,
  type SubagentProfileConfig,
} from "@nocturne/core/protocol";
import { ExternalAgentsPage } from "../src/ExternalAgentsPage";
import { fakeServer, withInit } from "./fake-server";

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

it("default 不能删除停用；新增模板、编辑、预览和删除档位", async () => {
  let items: SettingItem[] = [];
  const server = fakeServer(
    withInit({
      "runtime.describeSettings": () => items,
      "runtime.listModels": [model],
      "skills.describeSkills": { skills: [], warnings: [] },
      "agents.describeExternalAgents": { agents: [], warnings: [] },
      "runtime.updateSettings": (params: Record<string, unknown>) => {
        const patch = params.patch as SettingsPatch;
        for (const [key, value] of Object.entries(patch)) {
          items = items.filter((item) => item.key !== key);
          if (value != null)
            items.push({
              key: key as SettingItem["key"],
              effective: JSON.stringify(value),
              saved: JSON.stringify(value),
              source: "settings",
              overridden: false,
            });
        }
        return items;
      },
    }),
  );
  await server.initialize();
  render(<ExternalAgentsPage client={server.client} workspaceRoot={undefined} version={0} />);
  await screen.findByRole("heading", { name: "default" });
  expect(screen.queryByRole("button", { name: "删除档位" })).toBeNull();
  expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "添加档位" }));
  fireEvent.click(screen.getByRole("button", { name: "quick" }));
  fireEvent.change(screen.getByRole("textbox", { name: "何时用" }), {
    target: { value: "查找调用点" },
  });
  expect(screen.getByRole("radio", { name: "low" }).getAttribute("aria-checked")).toBe("true");
  fireEvent.click(screen.getByRole("combobox", { name: "档位模型" }));
  fireEvent.click(screen.getByRole("option", { name: /cheap/ }));
  expect(screen.queryByRole("radio", { name: "high" })).toBeNull();
  fireEvent.click(screen.getByRole("radio", { name: "low" }));
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await screen.findByRole("heading", { name: "quick" });
  const config = JSON.parse(items[0]?.effective ?? "null") as SubagentProfileConfig;
  expect(config).toMatchObject({
    model: "p/cheap",
    tools: "explore",
    effort: "low",
    enabled: true,
  });
  expect(document.querySelector(".profile-preview pre")?.textContent).toBe(
    subagentSelectionTable([{ ...config, name: "quick" }]),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "何时用" }), {
    target: { value: "读取文件" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(items[0]?.effective).toContain("读取文件"));
  fireEvent.click(screen.getByRole("button", { name: "删除档位" }));
  const dialog = screen.getByRole("dialog", { name: "删除档位 quick？" });
  fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
  await screen.findByRole("heading", { name: "default" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(items).toEqual([]);
  server.close();
});

it("删除档位用应用内确认框：默认焦点在取消，取消和 Esc 都不删除", async () => {
  const quick: SubagentProfileConfig = { description: "查找", tools: "explore", enabled: true };
  const { server, patches } = profileServer([settingItem("subagents.profiles.quick", quick)]);
  await server.initialize();
  render(<ExternalAgentsPage client={server.client} workspaceRoot={undefined} version={0} />);
  await screen.findByRole("heading", { name: "default" });
  fireEvent.click(screen.getByRole("button", { name: /quick/ }));
  const remove = await screen.findByRole("button", { name: "删除档位" });

  fireEvent.click(remove);
  let dialog = screen.getByRole("dialog", { name: "删除档位 quick？" });
  const cancel = within(dialog).getByRole("button", { name: "取消" });
  expect(document.activeElement).toBe(cancel);
  fireEvent.click(cancel);
  expect(screen.queryByRole("dialog")).toBeNull();

  fireEvent.click(remove);
  dialog = screen.getByRole("dialog", { name: "删除档位 quick？" });
  // Esc 被对话框消费（defaultPrevented），设置区的「Esc = 返回」不会跟着退出
  expect(fireEvent.keyDown(document.activeElement ?? dialog, { key: "Escape" })).toBe(false);
  expect(screen.queryByRole("dialog")).toBeNull();

  // 取消、Esc 之后都没有删除，也没有顺带提交外面的编辑表单
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(patches).toEqual([]);

  fireEvent.click(remove);
  dialog = screen.getByRole("dialog", { name: "删除档位 quick？" });
  fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
  await waitFor(() => expect(patches).toEqual([{ "subagents.profiles.quick": null }]));
  server.close();
});

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
function profileServer(initial: SettingItem[], agents: ExternalAgentOverview[] = []) {
  let items = initial;
  const patches: SettingsPatch[] = [];
  const server = fakeServer(
    withInit({
      "runtime.describeSettings": () => items,
      "runtime.listModels": [model, strong],
      "skills.describeSkills": { skills: [], warnings: [] },
      "agents.describeExternalAgents": { agents, warnings: [] },
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
  return { server, patches };
}

const radios = () =>
  within(screen.getByRole("radiogroup", { name: "思考强度" }))
    .getAllByRole("radio")
    .map((radio) => radio.textContent);

it("思考强度选项跟随所选模型：跟随当前模型列全部档位，选定模型只列它支持的，换模型清空已选强度", async () => {
  const { server } = profileServer([]);
  await server.initialize();
  render(<ExternalAgentsPage client={server.client} workspaceRoot={undefined} version={0} />);
  await screen.findByRole("heading", { name: "default" });
  fireEvent.click(screen.getByRole("button", { name: "添加档位" }));
  fireEvent.click(screen.getByRole("button", { name: "空白" }));
  expect(radios()).toEqual(["跟随会话", ...REASONING_EFFORT_ORDER]);
  fireEvent.click(screen.getByRole("combobox", { name: "档位模型" }));
  fireEvent.click(screen.getByRole("option", { name: /strong/ }));
  expect(radios()).toEqual(["跟随会话", "off", "low", "medium", "high"]);
  fireEvent.click(screen.getByRole("radio", { name: "high" }));
  fireEvent.click(screen.getByRole("combobox", { name: "档位模型" }));
  fireEvent.click(screen.getByRole("option", { name: /cheap/ }));
  expect(radios()).toEqual(["跟随会话", "off", "low"]);
  expect(screen.getByRole("radio", { name: "跟随会话" }).getAttribute("aria-checked")).toBe("true");
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
  await screen.findByRole("heading", { name: "default" });
  const preview = () => document.querySelector(".profile-preview pre")?.textContent;
  expect(preview()).toBe(
    subagentSelectionTable([{ ...quick, name: "quick" }], [agent], "p/strong"),
  );
  fireEvent.click(screen.getByRole("combobox", { name: "档位模型" }));
  fireEvent.click(screen.getByRole("option", { name: /cheap/ }));
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(patches).toEqual([{ "modelRoles.task": "p/cheap" }]));
  await waitFor(() =>
    expect(preview()).toBe(
      subagentSelectionTable([{ ...quick, name: "quick" }], [agent], "p/cheap"),
    ),
  );
  server.close();
});
