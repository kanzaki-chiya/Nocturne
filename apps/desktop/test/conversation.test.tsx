import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSessionView,
  type AssistantEntry,
  type PendingPermission,
  type PendingQuestion,
  type PermissionOption,
  type PermissionReply,
  type SessionView,
  type ToolEntry,
} from "@nocturne/core/protocol";
import type { RpcSession } from "@nocturne/rpc/client";

import { Conversation } from "../src/Conversation";

function sessionFixture(id = "session-1") {
  const methods = {
    id,
    respondPermission: vi
      .fn<(requestId: string, reply: PermissionReply) => Promise<void>>()
      .mockResolvedValue(undefined),
    respondQuestion: vi.fn<RpcSession["respondQuestion"]>().mockResolvedValue(undefined),
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

function mount(view: SessionView = createSessionView()) {
  const { session, methods } = sessionFixture();
  const openUrl = vi.fn();
  return {
    ...render(<Conversation session={session} view={view} openUrl={openUrl} />),
    session,
    methods,
    openUrl,
  };
}

afterEach(cleanup);

describe("Conversation 权限卡片", () => {
  const choices: [PermissionOption, string, PermissionReply][] = [
    ["allow_once", "允许一次", { decision: "allow" }],
    ["allow_session", "本会话内允许", { decision: "allow", remember: "session" }],
    ["allow_project", "在此项目中始终允许", { decision: "allow", remember: "project" }],
    ["deny_stop", "拒绝并停止本 Turn", { decision: "deny", stop: true }],
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
    fireEvent.click(screen.getByRole("button", { name: "拒绝（可附反馈）" }));
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
    expect(screen.queryByRole("button", { name: "本会话内允许" })).toBeNull();
    expect(screen.queryByRole("button", { name: "在此项目中始终允许" })).toBeNull();
    expect(screen.queryByRole("button", { name: "拒绝并停止本 Turn" })).toBeNull();
    view.pendingPermission = permission({ requestId: "permission-2", options: [] });
    rendered.rerender(
      <Conversation session={rendered.session} view={view} openUrl={rendered.openUrl} />,
    );
    expect(screen.getByRole("button", { name: "允许一次" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "拒绝（可附反馈）" })).toBeTruthy();
  });

  it("网络授权标题沿用 TUI，反馈 Esc 返回而不发送", () => {
    const view = createSessionView();
    view.pendingPermission = permission({ subjects: [{ kind: "network", target: "example.com" }] });
    const { methods } = mount(view);
    expect(screen.getByRole("button", { name: "本会话允许访问 example.com" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "拒绝（可附反馈）" }));
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
    rendered.rerender(
      <Conversation session={rendered.session} view={view} openUrl={rendered.openUrl} />,
    );
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
    rendered.rerender(
      <Conversation session={rendered.session} view={view} openUrl={rendered.openUrl} />,
    );
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
    const reasoning = screen.getByText("思考").closest("details");
    expect(reasoning?.open).toBe(false);
    expect(reasoning?.textContent).toContain("先检查文件");
    expect(screen.getByText("模型已切换")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("响应较慢");
    const diff = screen.getByText("查看差异 · file.ts").closest("details");
    expect(diff?.open).toBe(true);
    fireEvent.click(screen.getByText("查看差异 · file.ts"));
    expect(diff?.open).toBe(false);
    expect(container.querySelector(".conversation-diff-add code")?.textContent).toBe("+new");
    expect(container.querySelector(".conversation-diff-delete code")?.textContent).toBe("-old");
    expect(
      container.querySelector(".conversation-diff-delete .conversation-diff-number")?.textContent,
    ).toBe("1");
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
    mount(view);
    expect(screen.getByText("查看差异 · M a.ts")).toBeTruthy();
    expect(screen.getByText("M old.ts → new.ts")).toBeTruthy();
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
    expect(within(article).getByText("读取源文件").closest("details")?.open).toBe(false);
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
    expect(screen.getByLabelText("工具实时输出").textContent).toBe("第一行");
    expect(screen.getByText('{"command":')).toBeTruthy();
    const assistant = view.live.assistants[0];
    const liveTool = view.live.tools[0];
    if (assistant === undefined || liveTool === undefined) throw new Error("缺少流式条目");
    assistant.text = "正在 **回复**";
    liveTool.inputText += '"pwd"}';
    view.revision += 1;
    rendered.rerender(
      <Conversation session={rendered.session} view={view} openUrl={rendered.openUrl} />,
    );
    expect(screen.getByText("回复", { selector: "strong" })).toBeTruthy();
    expect(screen.getByText('{"command":"pwd"}')).toBeTruthy();
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
    rendered.rerender(
      <Conversation session={rendered.session} view={view} openUrl={rendered.openUrl} />,
    );
    expect(top).toBe(800);
    fireEvent.wheel(scroll, { deltaY: -100 });
    scroll.scrollTop = 300;
    fireEvent.scroll(scroll);
    height = 1300;
    const assistant = view.live.assistants[0];
    if (assistant === undefined) throw new Error("缺少流式回复");
    assistant.text += " 第二段";
    view.revision += 1;
    rendered.rerender(
      <Conversation session={rendered.session} view={view} openUrl={rendered.openUrl} />,
    );
    expect(top).toBe(300);
    fireEvent.click(screen.getByRole("button", { name: "回到最新消息" }));
    expect(top).toBe(1100);
    height = 1500;
    view.revision += 1;
    rendered.rerender(
      <Conversation session={rendered.session} view={view} openUrl={rendered.openUrl} />,
    );
    expect(top).toBe(1300);
    scroll.scrollTop = 400;
    fireEvent.scroll(scroll);
    expect(screen.getByRole("button", { name: "回到最新消息" })).toBeTruthy();
    const next = sessionFixture("session-2");
    rendered.rerender(
      <Conversation session={next.session} view={createSessionView()} openUrl={rendered.openUrl} />,
    );
    expect(screen.queryByRole("button", { name: "回到最新消息" })).toBeNull();
  });
});
