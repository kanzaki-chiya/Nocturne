import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Composer, type ComposerProps } from "../src/Composer";
import type { FileIndexEntry } from "../src/file-refs";
import type { PickedImage } from "../src/picked-images";

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
    fileRefsUnavailable: "普通对话没有项目文件",
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
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "中断" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "中断" }));
    expect(onInterrupt).toHaveBeenCalledTimes(2);
    expect(field.value).toBe("下一条草稿");
    await act(async () => {
      await Promise.resolve();
    });
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
    fireEvent.click(screen.getByRole("button", { name: "添加图片或引用文件" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /添加图片/ }));
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
  it("/ 弹层按「命令」组列出 /compact 与 /mcp，Tab 补全不发送", async () => {
    const onSubmit = vi.fn();
    render(<Composer {...props({ onSubmit })} />);
    const field = input("/");
    const menu = await screen.findByRole("listbox", { name: "斜杠命令补全" });
    expect(menu.textContent).toContain("命令");
    const items = screen.getAllByRole("option");
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining("/compact"),
      expect.stringContaining("/mcp"),
    ]);
    fireEvent.keyDown(field, { key: "Tab" });
    expect(field.value).toBe("/compact ");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
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
      expect(screen.getByRole("status").textContent).toContain("服务商页面在后续版本提供"),
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

describe("Composer 控件与附件", () => {
  it("模型 chip 菜单选择调用 onSelect；档位与预设同样经 chip", async () => {
    const controls = props().controls;
    if (controls === undefined) throw new Error("fixture 缺少 controls");
    render(<Composer {...props({ controls })} />);
    fireEvent.click(screen.getByRole("button", { name: "切换模型" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /fancy/ }));
    expect(controls.model.onSelect).toHaveBeenCalledWith("test/fancy");
    fireEvent.click(screen.getByRole("button", { name: "切换思考档位" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "high" }));
    expect(controls.effort.onSelect).toHaveBeenCalledWith("high");
    fireEvent.click(screen.getByRole("button", { name: "切换权限预设" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "smart" }));
    expect(controls.preset.onSelect).toHaveBeenCalledWith("smart");
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
    fireEvent.click(screen.getByRole("button", { name: "添加图片或引用文件" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /添加图片/ }));
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

  it("拖入非图片文件给出错误；图片附件存在时展示 visionHint", async () => {
    const getVisionHint = vi.fn(async () => "当前模型不支持图片，将由 test/desc 描述后发送");
    render(<Composer {...props({ getVisionHint })} />);
    const field = input("");
    fireEvent.drop(field, { dataTransfer: { files: [file("a.txt", "text/plain")] } });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("只能拖入图片"));
    fireEvent.paste(field, {
      clipboardData: {
        items: [{ kind: "file", type: "image/png", getAsFile: () => file("a.png", "image/png") }],
      },
    });
    await waitFor(() => expect(getVisionHint).toHaveBeenCalled());
    await screen.findByText(/test\/desc 描述后发送/);
  });

  it("session 变体：单行布局无 chip/无 tray，提示与附件仍工作", async () => {
    const getVisionHint = vi.fn(async () => "当前模型不支持图片，将由 test/desc 描述后发送");
    render(
      <Composer
        {...props({ variant: "session", controls: undefined, workspace: undefined, getVisionHint })}
      />,
    );
    expect(screen.queryByRole("button", { name: "切换模型" })).toBeNull();
    expect(screen.queryByRole("button", { name: "切换思考档位" })).toBeNull();
    expect(screen.queryByRole("button", { name: "切换权限预设" })).toBeNull();
    expect(screen.queryByRole("button", { name: "切换目录" })).toBeNull();
    const field = screen.getByLabelText<HTMLTextAreaElement>("消息输入");
    expect(screen.getByRole("button", { name: "添加图片或引用文件" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "发送" })).toBeTruthy();
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

  it("session 变体运行中 placeholder 为中断提示", () => {
    render(
      <Composer
        {...props({ variant: "session", controls: undefined, workspace: undefined, running: true })}
      />,
    );
    const field = screen.getByLabelText<HTMLTextAreaElement>("消息输入");
    expect(field.placeholder).toBe("继续输入，Esc 中断");
    expect(screen.getByRole("button", { name: "中断" })).toBeTruthy();
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

  it("fileRefs 为 null 时 @ 不弹层，＋ 菜单的引用文件禁用并带原因", async () => {
    render(<Composer {...props({ fileRefs: null })} />);
    input("看 @ma");
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "添加图片或引用文件" }));
    const item = screen.getByRole("menuitem", { name: /引用文件/ });
    expect((item as HTMLButtonElement).disabled).toBe(true);
    expect(item.getAttribute("title")).toBe("普通对话没有项目文件");
  });

  it("＋→引用文件 在光标处插入 @ 并打开弹层", async () => {
    const fileRefs = { load: vi.fn(async () => INDEX), key: 0 };
    render(<Composer {...props({ fileRefs })} />);
    const field = input("hi");
    field.setSelectionRange(2, 2);
    fireEvent.click(screen.getByRole("button", { name: "添加图片或引用文件" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /引用文件/ }));
    expect(field.value).toBe("hi @");
    expect(await screen.findByRole("listbox", { name: "文件引用补全" })).toBeTruthy();
  });
});
