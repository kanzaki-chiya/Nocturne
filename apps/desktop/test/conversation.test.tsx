import { webcrypto } from "node:crypto";
import type { ReadAttachmentResult } from "@nocturne/core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  createSessionView,
  type AssistantEntry,
  type ImageAttachment,
  type PendingPermission,
  type PendingQuestion,
  type PermissionOption,
  type PermissionReply,
  type RuntimeEvent,
  type SessionView,
  type ToolEntry,
  type TurnEndReason,
} from "@nocturne/core/protocol";
import type { RpcSession } from "@nocturne/rpc/client";

import { Conversation, type ConversationProps, type FileLinkHooks } from "../src/Conversation";
import { createAttachmentImageSource } from "../src/attachment-images";

const imageData = new Uint8Array([1, 2, 3]);
const historyImage: ImageAttachment = {
  type: "image",
  file: "history.png",
  label: "历史截图",
  mimeType: "image/png",
  bytes: 3,
  sha256: "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
  source: "paste",
};

const visibilityObservers: {
  callback: IntersectionObserverCallback;
  root: Element | Document | null;
  observe: Mock;
  disconnect: Mock;
}[] = [];

beforeEach(() => {
  visibilityObservers.length = 0;
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal(
    "URL",
    class extends URL {
      static override createObjectURL = vi.fn(() => "blob:history");
      static override revokeObjectURL = vi.fn();
    },
  );
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe = vi.fn();
      disconnect = vi.fn();
      constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit) {
        visibilityObservers.push({
          callback,
          root: options.root ?? null,
          observe: this.observe,
          disconnect: this.disconnect,
        });
      }
    },
  );
});

