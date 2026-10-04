import { createSessionView } from "@nocturne/core/protocol";
import type {
  ContextSummary,
  RpcResult,
  RpcRuntime,
  RpcSession,
  SessionStateSummary,
} from "@nocturne/rpc/client";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ContextPanel, StatusBar, contextRows, type StatusPanel } from "../src/StatusBar";

afterEach(cleanup);

const context: ContextSummary = {
  report: {
    sections: [
      { name: "system", source: "v1", chars: 1600, estimatedTokens: 400 },
      {
        name: "history",
        source: "8 条消息",
        chars: 4000,
        estimatedTokens: 1000,
        breakdown: {
          user: { chars: 400, estimatedTokens: 100 },
          assistant: { chars: 800, estimatedTokens: 200 },
          tool: { chars: 2400, estimatedTokens: 600 },
          summary: { chars: 400, estimatedTokens: 100 },
        },
      },
    ],
    totalChars: 5600,
    estimatedTokens: 1400,
    budgetTokens: 10000,
  },
  overBudget: false,
  mustCompact: false,
};

function fixture() {
  let model = { provider: "fixture", model: "one" };
  let effort: RpcResult<"session.reasoningEffortInfo">["current"] = "off";
  let preset = "default";
  let shell = "auto";
  const api = {
    id: "session-one",
    state: vi.fn(
      async () =>
        ({
          config: { model, permissionPreset: preset, reasoningEffort: effort },
        }) as SessionStateSummary,
    ),
    describeContext: vi.fn(async () => context),
    reasoningEffortInfo: vi.fn(async (): Promise<RpcResult<"session.reasoningEffortInfo">> => ({
      current: effort,
      effective: effort,
      available: ["low", "high"],
    })),
    shellInfo: vi.fn(async () => ({
      selected: shell,
      source: "settings",
      effective: { kind: shell === "auto" ? "pwsh" : shell, name: shell, path: "/bin/shell" },
    })),
    listShells: vi.fn(async () => [
      { kind: "bash", name: "Bash", available: true, executable: "/bin/bash" },
      { kind: "cmd", name: "cmd.exe", available: false },
    ]),
    setModel: vi.fn(async (next: { provider: string; model: string }) => {
      model = next;
    }),
    setReasoningEffort: vi.fn(async (next: string) => {
      effort = next as typeof effort;
    }),
    setPermissionPreset: vi.fn(async (next: string) => {
      preset = next;
    }),
    setShell: vi.fn(async (next: string) => {
      shell = next;
    }),
  };
  const models: RpcResult<"runtime.listModels"> = ["one", "two"].map((name) => ({
    ref: { provider: "fixture", model: name },
    capabilities: {
      toolCalls: true,
      parallelToolCalls: true,
      reasoning: "hidden",
      imageInput: false,
      promptCache: true,
      editTool: "edit",
    },
  }));
  const runtimeApi = { listModels: vi.fn(async () => models) };
  return {
    api,
    runtimeApi,
    session: api as unknown as RpcSession,
    runtime: runtimeApi as unknown as RpcRuntime,
    view: createSessionView(),
  };
}

describe("上下文 breakdown", () => {
  it("四类来自 history.breakdown，历史总量不重复进入堆叠条", () => {
    const { container } = render(<ContextPanel context={context} />);
    for (const [label, tokens] of [
      ["用户消息", "100"],
      ["助手回答", "200"],
      ["工具调用与结果", "600"],
      ["压缩摘要", "100"],
    ] as const) {
      const row = screen.getByText(label).closest("div");
      if (row === null) throw new Error("缺少历史明细行");
      expect(within(row).getByText(tokens)).toBeTruthy();
    }
    expect(screen.getByText("1,400 / 10,000 tokens · 14%")).toBeTruthy();
    expect(screen.getByText("8 条消息")).toBeTruthy();
    expect(screen.getByText("/compact")).toBeTruthy();
    const segments = Array.from(container.querySelectorAll<HTMLElement>("[data-segment]"));
    expect(segments.map((segment) => segment.dataset.segment)).toEqual([
      "system",
      "history-user",
      "history-assistant",
      "history-tool",
      "history-summary",
    ]);
    const totalWidth = segments.reduce(
      (sum, segment) => sum + Number.parseFloat(segment.style.width),
      0,
    );
    expect(totalWidth).toBeCloseTo(100);
    expect(
      contextRows(context.report)
        .filter((row) => !row.group)
        .reduce((sum, row) => sum + row.tokens, 0),
    ).toBe(1400);
  });

  it("没有 breakdown 时只展示真实历史总数，不伪造四类数据", () => {
    const legacy: ContextSummary = {
      ...context,
      report: {
        ...context.report,
        sections: [{ name: "history", source: "旧报告", chars: 4000, estimatedTokens: 1000 }],
      },
    };
    const { container } = render(<ContextPanel context={legacy} />);
    expect(screen.getByText("对话历史")).toBeTruthy();
    expect(screen.getByText("1,000")).toBeTruthy();
    expect(screen.queryByText("用户消息")).toBeNull();
    expect(container.querySelector('[data-segment="history"]')).not.toBeNull();
    expect(container.querySelector('[data-segment="history-user"]')).toBeNull();
  });

  it("四类为零仍保留明细；零预算和零总数不会生成 NaN/Infinity", () => {
    const zero: ContextSummary = {
      ...context,
      report: {
        totalChars: 0,
        estimatedTokens: 0,
        budgetTokens: 0,
        sections: [
          {
            name: "history",
            source: "0 条",
            chars: 0,
            estimatedTokens: 0,
            breakdown: {
              user: { chars: 0, estimatedTokens: 0 },
              assistant: { chars: 0, estimatedTokens: 0 },
              tool: { chars: 0, estimatedTokens: 0 },
              summary: { chars: 0, estimatedTokens: 0 },
            },
          },
        ],
      },
    };
    const { container } = render(<ContextPanel context={zero} />);
    expect(screen.getByText("0 / 0 tokens · 无可用预算")).toBeTruthy();
    expect(screen.getByText("压缩摘要")).toBeTruthy();
    expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
    for (const segment of container.querySelectorAll<HTMLElement>("[data-segment]"))
      expect(segment.style.width).toBe("0%");
  });

  it("图片用报告计数与 token，默认模型预算有明确说明", () => {
    const images: ContextSummary = {
      ...context,
      overBudget: true,
      report: {
        ...context.report,
        estimatedTokens: 3000,
        images: { count: 1, estimatedTokens: 1600 },
        modelDefaults: { contextWindow: true, maxOutputTokens: true },
      },
    };
    render(<ContextPanel context={images} />);
    expect(screen.getByText("1 张")).toBeTruthy();
    expect(screen.getByText("1,600")).toBeTruthy();
    expect(screen.getByText("已超出输入预算")).toBeTruthy();
    expect(screen.getByText(/模型未声明上下文长度/)).toBeTruthy();
    expect(screen.getByText(/模型未声明输出上限/)).toBeTruthy();
  });
});

