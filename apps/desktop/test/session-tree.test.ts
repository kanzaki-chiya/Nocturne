import { describe, expect, it } from "vitest";

import {
  buildSessionTree,
  formatRelative,
  moveProjectKey,
  projectKey,
  type SessionSummary,
} from "../src/session-tree";

const NOW = new Date("2026-10-04T12:00:00").getTime();

function session(
  id: string,
  cwd: string,
  mtimeMs: number,
  extra?: Partial<SessionSummary>,
): SessionSummary {
  return {
    id,
    createdAt: "2026-10-01T00:00:00Z",
    cwd,
    workspaceRoot: cwd,
    model: { provider: "p", model: "m" },
    mtimeMs,
    firstText: `标题 ${id}`,
    ...extra,
  };
}

const noPrefs = { pinned: [] as string[], projects: [] as string[], hidden: [] as string[] };
const WS = "C:\\Users\\A\\.nocturne\\workspace";
const opts = (o?: {
  plainWorkspace?: string | null;
  chatsExpanded?: boolean;
  expanded?: string[];
  collapsed?: string[];
}) => ({
  plainWorkspace: o?.plainWorkspace ?? null,
  chatsExpanded: o?.chatsExpanded ?? false,
  expanded: new Set(o?.expanded ?? []),
  collapsed: new Set(o?.collapsed ?? []),
  now: NOW,
});

describe("projectKey", () => {
  it("归并大小写与分隔符差异", () => {
    expect(projectKey("Z:\\Repo")).toBe(projectKey("z:/repo/"));
    expect(projectKey("Z:\\Repo")).toBe("z:\\repo");
    expect(projectKey("C:\\")).toBe("c:\\");
    expect(projectKey("/home/u/proj/")).toBe("/home/u/proj");
  });
});

describe("formatRelative", () => {
  it("各档位", () => {
    expect(formatRelative(NOW - 30_000, NOW)).toBe("现在");
    expect(formatRelative(NOW - 5 * 60_000, NOW)).toBe("5 分钟");
    expect(formatRelative(NOW - 3 * 3_600_000, NOW)).toBe("3 小时");
    expect(formatRelative(NOW - 30 * 3_600_000, NOW)).toBe("昨天");
    expect(formatRelative(NOW - 5 * 86_400_000, NOW)).toBe("5 天");
    expect(formatRelative(NOW - 40 * 86_400_000, NOW)).toBe("2026-08-25");
  });
});

