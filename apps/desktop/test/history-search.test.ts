import { describe, expect, it } from "vitest";

import {
  HISTORY_SEARCH_LIMIT,
  searchInputHistory,
  splitHighlightSegments,
} from "../src/history-search";

describe("searchInputHistory", () => {
  it("按最新在前排序、去重保留最新条且过滤不区分大小写", () => {
    const history = [
      "old fix worktree",
      "check Worktree status",
      "unrelated entry",
      "old fix worktree",
      "create WORKTREE branch",
    ];
    const results = searchInputHistory(history, "worktree");
    expect(results.map((r) => r.text)).toEqual([
      "create WORKTREE branch",
      "old fix worktree",
      "check Worktree status",
    ]);
    expect(results[0]?.ranges).toEqual([{ start: 7, end: 15 }]);
    const first = results[0];
    expect(first).toBeDefined();
    expect(splitHighlightSegments(first?.label ?? "", first?.ranges ?? [])).toEqual([
      { text: "create ", hit: false },
      { text: "WORKTREE", hit: true },
      { text: " branch", hit: false },
    ]);
  });

  it("空搜索词列出全部（去重、最新在前），超过 50 条截断到最新 50 条", () => {
    const history = Array.from({ length: 65 }, (_, i) => `item-${i}`);
    const results = searchInputHistory(history, "");
    expect(results).toHaveLength(HISTORY_SEARCH_LIMIT);
    expect(results[0]?.text).toBe("item-64");
    expect(results[49]?.text).toBe("item-15");
    expect(results.every((r) => r.ranges.length === 0)).toBe(true);
  });

  it("跨全量历史过滤后再限制最多 50 条，不遗漏更早的命中", () => {
    const history = [
      "early match target",
      ...Array.from({ length: 80 }, (_, i) => `noise-${i}`),
      ...Array.from({ length: 55 }, (_, i) => `target-${i}`),
    ];
    const results = searchInputHistory(history, "target");
    expect(results).toHaveLength(HISTORY_SEARCH_LIMIT);
    expect(results[0]?.text).toBe("target-54");
    expect(results[49]?.text).toBe("target-5");
    expect(results.some((r) => r.text === "early match target")).toBe(false);

    const onlyEarly = searchInputHistory(history, "early");
    expect(onlyEarly.map((r) => r.text)).toEqual(["early match target"]);
  });

  it("展示时将换行压成空格，同时保留原始多行文本供回填", () => {
    const history = ["第一行\n第二行\r\n\r\n第三行 worktree"];
    const results = searchInputHistory(history, "worktree");
    expect(results).toHaveLength(1);
    expect(results[0]?.text).toBe("第一行\n第二行\r\n\r\n第三行 worktree");
    expect(results[0]?.label).toBe("第一行 第二行 第三行 worktree");
    const row = results[0];
    expect(splitHighlightSegments(row?.label ?? "", row?.ranges ?? [])).toEqual([
      { text: "第一行 第二行 第三行 ", hit: false },
      { text: "worktree", hit: true },
    ]);
  });

  it("一次命中多个子串时全部标出高亮区间，大小写变长字符不越界", () => {
    const results = searchInputHistory(["Fix foo and fix bar", "İstanbul foo"], "fix");
    expect(results).toHaveLength(1);
    const hit = results[0];
    expect(splitHighlightSegments(hit?.label ?? "", hit?.ranges ?? [])).toEqual([
      { text: "Fix", hit: true },
      { text: " foo and ", hit: false },
      { text: "fix", hit: true },
      { text: " bar", hit: false },
    ]);

    const unicode = searchInputHistory(["İstanbul foo"], "foo");
    const uHit = unicode[0];
    expect(splitHighlightSegments(uHit?.label ?? "", uHit?.ranges ?? [])).toEqual([
      { text: "İstanbul ", hit: false },
      { text: "foo", hit: true },
    ]);
  });
});
