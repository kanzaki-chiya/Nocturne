import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ExternalAgentOverview } from "@nocturne/core/protocol";
import { EXTERNAL_AGENT_PRESETS, ExternalAgentsPage } from "../src/ExternalAgentsPage";
import { fakeServer, RpcFail, withInit as initHandlers } from "./fake-server";

const withInit = (handlers: Parameters<typeof initHandlers>[0]) =>
  initHandlers({ "runtime.describeSettings": [], "runtime.listModels": [], ...handlers });

afterEach(cleanup);
const managed: ExternalAgentOverview = {
  name: "managed",
  command: "node",
  args: ["fake-acp"],
  enabled: true,
  origin: "app",
  editable: true,
  path: "home/external-agents.json",
};
const manual: ExternalAgentOverview = {
  ...managed,
  name: "manual",
  origin: "user",
  editable: false,
  path: "home/config.json",
};

describe("外部 agent 设置页", () => {
  it("预设只填命令、不强制 approval、默认停用", () => {
    expect(EXTERNAL_AGENT_PRESETS).toEqual([
      {
        name: "omp",
        command: "omp",
        args: ["--mode", "acp"],
        enabled: false,
        description: "omp ACP 子代理",
      },
      {
        name: "codex",
        command: "npx",
        args: ["@agentclientprotocol/codex-acp"],
        enabled: false,
        description: "Codex ACP 子代理",
      },
    ]);
  });

  it("列表行点行进详情、面包屑返列表、行内开关不导航；不可编辑无更多菜单", async () => {
    let agents = [managed, manual];
    const f = fakeServer(
      withInit({
        "agents.describeExternalAgents": () => ({
          agents,
          warnings: ["忽略项目外部 agent"],
        }),
        "skills.describeSkills": { skills: [], warnings: [] },
        "agents.setExternalAgentEnabled": (params: Record<string, unknown>) => {
          agents = agents.map((a) =>
            a.name === params.name ? { ...a, enabled: Boolean(params.enabled) } : a,
          );
          return null;
        },
        "agents.probeExternalAgent": {
          ok: true,
          durationMs: 25,
          agentInfo: { name: "Fake", version: "1" },
          authMethods: [{ id: "login", name: "Local login", description: "ignored desc" }],
          configOptions: [],
        },
      }),
    );
    await f.initialize();
    render(<ExternalAgentsPage client={f.client} workspaceRoot="/work" version={0} />);
    await screen.findByRole("heading", { level: 1, name: "子代理" });

    // 列表行内 switch 切换不进入详情
    const rowSwitch = screen.getByRole("switch", { name: "启用 managed" });
    fireEvent.click(rowSwitch);
    await waitFor(() =>
      expect(
        f.calls.some(
          (call) =>
            call.method === "agents.setExternalAgentEnabled" &&
            call.params.name === "managed" &&
            call.params.enabled === false,
        ),
      ).toBe(true),
    );
    expect(screen.getByRole("heading", { level: 1, name: "子代理" })).toBeTruthy();

    // 点击列表行进入详情，再点面包屑返回列表
    fireEvent.click(screen.getByRole("button", { name: /managed/ }));
    await screen.findByRole("heading", { level: 1, name: /managed/ });
    expect(screen.queryByText(/外部费用计在其自己的账号/)).toBeNull();
    expect(screen.getByRole("button", { name: "更多" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "子代理" }));
    await screen.findByRole("heading", { level: 1, name: "子代理" });

    // 只读外部 agent：列表排在后，进详情无更多菜单，开关禁用并保留来源 title
    fireEvent.click(screen.getByRole("button", { name: /manual/ }));
    await screen.findByRole("heading", { level: 1, name: /manual/ });
    expect(document.querySelector("p.desc")).toBeNull();
    const badge = screen.getByText("只读", { selector: ".badge" });
    expect(badge.getAttribute("title")).toBe("来自 home/config.json，请修改该文件");
    const sw = screen.getByRole("switch", { name: "启用 agent" }) as HTMLButtonElement;
    expect(sw.disabled).toBe(true);
    expect(sw.getAttribute("title")).toBe("来自 home/config.json，请修改该文件");
    expect(screen.queryByRole("button", { name: "更多" })).toBeNull();

    // 探测连接：最近测试组显示结果、时间、登录方式（无 description）与可配置选项数
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    await screen.findByText("Local login");
    expect(screen.queryByText(/ignored desc/)).toBeNull();
    const probeRegion = screen.getByRole("region", { name: "最近测试" });
    expect(probeRegion.textContent).toContain("已连接Fake 1");
    expect(probeRegion.textContent).toMatch(/\d{2}:\d{2}:\d{2} · 25 ms/);
    expect(probeRegion.textContent).toContain("0 项");
    expect(
      f.calls
        .filter((call) => call.method === "agents.probeExternalAgent")
        .map((call) => call.params),
    ).toEqual([{ name: "manual" }]);
    f.close();
  });

  it("草稿探测与700项搜索下拉，create保存包括不透明配置值", async () => {
    const f = fakeServer(
      withInit({
        "agents.describeExternalAgents": { agents: [], warnings: [] },
        "skills.describeSkills": { skills: [], warnings: [] },
        "agents.probeExternalAgent": {
          ok: true,
          durationMs: 1,
          configOptions: [
            {
              id: "model",
              name: "模型",
              currentValue: "model-0",
              options: Array.from({ length: 700 }, (_, i) => ({
                value: `model-${i}`,
                name: `模型 ${i}`,
              })),
            },
          ],
        },
        "agents.saveExternalAgent": managed,
      }),
    );
    await f.initialize();
    render(<ExternalAgentsPage client={f.client} workspaceRoot={undefined} version={0} />);
    await screen.findByRole("heading", { level: 1, name: "子代理" });
    // 空外部组不显示
    expect(screen.queryByRole("region", { name: /外部 Agent/ })).toBeNull();
    const [add] = screen.getAllByRole("button", { name: "添加 agent" });
    if (add === undefined) throw new Error("外部 agent 添加入口不存在");
    fireEvent.click(add);
    await screen.findByRole("heading", { level: 1, name: /添加外部 Agent/ });
    fireEvent.click(screen.getByRole("combobox", { name: "外部 agent 预设" }));
    fireEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name: /omp/ }));
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    await screen.findByRole("combobox", { name: "模型" });
    fireEvent.click(screen.getByRole("combobox", { name: "模型" }));
    fireEvent.change(screen.getByRole("textbox", { name: "搜索模型" }), {
      target: { value: "699" },
    });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "搜索模型" }), { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(f.calls.some((call) => call.method === "agents.saveExternalAgent")).toBe(true),
    );
    expect(f.calls.find((call) => call.method === "agents.saveExternalAgent")?.params).toEqual({
      mode: "create",
      name: "omp",
      config: {
        command: "omp",
        args: ["--mode", "acp"],
        enabled: false,
        description: "omp ACP 子代理",
        env: {},
        configOptions: { model: "model-699" },
      },
    });
    expect(
      f.calls.find((call) => call.method === "agents.probeExternalAgent")?.params,
    ).toMatchObject({ config: { name: "omp", command: "omp", enabled: false } });
    expect(f.calls.some((call) => call.method === "runtime.reloadConfig")).toBe(false);
    f.close();
  });

  it("同名配置选项显示对方给的说明或值，可按值搜索，测试结果保存后保留", async () => {
    const f = fakeServer(
      withInit({
        "agents.describeExternalAgents": { agents: [managed], warnings: [] },
        "skills.describeSkills": { skills: [], warnings: [] },
        "agents.probeExternalAgent": {
          ok: true,
          durationMs: 1,
          agentInfo: { name: "omp", version: "18.6.0" },
          configOptions: [
            {
              id: "model",
              name: "Model",
              currentValue: "a/grok",
              options: [
                { value: "a/grok", name: "Grok 4.7", description: "a/grok" },
                { value: "b/grok", name: "Grok 4.7" },
              ],
            },
          ],
        },
        "agents.saveExternalAgent": managed,
      }),
    );
    await f.initialize();
    render(<ExternalAgentsPage client={f.client} workspaceRoot={undefined} version={0} />);
    fireEvent.click(await screen.findByRole("button", { name: /managed/ }));
    fireEvent.click(await screen.findByRole("button", { name: "更多" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "编辑" }));
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    const model = await screen.findByRole("combobox", { name: "Model" });
    // id 与名称只差大小写时不重复显示
    expect(screen.queryByText("model", { selector: "code" })).toBeNull();
    expect(screen.queryByText(/使用 agent 默认值/)).toBeNull();
    fireEvent.click(model);
    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "✓Grok 4.7a/grok",
      "Grok 4.7b/grok",
    ]);
    fireEvent.change(screen.getByRole("textbox", { name: "搜索Model" }), {
      target: { value: "b/" },
    });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "搜索Model" }), { key: "Enter" });
    expect(model.textContent).toBe("Grok 4.7");
    expect((screen.getByRole("textbox", { name: "JSON" }) as HTMLTextAreaElement).value).toContain(
      '"b/grok"',
    );
    expect(screen.queryByText(/已指定/)).toBeNull();
    expect(screen.queryByText(/使用 agent 默认值/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(f.calls.some((call) => call.method === "agents.saveExternalAgent")).toBe(true),
    );
    await waitFor(() => expect(screen.getAllByText("omp 18.6.0").length).toBeGreaterThan(0));
    f.close();
  });

  it("toggle、replace、更多菜单删除确认后回列表和失败保持草稿；名称锁定", async () => {
    let agents = [managed];
    let reject = true;
    const f = fakeServer(
      withInit({
        "agents.describeExternalAgents": () => ({ agents, warnings: [] }),
        "skills.describeSkills": { skills: [], warnings: [] },
        "agents.setExternalAgentEnabled": () => {
          agents = [{ ...managed, enabled: false }];
          return null;
        },
        "agents.saveExternalAgent": () => {
          if (reject) return new RpcFail(-32005, "名称重名", { field: "name" });
          return managed;
        },
        "agents.deleteExternalAgent": () => {
          agents = [];
          return null;
        },
      }),
    );
    await f.initialize();
    render(<ExternalAgentsPage client={f.client} workspaceRoot={undefined} version={0} />);
    fireEvent.click(await screen.findByRole("button", { name: /managed/ }));
    await screen.findByRole("heading", { level: 1, name: /managed/ });
    fireEvent.click(screen.getByRole("switch", { name: "启用 agent" }));
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "启用 agent" }).getAttribute("aria-checked")).toBe(
        "false",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "更多" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "编辑" }));
    expect((screen.getByLabelText(/^名称/) as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "描述" }), {
      target: { value: "保持草稿" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByRole("alert");
    expect((screen.getByRole("textbox", { name: "描述" }) as HTMLInputElement).value).toBe(
      "保持草稿",
    );
    reject = false;
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByRole("heading", { level: 1, name: /managed/ });
    expect(f.calls.find((call) => call.method === "agents.saveExternalAgent")?.params.mode).toBe(
      "replace",
    );
    fireEvent.click(screen.getByRole("button", { name: "更多" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
    const dialog = await screen.findByRole("dialog", { name: "删除 managed？" });
    expect(dialog.textContent).not.toContain("不会卸载命令行工具");
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    await screen.findByRole("heading", { level: 1, name: "子代理" });
    expect(screen.queryByRole("region", { name: /外部 Agent/ })).toBeNull();
    expect(f.calls.find((call) => call.method === "agents.deleteExternalAgent")?.params).toEqual({
      name: "managed",
    });
    expect(f.calls.some((call) => call.method === "runtime.reloadConfig")).toBe(false);
    f.close();
  });

  it("表单字段名对齐、启用开关切换后保存正确的 enabled 值", async () => {
    const f = fakeServer(
      withInit({
        "agents.describeExternalAgents": { agents: [], warnings: [] },
        "skills.describeSkills": { skills: [], warnings: [] },
        "agents.saveExternalAgent": managed,
      }),
    );
    await f.initialize();
    render(<ExternalAgentsPage client={f.client} workspaceRoot={undefined} version={0} />);
    await screen.findByRole("heading", { level: 1, name: "子代理" });
    const [add] = screen.getAllByRole("button", { name: "添加 agent" });
    if (add === undefined) throw new Error("外部 agent 添加入口不存在");
    fireEvent.click(add);
    await screen.findByRole("heading", { level: 1, name: /添加外部 Agent/ });

    fireEvent.change(screen.getByRole("textbox", { name: "名称" }), {
      target: { value: "custom" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "命令" }), { target: { value: "node" } });
    fireEvent.change(screen.getByRole("textbox", { name: "参数" }), {
      target: { value: "--acp\n--stdio" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "模式 id" }), {
      target: { value: "code" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "环境变量" }), {
      target: { value: '{"FOO": "bar"}' },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "JSON" }), {
      target: { value: '{"model": "m1"}' },
    });

    const enableSwitch = screen.getByRole("switch", { name: "启用" });
    expect(enableSwitch.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(enableSwitch);
    expect(enableSwitch.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(f.calls.some((call) => call.method === "agents.saveExternalAgent")).toBe(true),
    );
    expect(f.calls.find((call) => call.method === "agents.saveExternalAgent")?.params).toEqual({
      mode: "create",
      name: "custom",
      config: {
        command: "node",
        args: ["--acp", "--stdio"],
        enabled: true,
        mode: "code",
        env: { FOO: "bar" },
        configOptions: { model: "m1" },
      },
    });
    f.close();
  });
});
