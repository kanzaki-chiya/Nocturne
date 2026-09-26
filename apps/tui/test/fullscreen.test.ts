import stringWidth from "string-width";
import { describe, expect, it } from "vitest";

import { cursorColumn } from "../src/cursor.js";
import { sessionSavedLine } from "../src/exit-note.js";
import { frameBudget } from "../src/frame.js";
import { isAltM, noteBareEscape, shouldSwallowAfterEscape } from "../src/keys.js";
import { scrollFollow, scrollPage, scrollToBottom, scrollToTop } from "../src/scroll.js";
import { formatContextOccupancy, formatModelLabel } from "../src/status-format.js";
import { completeSlash, helpLines, readlineCompleter } from "../src/slash-catalog.js";
import { selectVisible, type LineBlock } from "../src/viewport.js";
import { moonRows } from "../src/welcome.js";

const key = {
  ctrl: false,
  meta: false,
  shift: false,
  escape: false,
  tab: false,
  pageUp: false,
  pageDown: false,
  home: false,
  end: false,
  return: false,
  upArrow: false,
  downArrow: false,
};

describe("帧高", () => {
  it("始终等于 rows-1，候选先减、对话后压", () => {
    const wide = frameBudget(30, 8);
    expect(wide.frameHeight).toBe(29);
    expect(wide.conversation + wide.inputRule + wide.input + wide.completion + wide.status).toBe(
      29,
    );
    expect(wide.completion).toBe(8);
    expect(wide.conversation).toBeGreaterThan(0);

    const tight = frameBudget(10, 8);
    expect(tight.frameHeight).toBe(9);
    expect(tight.completion).toBeLessThan(8);
    expect(tight.conversation).toBeGreaterThan(0);
    expect(
      tight.conversation + tight.inputRule + tight.input + tight.completion + tight.status,
    ).toBe(9);

    const short = frameBudget(4, 8);
    expect(short.frameHeight).toBe(3);
    expect(short.completion).toBe(0);
    expect(short.conversation + short.input + short.status + short.inputRule).toBe(3);

    const tiny = frameBudget(2, 3);
    expect(tiny.frameHeight).toBe(1);
    expect(tiny.completion).toBe(0);
    expect(tiny.conversation).toBe(0);
  });
});

describe("滚动状态", () => {
  it("翻页离开底部，Ctrl+End 回到跟随", () => {
    const up = scrollPage(scrollFollow(), 10);
    expect(up.follow).toBe(false);
    expect(up.fromBottom).toBe(10);
    expect(scrollToBottom().follow).toBe(true);
    expect(scrollToTop().fromBottom).toBeGreaterThan(1000);
    expect(scrollPage(up, -10).follow).toBe(true);
  });
});

describe("可见窗口", () => {
  it("只布局视口能碰到的块", () => {
    const laid = new Set<string>();
    const blocks: LineBlock[] = Array.from({ length: 50 }, (_, i) => ({
      key: `b${i}`,
      revision: "1",
      layout: () => {
        laid.add(`b${i}`);
        return [{ key: `b${i}`, text: `line ${i}` }];
      },
    }));
    const cache = new Map();
    const window = selectVisible(blocks, 80, 5, 0, cache);
    expect(window.lines.map((l) => l.text)).toEqual([
      "line 45",
      "line 46",
      "line 47",
      "line 48",
      "line 49",
    ]);
    expect(window.atBottom).toBe(true);
    expect(laid.has("b0")).toBe(false);
    expect(laid.has("b49")).toBe(true);

    laid.clear();
    const top = selectVisible(blocks, 80, 5, 10_000, cache);
    expect(top.atTop).toBe(true);
    expect(top.lines[0]?.text).toBe("line 0");
    expect(top.atBottom).toBe(false);
  });
});