describe("buildSessionTree", () => {
  it("按 cwd 分组（大小写/分隔符差异归并）且最近活动模式按最新会话排序", () => {
    const tree = buildSessionTree(
      [
        session("a1", "Z:\\Repo", NOW - 1000),
        session("a2", "z:/repo/", NOW - 2000),
        session("b1", "Z:\\other", NOW - 500),
      ],
      { ...noPrefs, projectSort: "activity" },
      opts(),
    );
    expect(tree.projects.map((p) => p.name)).toEqual(["other", "Repo"]);
    const repo = tree.projects[1];
    expect(repo?.key).toBe("z:\\repo");
    expect(repo?.path).toBe("Z:\\Repo");
    expect(repo?.count).toBe(2);
    expect(repo?.sessions.map((s) => s.id)).toEqual(["a1", "a2"]);
  });

  it("每项目默认 5 条，moreCount 计入其余；展开后全量", () => {
    const sessions = Array.from({ length: 8 }, (_, i) =>
      session(`s${i}`, "Z:\\repo", NOW - i * 1000),
    );
    const tree = buildSessionTree(sessions, noPrefs, opts());
    const proj = tree.projects[0];
    expect(proj?.sessions).toHaveLength(5);
    expect(proj?.moreCount).toBe(3);
    const expanded = buildSessionTree(sessions, noPrefs, opts({ expanded: ["z:\\repo"] }));
    expect(expanded.projects[0]?.sessions).toHaveLength(8);
    expect(expanded.projects[0]?.moreCount).toBe(0);
  });

  it("置顶区按 pinned 顺序、带项目名；置顶不在项目内重复", () => {
    const tree = buildSessionTree(
      [
        session("a", "Z:\\repo", NOW - 1000),
        session("b", "Z:\\repo", NOW - 2000),
        session("c", "Z:\\other", NOW - 500),
      ],
      { ...noPrefs, pinned: ["c", "a"] },
      opts(),
    );
    expect(tree.pinned.map((r) => r.id)).toEqual(["c", "a"]);
    expect(tree.pinned[0]?.project).toBe("other");
    expect(tree.pinned[1]?.project).toBe("repo");
    const repo = tree.projects.find((p) => p.key === "z:\\repo");
    expect(repo?.sessions.map((s) => s.id)).toEqual(["b"]);
  });

  it("隐藏项目不出现但其置顶会话仍在置顶区", () => {
    const tree = buildSessionTree(
      [session("a", "Z:\\repo", NOW - 1000), session("b", "Z:\\other", NOW - 500)],
      { pinned: ["a"], projects: [], hidden: ["z:\\repo"] },
      opts(),
    );
    expect(tree.projects.map((p) => p.key)).toEqual(["z:\\other"]);
    expect(tree.pinned.map((r) => r.id)).toEqual(["a"]);
  });

  it("最近活动模式：手动项目无会话也出现且排在有会话项目之后（按添加顺序）", () => {
    const tree = buildSessionTree(
      [session("a", "Z:\\repo", NOW - 1000)],
      { pinned: [], projects: ["Z:\\m2", "Z:\\m1"], hidden: [], projectSort: "activity" },
      opts(),
    );
    expect(tree.projects.map((p) => p.key)).toEqual(["z:\\repo", "z:\\m2", "z:\\m1"]);
    expect(tree.projects[1]?.manual).toBe(true);
    expect(tree.projects[1]?.count).toBe(0);
    expect(tree.projects[1]?.sessions).toHaveLength(0);
  });

  it("projectSort 为 name 时全部项目按名称排序（含无会话的手动项目）", () => {
    const tree = buildSessionTree(
      [
        session("a", "Z:\\zeta", NOW - 100),
        session("b", "Z:\\alpha", NOW - 5000),
        session("c", "Z:\\beta", NOW - 9000),
      ],
      { pinned: [], projects: ["Z:\\mango"], hidden: [], projectSort: "name" },
      opts(),
    );
    expect(tree.projects.map((p) => p.name)).toEqual(["alpha", "beta", "mango", "zeta"]);
  });

  it("锁定会话 meta 前缀 🔒；无标题回退「未命名会话」", () => {
    const tree = buildSessionTree(
      [
        session("a", "Z:\\repo", NOW - 1000, { locked: true }),
        session("b", "Z:\\repo", NOW - 2000, { firstText: undefined, locked: true }),
      ],
      noPrefs,
      opts(),
    );
    const repo = tree.projects[0];
    expect(repo?.sessions[0]?.meta).toMatch(/^🔒 /);
    expect(repo?.sessions[0]?.locked).toBe(true);
    expect(repo?.sessions[1]?.title).toBe("未命名会话");
  });

  it("pending 状态行 meta 为「待确认」（本步恒 idle，但结构支持）", () => {
    // status 字段本步恒为 idle，这里只验证行结构字段
    const tree = buildSessionTree([session("a", "Z:\\repo", NOW)], noPrefs, opts());
    expect(tree.projects[0]?.sessions[0]?.status).toBe("idle");
    expect(tree.projects[0]?.sessions[0]?.meta).toBe("现在");
  });

  it("cwd 归并后等于普通对话工作区的会话进「对话」，不进项目", () => {
    const tree = buildSessionTree(
      [
        session("c1", "c:/users/a/.nocturne/workspace/", NOW - 500),
        session("c2", "C:\\Users\\A\\.nocturne\\workspace", NOW - 1000),
        session("p1", "Z:\\repo", NOW - 800),
      ],
      noPrefs,
      opts({ plainWorkspace: WS }),
    );
    expect(tree.chats.rows.map((r) => r.id)).toEqual(["c1", "c2"]);
    expect(tree.chats.moreCount).toBe(0);
    expect(tree.projects.map((p) => p.key)).toEqual(["z:\\repo"]);
  });

  it("对话区默认 5 条 + moreCount，chatsExpanded 后全量", () => {
    const sessions = Array.from({ length: 7 }, (_, i) => session(`c${i}`, WS, NOW - i * 1000));
    const tree = buildSessionTree(sessions, noPrefs, opts({ plainWorkspace: WS }));
    expect(tree.chats.rows).toHaveLength(5);
    expect(tree.chats.moreCount).toBe(2);
    const expanded = buildSessionTree(
      sessions,
      noPrefs,
      opts({ plainWorkspace: WS, chatsExpanded: true }),
    );
    expect(expanded.chats.rows).toHaveLength(7);
    expect(expanded.chats.moreCount).toBe(0);
    expect(expanded.projects).toHaveLength(0);
  });

  it("置顶的对话会话项目标签为「对话」且不在对话区重复", () => {
    const tree = buildSessionTree(
      [session("c1", WS, NOW - 500), session("p1", "Z:\\repo", NOW - 1000)],
      { ...noPrefs, pinned: ["c1"] },
      opts({ plainWorkspace: WS }),
    );
    expect(tree.pinned).toHaveLength(1);
    expect(tree.pinned[0]?.project).toBe("对话");
    expect(tree.chats.rows).toHaveLength(0);
  });

  it("plainWorkspace 为 null 时所有会话按项目处理", () => {
    const tree = buildSessionTree(
      [session("c1", WS, NOW - 500), session("p1", "Z:\\repo", NOW - 1000)],
      noPrefs,
      opts({ plainWorkspace: null }),
    );
    expect(tree.chats.rows).toHaveLength(0);
    expect(tree.projects.map((p) => p.key)).toHaveLength(2);
  });

  it("手动项目路径等于普通对话工作区时不显示为项目", () => {
    const tree = buildSessionTree(
      [session("p1", "Z:\\repo", NOW - 1000)],
      { pinned: [], projects: [WS], hidden: [] },
      opts({ plainWorkspace: WS }),
    );
    expect(tree.projects.map((p) => p.key)).toEqual(["z:\\repo"]);
  });

  it("空会话（无 firstText 且未锁定）在对话、项目、置顶区都不显示", () => {
    const tree = buildSessionTree(
      [
        session("e1", "Z:\\repo", NOW - 100, { firstText: undefined }),
        session("e2", "Z:\\repo", NOW - 200, { firstText: "   " }),
        session("e3", "Z:\\repo", NOW - 300, { firstText: undefined, locked: true }),
        session("e4", WS, NOW - 400, { firstText: "" }),
        session("ok", "Z:\\repo", NOW - 500),
      ],
      { ...noPrefs, pinned: ["e1", "e2", "ok"] },
      opts({ plainWorkspace: WS }),
    );
    expect(tree.pinned.map((r) => r.id)).toEqual(["ok"]);
    expect(tree.chats.rows).toHaveLength(0);
    const repo = tree.projects.find((p) => p.key === "z:\\repo");
    expect(repo?.sessions.map((s) => s.id)).toEqual(["e3"]);
    expect(repo?.sessions[0]?.title).toBe("未命名会话");
    expect(repo?.count).toBe(2);
  });
});