function enterViewport(index = 0, isIntersecting = true) {
  const observer = visibilityObservers[index];
  if (!observer) throw new Error("缺少图片可视区观察器");
  act(() => {
    observer.callback(
      [{ isIntersecting } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
  });
}

function imageView(attachments = [historyImage]) {
  const view = createSessionView();
  view.entries = [
    {
      kind: "user",
      key: "history-user",
      seq: 1,
      turnId: "history-turn",
      content: [{ type: "text", text: "看图" }],
      attachments,
    },
  ];
  return view;
}

it("用户技能小标签使用日志快照，展开正文，工具行显示已加载", () => {
  const view = createSessionView();
  const loaded = tool({ name: "skill", input: { name: "alpha" } });
  if (!loaded.result) throw new Error("fixture 缺少结果");
  loaded.result.output = { name: "alpha" };
  loaded.result.modelContent = "技能 alpha 已加载";
  view.entries = [
    {
      kind: "user",
      key: "skill-user",
      seq: 1,
      turnId: "t",
      content: [
        { type: "text", text: "/alpha file" },
        { type: "text", text: '<skill name="alpha">快照正文</skill>' },
      ],
      skill: { name: "alpha", body: "快照正文" },
      attachments: [],
    },
    loaded,
  ];
  const rendered = mount(view);
  expect(screen.getByText("/alpha file")).toBeTruthy();
  const summary = rendered.container.querySelector(".skill-message summary");
  expect(summary?.textContent).toBe("技能 alpha · 已附加正文 4 字");
  if (!summary) throw new Error("缺少技能标签");
  fireEvent.click(summary);
  expect(rendered.container.querySelector(".skill-message pre")?.textContent).toBe("快照正文");
  expect(screen.getByText("已加载")).toBeTruthy();
});

it("任务清单成功工具行显示快照、进度与全部完成或清空，不显示 JSON", () => {
  const view = createSessionView();
  const entry = tool({ name: "todo_write", input: { items: [] } });
  if (!entry.result) throw new Error("fixture 缺少结果");
  entry.result.output = {
    items: [
      { text: "第一项", status: "completed" },
      { text: "正在做", status: "in_progress" },
      { text: "待办", status: "pending" },
    ],
  };
  view.entries = [entry];
  const rendered = mount(view);
  expect(screen.getByText("任务清单")).toBeTruthy();
  expect(screen.getByText("1/3 · 正在：正在做")).toBeTruthy();
  expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("1");
  fireEvent.click(screen.getByLabelText("工具详细信息"));
  expect(screen.getAllByRole("listitem")).toHaveLength(3);
  expect(rendered.container.querySelector(".todo-in_progress .todo-text")?.textContent).toBe(
    "正在做",
  );
  expect(screen.queryByRole("button", { name: "详情" })).toBeNull();
  entry.result.output = { items: [{ text: "第一项", status: "completed" }] };
  view.revision++;
  rendered.rerender(<Conversation view={view} {...conversationProps(rendered)} />);
  expect(screen.getByText("1/1 · 全部完成").className).toContain("todo-complete");
  entry.result.output = { items: [] };
  view.revision++;
  rendered.rerender(<Conversation view={view} {...conversationProps(rendered)} />);
  expect(screen.getByText("清空任务清单")).toBeTruthy();
});

it("失败的任务清单工具沿用普通错误与详情", () => {
  const view = createSessionView();
  view.entries = [{ ...failedTool("invalid_input", "清单无效"), name: "todo_write" }];
  mount(view);
  fireEvent.click(screen.getByLabelText("工具详细信息"));
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(screen.getByRole("button", { name: "详情" })).toBeTruthy();
});

it("委派标签显示日志快照而不把模型指令重复放进用户气泡", () => {
  const view = createSessionView();
  view.entries = [
    {
      kind: "user",
      key: "delegate-user",
      seq: 1,
      turnId: "t",
      content: [
        { type: "text", text: "/omp 原始任务" },
        { type: "text", text: "给模型的委派指令" },
      ],
      delegate: { agent: "omp", task: "原始任务" },
    },
  ];
  const rendered = mount(view);
  expect(screen.getByText("/omp 原始任务")).toBeDefined();
  expect(screen.queryByText("给模型的委派指令")).toBeNull();
  const summary = rendered.container.querySelector(".skill-message summary");
  expect(summary?.textContent).toBe("委派给外部 agent omp");
  expect(rendered.container.querySelector(".skill-message pre")?.textContent).toBe("原始任务");
});

function sessionFixture(id = "session-1") {
  const methods = {
    id,
    respondPermission: vi
      .fn<(requestId: string, reply: PermissionReply) => Promise<void>>()
      .mockResolvedValue(undefined),
    respondQuestion: vi.fn<RpcSession["respondQuestion"]>().mockResolvedValue(undefined),
    readAttachment: vi
      .fn<RpcSession["readAttachment"]>()
      .mockRejectedValue(new Error("附件文件缺失")),
    resolveFiles: vi.fn<RpcSession["resolveFiles"]>().mockResolvedValue([]),
    interrupt: vi.fn(),
  };
  // Conversation only consumes these RPC methods; fail visibly if its boundary grows.
  const session = methods as unknown as RpcSession;
  return { session, methods };
}

function permission(overrides: Partial<PendingPermission> = {}): PendingPermission {
  return {
    requestId: "permission-1",
    callId: "call-1",
    toolName: "write",
    subjects: [{ kind: "edit", target: "Z:/project/file.ts", detail: "修改配置" }],
    reason: "需要写入文件",
    options: ["allow_once", "allow_session", "allow_project", "deny", "deny_stop"],
    ...overrides,
  };
}

function question(overrides: Partial<PendingQuestion> = {}): PendingQuestion {
  return {
    requestId: "question-1",
    callId: "ask-1",
    questions: [
      {
        header: "存储",
        question: "选择数据库",
        options: [{ label: "SQLite", description: "本地文件" }, { label: "PostgreSQL" }],
      },
      { question: "选择功能", multiSelect: true, options: [{ label: "缓存" }, { label: "搜索" }] },
      { question: "补充说明" },
    ],
    ...overrides,
  };
}

function assistant(overrides: Partial<AssistantEntry> = {}): AssistantEntry {
  return {
    kind: "assistant",
    key: "assistant-1",
    seq: 2,
    turnId: "turn-1",
    messageId: "message-1",
    time: "2026-10-08T02:00:00.000Z",
    text: "**完成**",
    reasoning: "先检查文件",
    toolCalls: [],
    model: { provider: "test", model: "model" },
    usage: undefined,
    finishReason: "stop",
    ...overrides,
  };
}

function tool(overrides: Partial<ToolEntry> = {}): ToolEntry {
  return {
    kind: "tool",
    key: "tool-1",
    seq: 3,
    turnId: "turn-1",
    callId: "call-1",
    name: "edit",
    status: "ok",
    input: { path: "file.ts", old_string: "old", new_string: "new" },
    subjects: [],
    permission: undefined,
    resolution: undefined,
    liveOutput: "",
    result: {
      status: "ok",
      modelContent: "已修改 file.ts",
      output: { path: "file.ts", diff: "@@ -1,2 +1,2 @@\n-old\n+new\n keep" },
      error: undefined,
      truncated: false,
      spillPath: undefined,
      durationMs: 12,
    },
    ...overrides,
  };
}

function failedTool(code: string, message: string): ToolEntry {
  const entry = tool({ status: "error" });
  if (!entry.result) throw new Error("fixture 缺少结果");
  entry.result.status = "error";
  entry.result.output = undefined;
  entry.result.modelContent = message;
  entry.result.error = { code, message };
  return entry;
}

function conversationProps(rendered: { session: RpcSession; openUrl: (url: string) => void }) {
  return {
    session: rendered.session,
    openUrl: rendered.openUrl,
    cwd: "Z:/project",
    subscribeEvents: () => () => undefined,
    images: createAttachmentImageSource(),
    busy: false,
    onResubmit: vi.fn(async () => undefined),
  };
}

function mount(
  view: SessionView = createSessionView(),
  overrides: Partial<
    Pick<ConversationProps, "cwd" | "subscribeEvents" | "images" | "fileLinks">
  > & { resolveFilesImpl?: RpcSession["resolveFiles"] } = {},
) {
  const { session, methods } = sessionFixture();
  if (overrides.resolveFilesImpl !== undefined) {
    methods.resolveFiles.mockImplementation(overrides.resolveFilesImpl);
  }
  const openUrl = vi.fn();
  const rendered = { session, openUrl };
  const { resolveFilesImpl: _ignored, ...props } = overrides;
  void _ignored;
  return {
    ...render(<Conversation view={view} {...conversationProps(rendered)} {...props} />),
    session,
    methods,
    openUrl,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("回复与代码复制", () => {
  function clipboard() {
    const writeText = vi.fn(async (_text: string) => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    return writeText;
  }

  it("两段文字夹工具调用，只在最后一段显示操作栏并只复制该段 Markdown 原文", async () => {
    const writeText = clipboard();
    const view = createSessionView();
    view.entries = [
      assistant({ text: "**第一段**", finishReason: "tool_calls" }),
      tool(),
      assistant({ key: "a2", messageId: "m2", text: "第二段 `原文`" }),
    ];
    mount(view);
    expect(screen.getAllByRole("group", { name: "回复操作" })).toHaveLength(1);
    const copy = screen.getByRole("button", { name: "复制回复" });
    fireEvent.click(copy);
    await waitFor(() => expect(copy.textContent).toBe("已复制"));
    expect(writeText).toHaveBeenCalledWith("第二段 `原文`");
    expect(copy.closest("article")?.textContent).toContain("第二段");
  });

  it("当前轮生成中不显示操作栏，中断后复制已有部分", async () => {
    const writeText = clipboard();
    const view = createSessionView();
    view.entries = [
      assistant({ text: "先检查", finishReason: "tool_calls" }),
      tool(),
      assistant({ key: "a2", messageId: "m2", text: "部分回答", finishReason: "aborted" }),
    ];
    view.currentTurn = { turnId: "turn-1", turnIndex: 1 };
    const rendered = mount(view);
    expect(screen.queryByRole("group", { name: "回复操作" })).toBeNull();
    view.currentTurn = undefined;
    rendered.rerender(<Conversation view={view} {...conversationProps(rendered)} />);
    fireEvent.click(screen.getByRole("button", { name: "复制回复" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("部分回答"));
  });

  it.each(["ts", ""])("代码块复制原文（语言 %s）", async (language) => {
    const writeText = clipboard();
    const code = "  const value = '<tag>';\n\n// 原文";
    const view = createSessionView();
    view.entries = [assistant({ text: `\`\`\`${language}\n${code}\n\`\`\`` })];
    mount(view);
    fireEvent.click(screen.getByRole("button", { name: "复制代码" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(code));
  });

  it("复制失败提示沿用用户消息文案", async () => {
    const writeText = clipboard();
    writeText.mockRejectedValueOnce(new Error("denied"));
    const view = createSessionView();
    view.entries = [assistant()];
    mount(view);
    fireEvent.click(screen.getByRole("button", { name: "复制回复" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "复制失败");
  });
});

describe("Conversation 历史图片", () => {
  it("用户气泡进入消息滚动区才读取；加载中占位，成功显示缩略图", async () => {
    const images = createAttachmentImageSource();
    const rendered = mount(imageView(), { images });
    let finish!: (result: ReadAttachmentResult) => void;
    rendered.methods.readAttachment.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    expect(visibilityObservers[0]?.root).toBe(screen.getByRole("region", { name: "会话消息" }));
    expect(visibilityObservers[0]?.observe).toHaveBeenCalledWith(
      rendered.container.querySelector(".u-bubble"),
    );
    expect(rendered.methods.readAttachment).not.toHaveBeenCalled();
    enterViewport(0, false);
    expect(rendered.methods.readAttachment).not.toHaveBeenCalled();
    enterViewport();
    expect(rendered.methods.readAttachment).toHaveBeenCalledExactlyOnceWith("history.png");
    expect(rendered.container.querySelector(".u-img-placeholder")?.getAttribute("aria-busy")).toBe(
      "true",
    );
    expect(screen.queryByRole("img")).toBeNull();
    await act(async () => {
      finish({ data: imageData, mimeType: "image/png", bytes: 3 });
    });
    const image = await screen.findByRole("img", { name: "历史截图" });
    expect(image.getAttribute("src")).toBe("blob:history");
    expect(rendered.container.querySelector(".u-img-placeholder")).toBeNull();
    expect(visibilityObservers[0]?.disconnect).toHaveBeenCalled();
    images.dispose();
  });

  it("可视区内命中发送字节的 sha256 缓存，不调用 RPC", async () => {
    const images = createAttachmentImageSource();
    const url = await images.register(imageData, "image/png");
    const rendered = mount(imageView(), { images });
    expect(screen.queryByRole("img")).toBeNull();
    enterViewport();
    expect((await screen.findByRole("img")).getAttribute("src")).toBe(url);
    expect(rendered.methods.readAttachment).not.toHaveBeenCalled();
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    images.dispose();
  });

  it("重复图片的并发请求按 sha256 合并", async () => {
    const images = createAttachmentImageSource();
    const rendered = mount(imageView([historyImage, { ...historyImage, file: "copy.png" }]), {
      images,
    });
    rendered.methods.readAttachment.mockResolvedValue({
      data: imageData,
      mimeType: "image/png",
      bytes: 3,
    });
    enterViewport();
    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(2));
    expect(rendered.methods.readAttachment).toHaveBeenCalledTimes(1);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    images.dispose();
  });

  it.each(["附件文件缺失：history.png", "附件完整性校验失败：history.png", "连接已断开"])(
    "读取失败退回 filename chip，title 保留具体原因：%s",
    async (reason) => {
      const rendered = mount(imageView());
      rendered.methods.readAttachment.mockRejectedValue(new Error(reason));
      enterViewport();
      await waitFor(() => {
        const chip = rendered.container.querySelector(".u-img-chip");
        expect(chip?.textContent).toBe("history.png");
        expect(chip?.getAttribute("title")).toBe(`图片加载失败：${reason}`);
      });
      expect(screen.queryByRole("img")).toBeNull();
      expect(rendered.container.querySelector(".u-img-placeholder")).toBeNull();
    },
  );

  it("图片解码或显示失败也回退 chip，不留下破损图片", async () => {
    const images = createAttachmentImageSource();
    await images.register(imageData, "image/png");
    const rendered = mount(imageView(), { images });
    enterViewport();
    fireEvent.error(await screen.findByRole("img"));
    const chip = rendered.container.querySelector(".u-img-chip");
    expect(chip?.textContent).toBe("history.png");
    expect(chip?.getAttribute("title")).toBe("图片加载失败：图片无法解码或显示");
    expect(screen.queryByRole("img")).toBeNull();
    images.dispose();
  });

  it("工具图片只显示 chip，即便缓存命中也不读取或显示缩略图", async () => {
    const images = createAttachmentImageSource();
    await images.register(imageData, "image/png");
    const entry = tool({ name: "read", input: { path: "history.png" } });
    if (!entry.result) throw new Error("工具 fixture 缺少结果");
    entry.result.attachments = [historyImage];
    entry.result.output = undefined;
    const view = createSessionView();
    view.entries = [entry];
    const rendered = mount(view, { images });
    expect(rendered.container.querySelector(".u-img-chip")).toBeNull();
    fireEvent.click(screen.getByLabelText("工具详细信息"));
    expect(rendered.container.querySelector(".u-img-chip")?.textContent).toBe("历史截图");
    expect(screen.queryByRole("img")).toBeNull();
    expect(visibilityObservers).toHaveLength(0);
    expect(rendered.methods.readAttachment).not.toHaveBeenCalled();
    images.dispose();
  });

  it("卸载断开观察器；旧请求完成后不更新新会话", async () => {
    const images = createAttachmentImageSource();
    const rendered = mount(imageView(), { images });
    let finish!: (result: ReadAttachmentResult) => void;
    rendered.methods.readAttachment.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    enterViewport();
    const next = sessionFixture("next-session");
    rendered.rerender(
      <Conversation
        view={createSessionView()}
        {...conversationProps({ session: next.session, openUrl: rendered.openUrl })}
        images={images}
      />,
    );
    expect(visibilityObservers[0]?.disconnect).toHaveBeenCalled();
    await act(async () => {
      finish({ data: imageData, mimeType: "image/png", bytes: 3 });
    });
    await waitFor(() => expect(images.url(historyImage)).toBe("blob:history"));
    expect(screen.queryByRole("img")).toBeNull();
    expect(rendered.container.querySelector(".u-img-chip")).toBeNull();
    images.dispose();
  });

  it("未进入可视区便卸载，不因旧观察器回调读取附件", () => {
    const rendered = mount(imageView());
    rendered.unmount();
    enterViewport();
    expect(rendered.methods.readAttachment).not.toHaveBeenCalled();
    expect(visibilityObservers[0]?.disconnect).toHaveBeenCalled();
  });
});

describe("Conversation 权限卡片", () => {
  const choices: [PermissionOption, string, PermissionReply][] = [
    ["allow_once", "允许一次", { decision: "allow" }],
    ["allow_session", "本会话允许", { decision: "allow", remember: "session" }],
    ["allow_project", "本项目允许", { decision: "allow", remember: "project" }],
    ["deny_stop", "拒绝并停止", { decision: "deny", stop: true }],
  ];
  it.each(choices)(
    "%s 原样回传 requestId 与 reply，不在客户端结算",
    async (_option, label, expected) => {
      const view = createSessionView();
      view.pendingPermission = permission();
      const { methods } = mount(view);
      fireEvent.click(screen.getByRole("button", { name: label }));
      await waitFor(() =>
        expect(methods.respondPermission).toHaveBeenCalledWith("permission-1", expected),
      );
      expect(methods.respondPermission).toHaveBeenCalledTimes(1);
      expect(methods.interrupt).not.toHaveBeenCalled();
      expect(view.pendingPermission?.requestId).toBe("permission-1");
      expect(screen.getByRole("region", { name: "权限确认" })).toBeTruthy();
      expect(screen.getByRole("button", { name: label }).hasAttribute("disabled")).toBe(true);
    },
  );

  it.each(["", "  不要修改配置  "])("拒绝反馈 %j 回传 deny 且裁掉首尾空白", async (feedback) => {
    const view = createSessionView();
    view.pendingPermission = permission();
    const { methods } = mount(view);
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    expect(methods.respondPermission).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox", { name: "拒绝反馈（可选）" }), {
      target: { value: feedback },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送拒绝" }));
    const text = feedback.trim();
    await waitFor(() =>
      expect(methods.respondPermission).toHaveBeenCalledWith("permission-1", {
        decision: "deny",
        ...(text ? { feedback: text } : {}),
      }),
    );
    expect(methods.interrupt).not.toHaveBeenCalled();
    expect(view.pendingPermission).toBeDefined();
  });

  it("只展示后台提供的选项；空列表遵循 TUI 的一次允许/拒绝", () => {
    const view = createSessionView();
    view.pendingPermission = permission({ options: ["allow_once", "deny"] });
    const rendered = mount(view);
    expect(screen.queryByRole("button", { name: "本会话允许" })).toBeNull();
    expect(screen.queryByRole("button", { name: "本项目允许" })).toBeNull();
    expect(screen.queryByRole("button", { name: "拒绝并停止" })).toBeNull();
    view.pendingPermission = permission({ requestId: "permission-2", options: [] });
    rendered.rerender(<Conversation view={view} {...conversationProps(rendered)} />);
    expect(screen.getByRole("button", { name: "允许一次" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "拒绝" })).toBeTruthy();
  });

  it("网络授权标题沿用 TUI，反馈 Esc 返回而不发送", () => {
    const view = createSessionView();
    view.pendingPermission = permission({ subjects: [{ kind: "network", target: "example.com" }] });
    const { methods } = mount(view);
    expect(screen.getByRole("button", { name: "本会话允许访问 example.com" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(screen.getByRole("button", { name: "允许一次" })).toBeTruthy();
    expect(methods.respondPermission).not.toHaveBeenCalled();
  });

  it("失败保留请求并允许重试，后台换请求后重置卡片锁", async () => {
    const view = createSessionView();
    view.pendingPermission = permission();
    const rendered = mount(view);
    rendered.methods.respondPermission.mockRejectedValueOnce(new Error("请求仍在等待"));
    fireEvent.click(screen.getByRole("button", { name: "允许一次" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "发送失败：请求仍在等待",
    );
    expect(view.pendingPermission).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "允许一次" }));
    await waitFor(() => expect(rendered.methods.respondPermission).toHaveBeenCalledTimes(2));
    view.pendingPermission = permission({ requestId: "permission-next" });
    rendered.rerender(<Conversation view={view} {...conversationProps(rendered)} />);
    fireEvent.click(screen.getByRole("button", { name: "允许一次" }));
    await waitFor(() =>
      expect(rendered.methods.respondPermission).toHaveBeenLastCalledWith("permission-next", {
        decision: "allow",
      }),
    );
  });

  it("提交中的重复点击只产生一次 RPC", async () => {
    const view = createSessionView();
    view.pendingPermission = permission();
    const rendered = mount(view);
    let resolve!: () => void;
    rendered.methods.respondPermission.mockImplementation(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const button = screen.getByRole("button", { name: "允许一次" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(rendered.methods.respondPermission).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve();
    });
  });
});

describe("Conversation 提问卡片", () => {
  it("按题目顺序回传单选、多选+其他、自由文本，没有权限操作", async () => {
    const view = createSessionView();
    view.pendingQuestion = question();
    const { methods } = mount(view);
    fireEvent.click(screen.getByRole("radio", { name: /SQLite/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "缓存" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "搜索" }));
    fireEvent.change(screen.getByRole("textbox", { name: "选择功能 · 其他" }), {
      target: { value: "  导出  " },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "补充说明 · 回答" }), {
      target: { value: "  必须离线  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交回答" }));
    await waitFor(() =>
      expect(methods.respondQuestion).toHaveBeenCalledWith("question-1", {
        answers: [
          { selected: ["SQLite"] },
          { selected: ["缓存", "搜索"], text: "导出" },
          { selected: [], text: "必须离线" },
        ],
      }),
    );
    expect(methods.respondPermission).not.toHaveBeenCalled();
    expect(methods.interrupt).not.toHaveBeenCalled();
    expect(view.pendingQuestion).toBeDefined();
  });

  it("单选的其他文字清掉选项，逐题拒绝只回传 declined", async () => {
    const view = createSessionView();
    view.pendingQuestion = question();
    const { methods } = mount(view);
    fireEvent.click(screen.getByRole("radio", { name: /SQLite/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "选择数据库 · 其他" }), {
      target: { value: "自建" },
    });
    const groups = screen.getAllByRole("group");
    const group = groups[1];
    if (group === undefined) throw new Error("缺少第二个问题");
    fireEvent.click(within(group).getByRole("checkbox", { name: "缓存" }));
    fireEvent.click(within(group).getByRole("checkbox", { name: "拒绝回答" }));
    fireEvent.click(screen.getByRole("button", { name: "提交回答" }));
    await waitFor(() =>
      expect(methods.respondQuestion).toHaveBeenCalledWith("question-1", {
        answers: [{ selected: [], text: "自建" }, { declined: true }, { selected: [] }],
      }),
    );
  });

  it("自由文本按 Unicode 字符限制为 2000；不在前端拒绝空答案", async () => {
    const view = createSessionView();
    view.pendingQuestion = question({ questions: [{ question: "说明" }] });
    const { methods } = mount(view);
    fireEvent.change(screen.getByRole("textbox", { name: "说明 · 回答" }), {
      target: { value: "😀".repeat(2001) },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交回答" }));
    await waitFor(() =>
      expect(methods.respondQuestion).toHaveBeenCalledWith("question-1", {
        answers: [{ selected: [], text: "😀".repeat(2000) }],
      }),
    );
  });

  it("请求失败显示服务端错误，新 requestId 清空旧答案", async () => {
    const view = createSessionView();
    view.pendingQuestion = question({ questions: [{ question: "说明" }] });
    const rendered = mount(view);
    rendered.methods.respondQuestion.mockRejectedValueOnce(new Error("invalid_reply"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "旧答案" } });
    fireEvent.click(screen.getByRole("button", { name: "提交回答" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "发送失败：invalid_reply",
    );
    view.pendingQuestion = question({
      requestId: "question-new",
      questions: [{ question: "说明" }],
    });
    rendered.rerender(<Conversation view={view} {...conversationProps(rendered)} />);
    expect(screen.getByRole("textbox")).toHaveProperty("value", "");
    fireEvent.click(screen.getByRole("button", { name: "提交回答" }));
    await waitFor(() =>
      expect(rendered.methods.respondQuestion).toHaveBeenLastCalledWith("question-new", {
        answers: [{ selected: [] }],
      }),
    );
  });
});

describe("Conversation 渲染与滚动", () => {
  it("用户原文、助手 Markdown、折叠思考、通知和工具 diff 均可读", () => {
    const view = createSessionView();
    view.entries = [
      {
        kind: "user",
        key: "user-1",
        seq: 1,
        turnId: "turn-1",
        content: [{ type: "text", text: "**不解析用户 Markdown**" }],
      },
      assistant({
        text: "# 结果\n\n**完成**\n\n| 文件 | 状态 |\n| --- | --- |\n| file.ts | 已修改 |\n\n```ts\nconst n = 1;\n```",
      }),
      tool(),
      {
        kind: "notice",
        key: "notice-1",
        seq: 4,
        subtype: "config",
        message: "模型已切换",
        payload: {},
      },
    ];
    view.notices = [{ level: "warning", code: "provider_warning", message: "响应较慢" }];
    const { container } = mount(view);
    expect(screen.getByText("**不解析用户 Markdown**")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "结果" })).toBeTruthy();
    expect(container.querySelector("strong")?.textContent).toBe("完成");
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getByText("const n = 1;")).toBeTruthy();
    const reasoning = screen.getByRole("button", { name: "思考" });
    expect(reasoning.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("先检查文件")).toBeNull();
    fireEvent.click(reasoning);
    expect(reasoning.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("先检查文件")).toBeTruthy();
    // config 子类不进消息流
    expect(screen.queryByText("模型已切换")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("响应较慢");
    const card = container.querySelector(".diff");
    expect(card?.textContent).toContain("file.ts");
    expect(card?.textContent).toContain("+1");
    expect(card?.textContent).toContain("−1");
    expect({
      action: card?.querySelector(".diff-action")?.textContent,
      path: card?.querySelector(".diff-path")?.textContent,
      added: card?.querySelector(".diff-add")?.textContent,
      deleted: card?.querySelector(".diff-del")?.textContent,
      expanded: card?.querySelector("button")?.getAttribute("aria-expanded"),
      diffRows: card?.querySelectorAll(".diff-row").length,
    }).toMatchInlineSnapshot(`
      {
        "action": "编辑",
        "added": "+1",
        "deleted": "−1",
        "diffRows": 0,
        "expanded": "false",
        "path": "file.ts",
      }
    `);
    expect(container.querySelector(".diff-body")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "展开" }));
    expect(container.querySelector(".diff-row.diff-row-add code")?.textContent).toBe("new");
    expect(container.querySelector(".diff-row.diff-row-delete code")?.textContent).toBe("old");
    expect(container.querySelector(".diff-row.diff-row-delete .diff-num")?.textContent).toBe("1");
  });

  it("原始 HTML、事件属性、脚本、远程图片和不允许的 URL 不产生执行元素", () => {
    const view = createSessionView();
    view.entries = [
      assistant({
        text: '<script>window.pwned = true</script>\n\n<img src="https://track.example/pixel" onerror="alert(1)">\n\n[危险](javascript:alert%281%29) [文件](file:///secret) ![跟踪](https://track.example/pixel)\n\n[站点](https://example.com/)',
      }),
    ];
    const { container, openUrl } = mount(view);
    expect(container.querySelector("script, img, iframe, object, embed")).toBeNull();
    expect(container.querySelector("[onerror], [onclick]")).toBeNull();
    expect(container.textContent).toContain("<script>window.pwned = true</script>");
    expect(container.querySelectorAll("a")).toHaveLength(1);
    expect(openUrl).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("link", { name: "站点" }));
    expect(openUrl).toHaveBeenCalledWith("https://example.com/");
  });

  it("支持逐文件 apply_patch diff 和纯改名标题", () => {
    const view = createSessionView();
    const entry = tool();
    if (!entry.result) throw new Error("fixture 缺少结果");
    entry.result.output = {
      files: [
        { path: "a.ts", op: "update", diff: "@@ -1 +1 @@\n-a\n+b" },
        { path: "old.ts", op: "move", movedTo: "new.ts" },
      ],
    };
    view.entries = [entry];
    const { container } = mount(view);
    const cards = container.querySelectorAll(".diff");
    expect(cards).toHaveLength(2);
    expect(cards[0]?.textContent).toContain("a.ts");
    expect(cards[0]?.textContent).toContain("+1");
    expect(cards[1]?.textContent).toContain("old.ts → new.ts");
    expect(cards[1]?.querySelector(".diff-add, .diff-del")).toBeNull();
    expect(container.querySelector(".diff-body")).toBeNull();
  });

  it("diff 只剥一个标记，保留第二字符和缩进，不把 hunk 与换行元信息当正文", () => {
    const view = createSessionView();
    const entry = tool();
    if (!entry.result) throw new Error("fixture 缺少结果");
    entry.result.output = {
      path: "file.ts",
      diff: [
        "diff --git a/file.ts b/file.ts",
        "index abc..def 100644",
        "--- a/file.ts",
        "+++ b/file.ts",
        "@@ -2,3 +2,3 @@",
        "-  old",
        "+  new",
        "   keep",
        "--negative",
        "++positive",
        "\\ No newline at end of file",
        "@@ malformed metadata",
        "@@ -8 +8 @@",
        "-\told",
        "+\tnew",
      ].join("\n"),
    };
    view.entries = [entry];
    const { container } = mount(view);
    fireEvent.click(screen.getByRole("button", { name: "展开" }));
    expect(
      Array.from(container.querySelectorAll(".diff-row code"), (node) => node.textContent),
    ).toEqual(["  old", "  new", "  keep", "-negative", "+positive", "\told", "\tnew"]);
    expect(Array.from(container.querySelectorAll(".diff-num"), (node) => node.textContent)).toEqual(
      ["2", "2", "3", "4", "4", "8", "8"],
    );
    expect(container.querySelectorAll(".diff-sep")).toHaveLength(1);
    expect(container.querySelector(".diff-body")?.textContent).not.toMatch(
      /@@|No newline|diff --git|index abc|a\/file.ts|b\/file.ts/,
    );
    expect(container.querySelector(".diff-h .diff-add")?.textContent).toBe("+3");
    expect(container.querySelector(".diff-h .diff-del")?.textContent).toBe("−3");
    const rows = container.querySelectorAll(".diff-row:not(.diff-sep)");
    expect(container.querySelectorAll(".diff-row-add")).toHaveLength(3);
    expect(container.querySelectorAll(".diff-row-delete")).toHaveLength(3);
    const countClasses = Array.from(
      container.querySelectorAll(".diff-h .diff-add, .diff-h .diff-del"),
      (node) => Array.from(node.classList),
    ).flat();
    expect(countClasses).toEqual(["diff-add", "diff-del"]);
    for (const row of rows) {
      for (const countClass of countClasses) {
        expect(row.classList.contains(countClass)).toBe(false);
      }
      expect(Array.from(row.children, (node) => node.className || node.tagName)).toEqual([
        "diff-num",
        "diff-mark",
        "CODE",
      ]);
    }
    expect(container.querySelector(".diff-row-add .diff-mark")?.textContent).toBe("+");
    expect(container.querySelector(".diff-row-delete .diff-mark")?.textContent).toBe("−");
    expect(container.querySelector(".diff-add-row, .diff-delete")).toBeNull();
  });

  it("edit 展开只显示 diff、元信息与默认收起的详情", () => {
    const view = createSessionView();
    const entry = tool({ subjects: [{ kind: "edit", target: "file.ts" }] });
    if (!entry.result) throw new Error("fixture 缺少结果");
    entry.result.modelContent = "Success. Updated the following files: M Z:/project/file.ts";
    entry.result.output = { ...(entry.result.output as object), replaced: 2 };
    view.entries = [entry];
    const { container } = mount(view);
    fireEvent.click(screen.getByRole("button", { name: "展开" }));
    expect(container.querySelector(".diff-body")).not.toBeNull();
    expect(container.querySelector(".conversation-subjects")).toBeNull();
    expect(container.textContent).not.toContain("Success.");
    expect(screen.getByText("2 处替换")).toBeTruthy();
    const toggle = screen.getByRole("button", { name: "详情" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("region", { name: "参数" })).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByRole("region", { name: "参数" }).textContent).toContain("old_string");
    expect(screen.getByRole("region", { name: "结果" }).textContent).toContain("replaced");
  });

  it.each([undefined, "Z:/project/src"])(
    "shell 主体显示完整命令、输出与退出码，目录仅来自 cwd（%s）",
    (cwd) => {
      const view = createSessionView();
      const entry = tool({
        name: "shell",
        input: { command: "echo first\necho second", ...(cwd ? { cwd } : {}) },
      });
      if (!entry.result) throw new Error("fixture 缺少结果");
      entry.result.output = { exitCode: 0 };
      entry.result.modelContent = "first\nsecond";
      view.entries = [entry];
      const { container } = mount(view);
      fireEvent.click(screen.getByLabelText("工具详细信息"));
      expect(container.querySelector(".tool-command")?.textContent).toBe(
        "$ echo first\necho second",
      );
      expect(container.querySelector(".conversation-tool-output")?.textContent).toBe(
        "first\nsecond",
      );
      expect(screen.getByText("退出码 0")).toBeTruthy();
      expect(container.querySelector(".tool-info")?.textContent.includes("目录")).toBe(
        cwd !== undefined,
      );
    },
  );

  it("参数与结果为空不显示详情，普通结果路径相对化", () => {
    const view = createSessionView();
    const entry = tool({ name: "custom", input: {} });
    if (!entry.result) throw new Error("fixture 缺少结果");
    entry.result.output = {};
    entry.result.modelContent = "结果：Z:/project/src/file.ts";
    view.entries = [entry];
    const { container } = mount(view);
    fireEvent.click(screen.getByLabelText("工具详细信息"));
    expect(screen.queryByRole("button", { name: "详情" })).toBeNull();
    expect(container.querySelector(".conversation-tool-output")?.textContent).toBe(
      "结果：src/file.ts",
    );
  });

  it("读取工具默认只有单行摘要，完整输出和主体说明在折叠详情中", () => {
    const view = createSessionView();
    const entry = tool({
      name: "read",
      input: { path: "large.ts" },
      subjects: [{ kind: "read", target: "large.ts", detail: "读取源文件" }],
    });
    if (!entry.result) throw new Error("fixture 缺少结果");
    entry.result.modelContent = "源文件行\n".repeat(300);
    entry.result.output = { path: "large.ts", returnedLines: 300 };
    view.entries = [entry];
    mount(view);
    const article = screen.getByRole("article", { name: "工具 read" });
    const summary = within(article).getByLabelText("工具详细信息");
    expect(summary.textContent).toContain("读取");
    expect(summary.textContent).toContain("large.ts");
    expect(summary.textContent).not.toContain("源文件行");
    expect(summary.closest("details")?.open).toBe(false);
    expect(within(article).queryByText("读取源文件")).toBeNull();
    fireEvent.click(summary);
    expect(summary.closest("details")?.open).toBe(true);
    expect(article.textContent).toContain("源文件行");
  });

  it("live 助手文字/思考、工具参数和运行工具输出随原地 reducer 更新", () => {
    const view = createSessionView();
    view.live.assistants = [
      {
        kind: "assistant",
        messageId: "live-1",
        turnId: "turn-1",
        text: "正在",
        reasoning: "思考增量",
      },
    ];
    view.live.tools = [
      {
        kind: "tool",
        callId: "live-tool",
        name: "shell",
        turnId: "turn-1",
        inputText: '{"command":',
      },
    ];
    view.entries = [tool({ status: "running", result: undefined, liveOutput: "第一行" })];
    const rendered = mount(view);
    expect(screen.queryByLabelText("工具实时输出")).toBeNull();
    expect(rendered.container.querySelector(".tool-live")?.textContent).toBe("第一行");
    expect(screen.getByText('{"command":')).toBeTruthy();
    const assistant = view.live.assistants[0];
    const liveTool = view.live.tools[0];
    if (assistant === undefined || liveTool === undefined) throw new Error("缺少流式条目");
    assistant.text = "正在 **回复**";
    liveTool.inputText += '"pwd"}';
    view.revision += 1;
    rendered.rerender(<Conversation view={view} {...conversationProps(rendered)} />);
    expect(screen.getByText("回复", { selector: "strong" })).toBeTruthy();
    expect(screen.getByText('{"command":"pwd"}')).toBeTruthy();
  });

  it("实时工具默认收起显示最后非空行和秒数，点击展开滚底，完成保持用户选择", () => {
    vi.useFakeTimers();
    try {
      const view = createSessionView();
      const entry = tool({
        name: "shell",
        status: "running",
        result: undefined,
        liveOutput: "第一行\n最后一行\n  \n",
      });
      view.entries = [entry];
      const rendered = mount(view);
      const summary = screen.getByLabelText("工具详细信息");
      expect(summary.getAttribute("aria-expanded")).toBe("false");
      expect(rendered.container.querySelector(".tool-live")?.textContent).toBe("最后一行");
      expect(rendered.container.querySelector(".tool-spin")).not.toBeNull();
      expect(screen.queryByLabelText("工具实时输出")).toBeNull();
      expect(rendered.container.querySelector(".conversation-tool-progress")).toBeNull();
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(rendered.container.querySelector(".tool-secs")?.textContent).toBe("2 秒");
      fireEvent.click(summary);
      const output = screen.getByLabelText("工具实时输出");
      Object.defineProperty(output, "scrollHeight", { value: 250, configurable: true });
      entry.liveOutput += "新输出";
      view.revision += 1;
      rendered.rerender(<Conversation view={view} {...conversationProps(rendered)} />);
      expect(output.scrollTop).toBe(250);
      entry.status = "ok";
      const result = tool().result;
      if (!result) throw new Error("fixture 缺少结果");
      entry.result = { ...result, output: { exitCode: 0 }, modelContent: "完整执行结果" };
      view.revision += 1;
      rendered.rerender(<Conversation view={view} {...conversationProps(rendered)} />);
      expect(summary.closest("details")?.open).toBe(true);
      expect(screen.getByText("完整执行结果")).toBeTruthy();
      expect(screen.queryByLabelText("工具实时输出")).toBeNull();
      expect(rendered.container.querySelector(".tool-spin, .tool-secs")).toBeNull();
      fireEvent.click(summary);
      expect(summary.closest("details")?.open).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("未点击的实时工具完成后仍收起，编辑完成继承运行时展开选择", () => {
    const view = createSessionView();
    const entry = tool({ status: "running", result: undefined, liveOutput: "处理中" });
    view.entries = [entry];
    const rendered = mount(view);
    entry.status = "ok";
    entry.result = tool().result;
    view.revision += 1;
    rendered.rerender(<Conversation view={view} {...conversationProps(rendered)} />);
    expect(rendered.container.querySelector(".diff-body")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "展开" }));
    expect(rendered.container.querySelector(".diff-body")).not.toBeNull();
    cleanup();
    const running = tool({ status: "running", result: undefined, liveOutput: "编辑中" });
    view.entries = [running];
    const opened = mount(view);
    fireEvent.click(screen.getByLabelText("工具详细信息"));
    running.status = "ok";
    running.result = tool().result;
    view.revision += 1;
    opened.rerender(<Conversation view={view} {...conversationProps(opened)} />);
    expect(opened.container.querySelector(".diff-body")).not.toBeNull();
  });

  it("写入只显示新增计数，展开选择在重新渲染后保留", () => {
    const view = createSessionView();
    const entry = tool({ name: "write", input: { path: "new.ts", content: "a\nb\n" } });
    if (!entry.result) throw new Error("fixture 缺少结果");
    entry.result.output = { created: true, path: "new.ts" };
    view.entries = [entry];
    const rendered = mount(view);
    expect(rendered.container.querySelector(".diff-add")?.textContent).toBe("+2");
    expect(rendered.container.querySelector(".diff-del, .diff-body")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "展开" }));
    view.revision += 1;
    rendered.rerender(<Conversation view={view} {...conversationProps(rendered)} />);
    expect(rendered.container.querySelectorAll(".diff-row-add")).toHaveLength(2);
  });

  it("多文件各自收起，路径 key 在结果重排后保持展开选择", () => {
    const view = createSessionView();
    const entry = tool();
    if (!entry.result) throw new Error("fixture 缺少结果");
    const files = [
      { path: "a.ts", diff: "@@ -1 +1 @@\n-a\n+b" },
      { path: "b.ts", diff: "@@ -1 +1 @@\n-c\n+d" },
    ];
    entry.result.output = { files };
    view.entries = [entry];
    const rendered = mount(view);
    expect(rendered.container.querySelectorAll(".diff-body")).toHaveLength(0);
    const first = rendered.container.querySelector(".diff-h");
    if (!first) throw new Error("缺少文件行");
    fireEvent.click(first);
    entry.result.output = { files: [...files].reverse() };
    view.revision += 1;
    rendered.rerender(<Conversation view={view} {...conversationProps(rendered)} />);
    const cards = rendered.container.querySelectorAll(".diff");
    expect(cards[0]?.querySelector(".diff-path")?.textContent).toBe("b.ts");
    expect(cards[0]?.querySelector(".diff-body")).toBeNull();
    expect(cards[1]?.querySelector(".diff-path")?.textContent).toBe("a.ts");
    expect(cards[1]?.querySelector(".diff-body")).not.toBeNull();
  });

  it("运行工具出错后不自动展开，也不收起用户已展开的详情", () => {
    const view = createSessionView();
    const entry = tool({ status: "running", result: undefined, liveOutput: "处理中" });
    view.entries = [entry];
    const rendered = mount(view);
    entry.status = "error";
    entry.result = failedTool("not_read", "请读取文件").result;
    view.revision += 1;
    rendered.rerender(<Conversation view={view} {...conversationProps(rendered)} />);
    const summary = screen.getByLabelText("工具详细信息");
    expect(summary.closest("details")?.open).toBe(false);
    fireEvent.click(summary);
    view.revision += 1;
    rendered.rerender(<Conversation view={view} {...conversationProps(rendered)} />);
    expect(summary.closest("details")?.open).toBe(true);
    expect(screen.getByText("请读取文件")).toBeTruthy();
  });

  it("用户上翻后增量不会拉回；回到底部继续跟随，切会话重置", () => {
    const view = createSessionView();
    view.live.assistants = [
      { kind: "assistant", messageId: "live-1", turnId: "turn-1", text: "第一段", reasoning: "" },
    ];
    const rendered = mount(view);
    const scroll = screen.getByRole("region", { name: "会话消息" });
    let height = 1000;
    let top = 0;
    Object.defineProperties(scroll, {
      scrollHeight: { configurable: true, get: () => height },
      clientHeight: { configurable: true, get: () => 200 },
      scrollTop: {
        configurable: true,
        get: () => top,
        set: (value: number) => {
          top = Math.max(0, Math.min(value, height - 200));
        },
      },
    });
    view.revision += 1;
    rendered.rerender(<Conversation view={view} {...conversationProps(rendered)} />);
    expect(top).toBe(800);
    fireEvent.wheel(scroll, { deltaY: -100 });
    scroll.scrollTop = 300;
    fireEvent.scroll(scroll);
    height = 1300;
    const assistant = view.live.assistants[0];
    if (assistant === undefined) throw new Error("缺少流式回复");
    assistant.text += " 第二段";
    view.revision += 1;
    rendered.rerender(<Conversation view={view} {...conversationProps(rendered)} />);
    expect(top).toBe(300);
    const jump = screen.getByRole("button", { name: "回到最新消息" });
    const jumpRow = jump.parentElement;
    expect(jumpRow?.className).toBe("conversation-jump-row");
    expect(jumpRow?.previousElementSibling).toBe(scroll);
    expect(jumpRow?.parentElement?.className).toBe("conversation");
    expect(scroll.contains(jumpRow)).toBe(false);
    expect(scroll.contains(jump)).toBe(false);
    fireEvent.click(jump);
    expect(top).toBe(1100);
    expect(rendered.container.querySelector(".conversation-jump-row")).toBeNull();
    height = 1500;
    view.revision += 1;
    rendered.rerender(<Conversation view={view} {...conversationProps(rendered)} />);
    expect(top).toBe(1300);
    scroll.scrollTop = 400;
    fireEvent.scroll(scroll);
    expect(screen.getByRole("button", { name: "回到最新消息" })).toBeTruthy();
    scroll.scrollTop = 1300;
    fireEvent.scroll(scroll);
    expect(rendered.container.querySelector(".conversation-jump-row")).toBeNull();
    scroll.scrollTop = 400;
    fireEvent.scroll(scroll);
    const next = sessionFixture("session-2");
    rendered.rerender(
      <Conversation
        view={createSessionView()}
        {...conversationProps({ session: next.session, openUrl: rendered.openUrl })}
      />,
    );
    expect(screen.queryByRole("button", { name: "回到最新消息" })).toBeNull();
    expect(rendered.container.querySelector(".conversation-jump-row")).toBeNull();
  });

  it.each<[boolean, number, string]>([
    [true, 0, "思考"],
    [true, 999, "思考"],
    [true, 1000, "思考中 1s"],
    [true, 2500, "思考中 2s"],
    [false, 0, "思考"],
    [false, 999, "思考"],
    [false, 1000, "思考了 1s"],
    [false, 2500, "思考了 2s"],
  ])("思考 active=%s、%dms 展示 %s", (active, elapsed, label) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const listeners = new Set<(event: RuntimeEvent) => void>();
      const view = createSessionView();
      view.entries = [assistant({ reasoning: "先检查文件" })];
      mount(view, {
        subscribeEvents: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      });
      const emit = (kind: "reasoning" | "text", delta: string) => {
        const event: RuntimeEvent = {
          type: "message.assistant.delta",
          sessionId: "session-1",
          runId: "run-1",
          eseq: kind === "reasoning" ? 1 : 2,
          afterSeq: 1,
          time: new Date().toISOString(),
          turnId: "turn-1",
          payload: { messageId: "message-1", kind, delta },
        };
        for (const listener of listeners) listener(event);
      };
      act(() => {
        emit("reasoning", "先检查文件");
      });
      act(() => {
        vi.advanceTimersByTime(elapsed);
        if (!active) emit("text", "完成");
      });
      const summary = screen.getByText(label, { selector: ".think-label" });
      expect(summary.textContent).toBe(label);
      expect(summary.closest("button")?.getAttribute("aria-expanded")).toBe("false");
      if (!active) {
        act(() => {
          vi.advanceTimersByTime(3000);
        });
        expect(summary.textContent).toBe(label);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Markdown 换行", () => {
  it("段落内单个换行显示为换行：逐行数字不合并成一段", () => {
    const view = createSessionView();
    view.entries = [assistant({ text: "1\n2\n3\n4\n5" })];
    const { container } = mount(view);
    expect(container.querySelector(".conversation-markdown p")?.innerHTML).toBe(
      "1<br>2<br>3<br>4<br>5",
    );
  });

  it("句中软换行变 br，空行仍分段", () => {
    const view = createSessionView();
    view.entries = [assistant({ text: "第一行\n第二行\n\n新段落" })];
    const { container } = mount(view);
    const paragraphs = container.querySelectorAll(".conversation-markdown p");
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]?.innerHTML).toBe("第一行<br>第二行");
    expect(paragraphs[1]?.textContent).toBe("新段落");
  });

  it("代码块与表格不受换行选项影响", () => {
    const view = createSessionView();
    view.entries = [
      assistant({
        text: "```\nline1\nline2\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |",
      }),
    ];
    const { container } = mount(view);
    expect(container.querySelector(".conversation-code pre code")?.textContent).toBe(
      "line1\nline2",
    );
    expect(container.querySelector(".conversation-code br")).toBeNull();
    expect(container.querySelectorAll(".conversation-table th")).toHaveLength(2);
    expect(
      [...container.querySelectorAll(".conversation-table td")].map((cell) => cell.textContent),
    ).toEqual(["1", "2"]);
  });
});

describe("Conversation 工具行与拒绝", () => {
  it("工作区内路径相对化、区外绝对化；10 秒以上才显示时长", () => {
    const view = createSessionView();
    const inside = tool({ name: "edit", input: { path: "Z:/project/src/a.ts" } });
    inside.result = {
      status: "ok",
      modelContent: "",
      output: { path: "Z:/project/src/a.ts", replaced: 2 },
      error: undefined,
      truncated: false,
      spillPath: undefined,
      durationMs: 12_000,
    };
    const outside = tool({ name: "edit", input: { path: "Z:/other/x.ts" } });
    if (outside.result) outside.result.output = { path: "Z:/other/x.ts", replaced: 1 };
    view.entries = [inside, outside];
    const { container } = mount(view);
    const args = Array.from(container.querySelectorAll(".tool-arg")).map(
      (node) => node.textContent,
    );
    expect(args).toEqual(["src/a.ts", "Z:/other/x.ts"]);
    const rows = screen.getAllByRole("article", { name: /工具 edit/ });
    expect(rows[0]?.textContent).toContain("2 处");
    expect(rows[0]?.textContent).toContain("12 秒");
    expect(rows[1]?.textContent).not.toContain("ms");
  });

  it.each<[string, string]>([
    ["not_read", "需先读取文件"],
    ["stale_file", "文件已变化，需重新读取"],
  ])("可恢复守卫错误 %s 行尾淡色显示、无失败字样，原文点击展开", (code, brief) => {
    const message = "拒绝修改文件：Z:/project/src/a.ts。请先读取文件后重试";
    const view = createSessionView();
    view.entries = [failedTool(code, message)];
    const { container } = mount(view);
    const article = screen.getByRole("article", { name: "工具 edit" });
    const details = container.querySelector<HTMLDetailsElement>(".tool-details");
    expect(container.querySelector(".conversation-tool-error")).toBeNull();
    expect(article.querySelector(".tool-res.err")).toBeNull();
    expect(article.querySelector(".tool-res.recoverable")?.textContent).toBe(brief);
    expect(article.textContent).not.toContain("失败");
    expect(details?.querySelector(".conversation-error")).toBeNull();
    expect(details?.open).toBe(false);
    expect(article.textContent).not.toContain(code);
    expect(
      Array.from(article.querySelectorAll("[title]"), (node) => node.getAttribute("title")).join(
        " ",
      ),
    ).not.toContain(code);
    expect(article.querySelector(".tool-details .conversation-tool-output")).toBeNull();
    fireEvent.click(within(article).getByText(brief));
    expect(details?.open).toBe(true);
    expect(details?.querySelector(".conversation-tool-output")?.textContent).toBe(message);
    fireEvent.click(within(article).getByText(brief));
    expect(details?.open).toBe(false);
  });

  it("stale_file 附带 diff 时行尾显示已附上变更（淡色）", () => {
    const message = "文件自上次读取后已被外部修改";
    const modelContent = `${message}\n@@ -1,2 +1,2 @@\n-old\n+new`;
    const entry = failedTool("stale_file", message);
    if (!entry.result) throw new Error("fixture 缺少结果");
    entry.result.modelContent = modelContent;
    const view = createSessionView();
    view.entries = [entry];
    const { container } = mount(view);
    const article = screen.getByRole("article", { name: "工具 edit" });
    expect(article.querySelector(".tool-res.err")).toBeNull();
    expect(article.querySelector(".tool-res.recoverable")?.textContent).toBe(
      "文件已变化，已附上变更",
    );
    expect(container.querySelector(".conversation-tool-error")).toBeNull();
  });

  it.each<[string, string, string]>([
    ["Z:/project", "old 在 Z:/project/src/a.ts 中未出现。请重试", "old 在 src/a.ts 中未出现。"],
    ["Z:/project", "读取 Z:\\PROJECT\\src\\a.ts 失败。请重试", "读取 src/a.ts 失败。"],
    [
      "Z:\\my project\\repo.v2",
      "读取 z:/MY PROJECT/repo.v2/src/a b.ts 失败，耗时 1.25 秒。请重试",
      "读取 src/a b.ts 失败，耗时 1.25 秒。",
    ],
    [
      "/workspace/project",
      "Failed to read /workspace/project/src/a.ts after 1.25 seconds. Try again.",
      "Failed to read src/a.ts after 1.25 seconds.",
    ],
    ["Z:/project", "读取 Z:/project-other/a.ts 失败。请重试", "读取 Z:/project-other/a.ts 失败。"],
    ["Z:/project", "读取 Z:/outside/a.ts 失败。请重试", "读取 Z:/outside/a.ts 失败。"],
    [
      "/workspace/project",
      "读取 /Workspace/project/a.ts 失败。请重试",
      "读取 /Workspace/project/a.ts 失败。",
    ],
    ["Z:/project", "插件无法完成请求\n详细诊断", "插件无法完成请求"],
    ["Z:/project", "插件无法完成请求", "插件无法完成请求"],
  ])("未知失败仅显示第一句并正确处理路径（cwd=%s）", (cwd, message, brief) => {
    const view = createSessionView();
    view.entries = [failedTool("unknown_plugin_error", message)];
    const { container } = mount(view, { cwd });
    const details = container.querySelector<HTMLDetailsElement>(".tool-details");
    expect(container.querySelector(".conversation-tool-error")).toBeNull();
    expect(details?.querySelector(".tool-res.err")?.textContent).toBe(brief);
    expect(details?.open).toBe(false);
    expect(container.textContent).not.toContain("unknown_plugin_error");
    expect(
      Array.from(container.querySelectorAll("[title]"), (node) => node.getAttribute("title")).join(
        " ",
      ),
    ).not.toContain("unknown_plugin_error");
    fireEvent.click(screen.getByText(brief, { selector: ".tool-res" }));
    expect(details?.open).toBe(true);
    expect(details?.querySelector(".conversation-tool-output")?.textContent).toBe(message);
  });

  it("超时行尾显示秒数（用结构化字段），展开显示最后40行且不重复摘要", () => {
    const lines = Array.from({ length: 50 }, (_, index) => `line${index + 1}`);
    const entry = failedTool("timeout", "命令超过 999ms 超时");
    entry.name = "shell";
    if (!entry.result) throw new Error("fixture 缺少结果");
    entry.result.output = {
      exitCode: null,
      signal: null,
      timedOut: true,
      killed: true,
      durationMs: 180_000,
      timeoutMs: 180_000,
    };
    entry.result.modelContent = `命令超过 180000ms 超时，进程树已终止\n${lines.join("\n")}`;
    const view = createSessionView();
    view.entries = [entry];
    const { container } = mount(view);
    const article = screen.getByRole("article", { name: "工具 shell" });
    // 用 output.timeoutMs 换算，不解析 message 里的 999ms
    expect(article.querySelector(".tool-res.err")?.textContent).toBe("超时（180 秒）");
    const details = container.querySelector<HTMLDetailsElement>(".tool-details");
    fireEvent.click(within(article).getByText("超时（180 秒）"));
    expect(details?.open).toBe(true);
    const text = details?.querySelector(".conversation-tool-output")?.textContent ?? "";
    expect(text).not.toContain("命令超过");
    const outLines = text.split("\n");
    expect(outLines).toHaveLength(40);
    expect(outLines[0]).toBe("line11");
    expect(outLines[39]).toBe("line50");
  });

  it("被拒绝的工具只显示一行红色说明，feedback 进 title", () => {
    const view = createSessionView();
    const entry = tool({ status: "denied", result: undefined });
    entry.resolution = { callId: "call-1", action: "deny", source: "user", feedback: "不要动" };
    view.entries = [entry];
    const { container } = mount(view);
    const deny = container.querySelector(".note.deny");
    expect(deny?.textContent).toBe("✕ 已拒绝修改 file.ts");
    expect(deny?.getAttribute("title")).toBe("不要动");
    expect(container.querySelector(".tool")).toBeNull();
  });

  it("MCP 工具行显示 server/tool 与主要入参，注册名不重复出现", () => {
    const view = createSessionView();
    const entry = tool({
      name: "mcp__exa__web_search_exa",
      input: { query: "nocturne 0.7.2" },
      subjects: [{ kind: "mcp", target: "exa/web_search_exa" }],
    });
    if (entry.result) entry.result.output = { count: 3 };
    view.entries = [entry];
    const { container } = mount(view);
    const line = container.querySelector(".tool-line");
    expect(line?.textContent).not.toContain("mcp__");
    expect(line?.querySelector(".tool-name")?.textContent).toBe("exa/web_search_exa");
    expect(line?.querySelector(".tool-arg")?.textContent).toBe("nocturne 0.7.2");
    expect(line?.textContent?.match(/exa\/web_search_exa/g)).toHaveLength(1);
  });

  it("MCP 工具缺 subjects 时从注册名解析名字；无字符串入参则参数留空", () => {
    const view = createSessionView();
    const noSubjects = tool({
      name: "mcp__exa__fetch_url",
      input: { count: 3 },
      subjects: [],
    });
    if (noSubjects.result) noSubjects.result.output = { ok: true };
    view.entries = [
      noSubjects,
      tool({
        name: "mcp__exa__web_search_exa",
        status: "denied",
        input: { query: "热点新闻" },
        subjects: [{ kind: "mcp", target: "exa/web_search_exa" }],
        result: undefined,
      }),
    ];
    const { container } = mount(view);
    const line = container.querySelector(".tool-line");
    expect(line?.querySelector(".tool-name")?.textContent).toBe("exa/fetch_url");
    expect(line?.querySelector(".tool-arg")).toBeNull();
    const deny = container.querySelector(".note.deny");
    expect(deny?.textContent).not.toContain("mcp__");
    expect(deny?.textContent).toBe("✕ 已拒绝exa/web_search_exa 热点新闻");
  });

  it("permission 与 config 子类通知不进入消息流，其他通知原样显示", () => {
    const view = createSessionView();
    view.entries = [
      {
        kind: "notice",
        key: "n1",
        seq: 1,
        subtype: "permission",
        message: "允许了 read",
        payload: {},
      },
      { kind: "notice", key: "n2", seq: 2, subtype: "config", message: "模型切换", payload: {} },
      { kind: "notice", key: "n3", seq: 3, subtype: "turn_end", message: "Turn 结束", payload: {} },
    ];
    mount(view);
    expect(screen.queryByText("允许了 read")).toBeNull();
    expect(screen.queryByText("模型切换")).toBeNull();
    expect(screen.getByText("Turn 结束")).toBeTruthy();
  });

  it.each<[TurnEndReason, string]>([
    ["done", "已完成"],
    ["truncated", "回复已截断"],
    ["refused", "已拒绝"],
    ["aborted", "已中断"],
    ["max_steps", "已达到最大步骤数"],
    ["error", "发生错误"],
  ])("Turn 结束原因 %s 使用中文回执 %s，保留错误详情", (reason, label) => {
    const view = createSessionView();
    const error = reason === "error" ? { code: "provider_error", message: "连接失败" } : undefined;
    const detail = error ? `：${error.code} ${error.message}` : "";
    view.entries = [
      {
        kind: "notice",
        key: "turn-end-1",
        seq: 1,
        subtype: "turn_end",
        message: `Turn 结束（${reason}）${detail}`,
        payload: { reason, steps: 1, usage: { inputTokens: 1, outputTokens: 1 }, error },
      },
    ];
    const { container } = mount(view);
    expect(container.querySelector(".note")?.textContent).toBe(`${label}${detail}`);
    expect(container.textContent).not.toContain(`Turn 结束（${reason}）`);
  });

  it("恢复收束回执保留进程退出说明与错误详情", () => {
    const view = createSessionView();
    const message = "上次进程退出，已按 backend_closed 收束：连接断开";
    view.entries = [
      {
        kind: "notice",
        key: "recovered-turn-1",
        seq: 1,
        subtype: "turn_end",
        message,
        payload: {
          reason: "error",
          recovered: true,
          error: { code: "backend_closed", message: "连接断开" },
        },
      },
    ];
    mount(view);
    expect(screen.getByText(message)).toBeTruthy();
  });

  it("压缩回执只显示上下文已压缩，不泄漏摘要种类、序号或 payload", () => {
    const view = createSessionView();
    view.entries = [
      {
        kind: "notice",
        key: "compacted-1",
        seq: 42,
        subtype: "compacted",
        message: "上下文已压缩（summary，至 seq 41）",
        payload: { kind: "summary", throughSeq: 41, summary: "不应显示的摘要正文" },
      },
    ];
    const { container } = mount(view);
    expect(screen.getByText("上下文已压缩").textContent).toBe("上下文已压缩");
    expect(container.textContent).not.toMatch(/summary|seq|41|42|不应显示的摘要正文/);
  });

  it("用户消息里的 @ 引用渲染成带说明的 chip，历史图片等待进入可视区", () => {
    const view = createSessionView();
    view.entries = [
      {
        kind: "user",
        key: "u1",
        seq: 1,
        turnId: "t",
        content: [
          { type: "text", text: "看 @src/a.ts 这里" },
          { type: "text", text: "（a.ts 快照内容）" },
        ],
        fileRefs: [
          {
            path: "src/a.ts",
            kind: "file",
            chars: 10,
            lines: 36,
            totalLines: 120,
            truncated: false,
          },
        ],
        attachments: [
          {
            type: "image",
            file: "img-1.png",
            mimeType: "image/png",
            bytes: 10,
            sha256: "x",
            source: "paste",
          },
        ],
      },
    ];
    const { container } = mount(view);
    const ref = container.querySelector(".ref");
    expect(ref?.textContent).toBe("@src/a.ts");
    expect(ref?.getAttribute("title")).toBe("已附带 36/120 行");
    const placeholder = container.querySelector(".u-img-placeholder");
    expect(placeholder?.getAttribute("aria-label")).toBe("加载图片：img-1.png");
    expect(placeholder?.getAttribute("title")).toBe("图片进入可视区后加载");
  });
});

describe("Conversation 权限卡片 v2", () => {
  it("标题给出操作与审查者结论，主体单行排列且 shell 带 kind 前缀", () => {
    const view = createSessionView();
    view.pendingPermission = permission({
      toolName: "shell",
      subjects: [{ kind: "shell", target: "rm -rf x", shell: "pwsh" }],
      review: {
        callId: "call-1",
        backend: "b",
        verdict: "unsure",
        reason: "拿不准",
        durationMs: 1,
        cached: false,
      },
    });
    mount(view);
    const card = screen.getByRole("region", { name: "权限确认" });
    expect(card.textContent).toContain("需要确认 · 执行命令");
    expect(card.textContent).toContain("审查器拿不准，交给你决定");
    expect(card.textContent).toContain("pwsh › rm -rf x");
    expect(within(card).getByRole("button", { name: "允许一次" })).toBeTruthy();
    expect(within(card).getByRole("button", { name: "拒绝" })).toBeTruthy();
    expect(card.textContent).toContain("Esc 拒绝");
  });

  it("数字键直选选项、Esc 直接拒绝；均不经过输入框", async () => {
    const view = createSessionView();
    view.pendingPermission = permission();
    const rendered = mount(view);
    fireEvent.keyDown(window, { key: "3" });
    await waitFor(() =>
      expect(rendered.methods.respondPermission).toHaveBeenCalledWith("permission-1", {
        decision: "allow",
        remember: "project",
      }),
    );
    rendered.methods.respondPermission.mockClear();
    view.pendingPermission = permission({ requestId: "permission-2" });
    rendered.rerender(<Conversation view={view} {...conversationProps(rendered)} />);
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(rendered.methods.respondPermission).toHaveBeenCalledWith("permission-2", {
        decision: "deny",
      }),
    );
    rendered.methods.respondPermission.mockClear();
    view.pendingPermission = permission({ requestId: "permission-3" });
    rendered.rerender(<Conversation view={view} {...conversationProps(rendered)} />);
    // 焦点在可编辑字段时数字与 Esc 不触发
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    const textarea = screen.getByRole("textbox", { name: "拒绝反馈（可选）" });
    fireEvent.keyDown(textarea, { key: "1" });
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(rendered.methods.respondPermission).not.toHaveBeenCalled();
  });

  it("卡片挂载即获得焦点；数字键 1 触发第一个选项", async () => {
    const view = createSessionView();
    view.pendingPermission = permission();
    const { methods } = mount(view);
    const card = screen.getByRole("region", { name: "权限确认" });
    await waitFor(() => expect(document.activeElement).toBe(card));
    fireEvent.keyDown(card, { key: "1" });
    await waitFor(() =>
      expect(methods.respondPermission).toHaveBeenCalledWith("permission-1", {
        decision: "allow",
      }),
    );
  });

  it("焦点在卡片外可编辑字段时 Esc 也直接拒绝", async () => {
    const view = createSessionView();
    view.pendingPermission = permission();
    const { methods } = mount(view);
    // 卡片外的可编辑焦点（如输入框）：Esc 照样拒绝，外层调用方负责防误中断
    const outside = document.createElement("textarea");
    document.body.appendChild(outside);
    outside.focus();
    fireEvent.keyDown(outside, { key: "Escape" });
    await waitFor(() =>
      expect(methods.respondPermission).toHaveBeenCalledWith("permission-1", {
        decision: "deny",
      }),
    );
    document.body.removeChild(outside);
  });
});

describe("长思考收起", () => {
  const LONG = Array.from({ length: 80 }, (_, i) => `第 ${String(i + 1)} 步推理`).join("\n");

  /** jsdom 不排版：按元素给出高度，模拟一屏 600px、思考正文 bodyHeight */
  function layout(bodyHeight: number) {
    const proto = HTMLElement.prototype;
    const scrollHeight = Object.getOwnPropertyDescriptor(proto, "scrollHeight");
    const clientHeight = Object.getOwnPropertyDescriptor(proto, "clientHeight");
    Object.defineProperty(proto, "scrollHeight", {
      configurable: true,
      get(this: HTMLElement) {
        if (this.tagName === "PRE" && this.closest(".think") !== null) return bodyHeight;
        if (this.classList.contains("conversation-scroll")) return bodyHeight + 2000;
        return 0;
      },
    });
    Object.defineProperty(proto, "clientHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains("conversation-scroll") ? 600 : 0;
      },
    });
    return () => {
      if (scrollHeight) Object.defineProperty(proto, "scrollHeight", scrollHeight);
      if (clientHeight) Object.defineProperty(proto, "clientHeight", clientHeight);
    };
  }

  function withTiming(reasoning: string) {
    const view = createSessionView();
    view.entries = [assistant({ reasoning })];
    return view;
  }

  it("不到一屏：只有标题行，没有底部「收起思考」；点标题收起", () => {
    const restore = layout(200);
    try {
      mount(withTiming("短思考"));
      const header = screen.getByRole("button", { name: "思考" });
      fireEvent.click(header);
      expect(header.getAttribute("aria-expanded")).toBe("true");
      expect(header.closest(".think")?.className).toContain("open");
      expect(screen.queryByRole("button", { name: /收起思考/ })).toBeNull();
      fireEvent.click(header);
      expect(header.getAttribute("aria-expanded")).toBe("false");
      expect(screen.queryByText("短思考")).toBeNull();
    } finally {
      restore();
    }
  });

  it("超过一屏：底部「收起思考」；未跟随时收起把标题行滚回视野顶部", () => {
    const restore = layout(3000);
    try {
      mount(withTiming(LONG));
      const stream = screen.getByRole("region", { name: "会话消息" });
      const header = screen.getByRole("button", { name: "思考" });
      fireEvent.click(header);
      const bottom = screen.getByRole("button", { name: /收起思考/ });

      // 读者往上翻到思考中段：不再跟随最新
      fireEvent.wheel(stream, { deltaY: -100 });
      stream.scrollTop = 1500;
      fireEvent.scroll(stream);
      expect(screen.getByRole("button", { name: "回到最新消息" })).toBeTruthy();

      // 收起后标题行在视野上方 400px
      vi.spyOn(stream, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 100, 800, 600));
      vi.spyOn(header, "getBoundingClientRect").mockReturnValue(new DOMRect(0, -300, 800, 30));
      fireEvent.click(bottom);
      expect(header.getAttribute("aria-expanded")).toBe("false");
      expect(stream.scrollTop).toBe(1100);
      expect(screen.getByRole("button", { name: "回到最新消息" })).toBeTruthy();
    } finally {
      restore();
    }
  });

  it("跟随最新时收起：留在底部，跟随不被关闭", () => {
    const restore = layout(3000);
    try {
      mount(withTiming(LONG));
      const stream = screen.getByRole("region", { name: "会话消息" });
      const header = screen.getByRole("button", { name: "思考" });
      fireEvent.click(header);
      fireEvent.click(screen.getByRole("button", { name: /收起思考/ }));
      fireEvent.scroll(stream);
      expect(header.getAttribute("aria-expanded")).toBe("false");
      expect(screen.queryByRole("button", { name: "回到最新消息" })).toBeNull();
    } finally {
      restore();
    }
  });

  it("展开后标题显示时长，并标明可收起", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const listeners = new Set<(event: RuntimeEvent) => void>();
      mount(withTiming("先检查文件"), {
        subscribeEvents: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      });
      const emit = (kind: "reasoning" | "text", delta: string) => {
        const event: RuntimeEvent = {
          type: "message.assistant.delta",
          sessionId: "session-1",
          runId: "run-1",
          eseq: kind === "reasoning" ? 1 : 2,
          afterSeq: 1,
          time: new Date().toISOString(),
          turnId: "turn-1",
          payload: { messageId: "message-1", kind, delta },
        };
        for (const listener of listeners) listener(event);
      };
      act(() => {
        emit("reasoning", "先检查文件");
      });
      act(() => {
        vi.advanceTimersByTime(72_000);
        emit("text", "完成");
      });
      const header = screen.getByRole("button", { name: "思考了 72s" });
      fireEvent.click(header);
      expect(header.textContent).toBe("思考 · 1 分 12 秒▶");
      expect(header.querySelector(".fold-arrow.up")).not.toBeNull();
      expect(header.getAttribute("title")).toBe("收起思考");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("回答内文件引用（U-09）", () => {
  const hooks = (overrides: Partial<FileLinkHooks> = {}) => ({
    openerLabel: () => "系统默认程序",
    open: vi.fn(async (_path: string, _line?: number) => undefined),
    editors: () => ({ vscode: true, cursor: false }),
    openInEditor: vi.fn(
      async (_editor: "vscode" | "cursor", _path: string, _line?: number) => undefined,
    ),
    openFolder: vi.fn(async (_path: string) => undefined),
    copy: vi.fn(async (_text: string) => undefined),
    reveal: vi.fn(async (_path: string) => undefined),
    ...overrides,
  });
  const inside = (paths: string[], isDirectory = false) =>
    paths.map((input) => ({
      input,
      absolutePath: `Z:/project/${input}`,
      withinWorkspace: true,
      relativePath: input,
      exists: true,
      isDirectory,
    }));

  it("存在的引用渲染成链接，不存在的保持普通代码", async () => {
    const view = createSessionView();
    view.entries = [assistant({ text: "改了 `src/a.ts`，`src/missing.ts` 不存在" })];
    mount(view, {
      fileLinks: hooks(),
      resolveFilesImpl: async (paths: string[]) =>
        inside(paths).map((r) => (r.input === "src/missing.ts" ? { ...r, exists: false } : r)),
    });
    await screen.findByRole("button", { name: "src/a.ts" });
    expect(screen.queryByRole("button", { name: "src/missing.ts" })).toBeNull();
    expect(screen.getByText("src/missing.ts").tagName).toBe("CODE");
  });

  it("左键直接按设置打开并带行号，不弹菜单", async () => {
    const view = createSessionView();
    view.entries = [assistant({ text: "看 `src/a.ts:12-20` 的实现" })];
    const fileLinks = hooks();
    mount(view, { fileLinks, resolveFilesImpl: async (paths: string[]) => inside(paths) });
    fireEvent.click(await screen.findByRole("button", { name: "src/a.ts:12-20" }));
    await waitFor(() => {
      expect(fileLinks.open).toHaveBeenCalledWith("Z:/project/src/a.ts", 12);
    });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("右键菜单：打开、资源管理器、检测到的编辑器、复制绝对与相对路径", async () => {
    const view = createSessionView();
    view.entries = [assistant({ text: "看 `src/a.ts:12`" })];
    const fileLinks = hooks({ openerLabel: () => "VS Code" });
    mount(view, { fileLinks, resolveFilesImpl: async (paths: string[]) => inside(paths) });
    const link = await screen.findByRole("button", { name: "src/a.ts:12" });
    fireEvent.contextMenu(link);
    let menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: /打开/ }).textContent).toContain("VS Code");
    expect(within(menu).queryByRole("menuitem", { name: "Cursor" })).toBeNull();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "VS Code" }));
    expect(fileLinks.openInEditor).toHaveBeenCalledWith("vscode", "Z:/project/src/a.ts", 12);
    fireEvent.contextMenu(link);
    menu = await screen.findByRole("menu");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "复制相对路径" }));
    expect(fileLinks.copy).toHaveBeenCalledWith("src/a.ts");
    fireEvent.contextMenu(link);
    menu = await screen.findByRole("menu");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "复制绝对路径" }));
    expect(fileLinks.copy).toHaveBeenCalledWith("Z:/project/src/a.ts");
    fireEvent.contextMenu(link);
    menu = await screen.findByRole("menu");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "资源管理器" }));
    expect(fileLinks.reveal).toHaveBeenCalledWith("Z:/project/src/a.ts");
    expect(fileLinks.open).not.toHaveBeenCalled();
  });

  it("目录：左键交给系统打开，菜单不列编辑器", async () => {
    const view = createSessionView();
    view.entries = [assistant({ text: "在 `src` 目录下" })];
    const fileLinks = hooks();
    mount(view, { fileLinks, resolveFilesImpl: async (paths: string[]) => inside(paths, true) });
    const link = await screen.findByRole("button", { name: "src" });
    fireEvent.click(link);
    await waitFor(() => {
      expect(fileLinks.openFolder).toHaveBeenCalledWith("Z:/project/src");
    });
    fireEvent.contextMenu(link);
    const menu = await screen.findByRole("menu");
    expect(within(menu).queryByRole("menuitem", { name: "VS Code" })).toBeNull();
    expect(fileLinks.open).not.toHaveBeenCalled();
  });

  it("工作区外的路径不能直接打开：单击开菜单，只有资源管理器与复制绝对路径", async () => {
    const view = createSessionView();
    view.entries = [assistant({ text: "系统文件 `C:/Windows/exec.exe` 别乱点" })];
    const fileLinks = hooks();
    mount(view, {
      fileLinks,
      resolveFilesImpl: async (paths: string[]) =>
        paths.map((input) => ({
          input,
          absolutePath: "C:/Windows/exec.exe",
          withinWorkspace: false,
          exists: true,
          isDirectory: false,
        })),
    });
    const link = await screen.findByRole("button", { name: "C:/Windows/exec.exe" });
    fireEvent.click(link);
    const menu = await screen.findByRole("menu");
    expect(within(menu).queryByRole("menuitem", { name: /打开/ })).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: "VS Code" })).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: "复制相对路径" })).toBeNull();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "复制绝对路径" }));
    expect(fileLinks.copy).toHaveBeenCalledWith("C:/Windows/exec.exe");
    fireEvent.click(link);
    fireEvent.click(
      within(await screen.findByRole("menu")).getByRole("menuitem", { name: "资源管理器" }),
    );
    expect(fileLinks.reveal).toHaveBeenCalledWith("C:/Windows/exec.exe");
    expect(fileLinks.open).not.toHaveBeenCalled();
    expect(fileLinks.openInEditor).not.toHaveBeenCalled();
  });

  it("不传 fileLinks 时保持普通代码（旧行为）", () => {
    const view = createSessionView();
    view.entries = [assistant({ text: "改了 `src/a.ts`" })];
    const rendered = mount(view);
    expect(screen.getByText("src/a.ts").tagName).toBe("CODE");
    expect(screen.queryByRole("button", { name: "src/a.ts" })).toBeNull();
    expect(rendered.methods.resolveFiles).not.toHaveBeenCalled();
  });
});
