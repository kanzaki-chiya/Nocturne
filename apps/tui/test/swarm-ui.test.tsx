/**
 * Swarm 的 TUI 界面（tui.md §2、§6；ADR-0089）：工具行标签、帖子送达头部、
 * 输入框下方的状态块、/swarm board 留言板与成员会话切换。
 * 纯函数直接断言；界面用 ink-testing-library 渲染完整 App，Swarm 由离线 FakeProvider 驱动。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { render } from "ink-testing-library";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createRuntime,
  FakeProvider,
  replaySessionView,
  type FakeScript,
  type Runtime,
  type RuntimeSession,
} from "@nocturne/core";
import {
  createSessionView,
  type SwarmMemberView,
  type SwarmPostView,
  type SwarmView,
  type ViewEntry,
} from "@nocturne/core/protocol";

import { App } from "../src/app.js";
import { SwarmBoard, boardSideItems, type SwarmBoardProps } from "../src/components/swarm-board.js";
import { SwarmStrip, swarmStripRows } from "../src/components/swarm-strip.js";
import { layoutEntry, transcriptBlocks } from "../src/lines.js";
import { NOTIFY_DEFAULTS, swarmMemberRing } from "../src/notify.js";
import {
  filterSwarmPosts,
  splitSwarmMentions,
  swarmActivityText,
  swarmToolSummary,
  toolDisplayName,
} from "../src/text-format-swarm.js";
import { palettes } from "../src/theme.js";
import { settle as settleRaw } from "./provider-test-utils.js";

// 与 session-search 同法：把 Ink 用的 chalk 调到真彩色，才能断言强调色
const inkChalkPromise = (async (): Promise<{ level: 0 | 1 | 2 | 3 }> => {
  const req = createRequire(import.meta.resolve("ink"));
  const mod = (await import(pathToFileURL(req.resolve("chalk")).href)) as {
    default: { level: 0 | 1 | 2 | 3 };
  };
  return mod.default;
})();
let savedChalkLevel: 0 | 1 | 2 | 3 = 0;
const fg = (hex: string): string => {
  const n = Number.parseInt(hex.slice(1), 16);
  return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
};

const dirs: string[] = [];
const temp = (prefix = "nct-swarm-ui-") => {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
beforeEach(async () => {
  const chalk = await inkChalkPromise;
  savedChalkLevel = chalk.level;
  chalk.level = 3;
  vi.stubEnv("NOCTURNE_HOME", temp());
});
afterEach(async () => {
  (await inkChalkPromise).level = savedChalkLevel;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const ENV = { ascii: false, animated: false };
const pause = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
/** 超时时把当前帧带进报错 */
let currentFrame: (() => string) | undefined;
async function settle(check: () => boolean): Promise<void> {
  try {
    await settleRaw(check);
  } catch (e) {
    throw new Error(
      `${e instanceof Error ? e.message : String(e)}\n当前帧：\n${currentFrame?.() ?? ""}`,
    );
  }
}
/**
 * Ink 的 useInput 在组件挂载后的 effect 里订阅，且一次 stdin.write 只解析成一个按键：
 * 每个键单独写，先等订阅接上，再留一个 tick 让 React 提交状态。
 */
async function press(ui: ReturnType<typeof render>, data: string): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  ui.stdin.write(data);
  await new Promise<void>((resolve) => setImmediate(resolve));
}
async function keys(ui: ReturnType<typeof render>, ...seq: string[]): Promise<void> {
  for (const data of seq) await press(ui, data);
}

const CHARTER = {
  owns: "src/orders.ts",
  handsOff: "src/users.ts",
  doneWhen: "orders tests pass",
};

function member(name: string, over: Partial<SwarmMemberView> = {}): SwarmMemberView {
  return {
    name,
    childSessionId: `child-${name}`,
    charter: CHARTER,
    model: { provider: "fake", model: `model-${name}` },
    preset: "general",
    isolated: false,
    status: "waiting",
    pendingPermissions: [],
    ...over,
  };
}

function post(n: number, over: Partial<SwarmPostView> = {}): SwarmPostView {
  return {
    seq: n,
    time: "2026-11-12T13:52:00.000Z",
    number: n,
    from: "coordinator",
    fromKind: "coordinator",
    text: `第 ${n} 帖`,
    mentions: [],
    recipients: [],
    ...over,
  };
}

function swarmView(over: Partial<SwarmView> = {}): SwarmView {
  return {
    createdSeq: 1,
    title: "API 输入校验",
    status: "active",
    coordinator: { model: undefined, status: "working", awaitingPermission: false },
    members: [],
    awaitingPermissionMembers: [],
    posts: [],
    ...over,
  };
}

// ── 纯函数 ───────────────────────────────────────────────