describe("StatusBar", () => {
  it("受控 /context 面板读取 RPC 报告，Escape 通知关闭", async () => {
    const state = fixture();
    const onPanelChange = vi.fn();
    render(<StatusBar {...state} panel="context" onPanelChange={onPanelChange} />);
    expect(await screen.findByText("用户消息")).toBeTruthy();
    expect(state.api.describeContext).toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("dialog", { name: "上下文用量" }), { key: "Escape" });
    expect(onPanelChange).toHaveBeenCalledWith(null);
  });

  it.each([
    {
      panel: "model",
      trigger: "切换模型",
      option: /fixture · two/,
      method: "setModel",
      argument: { provider: "fixture", model: "two" },
      updated: "fixture · two",
    },
    {
      panel: "effort",
      trigger: "切换思考档位",
      option: /^high$/,
      method: "setReasoningEffort",
      argument: "high",
      updated: "high",
    },
    {
      panel: "preset",
      trigger: "切换权限预设",
      option: /^auto-edit$/,
      method: "setPermissionPreset",
      argument: "auto-edit",
      updated: "auto-edit",
    },
    {
      panel: "shell",
      trigger: "切换 Shell",
      option: /bash · Bash/,
      method: "setShell",
      argument: "bash",
      updated: "bash",
    },
  ] as const)(
    "$panel 选择调用真实 RPC 路径并刷新状态",
    async ({ trigger, option, method, argument, updated }) => {
      const state = fixture();
      const onChanged = vi.fn();
      render(<StatusBar {...state} onChanged={onChanged} />);
      await screen.findByText("fixture · one");
      fireEvent.click(screen.getByRole("button", { name: trigger }));
      const item = await screen.findByRole("button", { name: option });
      await waitFor(() => expect((item as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(item);
      await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
      expect(state.api[method]).toHaveBeenCalledWith(argument);
      expect(state.api.state.mock.calls.length).toBeGreaterThan(1);
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.getByText(updated)).toBeTruthy();
    },
  );

  it("未安装 Shell 禁用；运行中模型与预设禁用，思考档位仍可切换", async () => {
    const state = fixture();
    const { rerender } = render(<StatusBar {...state} panel="shell" />);
    const missing = await screen.findByRole("button", { name: /cmd · cmd.exe/ });
    expect((missing as HTMLButtonElement).disabled).toBe(true);
    const running = { ...state.view, status: "thinking" as const };
    rerender(<StatusBar {...state} view={running} panel="model" />);
    expect(
      ((await screen.findByRole("button", { name: /fixture · two/ })) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    rerender(<StatusBar {...state} view={running} panel="effort" />);
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "high" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
  });

  it("配置失败保留面板并显示真实错误，不调用成功回调", async () => {
    const state = fixture();
    state.api.setPermissionPreset.mockRejectedValue(new Error("session_busy"));
    const onChanged = vi.fn();
    render(<StatusBar {...state} panel="preset" onChanged={onChanged} />);
    const item = await screen.findByRole("button", { name: "smart" });
    await waitFor(() => expect((item as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(item);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "session_busy");
    expect(screen.getByRole("dialog", { name: "选择权限预设" })).toBeTruthy();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("流式 revision 不重复 describeContext，缓存来自包含口径的累计用量", async () => {
    const state = fixture();
    const view = {
      ...state.view,
      usage: { inputTokens: 1000, outputTokens: 20, cacheReadTokens: 800 },
    };
    const { rerender } = render(<StatusBar {...state} view={view} />);
    await screen.findByText("fixture · one");
    const calls = state.api.describeContext.mock.calls.length;
    rerender(<StatusBar {...state} view={{ ...view, revision: view.revision + 1 }} />);
    expect(state.api.describeContext.mock.calls.length).toBe(calls);
    expect(screen.getByText("80%")).toBeTruthy();
  });

  it("点击上下文触发外部面板状态，保留父代理命令接口", async () => {
    const state = fixture();
    const onPanelChange = vi.fn<(panel: StatusPanel | null) => void>();
    render(<StatusBar {...state} panel={null} onPanelChange={onPanelChange} />);
    await screen.findByText("fixture · one");
    fireEvent.click(screen.getByRole("button", { name: "上下文用量" }));
    expect(onPanelChange).toHaveBeenCalledWith("context");
  });
});