describe("buildSessionTree 手动排序", () => {
  const keys = (tree: { projects: { key: string }[] }) => tree.projects.map((p) => p.key);

  it("缺省即手动模式，按 projectOrder 排列，与会话活跃度无关", () => {
    const tree = buildSessionTree(
      [
        session("a", "Z:\\a", NOW - 100),
        session("b", "Z:\\b", NOW - 5000),
        session("c", "Z:\\c", NOW - 9000),
      ],
      { ...noPrefs, projectOrder: ["z:\\c", "z:\\a", "z:\\b"] },
      opts(),
    );
    expect(keys(tree)).toEqual(["z:\\c", "z:\\a", "z:\\b"]);
    expect(tree.newProjectKeys).toEqual([]);
  });

  it("不在 projectOrder 里的新项目排在最上面：无会话的在前（后添加的在前），其余按最早会话 createdAt 降序", () => {
    const tree = buildSessionTree(
      [
        session("o", "Z:\\old", NOW - 100),
        session("x1", "Z:\\x", NOW - 100, { createdAt: "2026-10-03T00:00:00Z" }),
        session("x2", "Z:\\x", NOW - 100, { createdAt: "2026-09-01T00:00:00Z" }),
        session("y", "Z:\\y", NOW - 9000, { createdAt: "2026-10-02T00:00:00Z" }),
      ],
      { ...noPrefs, projects: ["Z:\\m1", "Z:\\m2"], projectOrder: ["z:\\old"] },
      opts(),
    );
    // x 的最早会话是 09-01，比 y 的 10-02 早，所以 y 在前
    const expected = ["z:\\m2", "z:\\m1", "z:\\y", "z:\\x"];
    expect(tree.newProjectKeys).toEqual(expected);
    expect(keys(tree)).toEqual([...expected, "z:\\old"]);
  });

  it("新键写回 projectOrder 后，已有项目有了新会话位置也不变", () => {
    const sessions = [session("a", "Z:\\a", NOW - 9000), session("b", "Z:\\b", NOW - 5000)];
    const first = buildSessionTree(sessions, { ...noPrefs, projectOrder: [] }, opts());
    const projectOrder = [...first.newProjectKeys];
    const before = buildSessionTree(sessions, { ...noPrefs, projectOrder }, opts());
    const after = buildSessionTree(
      [...sessions, session("a2", "Z:\\a", NOW - 10)],
      { ...noPrefs, projectOrder },
      opts(),
    );
    expect(keys(after)).toEqual(keys(before));
    expect(after.newProjectKeys).toEqual([]);
  });

  it("隐藏后恢复回到原位（projectOrder 里的位置保留）", () => {
    const sessions = [
      session("a", "Z:\\a", NOW - 100),
      session("b", "Z:\\b", NOW - 200),
      session("c", "Z:\\c", NOW - 300),
    ];
    const projectOrder = ["z:\\a", "z:\\b", "z:\\c"];
    const hiddenTree = buildSessionTree(
      sessions,
      { ...noPrefs, hidden: ["Z:\\b"], projectOrder },
      opts(),
    );
    expect(keys(hiddenTree)).toEqual(["z:\\a", "z:\\c"]);
    expect(hiddenTree.newProjectKeys).toEqual([]);
    const restored = buildSessionTree(sessions, { ...noPrefs, projectOrder }, opts());
    expect(keys(restored)).toEqual(projectOrder);
  });

  it("名称、最近活动模式忽略 projectOrder，但仍返回新键", () => {
    const sessions = [session("z", "Z:\\zeta", NOW - 100), session("a", "Z:\\alpha", NOW - 5000)];
    const projectOrder = ["z:\\alpha"];
    const byName = buildSessionTree(
      sessions,
      { ...noPrefs, projectSort: "name", projectOrder: ["z:\\zeta", "z:\\alpha"] },
      opts(),
    );
    expect(keys(byName)).toEqual(["z:\\alpha", "z:\\zeta"]);
    const byActivity = buildSessionTree(
      sessions,
      { ...noPrefs, projectSort: "activity", projectOrder },
      opts(),
    );
    expect(keys(byActivity)).toEqual(["z:\\zeta", "z:\\alpha"]);
    expect(byActivity.newProjectKeys).toEqual(["z:\\zeta"]);
  });
});

