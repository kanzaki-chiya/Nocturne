// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  EnsembleMemberPermission,
  EnsembleMemberView,
  EnsemblePostView,
  EnsembleView,
} from "@nocturne/core/protocol";

import { EnsemblePane, type EnsembleSession } from "../src/EnsemblePane";

afterEach(cleanup);

/** 用本地时间构造，`formatEnsembleTime` 在任何时区都得到 09:05 */
const TIME = new Date(2026, 10, 12, 9, 5).toISOString();
const TIME_LABEL = "09:05";

const PERMISSION: EnsembleMemberPermission = {
  requestId: "req-1",
  callId: "call-1",
  reason: "要写 src/auth.ts",
  subjects: [],
  options: [],
};

function makeMember(name: string, overrides: Partial<EnsembleMemberView> = {}): EnsembleMemberView {
  return {
    name,
    childSessionId: `child-${name}`,
    charter: {
      owns: `${name} 负责的部分`,
      handsOff: `${name} 不碰的部分`,
      doneWhen: `${name} 的验收标准`,
    },
    model: { provider: "anthropic", model: "claude-opus-5.5" },
    preset: "general",
    isolated: false,
    status: "waiting",
    pendingPermissions: [],
    ...overrides,
  };
}

function makePost(number: number, overrides: Partial<EnsemblePostView> = {}): EnsemblePostView {
  return {
    seq: number,
    time: TIME,
    number,
    from: "maestro",
    fromKind: "maestro",
    text: `第 ${number} 条`,
    mentions: [],
    recipients: [],
    ...overrides,
  };
}

function makeEnsemble(overrides: Partial<EnsembleView> = {}): EnsembleView {
  return {
    createdSeq: 1,
    title: "API 输入校验",
    status: "active",
    maestro: {
      model: { provider: "anthropic", model: "claude-opus-5.5" },
      status: "waiting",
      awaitingPermission: false,
    },
    members: [],
    awaitingPermissionMembers: [],
    posts: [],
    ...overrides,
  };
}

function makeSession(overrides: Partial<EnsembleSession> = {}): EnsembleSession {
  return {
    postToEnsemble: vi.fn(async () => ({ number: 1, recipients: [] })),
    removeEnsembleMember: vi.fn(async () => undefined),
    endEnsemble: vi.fn(async () => ({ unmerged: [] })),
    ...overrides,
  };
}

function renderPane(options: {
  ensemble: EnsembleView;
  session?: EnsembleSession;
  onOpenMember?: (member: EnsembleMemberView) => void;
  onSelectMaestro?: () => void;
  visible?: boolean;
}) {
  const session = options.session ?? makeSession();
  const onOpenMember = options.onOpenMember ?? vi.fn();
  const onSelectMaestro = options.onSelectMaestro ?? vi.fn();
  const element = (ensemble: EnsembleView, visible: boolean) => (
    <EnsemblePane
      ensemble={ensemble}
      session={session}
      openUrl={vi.fn()}
      onOpenMember={onOpenMember}
      onSelectMaestro={onSelectMaestro}
      visible={visible}
    />
  );
  const page = render(element(options.ensemble, options.visible ?? true));
  return {
    ...page,
    session,
    onOpenMember,
    onSelectMaestro,
    show: (ensemble: EnsembleView, visible = true) => {
      page.rerender(element(ensemble, visible));
    },
  };
}

const nodes = (container: HTMLElement, selector: string): HTMLElement[] =>
  Array.from(container.querySelectorAll<HTMLElement>(selector));

const texts = (container: HTMLElement, selector: string): (string | null)[] =>
  nodes(container, selector).map((el) => el.textContent);

function rowOf(container: HTMLElement, name: string): HTMLElement | undefined {
  return nodes(container, ".ensemble-mem").find(
    (row) => row.querySelector(".ensemble-mem-name")?.textContent?.startsWith(name) === true,
  );
}

function lastLineOf(container: HTMLElement, name: string): string | null | undefined {
  return rowOf(container, name)?.querySelector(".ensemble-mem-last")?.textContent;
}

