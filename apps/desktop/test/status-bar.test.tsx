import { createSessionView } from "@nocturne/core/protocol";
import type { ContextSummary, RpcSession } from "@nocturne/rpc/client";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ContextPanel,
  StatusBar,
  contextRows,
  contextSourceLabel,
  type StatusPanel,
} from "../src/StatusBar";
import { presetOptions } from "../src/choice-info";
import type { SessionControls } from "../src/session-controls";

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

function controlsFixture() {
  const setShell = vi.fn(async (_kind: string) => undefined);
  const shellControl = {
    value: "auto" as string | undefined,
    label: "pwsh",
    groups: [
      {
        options: [
          { value: "auto", label: "auto", detail: "自动选择" },
          { value: "bash", label: "bash · Bash", detail: "/bin/bash" },
          { value: "cmd", label: "cmd · cmd.exe", disabled: "未安装" },
        ],
      },
    ],
    onSelect: setShell,
  };
  const controls: SessionControls = {
    controls: {
      model: {
        value: "fixture/one",
        label: "one",
        groups: [{ options: [{ value: "fixture/one", label: "one" }] }],
        onSelect: vi.fn(),
      },
      effort: {
        value: "off",
        label: "off",
        groups: [{ options: [{ value: "off", label: "off" }] }],
        onSelect: vi.fn(),
      },
      preset: {
        value: "smart",
        label: "smart",
        groups: [{ options: presetOptions() }],
        onSelect: vi.fn(),
      },
    },
    shellControl,
    shell: {
      selected: "auto",
      source: "settings",
      effective: { kind: "pwsh", name: "pwsh", path: "/bin/pwsh" },
    },
    shells: [
      { kind: "bash", name: "Bash", available: true, executable: "/bin/bash" },
      { kind: "cmd", name: "cmd.exe", available: false },
    ],
    loadShells: vi.fn(),
    setShell,
    visionHint: async () => undefined,
  };
  return controls;
}

