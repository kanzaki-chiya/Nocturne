import { describe, expect, it } from "vitest";

import {
  HISTORY_SEARCH_LIMIT,
  searchInputHistory,
  splitHighlightSegments,
  truncateHighlightSegments,
} from "../src/history-search.js";

describe("TUI searchInputHistory", () => {
  it("按最新在前排序、去重保留最新条并支持大小写不敏感子串过滤", () => {
    const history = ["git status", "check Worktree diff", "git status", "clean WORKTREE branch"];
    const results = searchInputHistory(history, "worktree");
    expect(results.map((r) => r.text)).toEqual(["clean WORKTREE branch", "check Worktree diff"]);
    const first = results[0];
    expect(splitHighlightSegments(first?.label ?? "", first?.ranges ?? [])).toEqual([
      { text: "clean ", hit: false },
      { text: "WORKTREE", hit: true },
      { text: " branch", hit: false },
    ]);
  });

  it("空查询返回全部去重历史，最多 50 条；换行压为空格", () => {
    const history = [...Array.from({ length: 60 }, (_, i) => `cmd-${i}`), "line1\n\nline2"];
    const results = searchInputHistory(history, "");
    expect(results).toHaveLength(HISTORY_SEARCH_LIMIT);
    expect(results[0]?.text).toBe("line1\n\nline2");
    expect(results[0]?.label).toBe("line1 line2");
    expect(results[49]?.text).toBe("cmd-11");
  });

  it("窄宽度截断高亮片段时保留省略号并清理控制字符", () => {
    const segments = [
      { text: "前缀\x1b[31m红色 ", hit: false },
      { text: "worktree", hit: true },
      { text: " 后缀很长很长", hit: false },
    ];
    expect(truncateHighlightSegments(segments, 14, "...")).toEqual([
      { text: "前缀红色 ", hit: false },
      { text: "wo", hit: true },
      { text: "...", hit: false },
    ]);
  });
});
