import { describe, expect, it } from "vitest";

import {
  buildSessionTree,
  formatRelative,
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
  it("按 cwd 分组（大小写/分隔符差异归并）且项目按最新会话排序", () => {
    const tree = buildSessionTree(
      [
        session("a1", "Z:\\Repo", NOW - 1000),
        session("a2", "z:/repo/", NOW - 2000),
        session("b1", "Z:\\other", NOW - 500),
      ],
      noPrefs,
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

  it("手动项目无会话也出现且排在有会话项目之后（按添加顺序）", () => {
    const tree = buildSessionTree(
      [session("a", "Z:\\repo", NOW - 1000)],
      { pinned: [], projects: ["Z:\\m2", "Z:\\m1"], hidden: [] },
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
