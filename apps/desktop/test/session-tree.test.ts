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
const opts = (o?: { expanded?: string[]; collapsed?: string[] }) => ({
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

  it("锁定会话 meta 前缀 🔒；无标题回退「未命名会话」", () => {
    const tree = buildSessionTree(
      [
        session("a", "Z:\\repo", NOW - 1000, { locked: true }),
        session("b", "Z:\\repo", NOW - 2000, { firstText: undefined }),
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
});
