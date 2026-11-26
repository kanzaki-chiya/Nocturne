import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SkillOverview } from "@nocturne/core/protocol";
import { shouldBlockGlobalRefresh } from "../src/App";
import { Composer, type ComposerProps } from "../src/Composer";
import { effortOption, presetOptions } from "../src/choice-info";
import type { FileIndexEntry } from "../src/file-refs";
import type { PickedImage } from "../src/picked-images";

const testSkill = (overrides: Partial<SkillOverview> = {}): SkillOverview => ({
  name: "alpha",
  layer: "user",
  source: ".agents",
  entryPath: "C:/home/alpha",
  realPath: "C:/actual/alpha",
  otherEntries: [],
  description: "技能说明",
  displayedDescriptionLength: 4,
  invocation: "both",
  catalogStatus: "full",
  enabled: true,
  commandConflict: false,
  missingDescription: false,
  fields: { name: "alpha" },
  unknownFields: {},
  ignored: [],
  bodyLines: 3,
  bodyPreview: "body",
  files: [{ name: "SKILL.md", directory: false }],
  size: 256,
  ...overrides,
});

const INDEX: FileIndexEntry[] = [
  { path: "src/main.ts", kind: "file" },
  { path: "docs/main.md", kind: "file" },
  { path: "my file.txt", kind: "file" },
  { path: "src/", kind: "directory" },
  { path: "src/sub.ts", kind: "file" },
];

function props(overrides: Partial<ComposerProps> = {}): ComposerProps {
  return {
    running: false,
    onSubmit: vi.fn(async () => true),
    onInterrupt: vi.fn(),
    onSlash: vi.fn(async () => true),
    controls: {
      model: {
        value: "test/cheap",
        label: "cheap",
        groups: [
          {
            label: "全部模型",
            options: [
              { value: "test/cheap", label: "cheap" },
              { value: "test/fancy", label: "fancy" },
            ],
          },
        ],
        onSelect: vi.fn(),
      },
      effort: {
        value: "off",
        label: "off",
        groups: [
          {
            options: [
              { value: "off", label: "off" },
              { value: "high", label: "high" },
            ],
          },
        ],
        onSelect: vi.fn(),
      },
      preset: {
        value: "default",
        label: "default",
        groups: [
          {
            options: [
              { value: "default", label: "default" },
              { value: "smart", label: "smart" },
            ],
          },
        ],
        onSelect: vi.fn(),
      },
    },
    workspace: {
      label: "普通对话",
      kind: "plain",
      readOnly: false,
      currentKey: null,
      projects: [{ key: "z:/proj", path: "Z:/proj", name: "proj" }],
      onSelectPlain: vi.fn(),
      onSelectProject: vi.fn(),
      onOpenOther: vi.fn(),
    },
    fileRefs: null,
    pickImages: vi.fn(async () => []),
    ...overrides,
  };
}

function input(text: string): HTMLTextAreaElement {
  const field = screen.getByLabelText<HTMLTextAreaElement>("消息输入");
  fireEvent.focus(field);
  fireEvent.change(field, { target: { value: text } });
  field.setSelectionRange(text.length, text.length);
  return field;
}