describe("工具行与文案", () => {
  it("七个 Swarm 工具用与桌面端相同的标签，其余工具沿用名字", () => {
    expect(
      [
        "swarm_init",
        "swarm_add_member",
        "swarm_post",
        "swarm_change_model",
        "swarm_remove_member",
        "swarm_end",
        "swarm_checkout",
      ].map(toolDisplayName),
    ).toEqual(["合奏", "添加", "发帖", "换模型", "移除", "结束", "检出"]);
    expect(toolDisplayName("shell")).toBe("shell");
    expect(swarmToolSummary("swarm_add_member", { name: "orders" })).toBe("@orders");
    expect(swarmToolSummary("swarm_change_model", { name: "orders", model: "p/m-2" })).toBe(
      "@orders m-2",
    );
    expect(swarmToolSummary("swarm_post", { text: "\n首行\n次行" })).toBe("首行");
    expect(swarmToolSummary("shell", { command: "ls" })).toBeUndefined();
  });

  it("工具行头部：全屏布局显示标签与参数，而不是工具名", () => {
    const entry: ViewEntry = {
      kind: "tool",
      key: "t1",
      turnId: "turn",
      callId: "c1",
      name: "swarm_add_member",
      seq: 3,
      status: "ok",
      input: { name: "orders", charter: CHARTER },
      subjects: [],
      permission: undefined,
      resolution: undefined,
      liveOutput: "",
      result: {
        status: "ok",
        modelContent: "",
        output: undefined,
        error: undefined,
        truncated: false,
        spillPath: undefined,
        durationMs: 1,
      },
    };
    const head = layoutEntry(entry, 80, false)[0]?.text ?? "";
    expect(head).toContain("✓ 添加 @orders");
    expect(head).not.toContain("swarm_add_member");
  });

  it("活动摘要：tool 用工具行动词加 detail，permission 是「等待确认：target」，paused 用 Runtime 原文首行", () => {
    expect(swarmActivityText({ kind: "tool", tool: "shell", detail: "pnpm test" })).toBe(
      "shell pnpm test",
    );
    expect(swarmActivityText({ kind: "tool", tool: "swarm_post" })).toBe("发帖");
    expect(swarmActivityText({ kind: "permission", target: "pnpm add zod" })).toBe(
      "等待确认：pnpm add zod",
    );
    expect(swarmActivityText({ kind: "permission" })).toBe("等待确认");
    expect(
      swarmActivityText({ kind: "paused", code: "provider_error", message: "限流\n详情" }),
    ).toBe("限流");
    expect(swarmActivityText({ kind: "paused", code: "provider_error", message: "" })).toBe(
      "provider_error",
    );
  });

  it("正文只强调 mentions 里的词：其他 @ 词与邮箱不强调，coordinator 对应 @协调者", () => {
    const parts = splitSwarmMentions("@orders 看 @users 和 a@orders 再找 @协调者", [
      "orders",
      "coordinator",
    ]);
    expect(parts.filter((p) => p.mention).map((p) => p.text)).toEqual(["@orders", "@协调者"]);
    expect(parts.map((p) => p.text).join("")).toBe("@orders 看 @users 和 a@orders 再找 @协调者");
  });

  it("按成员筛选：from 等于他或 recipients 含他；「全部」列出全部", () => {
    const posts = [
      post(1, { recipients: ["orders"] }),
      post(2, { from: "orders", fromKind: "member", recipients: ["coordinator"] }),
      post(3, { recipients: ["users"] }),
    ];
    expect(filterSwarmPosts(posts, "orders").map((p) => p.number)).toEqual([1, 2]);
    expect(filterSwarmPosts(posts, "all").map((p) => p.number)).toEqual([1, 2, 3]);
  });

  it("成员待确认响铃：订阅快照只登记；之后新出现的 requestId 响一次；正在看的成员不重复响", () => {
    const seen = new Set<string>();
    const updated = (eseq: number, name: string, ids: string[]) =>
      ({
        type: "swarm.member_updated",
        sessionId: "s",
        runId: "r",
        eseq,
        afterSeq: 0,
        time: "t",
        payload: {
          name,
          status: "working",
          pendingPermissions: ids.map((requestId) => ({
            requestId,
            callId: requestId,
            reason: "",
            subjects: [],
            options: [],
          })),
        },
      }) as const;
    const ctx = { focused: false };
    expect(swarmMemberRing(updated(0, "orders", ["old"]), seen, ctx, NOTIFY_DEFAULTS)).toBe(false);
    expect(swarmMemberRing(updated(5, "orders", ["old"]), seen, ctx, NOTIFY_DEFAULTS)).toBe(false);
    expect(swarmMemberRing(updated(6, "orders", ["old", "new"]), seen, ctx, NOTIFY_DEFAULTS)).toBe(
      true,
    );
    expect(swarmMemberRing(updated(7, "orders", ["new"]), seen, ctx, NOTIFY_DEFAULTS)).toBe(false);
    expect(
      swarmMemberRing(
        updated(8, "users", ["u1"]),
        seen,
        { focused: false, viewing: "users" },
        NOTIFY_DEFAULTS,
      ),
    ).toBe(false);
    expect(
      swarmMemberRing(updated(9, "users", ["u2"]), seen, { focused: true }, NOTIFY_DEFAULTS),
    ).toBe(false);
  });
});

