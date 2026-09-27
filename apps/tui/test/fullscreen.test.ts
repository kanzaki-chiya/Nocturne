import stringWidth from "string-width";
import { describe, expect, it } from "vitest";

import {
  composerWindow,
  cursorColumn,
  inputWindow,
  normalizeNewlines,
  verticalCursor,
} from "../src/cursor.js";
import { sessionSavedLine } from "../src/exit-note.js";
import { frameBudget } from "../src/frame.js";
import { isAltM, noteBareEscape, shouldSwallowAfterEscape } from "../src/keys.js";
import { formatContextOccupancy, formatModelLabel } from "../src/status-format.js";
import { completeSlash, helpLines, readlineCompleter } from "../src/slash-catalog.js";
import { moonRows } from "../src/welcome.js";
import { createPasteStore, pasteTokenAt, pasteTokenBefore } from "../src/paste.js";
import { layoutLive } from "../src/lines.js";
import { createSessionView } from "@nocturne/core/protocol";

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
    expect(frameBudget(20, 0, 7).input).toBe(5);
    expect(frameBudget(4, 8, 5).input).toBe(2);
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

describe("长文本粘贴与流式思考", () => {
  it("多行输入滚动后光标仍对应可见行，中文按显示列移动", () => {
    const value = "首\n中文\n三\n四\n五\n尾";
    const view = composerWindow("› ", value, 4, 40, 3);
    expect(view.rows.map((r) => r.before + (r.at ?? "") + r.after)).toEqual(["首", "中文", "三"]);
    expect(view.cursorRow).toBe(1);
    const tail = composerWindow("› ", value, value.length, 40, 3);
    expect(tail.rows.map((r) => r.before + (r.at ?? "") + r.after)).toEqual(["四", "五", "尾"]);
    expect(tail.cursorRow).toBe(2);
    expect(verticalCursor("中文\na\n尾巴", 2, 1)).toBe(4);
    expect(verticalCursor("中文\na\n尾巴", 4, -1)).toBe(0);
    expect(verticalCursor("a\nb", 0, -1)).toBeUndefined();
  });
  it("换行统一为 \n；输入框按光标水平滚动，换行显示为标记", () => {
    expect(normalizeNewlines("a\r\rb\r\nc")).toBe("a\n\nb\nc");
    const value = `${"甲".repeat(50)}\n末尾`;
    const view = inputWindow("› ", value, value.length, 40, "│");
    expect(view.before.startsWith("...")).toBe(true);
    expect(view.before.endsWith("│末尾")).toBe(true);
    expect(view.at).toBeUndefined();
    expect(stringWidth(`› ${view.before}`) + 1).toBeLessThanOrEqual(38);
    const mid = inputWindow("› ", "ab\ncd", 1, 40, "│");
    expect(mid).toEqual({ before: "a", at: "b", after: "│cd" });
  });

  it("正文已开始后思考继续增长，思考窗口仍显示", () => {
    const view = createSessionView();
    const a = {
      kind: "assistant" as const,
      messageId: "m1",
      turnId: undefined,
      text: "The",
      reasoning: "想",
    };
    view.live.assistants.push(a);
    view.status = "thinking";
    a.reasoning = "想了很久的第二段";
    const texts = layoutLive(
      view,
      80,
      false,
      new Map([["m1", [{ text: a.reasoning, started: 0, active: true }]]]),
      1000,
    ).map((l) => l.text);
    expect(texts).toContain("想了很久的第二段|");
    expect(texts).toContain("The");
  });
});

describe("粘贴占位", () => {
  it("多行与超长单行收起，短文本不收；展开只认已登记的占位", () => {
    const store = createPasteStore();
    expect(store.add("短文本")).toBeUndefined();
    expect(store.add("a\nb\nc")).toBe("[Paste #1, +2 lines]");
    expect(store.add("x".repeat(900))).toBe("[Paste #2, 900 chars]");
    expect(store.expand("前[Paste #1, +2 lines]后[Paste #9, +1 lines]")).toBe(
      "前a\nb\nc后[Paste #9, +1 lines]",
    );
    expect(pasteTokenBefore("看：[Paste #1, +2 lines]")).toBe("[Paste #1, +2 lines]".length);
    expect(pasteTokenBefore("看：[Paste #1, +2 lines] ")).toBe(0);
    expect(pasteTokenAt("[Paste #1, +2 lines]后")).toBe("[Paste #1, +2 lines]".length);
  });
});
