// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  EnsembleMemberPermission,
  EnsembleMemberView,
  EnsembleOverview,
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

function makeOverview(overrides: Partial<EnsembleOverview> = {}): EnsembleOverview {
  return {
    goal: "实现 REST API v1",
    checkpoints: ["所有验收标准通过", "无 lint 错误"],
    revision: 3,
    lines: [
      {
        id: "l1",
        title: "接入与配置",
        owner: "cli",
        progress: { text: "还差配置迁移", post: 7 },
        tasks: [
          { id: "t1", title: "provider 注册表", status: "done", owner: "cli" },
          { id: "t2", title: "配置迁移与兼容", status: "done", owner: "cli" },
        ],
      },
      {
        id: "l2",
        title: "派单与续派",
        owner: "runtime",
        post: 5,
        tasks: [
          { id: "t3", title: "任务单 schema", status: "todo", owner: "runtime" },
          { id: "t4", title: "失败重派策略", status: "work", owner: "runtime", post: 6 },
        ],
      },
      {
        id: "l3",
        title: "桌面体验",
        owner: "web",
        progress: { text: "等待 shell 稳定 API", wait: true },
        tasks: [
          { id: "t5", title: "连接状态页", status: "todo", owner: "web" },
          { id: "t6", title: "重启恢复演示", status: "todo", owner: "web" },
        ],
      },
    ],
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
  boardNonce?: number;
}) {
  const session = options.session ?? makeSession();
  const onOpenMember = options.onOpenMember ?? vi.fn();
  const onSelectMaestro = options.onSelectMaestro ?? vi.fn();
  const element = (ensemble: EnsembleView, visible: boolean, nonce?: number) => (
    <EnsemblePane
      ensemble={ensemble}
      session={session}
      openUrl={vi.fn()}
      onOpenMember={onOpenMember}
      onSelectMaestro={onSelectMaestro}
      visible={visible}
      boardNonce={nonce ?? options.boardNonce ?? 0}
    />
  );
  const page = render(element(options.ensemble, options.visible ?? true));
  return {
    ...page,
    session,
    onOpenMember,
    onSelectMaestro,
    show: (ensemble: EnsembleView, visible = true, nonce?: number) => {
      page.rerender(element(ensemble, visible, nonce));
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

function openBoard() {
  fireEvent.click(screen.getByRole("tab", { name: "留言板" }));
}

function openMembers() {
  fireEvent.click(screen.getByRole("tab", { name: "成员" }));
}

function openOverview() {
  fireEvent.click(screen.getByRole("tab", { name: "概览" }));
}

describe("Ensemble 面板页签与概览", () => {
  it("通用入口默认落在概览页签，点击页签切换", () => {
    renderPane({ ensemble: makeEnsemble({ overview: makeOverview() }) });
    expect(screen.getByRole("tab", { name: "概览" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "留言板" }).getAttribute("aria-selected")).toBe("false");

    openBoard();
    expect(screen.getByRole("tab", { name: "留言板" }).getAttribute("aria-selected")).toBe("true");
    openMembers();
    expect(screen.getByRole("tab", { name: "成员" }).getAttribute("aria-selected")).toBe("true");
    openOverview();
    expect(screen.getByRole("tab", { name: "概览" }).getAttribute("aria-selected")).toBe("true");
  });

  it("首次打开就带着 boardNonce（/ensemble board 直达）时落在留言板页签", () => {
    renderPane({
      ensemble: makeEnsemble({ overview: makeOverview() }),
      boardNonce: 3,
    });
    expect(screen.getByRole("tab", { name: "留言板" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "概览" }).getAttribute("aria-selected")).toBe("false");
  });

  it("boardNonce 变化时强制切到留言板页签", () => {
    const page = renderPane({
      ensemble: makeEnsemble({ overview: makeOverview() }),
      boardNonce: 0,
    });
    expect(screen.getByRole("tab", { name: "概览" }).getAttribute("aria-selected")).toBe("true");
    page.show(makeEnsemble({ overview: makeOverview() }), true, 1);
    expect(screen.getByRole("tab", { name: "留言板" }).getAttribute("aria-selected")).toBe("true");
  });

  it("概览显示目标、检查点、进度条与默认展开规则：首条进行中的线展开", () => {
    const page = renderPane({
      ensemble: makeEnsemble({ overview: makeOverview() }),
    });
    expect(page.container.textContent).toContain("实现 REST API v1");
    expect(texts(page.container, ".ensemble-ov-cps li")).toEqual([
      "检查点所有验收标准通过",
      "检查点无 lint 错误",
    ]);
    expect(page.container.textContent).toContain("2/6");

    const lines = nodes(page.container, ".ensemble-line");
    expect(lines).toHaveLength(3);
    // l2 有进行中任务 → 默认展开；l1 全部完成 → 收起；l3 在等待线后 → 收起
    expect(lines[0]?.classList.contains("open")).toBe(false);
    expect(lines[1]?.classList.contains("open")).toBe(true);
    expect(lines[2]?.classList.contains("open")).toBe(false);
    // 展开线内任务按 待办→进行中 排序（ADR-0131 §6）
    expect(texts(lines[1] as HTMLElement, ".ensemble-task-ttl")).toEqual([
      "任务单 schema",
      "失败重派策略进行中",
    ]);
    expect(texts(lines[1] as HTMLElement, ".ensemble-owner > span:last-child")).toEqual([
      "@runtime",
      "@runtime",
    ]);
    // 线头负责人为头像组，帖号引用在进展行右端
    expect(lines[1]?.querySelectorAll(".ensemble-line-owners .ensemble-av").length).toBeGreaterThan(
      0,
    );
    expect(lines[1]?.querySelector(".ensemble-line-head .ensemble-postref")?.textContent).toBe(
      "#5",
    );
    // 等待中的线显示 time 图标与 warning 进度
    expect(lines[2]?.classList.contains("wait")).toBe(true);
    expect(lines[2]?.querySelector(".ensemble-line-progress")?.textContent).toContain(
      "等待 shell 稳定 API",
    );
    expect(lines[0]?.querySelector(".ensemble-line-progress")?.textContent).toContain(
      "还差配置迁移",
    );
    expect(lines[0]?.querySelector(".ensemble-line-progress .ensemble-postref")?.textContent).toBe(
      "#7",
    );
  });

  it("手动折叠后不强制展开，数据刷新保持用户选择", () => {
    const page = renderPane({
      ensemble: makeEnsemble({ overview: makeOverview() }),
    });
    const toggleOf = (index: number) =>
      nodes(page.container, ".ensemble-line-head")[index] as HTMLElement;
    // 折叠默认展开的 l2
    fireEvent.click(toggleOf(1));
    expect(nodes(page.container, ".ensemble-line")[1]?.classList.contains("open")).toBe(false);
    // 展开 l1
    fireEvent.click(toggleOf(0));
    expect(nodes(page.container, ".ensemble-line")[0]?.classList.contains("open")).toBe(true);
    expect(nodes(page.container, ".ensemble-line")[0]?.textContent).toContain("provider 注册表");

    // 实时刷新（数据更新）：折叠/展开保持
    const updated = makeOverview({ revision: 4 });
    page.show(makeEnsemble({ overview: updated }));
    expect(nodes(page.container, ".ensemble-line")[1]?.classList.contains("open")).toBe(false);
    expect(nodes(page.container, ".ensemble-line")[0]?.classList.contains("open")).toBe(true);
  });

  it("实时刷新保留页签与草稿", async () => {
    const page = renderPane({
      ensemble: makeEnsemble({ overview: makeOverview(), posts: [makePost(1)] }),
    });
    openBoard();
    const field = screen.getByRole("textbox", { name: "留言板" }) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "还没写完的草稿" } });
    // 新帖到达：页签与草稿都保留
    page.show(makeEnsemble({ overview: makeOverview(), posts: [makePost(1), makePost(2)] }));
    expect(screen.getByRole("tab", { name: "留言板" }).getAttribute("aria-selected")).toBe("true");
    expect(field.value).toBe("还没写完的草稿");
  });

  it("createdSeq 变化（新一场合奏）时页签与展开状态重置为默认", () => {
    const first = makeEnsemble({ overview: makeOverview(), posts: [makePost(1)] });
    const page = renderPane({ ensemble: first });
    openBoard();
    expect(screen.getByRole("tab", { name: "留言板" }).getAttribute("aria-selected")).toBe("true");
    // 新一场合奏：回到概览
    page.show(makeEnsemble({ createdSeq: 10, overview: makeOverview() }));
    expect(screen.getByRole("tab", { name: "概览" }).getAttribute("aria-selected")).toBe("true");
  });

  it("无概览的旧合奏降级显示标题、结束摘要与成员入口", () => {
    const onOpenMember = vi.fn();
    const page = renderPane({
      ensemble: makeEnsemble({
        status: "ended",
        summary: "全部工作并回完成",
        members: [makeMember("users")],
      }),
      onOpenMember,
    });
    expect(page.container.querySelector(".ensemble-legacy")).not.toBeNull();
    expect(page.container.textContent).toContain("API 输入校验");
    expect(page.container.textContent).toContain("全部工作并回完成");
    // 成员入口仍可点击
    const main = page.container.querySelector(".ensemble-mem-main");
    if (!(main instanceof HTMLElement)) throw new Error("缺少成员入口");
    fireEvent.click(main);
    expect(onOpenMember).toHaveBeenCalled();
  });

  it("结束后输入框消失，概览保留任务与结束摘要", () => {
    const page = renderPane({
      ensemble: makeEnsemble({
        status: "ended",
        overview: makeOverview(),
        summary: "done",
      }),
    });
    expect(screen.queryByRole("textbox", { name: "留言板" })).toBeNull();
    expect(page.container.textContent).toContain("结束摘要");
    expect(nodes(page.container, ".ensemble-line")).toHaveLength(3);
    expect(page.container.textContent).toContain("已结束");
  });
});

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
    openBoard();

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
    expect(page.container.querySelector(".ensemble-post.sys .ensemble-sys-text")?.textContent).toBe(
      "Quiet reminder: @maestro 没有新帖\n请继续",
    );
    expect(page.container.querySelector(".ensemble-post.user")).not.toBeNull();
  });

  it("常驻搜索框过滤并高亮命中，计数显示 命中/总数", () => {
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
    openBoard();

    const input = screen.getByRole("textbox", { name: "搜索留言" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "hello" } });
    expect(nodes(page.container, ".ensemble-post")).toHaveLength(1);
    // 命中高亮为 mark.ensemble-hit，保留原大小写
    const hits = nodes(page.container, "mark.ensemble-hit");
    expect(hits.map((el) => el.textContent)).toEqual(["Hello"]);
    // 计数 1/3
    expect(page.container.querySelector(".ensemble-meta")?.textContent).toBe("1/3");

    fireEvent.change(input, { target: { value: "runtime" } });
    expect(nodes(page.container, ".ensemble-post")).toHaveLength(1);
    expect(page.container.querySelector(".ensemble-post-txt")?.textContent).toContain(
      "Quiet reminder",
    );

    fireEvent.change(input, { target: { value: "" } });
    expect(nodes(page.container, ".ensemble-post")).toHaveLength(3);
    expect(page.container.querySelector(".ensemble-meta")?.textContent).toBe("3");
  });

  it("筛选按钮带计数徽标，展开面板内 来自/发给 单选，选择后折叠处显示可移除的条件 chip", async () => {
    const page = renderPane({
      ensemble: makeEnsemble({
        members: [makeMember("users"), makeMember("orders")],
        posts: [
          makePost(1, {
            from: "users",
            fromKind: "member",
            recipients: ["maestro"],
            text: "users 汇报",
          }),
          makePost(2, { recipients: ["orders"], text: "请 orders 复核" }),
          makePost(3, { recipients: ["maestro"], text: "整体进度" }),
        ],
      }),
    });
    openBoard();

    const filterButton = screen.getByRole("button", { name: "筛选" });
    expect(filterButton.getAttribute("aria-expanded")).toBe("false");
    expect(page.container.querySelector(".ensemble-filter-n")).toBeNull();

    fireEvent.click(filterButton);
    expect(filterButton.getAttribute("aria-expanded")).toBe("true");
    const pop = page.container.querySelector(".ensemble-filterpop");
    expect(pop).not.toBeNull();
    expect(pop?.textContent).toContain("来自");
    expect(pop?.textContent).toContain("发给");

    // 打开「来自」菜单选 @users
    const selectors = nodes(pop as HTMLElement, ".ensemble-dd-main");
    fireEvent.click(selectors[0] as HTMLElement);
    const menu = await screen.findByRole("menu", { name: "来自" });
    const labels = Array.from(menu.querySelectorAll(".menu-label")).map((el) => el.textContent);
    expect(labels).toEqual(["全部", "指挥", "@users", "@orders"]);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "@users" }));
    await waitFor(() => {
      expect(nodes(page.container, ".ensemble-post")).toHaveLength(1);
    });
    expect(page.container.querySelector(".ensemble-post-txt")?.textContent).toContain("users 汇报");
    expect(page.container.querySelector(".ensemble-filter-n")?.textContent).toBe("1");

    // 收起筛选面板：显示条件 chip
    fireEvent.click(filterButton);
    expect(page.container.querySelector(".ensemble-filterpop")).toBeNull();
    const chips = nodes(page.container, ".ensemble-fchip");
    expect(chips.map((el) => el.textContent)).toEqual(["来自 @users"]);
    expect(screen.getByRole("button", { name: "清除筛选" })).not.toBeNull();

    // 单独移除条件 chip：回到未筛选
    fireEvent.click(screen.getByRole("button", { name: "移除作者筛选" }));
    expect(nodes(page.container, ".ensemble-post")).toHaveLength(3);
    expect(nodes(page.container, ".ensemble-fchip")).toHaveLength(0);
  });

  it("来自+发给 交集筛选；清除筛选按钮一次清空两个条件", async () => {
    const page = renderPane({
      ensemble: makeEnsemble({
        members: [makeMember("runtime"), makeMember("cli")],
        posts: [
          makePost(1, {
            from: "runtime",
            fromKind: "runtime",
            recipients: ["maestro"],
            text: "run-114 在重启后恢复失败",
          }),
          makePost(2, {
            from: "runtime",
            fromKind: "runtime",
            recipients: ["cli"],
            text: "runtime 发给 cli",
          }),
          makePost(3, {
            from: "cli",
            fromKind: "member",
            recipients: ["maestro"],
            text: "cli 汇报重启",
          }),
        ],
      }),
    });
    openBoard();

    const filterButton = screen.getByRole("button", { name: "筛选" });
    fireEvent.click(filterButton);
    const pop = () => page.container.querySelector(".ensemble-filterpop") as HTMLElement;

    // 来自 @runtime
    fireEvent.click(nodes(pop(), ".ensemble-dd-main")[0] as HTMLElement);
    await screen.findByRole("menu", { name: "来自" });
    fireEvent.click(screen.getByRole("menuitemradio", { name: "@runtime" }));

    // 发给 指挥（选完「来自」后筛选面板保持展开）
    await waitFor(() => {
      expect(pop()).not.toBeNull();
    });
    fireEvent.click(nodes(pop(), ".ensemble-dd-main")[1] as HTMLElement);
    await screen.findByRole("menu", { name: "发给" });
    fireEvent.click(screen.getByRole("menuitemradio", { name: "指挥" }));

    await waitFor(() => {
      expect(nodes(page.container, ".ensemble-post")).toHaveLength(1);
    });
    expect(page.container.querySelector(".ensemble-post-txt")?.textContent).toContain(
      "run-114 在重启后恢复失败",
    );
    expect(page.container.querySelector(".ensemble-meta")?.textContent).toBe("1/3");
    expect(page.container.querySelector(".ensemble-filter-n")?.textContent).toBe("2");

    // 清除筛选（面板内按钮）：条件与过滤全部清空
    const clears = Array.from(pop().querySelectorAll<HTMLElement>(".ensemble-fclear"));
    fireEvent.click(clears[0] as HTMLElement);
    expect(nodes(page.container, ".ensemble-post")).toHaveLength(3);
    expect(page.container.querySelector(".ensemble-filter-n")).toBeNull();
  });

  it("跟随最新默认开启，往上滚自动关闭；筛选面板内开关与跳底按钮都能重新开启并滚到底", () => {
    const page = renderPane({ ensemble: makeEnsemble({ posts: [makePost(1), makePost(2)] }) });
    openBoard();
    const body = scrollableBody(page.container, 600);

    // 开关在展开的筛选面板里（ADR-0131 §6 独立开关）
    fireEvent.click(screen.getByRole("button", { name: "筛选" }));
    const follow = () => screen.getByRole("switch", { name: "跟随最新" });
    expect(follow().getAttribute("aria-checked")).toBe("true");
    // 跟随中不显示跳底按钮
    expect(screen.queryByRole("button", { name: "回到最新" })).toBeNull();

    page.show(makeEnsemble({ posts: [makePost(1), makePost(2), makePost(3)] }));
    expect(body.scrollTop).toBe(600);

    body.scrollTop = 100;
    fireEvent.scroll(body);
    expect(follow().getAttribute("aria-checked")).toBe("false");
    // 关闭跟随后出现跳底按钮
    expect(screen.getByRole("button", { name: "回到最新" })).not.toBeNull();

    page.show(makeEnsemble({ posts: [makePost(1), makePost(2), makePost(3), makePost(4)] }));
    expect(body.scrollTop).toBe(100);

    // 点跳底按钮：重新开启并滚到底
    fireEvent.click(screen.getByRole("button", { name: "回到最新" }));
    expect(follow().getAttribute("aria-checked")).toBe("true");
    expect(body.scrollTop).toBe(600);

    fireEvent.wheel(body, { deltaY: -12 });
    expect(follow().getAttribute("aria-checked")).toBe("false");

    // 点面板内开关：重新开启并滚到底
    fireEvent.click(follow());
    expect(follow().getAttribute("aria-checked")).toBe("true");
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
    openBoard();

    expect(texts(page.container, ".ensemble-charter-tag")).toEqual(["负责", "不碰", "完成"]);
    expect(texts(page.container, ".ensemble-charter-row")).toEqual([
      "负责auth 输入校验",
      "不碰orders 的表结构",
      "完成pnpm test 全绿",
    ]);
    expect(page.container.textContent).not.toContain("Owns:");
    expect(nodes(page.container, ".ensemble-post-txt")).toHaveLength(1);
  });

  it("任务书帖标题行显示 → @成员名，与普通帖样式一致，带收件人时不重复", () => {
    const page = renderPane({
      ensemble: makeEnsemble({
        members: [makeMember("impl-1"), makeMember("review-1"), makeMember("qa-1")],
        posts: [
          makePost(1, { charterOf: "impl-1", mentions: [], recipients: [] }),
          makePost(2, {
            charterOf: "review-1",
            mentions: ["review-1"],
            recipients: ["review-1"],
          }),
          makePost(3, {
            charterOf: "qa-1",
            mentions: ["review-1"],
            recipients: ["review-1"],
          }),
          makePost(4, { mentions: [], recipients: [], text: "普通公告" }),
          makePost(5, { mentions: ["impl-1"], recipients: ["impl-1"], text: "@impl-1 开始吧" }),
        ],
      }),
    });
    openBoard();

    const posts = nodes(page.container, ".ensemble-post");
    expect(posts).toHaveLength(5);
    expect(posts.map((el) => el.querySelector(".ensemble-post-from")?.textContent)).toEqual([
      "指挥",
      "指挥",
      "指挥",
      "指挥",
      "指挥",
    ]);
    expect(posts.map((el) => el.querySelector(".ensemble-post-to")?.textContent ?? null)).toEqual([
      " → @impl-1",
      " → @review-1",
      " → @qa-1 @review-1",
      null,
      " → @impl-1",
    ]);
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
    openBoard();

    expect(texts(page.container, ".ensemble-at")).toEqual(["@users", "@all"]);
    expect(page.container.querySelector("code .ensemble-at")).toBeNull();
    expect(page.container.querySelector("code")?.textContent).toBe("@users");
  });

  it("留言板输入框 Enter 发送、Shift+Enter 换行、组字中不发送", async () => {
    const session = makeSession();
    renderPane({ ensemble: makeEnsemble(), session });
    openBoard();
    const field = screen.getByRole("textbox", { name: "留言板" }) as HTMLTextAreaElement;

    fireEvent.change(field, { target: { value: "   " } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(session.postToEnsemble).not.toHaveBeenCalled();

    fireEvent.change(field, { target: { value: "请先看 auth" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() =>
      expect(session.postToEnsemble).toHaveBeenCalledWith({ text: "请先看 auth" }),
    );
    await waitFor(() => expect(field.value).toBe(""));

    fireEvent.change(field, { target: { value: "第二行" } });
    fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
    expect(session.postToEnsemble).toHaveBeenCalledTimes(1);
    expect(field.value).toBe("第二行");

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
    openBoard();
    const field = screen.getByRole("textbox", { name: "留言板" }) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "要不要并回" } });
    fireEvent.keyDown(field, { key: "Enter" });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("ensemble 已结束，无法发帖");
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
    openBoard();
    const field = screen.getByRole("textbox", { name: "留言板" }) as HTMLTextAreaElement;

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

    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(session.postToEnsemble).not.toHaveBeenCalled();
    expect(field.value).toBe("@api-1 ");
    expect(screen.queryByRole("listbox")).toBeNull();

    fireEvent.change(field, { target: { value: "@api-1 请问 @d", selectionStart: 12 } });
    const filtered = screen.getByRole("listbox", { name: "提及补全" });
    expect(
      Array.from(filtered.querySelectorAll(".ensemble-ac-name")).map((e) => e.textContent),
    ).toEqual(["data-1"]);
    fireEvent.keyDown(field, { key: "Tab" });
    expect(field.value).toBe("@api-1 请问 @data-1 ");

    fireEvent.change(field, { target: { value: "@zzz", selectionStart: 4 } });
    expect(screen.queryByRole("listbox")).toBeNull();

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

    page.show(makeEnsemble({ status: "ended", posts: [makePost(1)] }));
    expect(screen.queryByRole("button", { name: "更多操作" })).toBeNull();
    openBoard();
    expect(screen.queryByRole("textbox", { name: "留言板" })).toBeNull();
  });

  it("成员行的溢出菜单与右键都打开移除菜单", async () => {
    const session = makeSession();
    const page = renderPane({
      ensemble: makeEnsemble({
        members: [makeMember("users", { status: "working" }), makeMember("docs")],
      }),
      session,
    });
    openMembers();

    const row = rowOf(page.container, "users");
    if (row === undefined) throw new Error("缺少成员行");
    const more = row.querySelector(".ensemble-mem-menu");
    if (!(more instanceof HTMLElement)) throw new Error("缺少更多按钮");
    fireEvent.click(more);
    await screen.findByRole("menu", { name: "更多操作" });
    fireEvent.click(screen.getByRole("menuitem", { name: "移除" }));
    await waitFor(() => expect(session.removeEnsembleMember).toHaveBeenCalledWith("users"));

    // 右键菜单同样可用
    fireEvent.contextMenu(rowOf(page.container, "users") as HTMLElement);
    await screen.findByRole("menu", { name: "更多操作" });
    fireEvent.click(screen.getByRole("menuitem", { name: "移除" }));
    await waitFor(() => expect(session.removeEnsembleMember).toHaveBeenCalledTimes(2));

    // 已结束的合奏不再出现更多按钮，也不能右键移除
    page.show(
      makeEnsemble({
        status: "ended",
        members: [makeMember("users", { status: "waiting" })],
      }),
    );
    expect(rowOf(page.container, "users")?.querySelector(".ensemble-mem-menu")).toBeNull();
    fireEvent.contextMenu(rowOf(page.container, "users") as HTMLElement);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("移除/结束失败时在页签行下方显示错误", async () => {
    const session = makeSession({
      endEnsemble: vi.fn(async () => {
        throw new Error("end failed");
      }),
    });
    renderPane({ ensemble: makeEnsemble({ posts: [makePost(1)] }), session });
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    await screen.findByRole("menu", { name: "更多操作" });
    fireEvent.click(screen.getByRole("menuitem", { name: "结束" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("end failed");
  });
});
