import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { formatQuotesBlock, type MessageQuote, type UserEntry } from "@nocturne/core/protocol";
import { EntryRow } from "../src/components/transcript.js";
import { formatQuoteLines } from "../src/format.js";
import { layoutEntry } from "../src/lines.js";

function makeQuotedUser(quotes: MessageQuote[], body: string): UserEntry {
  return {
    kind: "user",
    key: "u:5",
    seq: 5,
    turnId: "turn-5",
    content: [
      { type: "text", text: formatQuotesBlock(quotes) },
      { type: "text", text: body },
    ],
    quotes,
  };
}

describe("TUI 引用回复显示（ADR-0116）", () => {
  it("普通屏幕与全屏在用户消息上方以弱色 > 行显示引用，不重复首块原文", async () => {
    const quotes: MessageQuote[] = [
      { text: "超过 3 次改成指数退避，间隔上限 30 秒", seq: 2 },
      { text: "const delay = Math.min(1000 * 2 ** attempt, 30_000);", seq: 2 },
    ];
    const entry = makeQuotedUser(quotes, "上限改成 60 秒");

    // 全屏布局：引用行在用户消息行之前，且 dim=true
    const lines = layoutEntry(entry, 80, false);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines[0]).toMatchObject({
      text: "> 超过 3 次改成指数退避，间隔上限 30 秒",
      dim: true,
    });
    expect(lines[1]).toMatchObject({
      text: "> const delay = Math.min(1000 * 2 ** attempt, 30_000);",
      dim: true,
    });
    expect(lines[2]?.text).toBe("› 上限改成 60 秒");
    expect(lines.map((l) => l.text).join("\n")).not.toContain("30 秒\n\n> const");

    // 普通屏幕（EntryRow）：引用行同样位于 › 用户消息上方
    const { lastFrame, unmount } = render(<EntryRow entry={entry} width={80} />);
    await vi.waitFor(() => expect(lastFrame()).toContain("› 上限改成 60 秒"), {
      timeout: 5000,
    });
    const frame = lastFrame() ?? "";
    const quoteIdx = frame.indexOf("> 超过 3 次改成指数退避");
    const promptIdx = frame.indexOf("› 上限改成 60 秒");
    expect(quoteIdx).toBeGreaterThanOrEqual(0);
    expect(promptIdx).toBeGreaterThan(quoteIdx);
    unmount();
  });

  it("每段引用最多两行，超出部分在第二行末尾加省略号", () => {
    const lines = formatQuoteLines(
      [
        { text: "第一行\n第二行\n第三行会被截掉" },
        {
          text: "这是一段非常长非常长非常长非常长非常长非常长非常长非常长的单行文字用来验证自动折行超过两行后的截断效果",
        },
      ],
      { maxWidth: 30, ascii: false },
    );
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe("> 第一行");
    expect(lines[1]).toBe("> 第二行…");
    expect(lines[2]?.startsWith("> ")).toBe(true);
    expect(lines[3]?.startsWith("> ")).toBe(true);
    expect(lines[3]?.endsWith("…")).toBe(true);
  });

  it("无 quotes 字段的旧消息不显示引用行", () => {
    const legacy: UserEntry = {
      kind: "user",
      key: "u:1",
      seq: 1,
      turnId: "turn-1",
      content: [{ type: "text", text: "普通用户消息" }],
    };
    const lines = layoutEntry(legacy, 80, false);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe("› 普通用户消息");
  });
});