function file(name: string, type: string, bytes = [1, 2, 3]): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
beforeAll(() => {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    value: vi.fn(),
    configurable: true,
  });
  let blob = 0;
  Object.defineProperty(URL, "createObjectURL", {
    value: vi.fn(() => `blob:mock-${++blob}`),
    configurable: true,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
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

describe("Composer 文本与历史", () => {
  it("隐藏而不卸载，恢复后保留草稿、附件和历史位置", async () => {
    const properties = props({
      variant: "session",
      readInputHistory: async () => ["历史一", "历史二"],
      pickImages: async () => [{ name: "draft.png", data: new Uint8Array([9, 8, 7]) }],
    });
    const rendered = render(<Composer {...properties} />);
    await act(async () => undefined);
    const field = input("提问前草稿");
    fireEvent.click(screen.getByRole("button", { name: "添加文件" }));
    await screen.findByText("draft.png");
    const image = rendered.container.querySelector(".thumb2 img");
    rendered.rerender(<Composer {...properties} hidden />);
    expect(rendered.container.querySelector(".composer")).toHaveProperty("hidden", true);
    expect(screen.queryByRole("textbox")).toBeNull();
    rendered.rerender(<Composer {...properties} />);
    expect(screen.getByRole("textbox")).toBe(field);
    expect(field.value).toBe("提问前草稿");
    expect(screen.getByText("draft.png")).toBeTruthy();
    expect(rendered.container.querySelector(".thumb2 img")).toBe(image);
    input("");
    fireEvent.keyDown(field, { key: "ArrowUp" });
    await waitFor(() => expect(field.value).toBe("历史二"));
    rendered.rerender(<Composer {...properties} hidden />);
    rendered.rerender(<Composer {...properties} />);
    fireEvent.keyDown(field, { key: "ArrowUp" });
    expect(field.value).toBe("历史一");
  });
  it("Enter 发送原文，Shift+Enter 留给浏览器换行，不吞掉边缘空白", async () => {
    const onSubmit = vi.fn(async () => true);
    render(<Composer {...props({ onSubmit })} />);
    const field = input("  第一行  ");
    expect(fireEvent.keyDown(field, { key: "Enter", shiftKey: true })).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: "  第一行  \n第二行  " } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith({ text: "  第一行  \n第二行  ", attachments: [] });
    await waitFor(() => {
      expect(field.value).toBe("");
    });
  });

  it("native isComposing 和 composition 状态都不误发 Enter", async () => {
    const onSubmit = vi.fn(async () => true);
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
    expect(onSubmit).toHaveBeenCalledWith({ text: "中文输入", attachments: [] });
    await waitFor(() => {
      expect(field.value).toBe("");
    });
  });

  it("运行中 Enter 排队、Alt+Enter 插话，■ 与发送键并存；Esc 中断", async () => {
    const onInterrupt = vi.fn();
    const onSubmit = vi.fn(async () => true);
    render(<Composer {...props({ running: true, onInterrupt, onSubmit })} />);
    const field = input("下一条草稿");
    // ADR-0070：运行中 Enter = 排队
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenLastCalledWith({ text: "下一条草稿", attachments: [] }, "queue");
    await waitFor(() => {
      expect(field.value).toBe("");
    });
    // Alt+Enter = 插话
    fireEvent.change(field, { target: { value: "插话这条" } });
    fireEvent.keyDown(field, { key: "Enter", altKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(onSubmit).toHaveBeenLastCalledWith({ text: "插话这条", attachments: [] }, "steer");
    await waitFor(() => {
      expect(field.value).toBe("");
    });
    // ■ 与发送键并存；没输入时只有 ■
    expect(screen.getByRole("button", { name: "中断" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "发送" })).toBeNull();
    fireEvent.change(field, { target: { value: "又一条" } });
    expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    fireEvent.keyDown(field, { key: "Escape", isComposing: true });
    expect(onInterrupt).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: "Escape" });
    expect(onInterrupt).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "中断" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "中断" }));
    expect(onInterrupt).toHaveBeenCalledTimes(2);
    expect(field.value).toBe("又一条");
    await act(async () => {
      await Promise.resolve();
    });
  });

  it("空闲时 Alt+Enter 与 Enter 一样是普通发送，且不带 mode", async () => {
    const onSubmit = vi.fn(async () => true);
    render(<Composer {...props({ onSubmit })} />);
    const field = input("普通发送");
    fireEvent.keyDown(field, { key: "Enter", altKey: true });
    expect(onSubmit).toHaveBeenCalledWith({ text: "普通发送", attachments: [] });
    await waitFor(() => {
      expect(field.value).toBe("");
    });
  });

  it("组字中的 Enter 与 Alt+Enter 都不提交", async () => {
    const onSubmit = vi.fn(async () => true);
    render(<Composer {...props({ running: true, onSubmit })} />);
    const field = input("组字");
    fireEvent.keyDown(field, { key: "Enter", isComposing: true });
    fireEvent.keyDown(field, { key: "Enter", altKey: true, isComposing: true });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.compositionStart(field);
    fireEvent.keyDown(field, { key: "Enter", altKey: true, isComposing: false });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.compositionEnd(field);
  });

  it("输入框外 Esc 也可中断，而空闲 Esc 仅关闭弹层", async () => {
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

  it("点发送后立即清空，未接收或失败再把草稿和附件放回", async () => {
    let accept!: (value: boolean) => void;
    const onSubmit = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          accept = resolve;
        }),
    );
    render(<Composer {...props({ onSubmit })} />);
    const field = input("先清空");
    fireEvent.keyDown(field, { key: "Enter" });
    expect(field.value).toBe("");
    expect(onSubmit).toHaveBeenCalledTimes(1);
    await act(async () => {
      accept(false);
    });
    expect(field.value).toBe("先清空");
  });

  it("未接收或发送失败不清空输入与附件，也不记录输入历史", async () => {
    const onSubmit = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error("连接已断开"));
    const recordInputHistory = vi.fn(async () => undefined);
    const pickImages: () => Promise<PickedImage[]> = vi.fn(async () => [
      { name: "a.png", data: new Uint8Array([1]) },
    ]);
    render(<Composer {...props({ onSubmit, recordInputHistory, pickImages })} />);
    const field = input("保留这条消息");
    fireEvent.click(screen.getByRole("button", { name: "添加文件" }));
    expect(await screen.findByText("a.png")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => {
      expect(field.value).toBe("保留这条消息");
    });
    expect(screen.getByText("a.png")).toBeTruthy();
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("连接已断开");
    });
    expect(field.value).toBe("保留这条消息");
    expect(screen.getByText("a.png")).toBeTruthy();
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
      return true;
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
      expect(screen.getByRole("alert").textContent).toContain("保存输入历史失败");
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
        new Promise<boolean>((resolve) => {
          accept = () => {
            resolve(true);
          };
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

describe("Composer 斜杠命令", () => {
  it("/ 弹层按「命令」组列出 /compact、/mcp、/review 与执行方式，Tab 补全不发送", async () => {
    const onSubmit = vi.fn();
    render(<Composer {...props({ onSubmit })} />);
    const field = input("/");
    const menu = await screen.findByRole("listbox", { name: "斜杠命令补全" });
    expect(menu.textContent).toContain("命令");
    const items = screen.getAllByRole("option");
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining("/compact"),
      expect.stringContaining("/mcp"),
      expect.stringContaining("/review"),
      expect.stringContaining("/grill-me"),
      expect.stringContaining("/goal"),
      expect.stringContaining("/plan"),
      expect.stringContaining("/fugue"),
      expect.stringContaining("/ensemble"),
    ]);
    expect(menu.textContent).toContain("多代理攻坚");
    expect(menu.textContent).not.toContain("/cadenza");
    expect(menu.textContent).not.toContain("华彩");
    fireEvent.keyDown(field, { key: "Tab" });
    expect(field.value).toBe("/compact ");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("斜杠菜单选中 /fugue 后显示多代理攻坚标签，发送时携带 workMode: fugue", async () => {
    const onSubmit = vi.fn(async () => true);
    render(<Composer {...props({ variant: "session", onSubmit })} />);
    const field = input("/fu");
    const option = await screen.findByRole("option", { name: /\/fugue/ });
    fireEvent.click(option);
    expect(field.value).toBe("/fugue ");
    fireEvent.change(field, { target: { value: "/fugue 并行改造" } });
    const tag = await screen.findByRole("button", { name: "取消多代理攻坚" });
    expect(tag.querySelector(".input-label")?.textContent).toBe("多代理攻坚");
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        text: "并行改造",
        draftText: "/fugue 并行改造",
        workMode: "fugue",
        attachments: [],
      }),
    );
  });

  it("/compact 由 onSlash 处理；/mcp 同样不在输入框里执行", async () => {
    const onSlash = vi.fn(async () => true);
    const onSubmit = vi.fn();
    render(<Composer {...props({ onSlash, onSubmit })} />);
    const field = input("/compact");
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(onSlash).toHaveBeenCalledWith("/compact"));
    expect(onSubmit).not.toHaveBeenCalled();
    await waitFor(() => expect(field.value).toBe(""));
  });

  it("已移除命令只给界面操作提示，不发送也不调用 onSlash", async () => {
    const onSlash = vi.fn();
    const onSubmit = vi.fn();
    render(<Composer {...props({ onSlash, onSubmit })} />);
    const field = input("/model");
    expect(screen.getByRole("status").textContent).toContain("在输入框右下角切换模型");
    fireEvent.keyDown(field, { key: "Enter" });
    await act(async () => {
      await Promise.resolve();
    });
    expect(onSlash).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(field.value).toBe("/model");
    fireEvent.change(field, { target: { value: "/provider" } });
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("在 设置 › 服务商 管理"),
    );
  });

  it("未知命令给提示且不发送", async () => {
    const onSubmit = vi.fn();
    render(<Composer {...props({ onSubmit })} />);
    const field = input("/zzz");
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("未知命令 /zzz"));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(field.value).toBe("/zzz");
  });
});

describe("Composer 执行方式（ADR-0076）", () => {
  it("/grill-me 任务：去掉命令名后带 workMode 提交；运行中只排队", async () => {
    const onSubmit = vi.fn(async () => true);
    const { rerender } = render(<Composer {...props({ onSubmit })} />);
    const field = input("/grill-me 做个登录页");
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        text: "做个登录页",
        draftText: "/grill-me 做个登录页",
        workMode: "grill-me",
        attachments: [],
      }),
    );
    rerender(<Composer {...props({ onSubmit, running: true })} />);
    fireEvent.change(field, { target: { value: "/grill-me 第二件" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() =>
      expect(onSubmit).toHaveBeenLastCalledWith(
        { text: "第二件", draftText: "/grill-me 第二件", workMode: "grill-me", attachments: [] },
        "queue",
      ),
    );
  });
});