describe("帖子送达", () => {
  const delivered = (fromKind: "member" | "coordinator" | "user" | "runtime", from: string) =>
    ({
      kind: "user",
      key: "u1",
      seq: 9,
      content: [
        { type: "text", text: `<swarm-post n="4" from="${from}">\n第一行\n第二行\n</swarm-post>` },
      ],
      swarm: { postNumber: 4, from, fromKind },
    }) as unknown as ViewEntry;

  it("不按用户消息显示：强调色竖线 + `作者 → 本会话 · #n`，正文解包", () => {
    const lines = layoutEntry(
      delivered("member", "orders"),
      80,
      false,
      undefined,
      0,
      false,
      false,
      palettes.dark,
      {
        swarmRecipient: "@users",
      },
    );
    const text = lines.map((l) => l.text);
    expect(text[0]).toBe("│ @orders → @users · #4");
    expect(text.slice(1)).toEqual(["│ 第一行", "│ 第二行"]);
    expect(text.join("\n")).not.toContain("swarm-post");
    expect(text.join("\n")).not.toContain("›");
    expect(lines[0]?.segments?.[0]).toMatchObject({ text: "│ ", color: palettes.dark.accent });
  });

  it("作者：协调者、你、Runtime；协调者会话的接收者是「协调者」", () => {
    const head = (kind: "coordinator" | "user" | "runtime", from: string) =>
      layoutEntry(delivered(kind, from), 80, false)[0]?.text;
    expect(head("coordinator", "coordinator")).toBe("│ 协调者 → 协调者 · #4");
    expect(head("user", "user")).toBe("│ 你 → 协调者 · #4");
    expect(head("runtime", "runtime")).toBe("│ Runtime → 协调者 · #4");
  });
});

// ── 状态块与留言板组件 ────────────────────────────────────

describe("状态块", () => {
  it("只列 working、paused 与待确认成员，名字按最长对齐；首行是标题、最近一帖与帖子数", () => {
    const swarm = swarmView({
      members: [
        member("verifier", {
          status: "working",
          activity: { kind: "tool", tool: "shell", detail: "pnpm test" },
        }),
        member("products", {
          status: "working",
          pendingPermissions: [
            { requestId: "r", callId: "c", reason: "", subjects: [], options: [] },
          ],
          activity: { kind: "permission", target: "pnpm add zod" },
        }),
        member("users", { status: "waiting" }),
        member("ui", {
          status: "paused",
          activity: { kind: "paused", code: "x", message: "限流" },
        }),
        member("gone", { status: "removed" }),
      ],
      posts: [
        post(1),
        post(12, { from: "verifier", fromKind: "member", text: "运行 pnpm test\n下一行" }),
      ],
    });
    expect(swarmStripRows(swarm)).toBe(4);
    const ui = render(createElement(SwarmStrip, { swarm, width: 90, height: 10 }));
    const lines = strip(ui.lastFrame() ?? "").split("\n");
    expect(lines[0]).toMatch(/^◆ API 输入校验 {2}#12 @verifier: 运行 pnpm test +2 条$/);
    expect(lines).toHaveLength(4);
    expect(lines[1]).toBe("  ● verifier  model-verifier  shell pnpm test");
    expect(lines[2]).toBe("  ● products  model-products  等待确认：pnpm add zod");
    expect(lines[3]).toBe("  ● ui        model-ui        限流");
    expect((ui.lastFrame() ?? "").includes("users")).toBe(false);
    ui.unmount();
  });

  it("放不下时最后一行写 +N；Swarm 结束后整块不显示", () => {
    const members = ["a", "b", "c", "d"].map((n) => member(n, { status: "working" }));
    const ui = render(
      createElement(SwarmStrip, { swarm: swarmView({ members }), width: 80, height: 3 }),
    );
    const lines = strip(ui.lastFrame() ?? "").split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[2]?.trim()).toBe("+3");
    ui.unmount();
    expect(swarmStripRows(swarmView({ members, status: "ended" }))).toBe(0);
    const ended = render(
      createElement(SwarmStrip, {
        swarm: swarmView({ members, status: "ended" }),
        width: 80,
        height: 3,
      }),
    );
    expect(strip(ended.lastFrame() ?? "")).toBe("");
    ended.unmount();
  });
});

