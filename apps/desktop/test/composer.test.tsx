import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { Composer, type ComposerProps } from "../src/Composer";

function props(overrides: Partial<ComposerProps> = {}): ComposerProps {
  return { running: false, onSubmit: vi.fn(), onInterrupt: vi.fn(), ...overrides };
}

function input(text: string): HTMLTextAreaElement {
  const field = screen.getByLabelText<HTMLTextAreaElement>("消息输入");
  fireEvent.focus(field);
  fireEvent.change(field, { target: { value: text } });
  return field;
}

const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
beforeAll(() => {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    value: vi.fn(),
    configurable: true,
  });
});
afterAll(() => {
  if (originalScrollIntoView === undefined)
    Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  else Object.defineProperty(Element.prototype, "scrollIntoView", originalScrollIntoView);
});
afterEach(cleanup);

describe("Composer", () => {
  it("Enter 发送原文，Shift+Enter 留给浏览器换行，不吞掉边缘空白", async () => {
    const onSubmit = vi.fn();
    render(<Composer {...props({ onSubmit })} />);
    const field = input("  第一行  ");
    expect(fireEvent.keyDown(field, { key: "Enter", shiftKey: true })).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: "  第一行  \n第二行  " } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("  第一行  \n第二行  ");
    await waitFor(() => {
      expect(field.value).toBe("");
    });
  });

  it("native isComposing 和 composition 状态都不误发 Enter", async () => {
    const onSubmit = vi.fn();
    render(<Composer {...props({ onSubmit })} />);
    const field = input("中文输入");
    expect(fireEvent.keyDown(field, { key: "Enter", isComposing: true })).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.compositionStart(field);
    expect(fireEvent.keyDown(field, { key: "Enter", isComposing: false })).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.compositionEnd(field);
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("中文输入");
    await waitFor(() => {
      expect(field.value).toBe("");
    });
  });

  it("/ 弹列表展示能力状态，↑↓和 Tab 只选择补全、不发送", () => {
    const onSubmit = vi.fn();
    render(<Composer {...props({ onSubmit })} />);
    const field = input("/");
    expect(screen.getByRole("listbox", { name: "斜杠命令补全" })).toBeTruthy();
    expect(screen.getAllByText("第 3 步实现")).toHaveLength(2);
    fireEvent.change(field, { target: { value: "/co" } });
    expect(screen.getAllByRole("option")).toHaveLength(2);
    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(screen.getByText("/compact").closest("li")?.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(field, { key: "Tab" });
    expect(field.value).toBe("/compact ");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("补全命令后直接进入参数列表，鼠标选择不丢输入焦点", () => {
    render(<Composer {...props({ completionContext: { effortLevels: ["low", "high"] } })} />);
    const field = input("/eff");
    fireEvent.keyDown(field, { key: "Tab" });
    expect(field.value).toBe("/effort ");
    const option = screen.getByText("high").closest("li");
    expect(option).not.toBeNull();
    expect(fireEvent.mouseDown(option as HTMLElement)).toBe(false);
    fireEvent.click(option as HTMLElement);
    expect(field.value).toBe("/effort high");
    expect(document.activeElement).toBe(field);
  });

  it("运行中按钮和 Esc 中断，原文保留；合成输入时 Esc 不中断", async () => {
    const onInterrupt = vi.fn();
    const onSubmit = vi.fn();
    render(<Composer {...props({ running: true, onInterrupt, onSubmit })} />);
    const field = input("下一条草稿");
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: "Escape", isComposing: true });
    expect(onInterrupt).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: "Escape" });
    expect(onInterrupt).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>("button", { name: "中断" }).disabled).toBe(false);
    });
    fireEvent.click(screen.getByRole("button", { name: "中断" }));
    expect(onInterrupt).toHaveBeenCalledTimes(2);
    expect(field.value).toBe("下一条草稿");
    await act(async () => {
      await Promise.resolve();
    });
  });

  it("输入框外 Esc 也可中断，而空闲 Esc 仅关闭补全", async () => {
    const onInterrupt = vi.fn();
    const initial = props({ onInterrupt });
    const { rerender } = render(<Composer {...initial} />);
    const field = input("/");
    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(field.value).toBe("/");
    expect(onInterrupt).not.toHaveBeenCalled();
    rerender(<Composer {...initial} running />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onInterrupt).toHaveBeenCalledTimes(1);
    await act(async () => {
      await Promise.resolve();
    });
  });

  it("未接收或发送失败不清空输入，也不记录输入历史", async () => {
    const onSubmit = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error("连接已断开"));
    const recordInputHistory = vi.fn();
    render(<Composer {...props({ onSubmit, recordInputHistory })} />);
    const field = input("保留这条消息");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>("button", { name: "发送" }).disabled).toBe(false);
    });
    expect(field.value).toBe("保留这条消息");
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("连接已断开");
    });
    expect(field.value).toBe("保留这条消息");
    expect(recordInputHistory).not.toHaveBeenCalled();
  });

  it("等待接收时继续编辑的草稿不被旧发送清空，重复 Enter 不重复提交", async () => {
    let accept!: (value: boolean) => void;
    const onSubmit = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          accept = resolve;
        }),
    );
    render(<Composer {...props({ onSubmit })} />);
    const field = input("第一条");
    fireEvent.keyDown(field, { key: "Enter" });
    fireEvent.keyDown(field, { key: "Enter" });
    fireEvent.change(field, { target: { value: "第二条尚未发出" } });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    await act(async () => {
      accept(true);
    });
    expect(field.value).toBe("第二条尚未发出");
  });

  it("首次创建会话接收后记录原文，可从新会话引用写入", async () => {
    let activeSession: { record: (text: string) => Promise<void> } | null = null;
    const record = vi.fn(async (_text: string) => undefined);
    const recordInputHistory = vi.fn(async (text: string) => {
      await activeSession?.record(text);
    });
    const onSubmit = vi.fn(async () => {
      activeSession = { record };
    });
    render(<Composer {...props({ historyKey: "draft", onSubmit, recordInputHistory })} />);
    const field = input("首条消息\n原文");
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => {
      expect(record).toHaveBeenCalledWith("首条消息\n原文");
    });
    expect(recordInputHistory).toHaveBeenCalledTimes(1);
    expect(field.value).toBe("");
  });

  it("读取持久历史，↑↓浏览并还原未发送草稿；编辑后不继续沿用旧游标", async () => {
    const readInputHistory = vi.fn(async () => ["旧消息", "最近消息"]);
    render(<Composer {...props({ historyKey: "session-1", readInputHistory })} />);
    await act(async () => {
      await Promise.resolve();
    });
    const field = input("尚未发送的草稿");
    field.setSelectionRange(field.value.length, field.value.length);
    fireEvent.keyDown(field, { key: "ArrowUp" });
    expect(field.value).toBe("最近消息");
    fireEvent.keyDown(field, { key: "ArrowUp" });
    expect(field.value).toBe("旧消息");
    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(field.value).toBe("最近消息");
    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(field.value).toBe("尚未发送的草稿");
    fireEvent.change(field, { target: { value: "编辑草稿" } });
    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(field.value).toBe("编辑草稿");
  });

  it("延迟读取历史不会覆盖本次已接收输入，历史写入失败不误报为发送失败", async () => {
    let finishRead!: (rows: string[]) => void;
    const readInputHistory = vi.fn(
      () =>
        new Promise<string[]>((resolve) => {
          finishRead = resolve;
        }),
    );
    const recordInputHistory = vi.fn().mockRejectedValue(new Error("磁盘已满"));
    render(<Composer {...props({ readInputHistory, recordInputHistory })} />);
    const field = input("刚刚接收的消息");
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("消息已接收，但保存输入历史失败");
    });
    expect(field.value).toBe("");
    await act(async () => {
      finishRead(["以前的消息"]);
    });
    fireEvent.keyDown(field, { key: "ArrowUp" });
    expect(field.value).toBe("刚刚接收的消息");
    fireEvent.keyDown(field, { key: "ArrowUp" });
    expect(field.value).toBe("以前的消息");
  });

  it("流式重渲染的新读取回调不重复读取或重置游标，historyKey 变化才刷新", async () => {
    const firstRead = vi.fn(async () => ["第一条", "第二条"]);
    const laterRead = vi.fn(async () => ["新工作区输入"]);
    const initial = props({ historyKey: "same-session", readInputHistory: firstRead });
    const { rerender } = render(<Composer {...initial} />);
    await act(async () => {
      await Promise.resolve();
    });
    const field = input("草稿");
    fireEvent.keyDown(field, { key: "ArrowUp" });
    expect(field.value).toBe("第二条");
    rerender(<Composer {...initial} readInputHistory={laterRead} />);
    expect(firstRead).toHaveBeenCalledTimes(1);
    expect(laterRead).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: "ArrowUp" });
    expect(field.value).toBe("第一条");
    rerender(<Composer {...initial} historyKey="other-session" readInputHistory={laterRead} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(laterRead).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(field, { key: "ArrowUp" });
    expect(field.value).toBe("新工作区输入");
  });

  it("首次创建后卸载草稿 Composer，也仍然记录已经接收的首条原文", async () => {
    let accept!: () => void;
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          accept = resolve;
        }),
    );
    const recordInputHistory = vi.fn(async (_text: string) => undefined);
    const { unmount } = render(<Composer {...props({ onSubmit, recordInputHistory })} />);
    fireEvent.keyDown(input("首次消息"), { key: "Enter" });
    unmount();
    await act(async () => {
      accept();
    });
    expect(recordInputHistory).toHaveBeenCalledWith("首次消息");
  });

  it("空白消息不发送，disabled 时仍可保留和编辑草稿", () => {
    const onSubmit = vi.fn();
    render(<Composer {...props({ disabled: true, onSubmit })} />);
    const field = input(" \n ");
    fireEvent.keyDown(field, { key: "Enter" });
    fireEvent.change(field, { target: { value: "等待重新连接" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(field.value).toBe("等待重新连接");
    expect(field.disabled).toBe(false);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "发送" }).disabled).toBe(true);
  });
});