/** jsdom 不做布局：手动给出滚动尺寸，并把 scrollTop 变成可写的数据属性 */
function scrollableBody(container: HTMLElement, height: number, viewport = 200): HTMLElement {
  const body = container.querySelector<HTMLElement>(".ensemble-body");
  if (body === null) throw new Error("缺少 .ensemble-body");
  Object.defineProperties(body, {
    scrollHeight: { configurable: true, get: () => height },
    clientHeight: { configurable: true, value: viewport },
    scrollTop: { configurable: true, value: 0, writable: true },
  });
  return body;
}

function openMembers() {
  fireEvent.click(screen.getByRole("tab", { name: "成员" }));
}

describe("Ensemble 面板留言板", () => {
  it("帖子头部显示头像、作者、箭头与剔除作者后的收件人，无收件人不显示箭头", () => {
    const page = renderPane({
      ensemble: makeEnsemble({
        members: [makeMember("users"), makeMember("orders")],
        posts: [
          makePost(1, {
            mentions: ["maestro", "users", "all"],
            text: "请 @users 与 @all 看这里 @maestro",
          }),
          makePost(2, { from: "user", fromKind: "user", mentions: [], text: "我来补充" }),
          makePost(3, {
            from: "runtime",
            fromKind: "runtime",
            mentions: ["maestro"],
            text: "Quiet reminder: @maestro 没有新帖\n请继续",
          }),
          makePost(4, { from: "users", fromKind: "member", mentions: ["users"] }),
          makePost(5, {
            from: "orders",
            fromKind: "member",
            mentions: ["maestro", "users", "orders"],
          }),
        ],
      }),
    });

    expect(nodes(page.container, ".ensemble-post > .ensemble-av")).toHaveLength(5);
    expect(texts(page.container, ".ensemble-post-from")).toEqual([
      "指挥",
      "你",
      "Runtime",
      "@users",
      "@orders",
    ]);
    expect(texts(page.container, ".ensemble-post-to")).toEqual([
      " → @users @all",
      " → 指挥",
      " → 指挥 @users",
    ]);
    expect(texts(page.container, ".ensemble-post-meta")).toEqual([
      `#1 · ${TIME_LABEL}`,
      `#2 · ${TIME_LABEL}`,
      `#3 · ${TIME_LABEL}`,
      `#4 · ${TIME_LABEL}`,
      `#5 · ${TIME_LABEL}`,
    ]);
    // Runtime 帖正文原样纯文本，不做 Markdown
    expect(page.container.querySelector(".ensemble-post.sys .ensemble-sys-text")?.textContent).toBe(
      "Quiet reminder: @maestro 没有新帖\n请继续",
    );
    expect(page.container.querySelector(".ensemble-post.user")).not.toBeNull();
  });

  it("筛选条按作者与收件人过滤留言板", () => {
    const page = renderPane({
      ensemble: makeEnsemble({
        members: [makeMember("users"), makeMember("orders")],
        posts: [
          makePost(1, { from: "users", fromKind: "member", text: "users 汇报" }),
          makePost(2, { recipients: ["orders"], text: "请 orders 复核" }),
          makePost(3, { text: "整体进度" }),
        ],
      }),
    });

    expect(texts(page.container, ".ensemble-chip")).toEqual(["全部", "@users", "@orders"]);
    expect(nodes(page.container, ".ensemble-post")).toHaveLength(3);

    fireEvent.click(screen.getByRole("button", { name: "@orders" }));
    expect(nodes(page.container, ".ensemble-post")).toHaveLength(1);
    expect(page.container.querySelector(".ensemble-post-txt")?.textContent).toContain(
      "请 orders 复核",
    );
    expect(screen.getByRole("button", { name: "@orders" }).className).toBe("ensemble-chip on");
    expect(screen.getByRole("button", { name: "全部" }).className).toBe("ensemble-chip");

    fireEvent.click(screen.getByRole("button", { name: "@users" }));
    expect(nodes(page.container, ".ensemble-post")).toHaveLength(1);
    expect(page.container.querySelector(".ensemble-post-txt")?.textContent).toContain("users 汇报");

    fireEvent.click(screen.getByRole("button", { name: "全部" }));
    expect(nodes(page.container, ".ensemble-post")).toHaveLength(3);
  });

  it("搜索展开无占位文字，不区分大小写匹配正文与作者，Escape 收起并清空", () => {
    const page = renderPane({
      ensemble: makeEnsemble({
        posts: [
          makePost(1, { text: "Hello World 修好了" }),
          makePost(2, {
            from: "runtime",
            fromKind: "runtime",
            text: "Quiet reminder: @maestro 请继续",
          }),
          makePost(3, { text: "别的帖子" }),
        ],
      }),
    });

    const toggle = screen.getByRole("button", { name: "搜索" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");

    const input = screen.getByRole("textbox", { name: "搜索" }) as HTMLInputElement;
    expect(input.hasAttribute("placeholder")).toBe(false);
    expect(document.activeElement).toBe(input);
    expect(nodes(page.container, ".ensemble-post")).toHaveLength(3);

    fireEvent.change(input, { target: { value: "HELLO" } });
    expect(nodes(page.container, ".ensemble-post")).toHaveLength(1);
    expect(page.container.querySelector(".ensemble-post-txt")?.textContent).toContain(
      "Hello World",
    );

    fireEvent.change(input, { target: { value: "RUNTIME" } });
    expect(nodes(page.container, ".ensemble-post")).toHaveLength(1);
    expect(page.container.querySelector(".ensemble-post-txt")?.textContent).toContain(
      "Quiet reminder",
    );

    fireEvent.keyDown(input, { key: "Escape" });
    expect(page.container.querySelector(".ensemble-search")).toBeNull();
    expect(nodes(page.container, ".ensemble-post")).toHaveLength(3);

    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    expect((screen.getByRole("textbox", { name: "搜索" }) as HTMLInputElement).value).toBe("");
  });

  it("跟随最新默认开启，往上滚自动关闭，点按钮重新开启并滚到底", () => {
    const page = renderPane({ ensemble: makeEnsemble({ posts: [makePost(1), makePost(2)] }) });
    const body = scrollableBody(page.container, 600);
    const follow = () => screen.getByRole("button", { name: "跟随最新" });
    expect(follow().getAttribute("aria-pressed")).toBe("true");

    // 新帖到达时贴底
    page.show(makeEnsemble({ posts: [makePost(1), makePost(2), makePost(3)] }));
    expect(body.scrollTop).toBe(600);

    // 往上滚：关闭跟随
    body.scrollTop = 100;
    fireEvent.scroll(body);
    expect(follow().getAttribute("aria-pressed")).toBe("false");

    // 关闭后新帖不再拉回底部
    page.show(makeEnsemble({ posts: [makePost(1), makePost(2), makePost(3), makePost(4)] }));
    expect(body.scrollTop).toBe(100);

    // 点按钮重新开启并立即贴底
    fireEvent.click(follow());
    expect(follow().getAttribute("aria-pressed")).toBe("true");
    expect(body.scrollTop).toBe(600);

    // 滚轮上滑同样关闭跟随
    fireEvent.wheel(body, { deltaY: -12 });
    expect(follow().getAttribute("aria-pressed")).toBe("false");

    // 面板重新可见且跟随开启时回到最新
    fireEvent.click(follow());
    body.scrollTop = 0;
    page.show(makeEnsemble({ posts: [makePost(1), makePost(2), makePost(3), makePost(4)] }), false);
    page.show(makeEnsemble({ posts: [makePost(1), makePost(2), makePost(3), makePost(4)] }));
    expect(body.scrollTop).toBe(600);
  });

  it("任务书帖显示负责、不碰、完成三段，不显示英文原文", () => {
    const page = renderPane({
      ensemble: makeEnsemble({
        members: [
          makeMember("users", {
            charter: {
              owns: "auth 输入校验",
              handsOff: "orders 的表结构",
              doneWhen: "pnpm test 全绿",
            },
          }),
        ],
        posts: [
          makePost(1, {
            charterOf: "users",
            text: "Owns: auth validation. Hands off: orders schema. Done when: tests pass.",
          }),
        ],
      }),
    });

    expect(texts(page.container, ".ensemble-charter-tag")).toEqual(["负责", "不碰", "完成"]);
    expect(texts(page.container, ".ensemble-charter-row")).toEqual([
      "负责auth 输入校验",
      "不碰orders 的表结构",
      "完成pnpm test 全绿",
    ]);
    expect(page.container.textContent).not.toContain("Owns:");
    // 只显示一段任务书，不重复英文原文
    expect(nodes(page.container, ".ensemble-post-txt")).toHaveLength(1);
  });

  it("正文只强调 mentions 里的 @token，代码内与未提及的保持原样", () => {
    const page = renderPane({
      ensemble: makeEnsemble({
        members: [makeMember("users")],
        posts: [
          makePost(1, {
            mentions: ["users", "all"],
            text: "请 @users 检查 `@users` 与 @other，抄送 @all。",
          }),
        ],
      }),
    });

    expect(texts(page.container, ".ensemble-at")).toEqual(["@users", "@all"]);
    expect(page.container.querySelector("code .ensemble-at")).toBeNull();
    expect(page.container.querySelector("code")?.textContent).toBe("@users");
  });

  it("留言板输入框无占位文字，Enter 发送、Shift+Enter 换行、组字中不发送", async () => {
    const session = makeSession();
    renderPane({ ensemble: makeEnsemble(), session });
    const field = screen.getByRole("textbox", { name: "留言板" }) as HTMLTextAreaElement;
    expect(field.hasAttribute("placeholder")).toBe(false);

    // 全空白不发送
    fireEvent.change(field, { target: { value: "   " } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(session.postToEnsemble).not.toHaveBeenCalled();

    fireEvent.change(field, { target: { value: "请先看 auth" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() =>
      expect(session.postToEnsemble).toHaveBeenCalledWith({ text: "请先看 auth" }),
    );
    await waitFor(() => expect(field.value).toBe(""));

    // Shift+Enter 换行不发送
    fireEvent.change(field, { target: { value: "第二行" } });
    fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
    expect(session.postToEnsemble).toHaveBeenCalledTimes(1);
    expect(field.value).toBe("第二行");

    // 输入法组字期间 Enter 不发送
    fireEvent.compositionStart(field);
    fireEvent.keyDown(field, { key: "Enter" });
    expect(session.postToEnsemble).toHaveBeenCalledTimes(1);
    fireEvent.compositionEnd(field);
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(session.postToEnsemble).toHaveBeenCalledTimes(2));
  });

  it("发帖失败时保留草稿并在输入框上方显示 Runtime 原文", async () => {
    const session = makeSession({
      postToEnsemble: vi.fn(async () => {
        throw new Error("ensemble 已结束，无法发帖");
      }),
    });
    const page = renderPane({ ensemble: makeEnsemble(), session });
    const field = screen.getByRole("textbox", { name: "留言板" }) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "要不要并回" } });
    fireEvent.keyDown(field, { key: "Enter" });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("ensemble 已结束，无法发帖");
    expect(page.container.querySelector(".ensemble-boardin")?.firstElementChild).toBe(alert);
    expect(field.value).toBe("要不要并回");
  });

  it("发帖框 @ 补全：候选顺序、前缀筛选、组提及、已移除成员排除、键盘填入带空格且不发帖、组字期间不弹", () => {
    const session = makeSession();
    const page = renderPane({
      ensemble: makeEnsemble({
        members: [
          makeMember("api-1", { profile: "deep" }),
          makeMember("api-2"),
          makeMember("data-1"),
          makeMember("old-1", { status: "removed" }),
        ],
      }),
      session,
    });
    const field = screen.getByRole("textbox", { name: "留言板" }) as HTMLTextAreaElement;

    // 组字期间不弹
    fireEvent.compositionStart(field);
    fireEvent.change(field, { target: { value: "@", selectionStart: 1 } });
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.compositionEnd(field, { target: { selectionStart: 1 } });

    const list = screen.getByRole("listbox", { name: "提及补全" });
    const optionNames = Array.from(list.querySelectorAll(".ensemble-ac-name")).map(
      (el) => el.textContent,
    );
    expect(optionNames).toEqual(["指挥", "api-1", "api-2", "data-1", "@api", "all"]);
    expect(list.textContent).not.toContain("old-1");
    expect(list.textContent).toContain("deep");

    // 向下选 api-1 后 Enter 填入，不发帖且末尾带空格
    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(session.postToEnsemble).not.toHaveBeenCalled();
    expect(field.value).toBe("@api-1 ");
    expect(screen.queryByRole("listbox")).toBeNull();

    // 输入 @d 前缀筛选，Tab 填入
    fireEvent.change(field, { target: { value: "@api-1 请问 @d", selectionStart: 12 } });
    const filtered = screen.getByRole("listbox", { name: "提及补全" });
    expect(
      Array.from(filtered.querySelectorAll(".ensemble-ac-name")).map((e) => e.textContent),
    ).toEqual(["data-1"]);
    fireEvent.keyDown(field, { key: "Tab" });
    expect(field.value).toBe("@api-1 请问 @data-1 ");

    // 无匹配时不弹
    fireEvent.change(field, { target: { value: "@zzz", selectionStart: 4 } });
    expect(screen.queryByRole("listbox")).toBeNull();

    // Esc 关闭弹层，点击填入
    fireEvent.change(field, { target: { value: "@a", selectionStart: 2 } });
    expect(screen.getByRole("listbox")).not.toBeNull();
    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();

    fireEvent.change(field, { target: { value: "找 @", selectionStart: 3 } });
    const options = screen.getAllByRole("option");
    const firstOption = options[0];
    if (!firstOption) throw new Error("missing option");
    fireEvent.click(firstOption);
    expect(field.value).toBe("找 @maestro ");
    expect(page.container.querySelectorAll(".ensemble-ac")).toHaveLength(0);
  });
});

describe("Ensemble 面板成员页", () => {
  function membersEnsemble(overrides: Partial<EnsembleView> = {}): EnsembleView {
    return makeEnsemble({
      maestro: {
        model: { provider: "anthropic", model: "claude-opus-5.5" },
        status: "working",
        awaitingPermission: false,
        lastPostNumber: 3,
        activity: { kind: "post", number: 2, line: "已分派任务" },
      },
      members: [
        makeMember("auth", { status: "working", lastPostNumber: 2 }),
        makeMember("schema", { status: "working", pendingPermissions: [PERMISSION] }),
        makeMember("ui", { status: "paused" }),
        makeMember("docs", { status: "waiting" }),
        makeMember("legacy", { status: "removed", activity: { kind: "removed" } }),
      ],
      ...overrides,
    });
  }

  it("指挥置顶、分组标题按非空显示、状态点随状态变化", () => {
    const page = renderPane({ ensemble: membersEnsemble() });
    openMembers();
    expect(screen.getByRole("tab", { name: "成员" }).getAttribute("aria-selected")).toBe("true");

    const maestro = page.container.querySelector(".ensemble-mems > .ensemble-mem");
    expect(maestro?.classList.contains("coord")).toBe(true);
    expect(maestro?.querySelector(".ensemble-mem-name")?.textContent).toBe("指挥claude-opus-5.5");
    expect(maestro?.querySelector(".ensemble-mem-no")?.textContent).toBe("#3");
    expect(maestro?.querySelector(".ensemble-mem-last")?.textContent).toBe("已分派任务");
    expect(maestro?.querySelector(".ensemble-dot")?.className).toBe("ensemble-dot work");
    expect(rowOf(page.container, "auth")?.querySelector(".ensemble-mem-no")?.textContent).toBe(
      "#2",
    );

    expect(texts(page.container, ".ensemble-grp")).toEqual([
      "工作中",
      "已暂停",
      "等待",
      "已移除 1",
    ]);
    const dotOf = (name: string) =>
      rowOf(page.container, name)?.querySelector(".ensemble-dot")?.className;
    expect(dotOf("auth")).toBe("ensemble-dot work");
    expect(dotOf("schema")).toBe("ensemble-dot ask");
    expect(dotOf("ui")).toBe("ensemble-dot pause");
    expect(dotOf("docs")).toBe("ensemble-dot wait");

    // 结束后未移除成员统一变成 wait，已移除保持 retired
    page.show(membersEnsemble({ status: "ended" }));
    expect(dotOf("auth")).toBe("ensemble-dot wait");
    expect(dotOf("schema")).toBe("ensemble-dot wait");
    expect(dotOf("ui")).toBe("ensemble-dot wait");
    expect(page.container.querySelector(".ensemble-mem-menu")).toBeNull();
  });

  it("空的分组不显示组标题", () => {
    const page = renderPane({
      ensemble: makeEnsemble({ members: [makeMember("auth", { status: "working" })] }),
    });
    openMembers();
    expect(texts(page.container, ".ensemble-grp")).toEqual(["工作中"]);
  });

  it("已移除组默认收起，展开后 aria-expanded 为 true 并可打开成员会话", () => {
    const onOpenMember = vi.fn();
    const page = renderPane({
      ensemble: makeEnsemble({
        members: [
          makeMember("auth", { status: "working" }),
          makeMember("legacy", { status: "removed", activity: { kind: "removed" } }),
        ],
      }),
      onOpenMember,
    });
    openMembers();

    const toggle = screen.getByRole("button", { name: "已移除 1" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(nodes(page.container, ".ensemble-mem.retired")).toHaveLength(0);

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const retired = page.container.querySelector(".ensemble-mem.retired");
    if (retired === null) throw new Error("缺少已移除成员行");
    expect(retired.querySelector(".ensemble-mem-menu")).toBeNull();
    expect(retired.querySelector(".ensemble-dot")?.className).toBe("ensemble-dot retired");

    const main = retired.querySelector(".ensemble-mem-main");
    if (!(main instanceof HTMLElement)) throw new Error("缺少成员行按钮");
    fireEvent.click(main);
    expect(onOpenMember).toHaveBeenCalledWith(expect.objectContaining({ name: "legacy" }));
  });

  it("第二行显示活动摘要，无原因的移除不显示第二行", () => {
    const page = renderPane({
      ensemble: makeEnsemble({
        maestro: {
          model: { provider: "anthropic", model: "claude-opus-5.5" },
          status: "waiting",
          awaitingPermission: true,
          activity: { kind: "permission", target: "shell · pnpm test" },
        },
        members: [
          makeMember("auth", {
            status: "working",
            activity: { kind: "tool", tool: "read", detail: "src/auth.ts" },
          }),
          makeMember("schema", {
            status: "paused",
            activity: { kind: "paused", code: "session_not_found", message: "gone" },
          }),
          makeMember("ui", {
            status: "waiting",
            activity: { kind: "charter", line: "ui 负责样式" },
          }),
          makeMember("legacy", {
            status: "removed",
            activity: { kind: "removed", reason: "已经不需要这个成员了\n第二行" },
          }),
          makeMember("orphan", { status: "removed", activity: { kind: "removed" } }),
        ],
      }),
    });
    openMembers();

    expect(lastLineOf(page.container, "指挥")).toBe("等待确认：shell · pnpm test");
    expect(lastLineOf(page.container, "auth")).toBe("读取 src/auth.ts");
    expect(lastLineOf(page.container, "schema")).toBe("找不到这个子代理的日志，可能已被删除");
    expect(lastLineOf(page.container, "ui")).toBe("ui 负责样式");

    fireEvent.click(screen.getByRole("button", { name: "已移除 2" }));
    expect(lastLineOf(page.container, "legacy")).toBe("已经不需要这个成员了");
    expect(lastLineOf(page.container, "orphan")).toBeUndefined();
  });

  it("点击指挥行回到主会话", () => {
    const onSelectMaestro = vi.fn();
    const page = renderPane({ ensemble: membersEnsemble(), onSelectMaestro });
    openMembers();
    const main = page.container.querySelector(".ensemble-mem.coord .ensemble-mem-main");
    if (!(main instanceof HTMLElement)) throw new Error("缺少指挥行");
    fireEvent.click(main);
    expect(onSelectMaestro).toHaveBeenCalledTimes(1);
  });
});

describe("Ensemble 面板菜单", () => {
  it("子栏溢出菜单的结束调用 endEnsemble，已结束时菜单与输入框都隐藏", async () => {
    const session = makeSession();
    const page = renderPane({ ensemble: makeEnsemble({ posts: [makePost(1)] }), session });

    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    await screen.findByRole("menu", { name: "更多操作" });
    fireEvent.click(screen.getByRole("menuitem", { name: "结束" }));

    await waitFor(() => expect(session.endEnsemble).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    page.show(makeEnsemble({ status: "ended", posts: [makePost(1)] }));
    expect(screen.queryByRole("button", { name: "更多操作" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "留言板" })).toBeNull();
  });

  it("结束失败时在面板顶部显示 Runtime 原文", async () => {
    const session = makeSession({
      endEnsemble: vi.fn(async () => {
        throw new Error("还有成员的分支没有并回");
      }),
    });
    renderPane({ ensemble: makeEnsemble(), session });
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    await screen.findByRole("menu", { name: "更多操作" });
    fireEvent.click(screen.getByRole("menuitem", { name: "结束" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("还有成员的分支没有并回");
  });

  it("成员行菜单的移除调用 removeEnsembleMember，报错时显示 Runtime 原文", async () => {
    const session = makeSession();
    const page = renderPane({
      ensemble: makeEnsemble({ members: [makeMember("auth", { status: "working" })] }),
      session,
    });
    openMembers();

    const row = rowOf(page.container, "auth");
    if (row === undefined) throw new Error("缺少 auth 成员行");
    const trigger = row.querySelector(".ensemble-mem-menu");
    if (!(trigger instanceof HTMLElement)) throw new Error("缺少成员菜单按钮");
    fireEvent.click(trigger);
    await screen.findByRole("menu", { name: "更多操作" });
    fireEvent.click(screen.getByRole("menuitem", { name: "移除" }));

    await waitFor(() => expect(session.removeEnsembleMember).toHaveBeenCalledWith("auth"));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("移除失败时显示 Runtime 原文", async () => {
    const session = makeSession({
      removeEnsembleMember: vi.fn(async () => {
        throw new Error("这个成员的分支还没有并回提交");
      }),
    });
    const page = renderPane({
      ensemble: makeEnsemble({ members: [makeMember("auth", { status: "working" })] }),
      session,
    });
    openMembers();

    const trigger = page.container.querySelector(".ensemble-mem-menu");
    if (!(trigger instanceof HTMLElement)) throw new Error("缺少成员菜单按钮");
    fireEvent.click(trigger);
    await screen.findByRole("menu", { name: "更多操作" });
    fireEvent.click(screen.getByRole("menuitem", { name: "移除" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("这个成员的分支还没有并回提交");
  });

  it("点击成员行打开会话，右键同样能打开移除菜单", async () => {
    const onOpenMember = vi.fn();
    const page = renderPane({
      ensemble: makeEnsemble({ members: [makeMember("auth", { status: "working" })] }),
      onOpenMember,
    });
    openMembers();

    const row = rowOf(page.container, "auth");
    if (row === undefined) throw new Error("缺少 auth 成员行");
    const main = row.querySelector(".ensemble-mem-main");
    if (!(main instanceof HTMLElement)) throw new Error("缺少成员行按钮");
    fireEvent.click(main);
    expect(onOpenMember).toHaveBeenCalledWith(expect.objectContaining({ name: "auth" }));

    // 点菜单按钮不打开会话
    const trigger = row.querySelector(".ensemble-mem-menu");
    if (!(trigger instanceof HTMLElement)) throw new Error("缺少成员菜单按钮");
    fireEvent.click(trigger);
    await screen.findByRole("menu", { name: "更多操作" });
    expect(onOpenMember).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    fireEvent.contextMenu(row);
    await screen.findByRole("menu", { name: "更多操作" });
    expect(screen.getByRole("menuitem", { name: "移除" })).not.toBeNull();
  });
});