function boardSwarm(over: Partial<SwarmView> = {}): SwarmView {
  return swarmView({
    members: [
      member("verifier", { status: "working" }),
      member("products", {
        status: "working",
        pendingPermissions: [
          { requestId: "r", callId: "c", reason: "", subjects: [], options: [] },
        ],
      }),
      member("orders"),
      member("old", { status: "removed" }),
    ],
    posts: [
      post(1, {
        text: "任务书",
        charterOf: "orders",
        mentions: ["orders"],
        recipients: ["orders"],
      }),
      post(2, {
        from: "products",
        fromKind: "member",
        text: "交给 @verifier 和 @nobody",
        mentions: ["verifier"],
        recipients: ["verifier"],
      }),
      post(3, {
        from: "verifier",
        fromKind: "member",
        text: "@orders 返工",
        mentions: ["orders"],
        recipients: ["orders"],
      }),
    ],
    ...over,
  });
}

function renderBoard(swarm: SwarmView, over: Partial<SwarmBoardProps> = {}) {
  const mocks = {
    onClose: vi.fn<() => void>(),
    onPost: vi.fn<(text: string) => Promise<void>>(async () => undefined),
    onOpenMember: vi.fn<(childSessionId: string) => void>(),
    onOpenCoordinator: vi.fn<() => void>(),
  };
  const props: SwarmBoardProps = {
    swarm,
    width: 80,
    height: 22,
    active: true,
    ...mocks,
    ...over,
  };
  const ui = render(createElement(SwarmBoard, props));
  const frame = () => strip(ui.lastFrame() ?? "");
  currentFrame = frame;
  return { ui, props, frame, mocks };
}

