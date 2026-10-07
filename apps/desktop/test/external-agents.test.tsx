import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ExternalAgentOverview } from "@nocturne/core/protocol";
import { EXTERNAL_AGENT_PRESETS, ExternalAgentsPage } from "../src/ExternalAgentsPage";
import { fakeServer, RpcFail, withInit } from "./fake-server";

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
  it("来源只读、保存测试近期结果与无额度探测说明", async () => {
    const f = fakeServer(
      withInit({
        "agents.describeExternalAgents": {
          agents: [managed, manual],
          warnings: ["忽略项目外部 agent"],
        },
        "skills.describeSkills": { skills: [], warnings: [] },
        "agents.probeExternalAgent": {
          ok: true,
          durationMs: 25,
          agentInfo: { name: "Fake", version: "1" },
          authMethods: [{ id: "login", name: "Local login" }],
          configOptions: [],
        },
      }),
    );
    await f.initialize();
    render(<ExternalAgentsPage client={f.client} workspaceRoot="/work" version={0} />);
    await screen.findByRole("heading", { name: "managed" });
    expect(screen.getByText(/费用与额度计在该 agent 自己的账号上/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /manual/ }));
    await screen.findByRole("heading", { name: "manual" });
    expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "编辑" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "删除" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    await screen.findByText("仅初始化并新建临时 ACP 会话，不发送 prompt，不消耗对方额度。");
    expect(screen.getByText("最近测试").nextElementSibling?.textContent).toContain(
      "已连接 · Fake 1",
    );
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
    await screen.findByRole("heading", { name: "还没有外部 agent" });
    const [add] = screen.getAllByRole("button", { name: "添加 agent" });
    if (add === undefined) throw new Error("外部 agent 添加入口不存在");
    fireEvent.click(add);
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
  it("toggle、replace、删除和失败保持草稿；名称锁定", async () => {
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
    await screen.findByRole("heading", { name: "managed" });
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() =>
      expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false"),
    );
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    expect((screen.getByLabelText(/^名称/) as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("说明"), { target: { value: "保持草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByRole("alert");
    expect((screen.getByLabelText("说明") as HTMLInputElement).value).toBe("保持草稿");
    reject = false;
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByRole("heading", { name: "managed" });
    expect(f.calls.find((call) => call.method === "agents.saveExternalAgent")?.params.mode).toBe(
      "replace",
    );
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await screen.findByRole("heading", { name: "还没有外部 agent" });
    expect(f.calls.find((call) => call.method === "agents.deleteExternalAgent")?.params).toEqual({
      name: "managed",
    });
    expect(f.calls.some((call) => call.method === "runtime.reloadConfig")).toBe(false);
    f.close();
  });
});