describe("Composer 控件与附件", () => {
  it("32 KiB 粘贴转文件，CtrlShiftV 保留原文路径", async () => {
    const onSubmit = vi.fn(async () => true);
    render(<Composer {...props({ onSubmit })} />);
    const field = input("");
    const text = "x".repeat(32768);
    fireEvent.paste(field, { clipboardData: { items: [], getData: () => text } });
    expect(await screen.findByText("pasted-1.txt")).toBeTruthy();
    expect(field.value).toBe("");
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "",
          attachments: [expect.objectContaining({ label: "pasted-1.txt", source: "paste" })],
        }),
      ),
    );
    await waitFor(() => expect(screen.queryByText("pasted-1.txt")).toBeNull());
    fireEvent.keyDown(field, { key: "V", ctrlKey: true, shiftKey: true });
    const allowed = fireEvent.paste(field, { clipboardData: { items: [], getData: () => text } });
    expect(allowed).toBe(true);
    expect(screen.queryByText("pasted-2.txt")).toBeNull();
  });
  it("模型 chip 菜单选择调用 onSelect，底部可管理服务商；档位与预设同样经 chip，危险项排在最后", async () => {
    const controls = props().controls;
    if (controls === undefined) throw new Error("fixture 缺少 controls");
    controls.preset.groups = [{ options: presetOptions() }];
    expect(presetOptions().every((option) => !("description" in option))).toBe(true);
    expect(
      ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
        .map(effortOption)
        .every((option) => !("description" in option)),
    ).toBe(true);
    const onManageProviders = vi.fn();
    render(<Composer {...props({ controls, onManageProviders })} />);
    fireEvent.click(screen.getByRole("button", { name: "切换模型" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /fancy/ }));
    expect(controls.model.onSelect).toHaveBeenCalledWith("test/fancy");
    fireEvent.click(screen.getByRole("button", { name: "切换模型" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "管理服务商…" }));
    expect(onManageProviders).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "切换思考档位" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "high" }));
    expect(controls.effort.onSelect).toHaveBeenCalledWith("high");
    const presetTrigger = screen.getByRole("button", { name: "切换权限预设" });
    fireEvent.click(presetTrigger);
    expect(presetTrigger.getAttribute("aria-expanded")).toBe("true");
    const options = screen.getAllByRole("menuitemradio");
    expect(options).toHaveLength(6);
    expect(options.at(-1)?.textContent).toContain("bypass");
    expect(options.at(-1)?.className).toContain("danger");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "smart" }));
    expect(controls.preset.onSelect).toHaveBeenCalledWith("smart");
    expect(presetTrigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("模型与目录 chip 带各自上限与省略类并保留完整 title，预设与档位不收缩", () => {
    const longLabel = "dealignai/Qwen3.8-Flash-Next-CYBERSECURITY-NVFP4 · qwen3.8-colab";
    const longDir = "very-long-workspace-folder-name-that-exceeds-the-320px-chip-limit";
    const baseControls = props().controls;
    const baseWorkspace = props().workspace;
    if (baseControls === undefined || baseWorkspace === undefined) {
      throw new Error("fixture 缺少 controls 或 workspace");
    }
    const controls = {
      ...baseControls,
      model: { ...baseControls.model, label: longLabel, icon: "qwen-color" },
    };
    const { rerender } = render(<Composer {...props({ variant: "session", controls })} />);
    const model = screen.getByRole("button", { name: "切换模型" });
    const preset = screen.getByRole("button", { name: "切换权限预设" });
    const effort = screen.getByRole("button", { name: "切换思考档位" });
    expect(model.classList.contains("chip")).toBe(true);
    expect(model.classList.contains("chip-model")).toBe(true);
    expect(model.querySelector(".brand-icon.brand-icon-sm")).not.toBeNull();
    expect(model.querySelector(".brand-icon.is-fallback")).toBeNull();
    expect(model.querySelector("title")).toBeNull();
    expect(model.querySelector(".t")?.textContent).toBe(longLabel);
    expect(model.querySelector(".caret")).not.toBeNull();
    expect(model.getAttribute("title")).toBe(longLabel);
    expect(preset.classList.contains("chip-model")).toBe(false);
    expect(effort.classList.contains("chip-model")).toBe(false);

    const disabledControls = {
      ...controls,
      model: { ...controls.model, disabled: "运行中暂不可切换模型" },
    };
    const longWorkspace = {
      ...baseWorkspace,
      label: longDir,
      title: `Z:\\projects\\${longDir}`,
    };
    rerender(<Composer {...props({ controls: disabledControls, workspace: longWorkspace })} />);
    const dir = screen.getByRole("button", { name: "切换目录" });
    const draftModel = screen.getByRole("button", { name: "切换模型" });
    const draftPreset = screen.getByRole("button", { name: "切换权限预设" });
    expect(draftModel.getAttribute("title")).toBe("运行中暂不可切换模型");
    expect((draftModel as HTMLButtonElement).disabled).toBe(true);
    expect(dir.classList.contains("chip")).toBe(true);
    expect(dir.classList.contains("chip-dir")).toBe(true);
    expect(dir.getAttribute("title")).toBe(`Z:\\projects\\${longDir}`);
    expect(dir.querySelector("b")?.textContent).toBe(longDir);
    expect(draftPreset.classList.contains("chip-dir")).toBe(false);
    expect(draftPreset.classList.contains("chip-model")).toBe(false);
  });

  it("目录菜单列出普通对话与项目，选择走回调", async () => {
    const workspace = props().workspace;
    if (workspace === undefined) throw new Error("fixture 缺少 workspace");
    render(<Composer {...props({ workspace })} />);
    fireEvent.click(screen.getByRole("button", { name: "切换目录" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /proj/ }));
    expect(workspace.onSelectProject).toHaveBeenCalledWith("Z:/proj");
  });

  it("pickImages、粘贴与移除附件；提交载荷含 Uint8Array/类型/文件名", async () => {
    const pickImages = vi.fn(async (): Promise<PickedImage[]> => [
      { name: "picked.png", data: new Uint8Array([9, 8, 7]) },
    ]);
    const onSubmit = vi.fn(async () => true);
    render(<Composer {...props({ pickImages, onSubmit })} />);
    const field = input("看图");
    fireEvent.click(screen.getByRole("button", { name: "添加文件" }));
    expect(await screen.findByText("picked.png")).toBeTruthy();
    fireEvent.paste(field, {
      clipboardData: {
        items: [
          { kind: "file", type: "image/jpeg", getAsFile: () => file("shot.jpg", "image/jpeg") },
        ],
      },
    });
    expect(await screen.findByText("shot.jpg")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "移除 picked.png" }));
    expect(screen.queryByText("picked.png")).toBeNull();
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const submitted = (onSubmit.mock.calls[0] as unknown[])[0] as {
      text: string;
      attachments: { data: Uint8Array; mimeType: string; label: string }[];
    };
    expect(submitted.text).toBe("看图");
    expect(submitted.attachments).toHaveLength(1);
    expect(submitted.attachments[0]?.data).toBeInstanceOf(Uint8Array);
    expect(submitted.attachments[0]?.mimeType).toBe("image/jpeg");
    expect(submitted.attachments[0]?.label).toBe("shot.jpg");
  });

  it("拖入文件显示卡片；图片附件存在时展示 visionHint", async () => {
    const getVisionHint = vi.fn(async () => "当前模型不支持图片，将由 test/desc 描述后发送");
    render(<Composer {...props({ getVisionHint })} />);
    const field = input("");
    fireEvent.drop(field, { dataTransfer: { files: [file("a.txt", "text/plain")] } });
    expect(await screen.findByText("a.txt")).toBeTruthy();
    fireEvent.paste(field, {
      clipboardData: {
        items: [{ kind: "file", type: "image/png", getAsFile: () => file("a.png", "image/png") }],
      },
    });
    await waitFor(() => expect(getVisionHint).toHaveBeenCalled());
    await screen.findByText(/test\/desc 描述后发送/);
  });

  it("session 变体：卡片上层文字区、下层工具行含预设/模型/档位 chip，无 tray，提示与附件仍工作", async () => {
    const getVisionHint = vi.fn(async () => "当前模型不支持图片，将由 test/desc 描述后发送");
    const { container, rerender } = render(
      <Composer {...props({ variant: "session", getVisionHint })} />,
    );
    const preset = screen.getByRole("button", { name: "切换权限预设" });
    const model = screen.getByRole("button", { name: "切换模型" });
    const effort = screen.getByRole("button", { name: "切换思考档位" });
    expect(screen.queryByRole("button", { name: "切换目录" })).toBeNull();
    expect(screen.queryByRole("button", { name: "选择分支" })).toBeNull();
    const field = screen.getByLabelText<HTMLTextAreaElement>("消息输入");
    const card = container.querySelector(".composer.session .cbox");
    const text = card?.querySelector(".txt");
    const toolbar = card?.querySelector(".tb");
    const plus = screen.getByRole("button", { name: "添加" });
    const paperclip = screen.getByRole("button", { name: "添加文件" });
    const send = screen.getByRole("button", { name: "发送" });
    expect(card).not.toBeNull();
    expect(Array.from(card?.children ?? [])).toEqual([text, toolbar]);
    expect(text?.contains(field)).toBe(true);
    expect(text?.querySelector(".composer-mirror")).not.toBeNull();
    expect(text?.querySelector("button")).toBeNull();
    expect(toolbar?.parentElement).toBe(card);
    expect(plus.parentElement).toBe(toolbar);
    expect(paperclip.parentElement).toBe(toolbar);
    expect(send.parentElement).toBe(toolbar);
    expect(Array.from(toolbar?.children ?? [])).toEqual([
      plus,
      paperclip,
      preset,
      toolbar?.querySelector(".sp"),
      model,
      effort,
      send,
    ]);
    expect(container.querySelector(".session-row")).toBeNull();
    expect(container.querySelector(".tray")).toBeNull();

    // 切到 draft（新会话页）时，.tray 出现在 .cbox 下方并容纳工作区与分支 chip；切回 session 则无 .tray
    rerender(
      <Composer
        {...props({
          variant: "draft",
          branch: {
            current: "main",
            branches: [{ name: "main" }],
            canCreate: true,
            onSelect: vi.fn(),
          },
        })}
      />,
    );
    const draftCw = container.querySelector(".composer:not(.session) .cw");
    const draftCard = draftCw?.querySelector(".cbox");
    const draftTray = draftCw?.querySelector(".tray");
    const draftToolbar = draftCard?.querySelector(".tb");
    const draftDir = screen.getByRole("button", { name: "切换目录" });
    const draftBranch = screen.getByRole("button", { name: "选择分支" });
    expect(draftTray).not.toBeNull();
    expect(draftTray?.parentElement).toBe(draftCw);
    expect(draftTray?.previousElementSibling).toBe(draftCard);
    expect(Array.from(draftTray?.children ?? [])).toEqual([draftDir, draftBranch]);
    expect(draftToolbar?.contains(draftDir)).toBe(false);
    expect(draftToolbar?.contains(draftBranch)).toBe(false);

    rerender(
      <Composer
        {...props({
          variant: "session",
          branch: {
            current: "main",
            branches: [{ name: "main" }],
            canCreate: true,
            onSelect: vi.fn(),
          },
          getVisionHint,
        })}
      />,
    );
    expect(container.querySelector(".tray")).toBeNull();
    // 附件缩略图在卡内，vision 提示显示在卡片上方气泡（role=status）
    fireEvent.paste(field, {
      clipboardData: {
        items: [{ kind: "file", type: "image/png", getAsFile: () => file("a.png", "image/png") }],
      },
    });
    await waitFor(() => expect(getVisionHint).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("test/desc 描述后发送"),
    );
    expect(document.querySelector(".atts .thumb2 img")).not.toBeNull();
  });

  it("session 运行中：下层工具行右侧为 ■ 与发送键，点击中断且保留上层草稿", async () => {
    const onInterrupt = vi.fn();
    const { container } = render(
      <Composer {...props({ variant: "session", running: true, onInterrupt })} />,
    );
    const field = input("下一条草稿");
    const card = container.querySelector(".composer.session .cbox");
    const text = card?.querySelector(".txt");
    const toolbar = card?.querySelector(".tb");
    const plus = screen.getByRole("button", { name: "添加" });
    const paperclip = screen.getByRole("button", { name: "添加文件" });
    const preset = screen.getByRole("button", { name: "切换权限预设" });
    const model = screen.getByRole("button", { name: "切换模型" });
    const effort = screen.getByRole("button", { name: "切换思考档位" });
    const stop = screen.getByRole<HTMLButtonElement>("button", { name: "中断" });
    const send = screen.getByRole<HTMLButtonElement>("button", { name: "发送" });
    expect(field.placeholder).toBe("输入消息");
    expect(field.placeholder).not.toContain("@ 引用文件");
    expect(field.placeholder).not.toMatch(/Enter|插话|排队/);
    expect(send.getAttribute("title")).toBe("发送");
    expect(Array.from(card?.children ?? [])).toEqual([text, toolbar]);
    expect(text?.contains(field)).toBe(true);
    // ADR-0070：运行中输入非空时 ■ 与发送键并存
    expect(Array.from(toolbar?.children ?? [])).toEqual([
      plus,
      paperclip,
      preset,
      toolbar?.querySelector(".sp"),
      model,
      effort,
      stop,
      send,
    ]);
    expect(stop.className).toBe("send stop");
    expect(stop.querySelector("svg")).not.toBeNull();
    expect(send.disabled).toBe(false);
    expect(container.querySelector(".tray")).toBeNull();
    fireEvent.click(stop);
    expect(onInterrupt).toHaveBeenCalledTimes(1);
    expect(field.value).toBe("下一条草稿");
    await waitFor(() => expect(stop.disabled).toBe(false));
  });
});