function fixture() {
  const api = {
    id: "session-one",
    describeContext: vi.fn(async () => context),
    readAttachment: vi
      .fn<RpcSession["readAttachment"]>()
      .mockRejectedValue(new Error("附件文件缺失")),
  };
  const controls = controlsFixture();
  return {
    api,
    session: api as unknown as RpcSession,
    view: createSessionView(),
    controls,
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
      expect(row.textContent).toContain(tokens);
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

describe("contextSourceLabel", () => {
  it("已知来源翻译成中文，其余原样返回（路径按主目录缩写）", () => {
    expect(contextSourceLabel("nocturne base prompt")).toBe("内置提示词");
    expect(contextSourceLabel("custom base prompt")).toBe("自定义提示词");
    expect(contextSourceLabel("3 tools")).toBe("3 个工具");
    expect(contextSourceLabel("8 items")).toBe("8 项");
    expect(contextSourceLabel("2 entries")).toBe("2 条");
    expect(contextSourceLabel("C:\\Users\\me\\proj\\file.ts", "C:/Users/me")).toBe(
      "~\\proj\\file.ts",
    );
    expect(contextSourceLabel("任意其他来源")).toBe("任意其他来源");
  });
});

describe("StatusBar", () => {
  it("缓存命中率在进行中 Turn 每步结束即更新，不等 Turn 结束", () => {
    const state = fixture();
    const cache = () => document.querySelector(".status-cache")?.textContent;
    const rendered = render(<StatusBar {...state} />);
    expect(cache()).toBe("缓存 —");
    const view = {
      ...state.view,
      status: "running_tool" as const,
      currentTurn: { turnId: "t1", turnIndex: 1 },
      entries: [
        {
          kind: "assistant" as const,
          key: "a:m1",
          turnId: "t1",
          messageId: "m1",
          seq: 3,
          time: "2026-10-09T00:00:00.000Z",
          text: "",
          reasoning: "",
          toolCalls: [],
          model: { provider: "fixture", model: "one" },
          usage: { inputTokens: 1000, outputTokens: 5, cacheReadTokens: 900 },
          finishReason: "tool_calls" as const,
        },
      ],
    };
    rendered.rerender(<StatusBar {...state} view={view} />);
    expect(cache()).toBe("缓存 90%");
  });

  it("已有数据时刷新不插入读取行；失败保留数据并在标题显示提示", async () => {
    const state = fixture();
    const rendered = render(<StatusBar {...state} panel="context" />);
    await screen.findByText("用户消息");
    const dialog = screen.getByRole("dialog");
    const rowCount = dialog.querySelectorAll(".context-details > div").length;
    const childCount = dialog.childElementCount;
    let reject!: (reason: Error) => void;
    state.api.describeContext.mockImplementation(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    rendered.rerender(
      <StatusBar {...state} view={{ ...state.view, status: "thinking" }} panel="context" />,
    );
    expect(dialog.getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByText("正在读取…")).toBeNull();
    expect(dialog.querySelectorAll(".context-details > div")).toHaveLength(rowCount);
    expect(dialog.childElementCount).toBe(childCount);
    await act(async () => {
      reject(new Error("读取失败"));
    });
    expect(screen.getByRole("alert").getAttribute("title")).toBe("刷新失败：读取失败");
    expect(screen.getByRole("alert").closest(".status-popover-heading")).not.toBeNull();
    expect(dialog.childElementCount).toBe(childCount);
    expect(dialog.querySelectorAll(".context-details > div")).toHaveLength(rowCount);
    expect(screen.getByText("用户消息")).toBeTruthy();
  });

  it("受控 /context 面板读取 RPC 报告，Escape 通知关闭", async () => {
    const state = fixture();
    const onPanelChange = vi.fn();
    render(<StatusBar {...state} panel="context" onPanelChange={onPanelChange} />);
    expect(await screen.findByText("用户消息")).toBeTruthy();
    expect(state.api.describeContext).toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("dialog", { name: "上下文用量" }), { key: "Escape" });
    expect(onPanelChange).toHaveBeenCalledWith(null);
  });

  it("Shell 菜单列出生效值与候选，选择调用 controls.setShell", async () => {
    const state = fixture();
    render(<StatusBar {...state} />);
    const trigger = screen.getByRole("button", { name: "切换 Shell" });
    expect(trigger.textContent).toContain("pwsh");
    fireEvent.click(trigger);
    expect(state.controls.loadShells).toHaveBeenCalled();
    const bash = await screen.findByRole("menuitemradio", { name: /bash · Bash/ });
    const cmd = screen.getByRole("menuitemradio", { name: /cmd · cmd.exe/ });
    expect((cmd as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(bash);
    await waitFor(() => expect(state.controls.setShell).toHaveBeenCalledWith("bash"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("setShell 失败显示真实错误", async () => {
    const state = fixture();
    state.controls.setShell = vi.fn(async () => {
      throw new Error("session_busy");
    });
    state.controls.shellControl = {
      ...state.controls.shellControl,
      onSelect: state.controls.setShell,
    };
    render(<StatusBar {...state} />);
    fireEvent.click(screen.getByRole("button", { name: "切换 Shell" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /bash · Bash/ }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "session_busy");
  });

  it("模型菜单调用 onSelect；权限预设是自绘下拉，选项带说明，危险项在最后", async () => {
    const state = fixture();
    const onManageProviders = vi.fn();
    render(<StatusBar {...state} onManageProviders={onManageProviders} />);
    fireEvent.click(screen.getByRole("button", { name: "切换模型" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "one" }));
    await waitFor(() =>
      expect(state.controls.controls.model.onSelect).toHaveBeenCalledWith("fixture/one"),
    );
    fireEvent.click(screen.getByRole("button", { name: "切换模型" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "管理服务商…" }));
    expect(onManageProviders).toHaveBeenCalledTimes(1);

    const preset = screen.getByRole("combobox", { name: "切换权限预设" });
    fireEvent.click(preset);
    expect(preset.getAttribute("aria-expanded")).toBe("true");
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(6);
    expect(options.at(-1)?.textContent).toMatch(/bypass/);
    expect(options.at(-1)?.className).toContain("risk");
    expect(screen.getByRole("option", { name: /^default/ }).textContent).toContain("默认");
    fireEvent.click(screen.getByRole("option", { name: /^default/ }));
    await waitFor(() =>
      expect(state.controls.controls.preset.onSelect).toHaveBeenCalledWith("default"),
    );
    expect(preset.getAttribute("aria-expanded")).toBe("false");
  });

  it("流式 revision 不重复 describeContext，缓存来自包含口径的累计用量", async () => {
    const state = fixture();
    const view = {
      ...state.view,
      usage: { inputTokens: 1000, outputTokens: 20, cacheReadTokens: 800 },
    };
    const { rerender } = render(<StatusBar {...state} view={view} />);
    await screen.findByText(/14%/);
    const calls = state.api.describeContext.mock.calls.length;
    rerender(<StatusBar {...state} view={{ ...view, revision: view.revision + 1 }} />);
    expect(state.api.describeContext.mock.calls.length).toBe(calls);
    expect(screen.getByText("80%")).toBeTruthy();
  });

  it("点击上下文触发外部面板状态，保留父代理命令接口", async () => {
    const state = fixture();
    const onPanelChange = vi.fn<(panel: StatusPanel | null) => void>();
    render(<StatusBar {...state} panel={null} onPanelChange={onPanelChange} />);
    await screen.findByText(/14%/);
    fireEvent.click(screen.getByRole("button", { name: "上下文用量" }));
    expect(onPanelChange).toHaveBeenCalledWith("context");
  });

  it("Turn 状态与当前 Turn 序号显示在右侧", async () => {
    const state = fixture();
    const view = {
      ...state.view,
      status: "thinking" as const,
      currentTurn: { turnId: "t1", turnIndex: 3 },
    };
    render(<StatusBar {...state} view={view} />);
    expect(await screen.findByText(/Turn 3/)).toBeTruthy();
  });
});

describe("MCP 未连接标记", () => {
  it("有 failed 服务器时出现，悬停列出名称与错误原因，点击打开 MCP 设置；ready 后消失", () => {
    const state = fixture();
    const onManageMcp = vi.fn();
    const rendered = render(<StatusBar {...state} onManageMcp={onManageMcp} />);
    expect(screen.queryByRole("button", { name: /MCP 未连接/ })).toBeNull();

    const failed = {
      ...state.view,
      mcpServers: {
        exa: { state: "ready" as const, toolCount: 2 },
        "browseros-neo": {
          state: "failed" as const,
          error: "连接失败，请检查服务器配置、连接和凭据",
        },
      },
    };
    rendered.rerender(<StatusBar {...state} view={failed} onManageMcp={onManageMcp} />);
    const badge = screen.getByRole("button", { name: /MCP 未连接 1/ });
    expect(badge.textContent).toBe("MCP 未连接 1");
    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.mouseEnter(badge);
    const tip = screen.getByRole("tooltip");
    expect(tip.textContent).toContain("browseros-neo");
    expect(tip.textContent).toContain("启动失败");
    expect(tip.textContent).toContain("连接失败，请检查服务器配置、连接和凭据");
    expect(tip.textContent).not.toContain("exa");
    expect(badge.getAttribute("aria-describedby")).toBe(tip.id);
    fireEvent.mouseLeave(badge);
    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.focus(badge);
    expect(screen.getByRole("tooltip").textContent).toContain("browseros-neo");
    fireEvent.click(badge);
    expect(onManageMcp).toHaveBeenCalledOnce();

    const recovered = {
      ...state.view,
      mcpServers: { "browseros-neo": { state: "ready" as const, toolCount: 3 } },
    };
    rendered.rerender(<StatusBar {...state} view={recovered} onManageMcp={onManageMcp} />);
    expect(screen.queryByRole("button", { name: /MCP 未连接/ })).toBeNull();
  });

  it("crashed 计入；移除后标记消失", () => {
    const state = fixture();
    const view = {
      ...state.view,
      mcpServers: {
        a: { state: "crashed" as const, error: "进程已退出或管道已关闭" },
        b: { state: "failed" as const },
      },
    };
    const rendered = render(<StatusBar {...state} view={view} />);
    fireEvent.focus(screen.getByRole("button", { name: /MCP 未连接 2/ }));
    expect(screen.getByRole("tooltip").textContent).toContain("连接断开");
    rendered.rerender(<StatusBar {...state} view={{ ...state.view, mcpServers: {} }} />);
    expect(screen.queryByRole("button", { name: /MCP 未连接/ })).toBeNull();
  });
});