describe("状态栏格式", () => {
  it("0.1% / 1M，长度未知只显示已用量，模型段只显示模型 ID", () => {
    expect(formatContextOccupancy(1000, 1_000_000)).toBe("0.1% / 1M");
    expect(formatContextOccupancy(128_000, 128_000)).toBe("100% / 128K");
    expect(formatContextOccupancy(1500, undefined)).toBe("1.5K");
    const label = formatModelLabel(
      { provider: "command code", model: "deepseek/deepseek-v4.1-flash" },
      [
        {
          ref: { provider: "command code", model: "deepseek/deepseek-v4.1-flash" },
          displayName: "Flash",
          capabilities: {
            toolCalls: true,
            parallelToolCalls: false,
            reasoning: "none",
            imageInput: false,
            promptCache: false,
          },
        },
      ],
      80,
    );
    expect(label).toBe("deepseek/deepseek-v4.1-flash");
    expect(label).not.toContain("command code");
    expect(
      formatModelLabel(
        { provider: "command code", model: "deepseek/deepseek-v4.1-flash" },
        [
          {
            ref: { provider: "command code", model: "deepseek/deepseek-v4.1-flash" },
            displayName: "Flash",
            capabilities: {
              toolCalls: true,
              parallelToolCalls: false,
              reasoning: "none",
              imageInput: false,
              promptCache: false,
            },
          },
        ],
        16,
      ),
    ).toBe("Flash");
  });
});

describe("补全", () => {
  const ctx = { effortLevels: ["low", "high"], providerIds: ["deepseek", "openrouter"] };

  it("前缀优先于包含，/help 与补全共用命令表", () => {
    const hits = completeSlash("/p", ctx);
    const inserts = hits.map((h) => h.insert);
    expect(inserts[0]).toBe("/preset");
    expect(inserts[1]).toBe("/provider");
    expect(hits[1]?.label).toContain("管理服务商");
    const help = helpLines().join("\n");
    for (const hit of hits) {
      const name = hit.insert.split(" ")[0] ?? "";
      if (name === "/quit") continue;
      expect(help).toContain(name);
    }
  });

  it("三类参数补全", () => {
    expect(completeSlash("/effort ", ctx).map((h) => h.insert)).toEqual([
      "/effort off",
      "/effort low",
      "/effort high",
    ]);
    const provider = completeSlash("/provider ", ctx).map((h) => h.insert);
    expect(provider).toContain("/provider add");
    expect(provider).toContain("/provider deepseek");
    expect(completeSlash("/preset ", ctx).map((h) => h.insert)).toEqual([
      "/preset read-only",
      "/preset default",
      "/preset auto-edit",
      "/preset full-access",
    ]);
  });

  it("readline completer 覆盖同一范围", () => {
    const [matches, prefix] = readlineCompleter("/effort ", ctx);
    expect(prefix).toBe("/effort ");
    expect(matches).toContain("/effort off");
    expect(matches).toContain("/effort low");
  });
});

describe("Alt+M 与光标", () => {
  it("meta+m 识别；Esc 后的字母吞掉但不识别为切换", () => {
    expect(isAltM("m", { ...key, meta: true })).toBe(true);
    expect(isAltM("m", key)).toBe(false);
    const until = noteBareEscape(1_000);
    expect(shouldSwallowAfterEscape("m", key, until, 1_020)).toBe(true);
    expect(shouldSwallowAfterEscape("m", { ...key, meta: true }, until, 1_020)).toBe(false);
  });

  it("光标按显示宽度，中文占 2 列", () => {
    expect(cursorColumn("› ", "ab", 80)).toBe(4);
    expect(cursorColumn("› ", "中", 80)).toBe(4);
    expect(cursorColumn("› ", "中文", 80)).toBe(6);
    expect(cursorColumn("搜索: ", "中文", 80)).toBe(10);
    expect(cursorColumn("过滤: ", "中文", 80)).toBe(10);
    expect(cursorColumn("> ", "中文", 80)).toBe(6);
  });
});

describe("退出文案", () => {
  it("包含会话 id 与继续命令", () => {
    expect(sessionSavedLine("abc")).toBe("会话 abc 已保存，nctrn -c 继续");
  });
});

describe("欢迎区弯月", () => {
  it("4 行 9 列，只用宽度确定的字符；ASCII 模式退回 #", () => {
    const rows = moonRows(false).map((r) => r.map((s) => s.text).join(""));
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(stringWidth(row)).toBe(9);
      expect(row).toMatch(/^[ ▀▄█]+$/);
    }
    for (const row of moonRows(true))
      expect(row.every((s) => s.text === "#" || s.text === " ")).toBe(true);
  });
});