describe("Composer @ 引用", () => {
  it("输入 @ 打开文件弹层，选择插入路径并加空格", async () => {
    const fileRefs = { load: vi.fn(async () => INDEX), key: 0 };
    render(<Composer {...props({ fileRefs })} />);
    const field = input("看 @ma");
    const menu = await screen.findByRole("listbox", { name: "文件引用补全" });
    expect(menu.textContent).toContain("main.ts");
    const option = screen
      .getAllByRole("option")
      .find((row) => /main\.ts/.test(row.textContent ?? "")) as HTMLElement;
    fireEvent.click(option);
    expect(field.value).toBe("看 @src/main.ts ");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("含空格路径插入引号形式，目录选择保持弹层继续展开", async () => {
    const fileRefs = { load: vi.fn(async () => INDEX), key: 0 };
    render(<Composer {...props({ fileRefs })} />);
    const field = input("@");
    await screen.findByRole("listbox", { name: "文件引用补全" });
    fireEvent.click(
      screen
        .getAllByRole("option")
        .find((row) => /my file\.txt/.test(row.textContent ?? "")) as HTMLElement,
    );
    expect(field.value).toBe('@"my file.txt" ');
    fireEvent.change(field, { target: { value: "@" } });
    field.setSelectionRange(1, 1);
    await screen.findByRole("listbox", { name: "文件引用补全" });
    fireEvent.click(
      screen
        .getAllByRole("option")
        .find((row) => /^src\/$/.test(row.textContent ?? "")) as HTMLElement,
    );
    expect(field.value).toBe("@src/");
    expect(await screen.findByRole("listbox", { name: "文件引用补全" })).toBeTruthy();
    expect(
      screen
        .getAllByRole("option")
        .find((row) => /sub\.ts/.test(row.textContent ?? "")) as HTMLElement,
    ).toBeTruthy();
  });

  it("fileRefs 为 null 时 @ 不弹层，且 ＋ 菜单不再列出引用文件", async () => {
    render(<Composer {...props({ fileRefs: null })} />);
    input("看 @ma");
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    expect(screen.queryByRole("menuitem", { name: /引用文件/ })).toBeNull();
  });

  it("U-05：Backspace 整删光标前的完整 @引用，键入中的词逐字删", () => {
    render(<Composer {...props()} />);
    // "看 @src/main.ts 谢谢"：@ 在 2，空格在 13
    const field = input("看 @src/main.ts 谢谢");
    field.setSelectionRange(14, 14);
    expect(fireEvent.keyDown(field, { key: "Backspace" })).toBe(false);
    expect(field.value).toBe("看 谢谢");
    expect(field.selectionStart).toBe(2);
    // 词中位置逐字删（jsdom 不执行默认删除，值为我们的不干预＋原生语义）
    field.setSelectionRange(10, 10);
    fireEvent.change(field, { target: { value: "看 @src/main.ts 谢谢" } });
    field.setSelectionRange(10, 10);
    expect(fireEvent.keyDown(field, { key: "Backspace" })).toBe(true);
    // 键入中的裸词不整删
    fireEvent.change(field, { target: { value: "看 @fo" } });
    field.setSelectionRange(6, 6);
    expect(fireEvent.keyDown(field, { key: "Backspace" })).toBe(true);
    expect(field.value).toBe("看 @fo");
  });

  it("U-05：Delete 整删光标后的完整 @引用；有选区与合成中不拦截", () => {
    render(<Composer {...props()} />);
    const field = input("看 @src/main.ts 谢谢");
    field.setSelectionRange(2, 2);
    expect(fireEvent.keyDown(field, { key: "Delete" })).toBe(false);
    expect(field.value).toBe("看 谢谢");
    // 有选区时走默认（jsdom 不做原生删除，值为不干预）
    fireEvent.change(field, { target: { value: "看 @src/main.ts 谢谢" } });
    field.setSelectionRange(2, 14);
    expect(fireEvent.keyDown(field, { key: "Backspace" })).toBe(true);
    expect(field.value).toBe("看 @src/main.ts 谢谢");
    // 输入法组合中不拦截
    field.setSelectionRange(14, 14);
    expect(fireEvent.keyDown(field, { key: "Backspace", isComposing: true })).toBe(true);
    expect(field.value).toBe("看 @src/main.ts 谢谢");
  });
});

describe("Composer 新会话页托盘与分支选择（ADR-0085）", () => {
  it("普通对话或非仓库时托盘仅含工作区而不显示分支 chip；git 仓库托盘内显示工作区与分支，所有选项（含其他工作树占用）均可选，搜索不匹配时出现新建分支", async () => {
    const onSelect = vi.fn();
    const { container, rerender } = render(
      <Composer
        {...props({
          branch: {
            current: null,
            branches: [],
            canCreate: false,
            onSelect,
          },
        })}
      />,
    );
    const plainCw = container.querySelector(".composer:not(.session) .cw");
    const plainTray = plainCw?.querySelector(".tray");
    expect(plainTray).not.toBeNull();
    expect(plainTray?.parentElement).toBe(plainCw);
    expect(screen.queryByRole("button", { name: "选择分支" })).toBeNull();
    expect(Array.from(plainTray?.children ?? [])).toEqual([
      screen.getByRole("button", { name: "切换目录" }),
    ]);

    rerender(
      <Composer
        {...props({
          workspace: {
            label: "nocturne",
            kind: "project",
            readOnly: false,
            currentKey: "z:/nocturne",
            projects: [{ key: "z:/nocturne", path: "Z:/nocturne", name: "nocturne" }],
            onSelectPlain: vi.fn(),
            onSelectProject: vi.fn(),
            onOpenOther: vi.fn(),
          },
          branch: {
            current: "main",
            branches: [
              { name: "main" },
              { name: "fix/style" },
              { name: "feat/occupied", worktree: "Z:/nocturne-wt/occupied" },
            ],
            canCreate: true,
            onSelect,
          },
        })}
      />,
    );
    const branchBtn = screen.getByRole("button", { name: "选择分支" });
    expect((branchBtn as HTMLButtonElement).disabled).toBe(false);
    expect(branchBtn.textContent).toBe("main");
    expect(branchBtn.querySelector(".caret")).not.toBeNull();

    fireEvent.click(branchBtn);
    const menu = await screen.findByRole("menu");
    const searchInput = within(menu).getByRole("textbox");
    expect(document.activeElement).toBe(searchInput);

    // 占用项在工作树检出：新会话页不禁用，仅在父行 title 显示工作树路径
    const occupiedItem = screen.getByRole("menuitemradio", { name: "feat/occupied" });
    expect((occupiedItem as HTMLButtonElement).disabled).toBe(false);
    expect(occupiedItem.parentElement?.getAttribute("title")).toBe("Z:/nocturne-wt/occupied");

    // 搜索不匹配且合法分支名时出现「新建分支 …」
    fireEvent.change(searchInput, { target: { value: "r1110e/branch-picker" } });
    const createItem = screen.getByRole("menuitemradio", {
      name: "新建分支 r1110e/branch-picker",
    });
    fireEvent.click(createItem);
    expect(onSelect).toHaveBeenCalledWith("r1110e/branch-picker", true);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("Composer ＋ 菜单、子菜单与执行方式标签", () => {
  it("选执行方式显示标签并随发送带上 workMode，发送后标签清空；失败时保留标签", async () => {
    const onSubmit = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { container } = render(<Composer {...props({ variant: "session", onSubmit })} />);

    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    const plusMenu = await screen.findByRole("menu", { name: "添加" });
    expect(plusMenu.textContent).toContain("追问需求");
    expect(plusMenu.textContent).toContain("目标");
    expect(plusMenu.textContent).toContain("计划");
    expect(plusMenu.textContent).toContain("多代理攻坚");
    expect(plusMenu.textContent).toContain("合奏");
    expect(plusMenu.textContent).not.toContain("华彩");
    expect(within(plusMenu).queryByRole("menuitemradio")).toBeNull();

    fireEvent.click(within(plusMenu).getByRole("menuitem", { name: "目标" }));
    const modeTag = screen.getByRole("button", { name: "取消目标" });
    expect(modeTag.parentElement).toBe(container.querySelector(".tb"));
    expect(modeTag.nextElementSibling?.className).toBe("tb-sep");
    expect(modeTag.querySelector(".input-label")?.textContent).toBe("目标");
    expect(modeTag.querySelector(".work-mode-icon svg")).toBeTruthy();
    expect(modeTag.querySelector(".work-mode-close svg")).toBeTruthy();

    // 选了执行方式但输入为空：发送按钮禁用，按 Enter 给用法提示而不发送
    const sendBtn = screen.getByRole<HTMLButtonElement>("button", { name: "发送" });
    expect(sendBtn.disabled).toBe(true);
    const field = screen.getByLabelText<HTMLTextAreaElement>("消息输入");
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe("用法：/goal 任务");

    // 填写任务但发送被拒绝：标签保留
    fireEvent.change(field, { target: { value: "把测试跑绿" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenLastCalledWith({
      text: "把测试跑绿",
      workMode: "goal",
      attachments: [],
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "取消目标" })).toBeTruthy());

    // 再次发送成功：标签清空
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("button", { name: "取消目标" })).toBeNull());
    expect(container.querySelector(".tb .tb-sep")).toBeNull();
  });

  it("取消执行方式标签后发送不再带 workMode", async () => {
    const onSubmit = vi.fn(async () => true);
    render(<Composer {...props({ onSubmit })} />);

    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "计划" }));
    const tag = screen.getByRole("button", { name: "取消计划" });
    fireEvent.click(tag);
    expect(screen.queryByRole("button", { name: "取消计划" })).toBeNull();

    const field = input("只做普通提问");
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenLastCalledWith({
      text: "只做普通提问",
      attachments: [],
    });
  });

  it("选中执行方式标签后发送斜杠技能命令时不带 workMode 且保留标签；再发普通文本带出并清空标签", async () => {
    const onSubmit = vi.fn(async (_payload: unknown) => true);
    render(
      <Composer
        {...props({
          variant: "session",
          skills: [testSkill({ name: "deploy", description: "发布" })],
          onSubmit,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "目标" }));
    expect(screen.getByRole("button", { name: "取消目标" })).toBeTruthy();

    // 再次打开「+」菜单：执行方式不带勾选列（仍为普通 menuitem，无 menuitemradio）
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    const reopened = await screen.findByRole("menu", { name: "添加" });
    expect(within(reopened).queryByRole("menuitemradio")).toBeNull();
    expect(reopened.querySelector(".menu-check")).toBeNull();
    fireEvent.keyDown(reopened, { key: "Escape" });

    const field = input("/deploy x");
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const skillCall = onSubmit.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(skillCall.workMode).toBeUndefined();
    expect(skillCall.skill).toBeTruthy();
    expect(screen.getByRole("button", { name: "取消目标" })).toBeTruthy();

    fireEvent.change(field, { target: { value: "完成收尾" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect(onSubmit).toHaveBeenLastCalledWith({
      text: "完成收尾",
      workMode: "goal",
      attachments: [],
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: "取消目标" })).toBeNull());
  });

  it("被禁用的执行方式禁用并带悬停说明原因", async () => {
    render(
      <Composer
        {...props({
          variant: "session",
          workModeDisabled: {
            ensemble: "当前会话已有进行中的合奏，请先结束当前合奏",
          },
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    const ensembleItem = (await screen.findByRole("menuitem", {
      name: "合奏",
    })) as HTMLButtonElement;
    expect(ensembleItem.disabled).toBe(true);
    expect(ensembleItem.getAttribute("title")).toBe("当前会话已有进行中的合奏，请先结束当前合奏");
  });

  it("技能子菜单支持无占位符搜索过滤、插入 /技能名 并保留管理技能入口", async () => {
    const onManageSkills = vi.fn();
    render(
      <Composer
        {...props({
          skills: [
            testSkill({ name: "plan-check", description: "检查计划步骤" }),
            testSkill({ name: "deploy", description: "发布构建产物" }),
          ],
          onManageSkills,
        })}
      />,
    );
    const field = input("先");
    field.setSelectionRange(1, 1);

    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "技能" }));
    const submenu = await screen.findByRole("menu", { name: "技能" });
    const search = within(submenu).getByRole("searchbox", { name: "搜索技能" });
    expect(search.getAttribute("placeholder")).toBeNull();

    fireEvent.change(search, { target: { value: "not-found" } });
    expect(submenu.textContent).not.toContain("没有匹配的技能");
    expect(submenu.querySelector(".menu-note")).toBeNull();
    expect(submenu.querySelector(".menu-sep")).not.toBeNull();
    expect(within(submenu).getByRole("menuitem", { name: "管理技能" })).toBeTruthy();

    fireEvent.change(search, { target: { value: "deploy" } });
    expect(within(submenu).queryByRole("menuitem", { name: "plan-check" })).toBeNull();
    fireEvent.click(within(submenu).getByRole("menuitem", { name: "deploy" }));
    expect(field.value).toBe("先");
    expect(document.querySelector(".draft-skill .input-label")?.textContent).toBe("deploy");

    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "技能" }));
    const submenu2 = await screen.findByRole("menu", { name: "技能" });
    fireEvent.click(within(submenu2).getByRole("menuitem", { name: "管理技能" }));
    expect(onManageSkills).toHaveBeenCalledTimes(1);
  });

  it("MCP 不可用时 ＋ 按钮与 MCP 子菜单项显示红点，恢复后消失；点管理 MCP 走回调", async () => {
    const onManageMcp = vi.fn();
    const { rerender } = render(
      <Composer
        {...props({
          variant: "session",
          mcpServers: {
            broken: { state: "failed", toolCount: 0, error: "连接失败" },
            docs: { state: "ready", toolCount: 2 },
          },
          onManageMcp,
        })}
      />,
    );
    const plusBtn = screen.getByRole("button", { name: "添加" });
    expect(plusBtn.querySelector(".mcp-dot")).not.toBeNull();

    fireEvent.click(plusBtn);
    const mcpTrigger = await screen.findByRole("menuitem", { name: "MCP" });
    expect(mcpTrigger.querySelector(".mcp-dot")).not.toBeNull();
    fireEvent.click(mcpTrigger);

    const mcpSubmenu = await screen.findByRole("menu", { name: "MCP" });
    expect(mcpSubmenu.textContent).toContain("broken");
    expect(mcpSubmenu.textContent).toContain("docs");
    expect(mcpSubmenu.querySelector(".mcp-state-dot.is-failed")).not.toBeNull();
    expect(mcpSubmenu.querySelector(".mcp-state-dot.is-ready")).not.toBeNull();

    fireEvent.click(within(mcpSubmenu).getByRole("menuitem", { name: "管理 MCP" }));
    expect(onManageMcp).toHaveBeenCalledTimes(1);

    rerender(
      <Composer
        {...props({
          variant: "session",
          mcpServers: {
            broken: { state: "ready", toolCount: 1 },
            docs: { state: "standby", toolCount: 2 },
          },
          onManageMcp,
        })}
      />,
    );
    expect(screen.getByRole("button", { name: "添加" }).querySelector(".mcp-dot")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    const mcpTrigger2 = await screen.findByRole("menuitem", { name: "MCP" });
    expect(mcpTrigger2.querySelector(".mcp-dot")).toBeNull();
    fireEvent.click(mcpTrigger2);
    const mcpSubmenu2 = await screen.findByRole("menu", { name: "MCP" });
    expect(mcpSubmenu2.querySelector(".mcp-state-dot.is-standby")).not.toBeNull();
  });
});

it("技能补全以行内标签呈现并保持原始技能发送载荷", async () => {
  const onSubmit = vi.fn(async () => true);
  const { container } = render(<Composer {...props({ skills: [testSkill()], onSubmit })} />);
  const field = input("/al");
  fireEvent.keyDown(field, { key: "Enter" });
  expect(container.querySelector(".draft-skill .input-label")?.textContent).toBe("alpha");
  expect(field.value).toBe("");
  expect(field.getAttribute("placeholder")).toBeNull();
  fireEvent.change(field, { target: { value: "检查文件\n并给建议" } });
  fireEvent.keyDown(field, { key: "Enter" });
  await waitFor(() =>
    expect(onSubmit).toHaveBeenCalledWith({
      attachments: [],
      text: "/alpha 检查文件\n并给建议",
      skill: { name: "alpha", arguments: "检查文件\n并给建议" },
    }),
  );
});

it("分叉回填和输入历史恢复技能标签，起始退格只删除标签", async () => {
  const readInputHistory = vi.fn(async () => ["/alpha 历史"]);
  const { container } = render(
    <Composer
      {...props({ skills: [testSkill()], initialDraft: "/alpha 分叉", readInputHistory })}
    />,
  );
  const field = screen.getByLabelText<HTMLTextAreaElement>("消息输入");
  expect(field.value).toBe("分叉");
  expect(container.querySelector(".draft-skill .input-label")?.textContent).toBe("alpha");
  field.setSelectionRange(0, 0);
  fireEvent.keyDown(field, { key: "Backspace" });
  expect(field.value).toBe("分叉");
  expect(container.querySelector(".draft-skill .input-label")).toBeNull();
  await waitFor(() => expect(readInputHistory).toHaveBeenCalled());
  fireEvent.keyDown(field, { key: "ArrowUp" });
  expect(field.value).toBe("历史");
  expect(container.querySelector(".draft-skill .input-label")?.textContent).toBe("alpha");
});

it("手输计划在组字结束后显示执行方式标签并保持命令发送载荷", async () => {
  const onSubmit = vi.fn(async () => true);
  render(<Composer {...props({ onSubmit })} />);
  const field = input("/plan");
  fireEvent.compositionStart(field);
  fireEvent.change(field, { target: { value: "/plan 修复测试" } });
  expect(field.value).toBe("/plan 修复测试");
  expect(screen.queryByRole("button", { name: "取消计划" })).toBeNull();
  fireEvent.compositionEnd(field);
  expect(field.value).toBe("修复测试");
  expect(screen.getByRole("button", { name: "取消计划" }).textContent).toBe("计划");
  fireEvent.keyDown(field, { key: "Enter" });
  await waitFor(() =>
    expect(onSubmit).toHaveBeenCalledWith({
      attachments: [],
      text: "修复测试",
      draftText: "/plan 修复测试",
      workMode: "plan",
    }),
  );
});

describe("Composer 输入历史搜索", () => {
  it("Ctrl+R 打开历史列表并阻止默认行为，继续输入实时过滤并高亮命中", async () => {
    const readInputHistory = vi.fn(async () => [
      "老日志\n换行展示",
      "检查 worktree 状态",
      "无关指令",
      "检查 worktree 状态",
      "合进来之后把 Worktree 和分支删掉",
    ]);
    render(<Composer {...props({ historyKey: "hist-1", readInputHistory })} />);
    await waitFor(() => expect(readInputHistory).toHaveBeenCalled());

    const field = input("");
    const openEv = createEvent.keyDown(field, { key: "r", ctrlKey: true });
    fireEvent(field, openEv);
    expect(openEv.defaultPrevented).toBe(true);

    const listbox = screen.getByRole("listbox", { name: "输入历史" });
    expect(listbox.querySelector(".composer-popup-h")?.textContent).toBe("历史");
    const allOptions = within(listbox).getAllByRole("option");
    expect(allOptions.map((o) => o.textContent)).toEqual([
      "合进来之后把 Worktree 和分支删掉",
      "检查 worktree 状态",
      "无关指令",
      "老日志 换行展示",
    ]);
    expect(allOptions[0]?.className).toContain("is-active");

    fireEvent.change(field, { target: { value: "worktree" } });
    const filtered = within(listbox).getAllByRole("option");
    expect(filtered.map((o) => o.textContent)).toEqual([
      "合进来之后把 Worktree 和分支删掉",
      "检查 worktree 状态",
    ]);
    expect(filtered[0]?.className).toContain("is-active");
    expect(filtered[0]?.querySelector("mark.composer-history-hl")?.textContent).toBe("Worktree");
    expect(filtered[1]?.querySelector("mark.composer-history-hl")?.textContent).toBe("worktree");
  });

  it("↑/↓ 与再次按 Ctrl+R 移动选中项，Enter 与 Tab 回填且不发送、光标置末、恢复标签", async () => {
    const onSubmit = vi.fn(async () => true);
    const readInputHistory = vi.fn(async () => [
      "first worktree cmd",
      "/alpha worktree review",
      "third worktree cmd",
    ]);
    const { container } = render(
      <Composer
        {...props({ historyKey: "hist-2", skills: [testSkill()], onSubmit, readInputHistory })}
      />,
    );
    await waitFor(() => expect(readInputHistory).toHaveBeenCalled());

    const field = input("worktree");
    fireEvent.keyDown(field, { key: "r", ctrlKey: true });
    const listbox = screen.getByRole("listbox", { name: "输入历史" });
    const rows = within(listbox).getAllByRole("option");
    expect(rows[0]?.className).toContain("is-active");

    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(within(listbox).getAllByRole("option")[1]?.className).toContain("is-active");
    fireEvent.keyDown(field, { key: "ArrowUp" });
    expect(within(listbox).getAllByRole("option")[0]?.className).toContain("is-active");
    fireEvent.keyDown(field, { key: "r", ctrlKey: true });
    expect(within(listbox).getAllByRole("option")[1]?.className).toContain("is-active");

    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox", { name: "输入历史" })).toBeNull();
    expect(container.querySelector(".draft-skill .input-label")?.textContent).toBe("alpha");
    expect(field.value).toBe("worktree review");
    expect(field.selectionStart).toBe("worktree review".length);
    expect(field.selectionEnd).toBe("worktree review".length);

    // Tab 同样回填并关闭列表，不发送
    field.setSelectionRange(0, 0);
    fireEvent.keyDown(field, { key: "Backspace" });
    fireEvent.change(field, { target: { value: "first" } });
    fireEvent.keyDown(field, { key: "r", ctrlKey: true });
    fireEvent.keyDown(field, { key: "Tab" });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox", { name: "输入历史" })).toBeNull();
    expect(field.value).toBe("first worktree cmd");
    expect(field.selectionStart).toBe("first worktree cmd".length);
  });

  it("Esc 关闭历史列表并保留当前搜索文字；无匹配时显示空状态且 Enter/↑ 不误触发发送或翻历史", async () => {
    const onSubmit = vi.fn(async () => true);
    const readInputHistory = vi.fn(async () => ["已有历史"]);
    render(<Composer {...props({ historyKey: "hist-3", onSubmit, readInputHistory })} />);
    await waitFor(() => expect(readInputHistory).toHaveBeenCalled());

    const field = input("不会命中");
    fireEvent.keyDown(field, { key: "r", ctrlKey: true });
    const listbox = screen.getByRole("listbox", { name: "输入历史" });
    expect(listbox.querySelector(".composer-popup-note")?.textContent).toBe("没有匹配的历史");

    fireEvent.keyDown(field, { key: "ArrowUp" });
    expect(field.value).toBe("不会命中");
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("listbox", { name: "输入历史" })).toBeTruthy();

    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "输入历史" })).toBeNull();
    expect(field.value).toBe("不会命中");
  });

  it("斜杠命令或 @ 引用列表打开时按 Ctrl+R 切换为历史列表，Esc 不回跳斜杠列表", async () => {
    const onSlash = vi.fn(async () => true);
    const readInputHistory = vi.fn(async () => ["/compact 之前", "检查 @main"]);
    render(
      <Composer
        {...props({
          historyKey: "hist-4",
          onSlash,
          readInputHistory,
          fileRefs: { key: 1, load: async () => INDEX },
        })}
      />,
    );
    await waitFor(() => expect(readInputHistory).toHaveBeenCalled());

    const field = input("/co");
    expect(await screen.findByRole("listbox", { name: "斜杠命令补全" })).toBeTruthy();

    fireEvent.keyDown(field, { key: "r", ctrlKey: true });
    expect(screen.queryByRole("listbox", { name: "斜杠命令补全" })).toBeNull();
    const histList = screen.getByRole("listbox", { name: "输入历史" });
    expect(within(histList).getAllByRole("option")[0]?.textContent).toBe("/compact 之前");

    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(field.value).toBe("/co");

    fireEvent.change(field, { target: { value: "@main" } });
    field.setSelectionRange(5, 5);
    expect(await screen.findByRole("listbox", { name: "文件引用补全" })).toBeTruthy();
    fireEvent.keyDown(field, { key: "r", ctrlKey: true });
    expect(screen.queryByRole("listbox", { name: "文件引用补全" })).toBeNull();
    const histList2 = screen.getByRole("listbox", { name: "输入历史" });
    expect(within(histList2).getAllByRole("option")[0]?.textContent).toBe("检查 @main");
  });

  it("焦点在 .xterm 时 Composer 不打开历史且全局不接管 Ctrl+R", async () => {
    const readInputHistory = vi.fn(async () => ["之前命令"]);
    render(
      <div>
        <Composer {...props({ historyKey: "hist-5", readInputHistory })} />
        <div className="xterm">
          <textarea aria-label="终端焦点" />
        </div>
      </div>,
    );
    await waitFor(() => expect(readInputHistory).toHaveBeenCalled());

    const termField = screen.getByLabelText<HTMLTextAreaElement>("终端焦点");
    termField.focus();
    const ev = createEvent.keyDown(termField, {
      key: "r",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(termField, ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(screen.queryByRole("listbox", { name: "输入历史" })).toBeNull();
    expect(
      shouldBlockGlobalRefresh(
        new KeyboardEvent("keydown", { key: "r", ctrlKey: true, cancelable: true }),
        false,
      ),
    ).toBe(false);
  });
});

it("组字结束后再输入，光标不被拉回组字结束处", () => {
  render(<Composer {...props()} />);
  const field = screen.getByLabelText<HTMLTextAreaElement>("消息输入");
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (!setter) throw new Error("缺少 value setter");
  const type = (value: string, caret: number) => {
    setter.call(field, value);
    field.setSelectionRange(caret, caret);
    fireEvent.input(field);
  };
  fireEvent.compositionStart(field);
  type("你好", 2);
  fireEvent.compositionEnd(field);
  fireEvent.compositionStart(field);
  type("你好t", 3);
  expect(field.selectionStart).toBe(3);
  fireEvent.compositionEnd(field);
  field.setSelectionRange(0, 0);
  fireEvent.select(field);
  type("x你好t", 1);
  expect(field.selectionStart).toBe(1);
});