describe("/swarm board", () => {
  it("左列顺序与状态点：全部、在场成员、已移除成员、协调者", () => {
    const items = boardSideItems(boardSwarm(), false);
    expect(items.map((i) => i.label)).toEqual([
      "全部",
      "verifier",
      "products",
      "orders",
      "old",
      "协调者",
    ]);
    expect(items.map((i) => i.dot?.text ?? "")).toEqual(["", "●", "●", "○", "○", "●"]);
    expect(items.map((i) => i.dot?.tone ?? "")).toEqual([
      "",
      "accent",
      "warning",
      "muted",
      "muted",
      "accent",
    ]);
    expect(items[4]?.tone).toBe("muted");
  });

  it("头部带帖子数与跟随；按成员筛选；只有 mentions 里的词被强调；任务书帖三段", async () => {
    const { ui, frame } = renderBoard(boardSwarm());
    expect(frame().split("\n")[0]).toBe("API 输入校验  3 条 · 跟随");
    // 跟随：选中最新一帖，详情是 #3
    expect(frame()).toContain("#3 @verifier → @orders  ");
    // 只有 mentions 里的 @orders 上强调色
    const raw = ui.lastFrame() ?? "";
    const accent = fg(palettes.dark.accent);
    expect(raw).toContain(`${accent}@orders`);
    // 往上移：退出跟随
    await press(ui, "\x1b[A");
    await settle(() => !frame().split("\n")[0]?.includes("跟随"));
    expect(frame()).toContain("交给 @verifier 和 @nobody");
    const raw2 = ui.lastFrame() ?? "";
    expect(raw2).toContain(`${accent}@verifier`);
    expect(raw2).not.toContain(`${accent}@nobody`);
    // 再往上是任务书帖：三段
    await press(ui, "\x1b[A");
    await settle(() => frame().includes("负责"));
    for (const word of [
      "负责",
      "src/orders.ts",
      "不碰",
      "src/users.ts",
      "完成",
      "orders tests pass",
    ])
      expect(frame()).toContain(word);
    // End 回到最新一帖并恢复跟随
    await press(ui, "\x1b[F");
    await settle(() => frame().split("\n")[0]?.includes("跟随") === true);
    // 成员列：选 products 只列他发的与发给他的
    await keys(ui, "\t", "\t", "\x1b[B", "\x1b[B");
    await settle(() => !frame().includes("#3 @verifier → @orders"));
    expect(frame()).toContain("#2");
    expect(frame()).not.toContain("#1 协调者");
    ui.unmount();
  });

  it("跟随状态下新帖到达自动选中最新一帖；退出跟随后不跳", async () => {
    const swarm = boardSwarm();
    const { ui, props, frame } = renderBoard(swarm);
    const next = boardSwarm({ posts: [...swarm.posts, post(4, { text: "第四帖正文" })] });
    ui.rerender(createElement(SwarmBoard, { ...props, swarm: next }));
    await settle(() => frame().includes("第四帖正文"));
    await press(ui, "\x1b[A");
    await settle(() => !frame().split("\n")[0]?.includes("跟随"));
    const five = boardSwarm({ posts: [...next.posts, post(5, { text: "第五帖正文" })] });
    ui.rerender(createElement(SwarmBoard, { ...props, swarm: five }));
    await pause();
    expect(frame()).not.toContain("第五帖正文");
    expect(frame()).toContain("@orders 返工");
    ui.unmount();
  });

  it("成员列 Enter 进成员会话，「协调者」行回协调者；输入框 Enter 发帖，失败显示原文", async () => {
    const onPost = vi.fn(async (text: string) => {
      if (text === "坏帖") throw new Error('Member "old" has been removed and cannot be woken.');
    });
    const { ui, props, frame, mocks } = renderBoard(boardSwarm(), { onPost });
    await keys(ui, "\x1b[Z", "\x1b[B", "\r"); // 帖子 → 成员，选 verifier，Enter
    await settle(() => mocks.onOpenMember.mock.calls.length === 1);
    expect(props.onOpenMember).toHaveBeenCalledWith("child-verifier");
    await keys(ui, "\x1b[A", "\x1b[A", "\r"); // 全部 → 协调者（循环），Enter
    await settle(() => mocks.onOpenCoordinator.mock.calls.length === 1);
    // 输入框
    await keys(ui, "\t", "\t");
    await press(ui, "@orders 再跑一次");
    await press(ui, "\r");
    await settle(() => onPost.mock.calls.length === 1);
    expect(onPost).toHaveBeenCalledWith("@orders 再跑一次");
    await press(ui, "坏帖");
    await press(ui, "\r");
    await settle(() => frame().includes('! Member "old" has been removed and cannot be woken.'));
    ui.unmount();
  });

  it("已结束的 Swarm 也能查看，但没有输入框", async () => {
    const { ui, frame, mocks } = renderBoard(boardSwarm({ status: "ended" }));
    expect(frame()).toContain("#3 @verifier → @orders");
    expect(frame().trimEnd().split("\n").at(-1)).not.toMatch(/^›/);
    ui.stdin.write("\t\t\t");
    await pause();
    ui.stdin.write("abc\r");
    await pause();
    expect(mocks.onPost).not.toHaveBeenCalled();
    ui.unmount();
  });

  it("帖子头剔除作者自身；发帖框支持 @ 补全（顺序、筛选、组提及、键盘填入不发帖、Esc 收起）", async () => {
    const onPost = vi.fn(async () => undefined);
    const swarm = boardSwarm({
      members: [
        member("api-1", { profile: "deep" }),
        member("api-2"),
        member("old", { status: "removed" }),
      ],
      posts: [
        post(1, {
          from: "api-1",
          fromKind: "member",
          mentions: ["coordinator", "api-1", "api-2"],
          recipients: ["coordinator", "api-2"],
          text: "@coordinator @api-1 @api-2 完成",
        }),
        post(2, {
          from: "coordinator",
          fromKind: "coordinator",
          mentions: ["coordinator"],
          recipients: [],
          text: "仅记一条 @coordinator",
        }),
      ],
    });
    const { ui, frame, mocks } = renderBoard(swarm, { onPost });
    expect(frame()).toContain("#2 协调者  ");
    expect(frame()).not.toContain("#2 协调者 →");

    // 切到输入框输入 @ 显示候选（不含已移除 old，含 @api 组）
    await press(ui, "\t");
    await press(ui, "@");
    await settle(() => frame().includes("model-api-2"));
    expect(frame()).not.toContain("model-old");

    // Esc 关闭弹层而不关闭留言板（等 Ink 50ms ESC 计时器 settle 后再输入）
    await press(ui, "\x1b");
    await pause(80);
    await settle(() => !frame().includes("model-api-2"));
    expect(mocks.onClose).not.toHaveBeenCalled();

    // 删除 @ 后重新输入 @a 筛选，向下选 api-2 后 Enter 填入：不发帖且末尾带空格
    await keys(ui, "\x7f", "@", "a");
    await settle(() => frame().includes("model-api-2"));
    await press(ui, "\x1b[B");
    await press(ui, "\r");
    await settle(() => frame().includes("@api-2 "));
    expect(onPost).not.toHaveBeenCalled();

    // 继续输入文本后 Enter 发帖
    await press(ui, "请看");
    await press(ui, "\r");
    await settle(() => onPost.mock.calls.length === 1);
    expect(onPost).toHaveBeenCalledWith("@api-2 请看");
    ui.unmount();
  });
});

// ── 完整 App：真实 Runtime 里的 Swarm ─────────────────────

const callTool = (id: string, name: string, input: unknown): FakeScript[number] => ({
  type: "tool_call",
  toolCallId: id,
  name,
  input,
});
const stopText = (text: string): FakeScript => [
  { type: "text_delta", text },
  { type: "finish", reason: "stop" },
];