describe("moveProjectKey", () => {
  it("可见列表内移动：插入下标是移动前的位置", () => {
    const order = ["a", "b", "c"];
    expect(moveProjectKey(order, order, "a", 3)).toEqual(["b", "c", "a"]);
    expect(moveProjectKey(order, order, "c", 0)).toEqual(["c", "a", "b"]);
    expect(moveProjectKey(order, order, "b", 0)).toEqual(["b", "a", "c"]);
    expect(moveProjectKey(order, order, "a", 2)).toEqual(["b", "a", "c"]);
  });

  it("隐藏项目保持相对位置：落在可见项之前插到它前面，末尾插到最后一个可见项之后", () => {
    // h1、h2 隐藏；可见 a b c
    const order = ["h1", "a", "b", "h2", "c"];
    const visible = ["a", "b", "c"];
    // c 移到 b 前面：h2 仍在 b 之后
    expect(moveProjectKey(order, visible, "c", 1)).toEqual(["h1", "a", "c", "b", "h2"]);
    // a 移到最后：插在 c 之后，h1 仍在最前
    expect(moveProjectKey(order, visible, "a", 3)).toEqual(["h1", "b", "h2", "c", "a"]);
    // c 移到最前：插在 a 之前（h1 之后）
    expect(moveProjectKey(order, visible, "c", 0)).toEqual(["h1", "c", "a", "b", "h2"]);
  });

  it("尚未写回的可见键先补到最前面", () => {
    expect(moveProjectKey(["a", "b"], ["n", "a", "b"], "a", 3)).toEqual(["n", "b", "a"]);
  });
});
