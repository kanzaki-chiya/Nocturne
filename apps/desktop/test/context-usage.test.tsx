import { createSessionView, type SessionView } from "@nocturne/core/protocol";
import type { ContextSummary, RpcSession } from "@nocturne/rpc/client";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ContextPanel, contextRows, contextSourceLabel, segmentWidths } from "../src/context-panel";
import { ContextUsage } from "../src/ContextUsage";

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
  const api = {
    id: "session-one",
    describeContext: vi.fn(async () => context),
    readAttachment: vi
      .fn<RpcSession["readAttachment"]>()
      .mockRejectedValue(new Error("附件文件缺失")),
  };
  return {
    api,
    session: api as unknown as RpcSession,
    view: createSessionView(),
  };
}

describe("上下文 breakdown", () => {
  it("回放增长不查上下文，结束只查一次；实时变化 single-flight 后补拉", async () => {
    // 飞行中的多次条目变化只合成一次 describeContext，不并发发出旧请求。
    const f = fixture();
    const pending: ((value: ContextSummary) => void)[] = [];
    f.api.describeContext.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
    const ui = (replaying: boolean) => (
      <ContextUsage session={f.session} view={f.view} replaying={replaying} />
    );
    const mounted = render(ui(true));
    for (let i = 0; i < 4; i++) {
      f.view.entries.push({} as SessionView["entries"][number]);
      mounted.rerender(ui(true));
    }
    expect(f.api.describeContext).not.toHaveBeenCalled();
    mounted.rerender(ui(false));
    expect(f.api.describeContext).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 4; i++) {
      f.view.entries.push({} as SessionView["entries"][number]);
      mounted.rerender(ui(false));
    }
    expect(f.api.describeContext).toHaveBeenCalledTimes(1);
    await act(async () => pending.shift()?.(context));
    expect(f.api.describeContext).toHaveBeenCalledTimes(2);
    await act(async () => pending.shift()?.(context));
    expect(f.api.describeContext).toHaveBeenCalledTimes(2);
  });

  it("切换会话后旧上下文响应不能覆盖新会话", async () => {
    // 旧会话晚到的响应必须被会话身份丢弃，不能写入当前状态栏。
    const a = fixture(),
      b = fixture();
    let finish: ((value: ContextSummary) => void) | undefined;
    a.api.describeContext.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const mounted = render(<ContextUsage session={a.session} view={a.view} />);
    mounted.rerender(<ContextUsage session={b.session} view={b.view} />);
    await waitFor(() => expect(b.api.describeContext).toHaveBeenCalledTimes(1));
    await act(async () =>
      finish?.({ ...context, report: { ...context.report, estimatedTokens: 999999 } }),
    );
    expect(screen.queryByText(/999,999/)).toBeNull();
  });
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
    expect(screen.getByText("1,400 / 10,000 tokens（14%）")).toBeTruthy();
    expect(screen.getByText("8 条消息")).toBeTruthy();
    expect(screen.queryByText("/compact")).toBeNull();
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
    expect(totalWidth).toBeCloseTo(14);
    expect(
      contextRows(context.report)
        .filter((row) => !row.group)
        .reduce((sum, row) => sum + row.tokens, 0),
    ).toBe(1400);
  });

  it("总量大于明细时补一行其他，明细更大时不改各项数字", () => {
    const bigger = {
      ...context,
      report: { ...context.report, estimatedTokens: 5000, unattributedTokens: 3600 },
    };
    render(<ContextPanel context={bigger} />);
    const row = screen.getByText("其他").closest("div");
    expect(row?.textContent).toContain("3,600");
    expect(
      contextRows(bigger.report)
        .filter((item) => !item.group)
        .reduce((sum, item) => sum + item.tokens, 0),
    ).toBe(5000);

    const smaller = {
      ...context,
      report: { ...context.report, estimatedTokens: 100 },
    };
    cleanup();
    render(<ContextPanel context={smaller} />);
    expect(screen.queryByText("其他")).toBeNull();
    expect(screen.getByText("用户消息").closest("div")?.textContent).toContain("100");
    expect(screen.getByText("工具调用与结果").closest("div")?.textContent).toContain("600");
  });

  it("堆叠条总长跟总量占预算的比例走，明细之和不同也不影响", () => {
    const fill = (estimatedTokens: number, budgetTokens: number) => {
      const report = { ...context.report, estimatedTokens, budgetTokens };
      return [...segmentWidths(report, contextRows(report)).values()].reduce((a, b) => a + b, 0);
    };
    expect(fill(5000, 10000)).toBeCloseTo(50);
    expect(fill(20000, 10000)).toBeCloseTo(100);
    expect(fill(1400, 0)).toBeCloseTo(100);
  });

  it("项目说明和环境的路径只在悬停提示里", () => {
    render(
      <ContextPanel
        context={{
          ...context,
          report: {
            ...context.report,
            sections: [
              { name: "instructions", source: "Z:/a/AGENTS.md", chars: 8, estimatedTokens: 2 },
              { name: "environment", source: "Z:/a", chars: 8, estimatedTokens: 2 },
            ],
          },
        }}
      />,
    );
    expect(screen.queryByText("Z:/a/AGENTS.md")).toBeNull();
    expect(screen.queryByText("Z:/a")).toBeNull();
    expect(screen.getByText("项目说明").getAttribute("title")).toBe("Z:/a/AGENTS.md");
    expect(screen.getByText("环境").getAttribute("title")).toBe("Z:/a");
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
    expect(screen.getByText("0 / 0 tokens（无可用预算）")).toBeTruthy();
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
    expect(contextSourceLabel("nocturne base prompt")).toBe("");
    expect(contextSourceLabel("会话技能目录")).toBe("");
    expect(contextSourceLabel("custom base prompt")).toBe("自定义提示词");
    expect(contextSourceLabel("3 tools")).toBe("3 个工具");
    expect(contextSourceLabel("15 tools（MCP 按需，65 个工具未列出）")).toBe(
      "15 个工具（MCP 按需，65 个工具未列出）",
    );
    expect(contextSourceLabel("8 items")).toBe("8 项");
    expect(contextSourceLabel("2 entries")).toBe("2 条");
    expect(contextSourceLabel("C:\\Users\\me\\proj\\file.ts", "C:/Users/me")).toBe(
      "~\\proj\\file.ts",
    );
    expect(contextSourceLabel("任意其他来源")).toBe("任意其他来源");
  });
});

describe("上下文圆环", () => {
  it("打开、Esc 和外部点击关闭后焦点回到圆环", async () => {
    const f = fixture();
    render(<ContextUsage session={f.session} view={f.view} />);
    const ring = await screen.findByRole("button", { name: "上下文用量 14%" });
    fireEvent.click(ring);
    const dialog = screen.getByRole("dialog", { name: "上下文用量" });
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(ring);
    fireEvent.click(ring);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(ring);
  });
  it("累计用量包含进行中步骤，缓存缺失显示横线", async () => {
    const f = fixture();
    f.view.usage = { inputTokens: 1200, outputTokens: 200, cacheReadTokens: 1080 };
    render(<ContextUsage session={f.session} view={f.view} />);
    fireEvent.click(await screen.findByRole("button", { name: "上下文用量 14%" }));
    expect(screen.getByText("累计 1,400 tokens")).toBeTruthy();
    expect(screen.getByText("缓存 90%")).toBeTruthy();
  });
});