/** 按系统提示区分协调者与成员；成员 orders 第一轮停在一个需要确认的 shell 调用上 */
async function swarmRuntime(
  blockSecondTurn?: Promise<FakeScript>,
): Promise<{ runtime: Runtime; session: RuntimeSession }> {
  let coordStarted = false;
  const provider = new FakeProvider({
    roleHandler: () => stopText("标题"),
    handler: (req) => {
      const sys = req.system.map((b) => b.text).join("\n");
      const who = /persistent ensemble member `@([a-z0-9-]+)`/.exec(sys)?.[1];
      if (who === undefined) {
        if (!coordStarted) {
          coordStarted = true;
          return [
            callTool("i", "swarm_init", { title: "订单校验" }),
            callTool("a1", "swarm_add_member", { name: "orders", charter: CHARTER }),
            callTool("a2", "swarm_add_member", { name: "users", charter: CHARTER }),
            callTool("p", "swarm_post", { text: "@orders 开始" }),
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return stopText("协调者收到");
      }
      if (who === "orders" && !req.messages.some((m) => m.role === "tool"))
        return [
          callTool("w", "shell", { command: "echo ok > approved.txt" }),
          { type: "finish", reason: "tool_calls" },
        ];
      // 成员第二轮用外部 gate 卡住：断言期间成员 Turn 一定还在进行
      if (who === "orders" && blockSecondTurn !== undefined) return blockSecondTurn;
      return stopText(`${who} 完成`);
    },
  });
  const ws = temp();
  const runtime = await createRuntime({
    cwd: ws,
    workspaceRoot: ws,
    sessionsDir: temp(),
    providers: [provider],
    interactive: true,
    subagent: { background: true },
  });
  const session = await runtime.createSession({
    model: "fake/fake-1",
    permissionPreset: "default",
  });
  return { runtime, session };
}

describe("App 里的 Swarm", () => {
  it("状态块随 Swarm 出现；board 进出成员会话不 close 协调者、不 interrupt 成员；回到协调者状态块仍在；/swarm end 后整块消失", async () => {
    const { runtime, session } = await swarmRuntime();
    const coordClose = vi.spyOn(session, "close");
    const coordInterrupt = vi.spyOn(session, "interrupt");
    const ui = render(createElement(App, { session, runtime, env: ENV, inline: false }));
    const frame = () => strip(ui.lastFrame() ?? "");
    currentFrame = frame;
    const enter = async (value: string) => {
      ui.stdin.write(value);
      await pause(100);
      ui.stdin.write("\r");
    };
    let orders: RuntimeSession | undefined;
    try {
      await settle(() => frame().includes("fake-1"));
      await enter("/swarm 校验订单");
      // 状态块：orders 等确认
      await vi.waitFor(() => expect(frame()).toContain("◆ 订单校验"), { timeout: 8000 });
      await vi.waitFor(
        () => expect(frame()).toMatch(/● orders +fake-1 +等待确认：echo ok > approved\.txt/),
        {
          timeout: 8000,
        },
      );
      expect(frame()).not.toMatch(/● users/);
      // 对话里的工具行标签
      expect(frame()).toContain("合奏 订单校验");
      expect(frame()).toContain("添加 @orders");
      expect(frame()).toContain("发帖 @orders 开始");

      const view = replaySessionView(session.durableEvents());
      const child = view.swarm?.members.find((m) => m.name === "orders")?.childSessionId ?? "";
      orders = await runtime.resumeSession(child);
      const memberInterrupt = vi.spyOn(orders, "interrupt");
      const memberClose = vi.spyOn(orders, "close");

      // board：成员列选 orders，Enter 进入成员会话
      await enter("/swarm board");
      await settle(() => frame().includes("订单校验  ") && frame().includes("全部"));
      await keys(ui, "\x1b[Z", "\x1b[B", "\r");
      // 成员会话：确认框就是现有权限框；帖子送达头部写本会话的名字
      await settle(() => frame().includes("协调者 → @orders · #3"));
      await vi.waitFor(() => expect(frame()).toContain("echo ok > approved.txt"));
      // 状态块仍读协调者
      expect(frame()).toContain("◆ 订单校验");
      await press(ui, "a");
      await vi.waitFor(() => expect(frame()).not.toMatch(/等待确认：echo ok/), { timeout: 8000 });

      // 回协调者：board 的「协调者」行
      await enter("/swarm board");
      await settle(() => frame().includes("全部"));
      await keys(ui, "\x1b[Z", "\x1b[A", "\r");
      await settle(() => !frame().includes("全部") && frame().includes("◆ 订单校验"));
      expect(frame()).not.toContain("协调者 → @orders · #3");

      expect(coordClose).not.toHaveBeenCalled();
      expect(memberClose).not.toHaveBeenCalled();
      expect(memberInterrupt).not.toHaveBeenCalled();
      expect(coordInterrupt).not.toHaveBeenCalled();

      await enter("/swarm end");
      await settle(() => replaySessionView(session.durableEvents()).swarm?.status === "ended");
      await settle(() => !frame().includes("◆ 订单校验"));
    } finally {
      ui.unmount();
      coordClose.mockRestore();
      await session.close();
    }
  }, 30_000);

  it("成员视图下 /resume <id>：先回到协调者视图，再走 switchSession", async () => {
    const { runtime, session } = await swarmRuntime();
    const other = await runtime.createSession({ model: "fake/fake-1" });
    const otherId = other.id;
    await other.close();
    const calls: string[] = [];
    const switchSession = vi.fn(async (id: string) => {
      calls.push(id);
      return { kind: "error" as const, message: "已拒绝" };
    });
    const ui = render(
      createElement(App, { session, runtime, env: ENV, inline: false, switchSession }),
    );
    const frame = () => strip(ui.lastFrame() ?? "");
    currentFrame = frame;
    const enter = async (value: string) => {
      ui.stdin.write(value);
      await pause(100);
      ui.stdin.write("\r");
    };
    try {
      await settle(() => frame().includes("fake-1"));
      await enter("/swarm 校验订单");
      await vi.waitFor(() => expect(frame()).toContain("等待确认：echo ok"), { timeout: 8000 });
      await enter("/swarm board");
      await settle(() => frame().includes("全部"));
      await keys(ui, "\x1b[Z", "\x1b[B", "\r");
      await settle(() => frame().includes("协调者 → @orders · #3"));
      await press(ui, "a");
      await vi.waitFor(() => expect(frame()).not.toMatch(/等待确认：echo ok/), { timeout: 8000 });
      await enter(`/resume ${otherId}`);
      await settle(() => switchSession.mock.calls.length === 1);
      expect(calls[0]).toBe(otherId);
      // 回调之后整帧已换回协调者视图（不是成员会话）
      await settle(() => !frame().includes("协调者 → @orders · #3"));
      await settle(() => frame().includes("! 已拒绝"));
      expect(frame()).not.toContain("协调者 → @orders · #3");
    } finally {
      ui.unmount();
      await session.endSwarm().catch(() => undefined);
      await session.close();
    }
  }, 30_000);

  it("成员 Turn 进行中：确认权限后立刻能输入，Enter 插话/排队，Esc 只中断成员", async () => {
    let release: (script: FakeScript) => void = () => undefined;
    const gate = new Promise<FakeScript>((resolve) => {
      release = resolve;
    });
    const { runtime, session } = await swarmRuntime(gate);
    const coordInterrupt = vi.spyOn(session, "interrupt");
    const ui = render(createElement(App, { session, runtime, env: ENV, inline: false }));
    const frame = () => strip(ui.lastFrame() ?? "");
    currentFrame = frame;
    const enter = async (value: string) => {
      ui.stdin.write(value);
      await pause(100);
      ui.stdin.write("\r");
    };
    let member: RuntimeSession | undefined;
    try {
      await settle(() => frame().includes("fake-1"));
      await enter("/swarm 校验订单");
      await vi.waitFor(() => expect(frame()).toContain("等待确认：echo ok"), { timeout: 8000 });
      await enter("/swarm board");
      await settle(() => frame().includes("全部"));
      await keys(ui, "\x1b[Z", "\x1b[B", "\r");
      await settle(() => frame().includes("协调者 → @orders · #3"));
      await vi.waitFor(() => expect(frame()).toContain("需要确认"), { timeout: 8000 });
      const child =
        replaySessionView(session.durableEvents()).swarm?.members.find((m) => m.name === "orders")
          ?.childSessionId ?? "";
      member = await runtime.resumeSession(child);
      const memberInterrupt = vi.spyOn(member, "interrupt");

      await press(ui, "a");
      // 成员第二轮被 gate 卡住：这一轮还没结束，输入框必须收得到字
      await press(ui, "私信：成员轮次进行中");
      await vi.waitFor(() => expect(frame()).toContain("私信：成员轮次进行中"), {
        timeout: 3000,
      });
      await press(ui, "\r");
      await vi.waitFor(
        async () => {
          const pending = await member?.pendingInputs();
          const logged = member
            ?.durableEvents()
            .some(
              (e) =>
                e.type === "message.user" &&
                JSON.stringify(e.payload).includes("私信：成员轮次进行中"),
            );
          expect(
            pending?.items.some((i) => i.text.includes("私信：成员轮次进行中")) || logged,
          ).toBe(true);
        },
        { timeout: 5000 },
      );
      // 成员 Turn 仍在跑（gate 未放行），Esc 必须中断成员而不是协调者
      await press(ui, "\x1b");
      await vi.waitFor(() => expect(memberInterrupt).toHaveBeenCalled(), { timeout: 3000 });
      expect(coordInterrupt).not.toHaveBeenCalled();
    } finally {
      release(stopText("orders 完成"));
      ui.unmount();
      coordInterrupt.mockRestore();
      await session.endSwarm().catch(() => undefined);
      await session.close();
    }
  }, 30_000);

  it("respondPermission 失败时权限框回来，并能再次回答", async () => {
    const { runtime, session } = await swarmRuntime();
    const ui = render(createElement(App, { session, runtime, env: ENV, inline: false }));
    const frame = () => strip(ui.lastFrame() ?? "");
    currentFrame = frame;
    const enter = async (value: string) => {
      ui.stdin.write(value);
      await pause(100);
      ui.stdin.write("\r");
    };
    let member: RuntimeSession | undefined;
    try {
      await settle(() => frame().includes("fake-1"));
      await enter("/swarm 校验订单");
      await vi.waitFor(() => expect(frame()).toContain("等待确认：echo ok"), { timeout: 8000 });
      await enter("/swarm board");
      await settle(() => frame().includes("全部"));
      await keys(ui, "\x1b[Z", "\x1b[B", "\r");
      await settle(() => frame().includes("协调者 → @orders · #3"));
      await vi.waitFor(() => expect(frame()).toContain("需要确认"), { timeout: 8000 });
      const child =
        replaySessionView(session.durableEvents()).swarm?.members.find((m) => m.name === "orders")
          ?.childSessionId ?? "";
      member = await runtime.resumeSession(child);
      const respond = vi
        .spyOn(member, "respondPermission")
        .mockRejectedValueOnce(new Error("权限回复失败"));
      await press(ui, "a");
      await vi.waitFor(() => expect(frame()).toContain("! 权限回复失败"), { timeout: 3000 });
      expect(frame()).toContain("需要确认");
      respond.mockRestore();
      await press(ui, "a");
      await vi.waitFor(() => expect(frame()).not.toContain("需要确认"), { timeout: 8000 });
    } finally {
      ui.unmount();
      await session.endSwarm().catch(() => undefined);
      await session.close();
    }
  }, 30_000);

  it("一次 Enter 只调用一次 enqueueInput，Turn 结束后也只有一条插话", async () => {
    let release: (script: FakeScript) => void = () => undefined;
    const gate = new Promise<FakeScript>((resolve) => {
      release = resolve;
    });
    const { runtime, session } = await swarmRuntime(gate);
    const ui = render(createElement(App, { session, runtime, env: ENV, inline: false }));
    const frame = () => strip(ui.lastFrame() ?? "");
    currentFrame = frame;
    const enter = async (value: string) => {
      ui.stdin.write(value);
      await pause(100);
      ui.stdin.write("\r");
    };
    const text = "只发一次的私信";
    try {
      await settle(() => frame().includes("fake-1"));
      await enter("/swarm 校验订单");
      await vi.waitFor(() => expect(frame()).toContain("等待确认：echo ok"), { timeout: 8000 });
      await enter("/swarm board");
      await settle(() => frame().includes("全部"));
      await keys(ui, "\x1b[Z", "\x1b[B", "\r");
      await settle(() => frame().includes("协调者 → @orders · #3"));
      await vi.waitFor(() => expect(frame()).toContain("需要确认"), { timeout: 8000 });
      const child =
        replaySessionView(session.durableEvents()).swarm?.members.find((m) => m.name === "orders")
          ?.childSessionId ?? "";
      const member = await runtime.resumeSession(child);
      const enqueue = vi.spyOn(member, "enqueueInput");
      await press(ui, "a");
      await press(ui, text);
      await press(ui, "\r");
      await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1), { timeout: 3000 });
      await pause(200);
      expect(enqueue).toHaveBeenCalledTimes(1);
      release(stopText("orders 完成"));
      await vi.waitFor(
        () => {
          const n = member
            .durableEvents()
            .filter(
              (e) => e.type === "message.user" && JSON.stringify(e.payload).includes(text),
            ).length;
          expect(n).toBe(1);
        },
        { timeout: 8000 },
      );
      await vi.waitFor(
        () => expect(member.durableEvents().some((e) => e.type === "turn.completed")).toBe(true),
        { timeout: 8000 },
      );
      const n = member
        .durableEvents()
        .filter(
          (e) => e.type === "message.user" && JSON.stringify(e.payload).includes(text),
        ).length;
      expect(n).toBe(1);
      expect(enqueue).toHaveBeenCalledTimes(1);
    } finally {
      release(stopText("orders 完成"));
      ui.unmount();
      await session.endSwarm().catch(() => undefined);
      await session.close();
    }
  }, 30_000);
});

describe("帖子送达块在完整对话块表里", () => {
  it("transcriptBlocks 把 swarmRecipient 传给条目布局", () => {
    const view = createSessionView();
    const entry = {
      kind: "user",
      key: "u1",
      seq: 1,
      content: [{ type: "text", text: '<swarm-post n="2" from="orders">\n好\n</swarm-post>' }],
      swarm: { postNumber: 2, from: "orders", fromKind: "member" },
    } as unknown as ViewEntry;
    const blocks = transcriptBlocks({
      welcome: [],
      notices: [],
      frozen: [],
      entries: [entry],
      hide: () => false,
      live: view,
      clientLines: [],
      ascii: false,
      swarmRecipient: "@users",
    });
    const lines = blocks.flatMap((b) => b.layout(80)).map((l) => l.text);
    expect(lines).toContain("│ @orders → @users · #2");
  });
});
