import { describe, expect, it } from "vitest";

import { createSessionView, type RuntimeEvent } from "@nocturne/core/protocol";

import { layoutEntry, layoutLive, transcriptBlocks } from "../src/lines.js";
import { selCopyText } from "../src/selection.js";
import { layoutCached, reanchorFromBottom, selectVisible } from "../src/viewport.js";
import { reasoningLabel, recordReasoning, type ReasoningMap } from "../src/reasoning.js";

const delta = (messageId: string, kind: "reasoning" | "text", text: string): RuntimeEvent =>
  ({ type: "message.assistant.delta", payload: { messageId, kind, delta: text } }) as RuntimeEvent;

describe("思考折叠", () => {
  it("不足四行按实际行数显示，满四行后窗口高度不变且只显示最新四行", () => {
    const view = createSessionView();
    view.live.assistants.push({
      kind: "assistant",
      messageId: "m1",
      turnId: "t1",
      reasoning: "",
      text: "",
    });
    const parts: ReasoningMap = new Map();
    recordReasoning(parts, delta("m1", "reasoning", "一\n二"), 1000);
    expect(layoutLive(view, 80, false, parts, 13000).map((l) => l.text)).toEqual([
      "∴ 思考中 12s（Ctrl+O 展开）",
      "一",
      "二|",
    ]);
    recordReasoning(parts, delta("m1", "reasoning", "\n三\n四\n五"), 2000);
    const full = layoutLive(view, 80, false, parts, 13000).map((l) => l.text);
    expect(full).toHaveLength(5);
    expect(full).toEqual(["∴ 思考中 12s（Ctrl+O 展开）", "二", "三", "四", "五|"]);
    recordReasoning(parts, delta("m1", "reasoning", "\n六"), 3000);
    expect(layoutLive(view, 80, false, parts, 13000).map((l) => l.text)).toEqual([
      "∴ 思考中 12s（Ctrl+O 展开）",
      "三",
      "四",
      "五",
      "六|",
    ]);
    recordReasoning(parts, delta("m1", "text", "正文"), 14000);
    expect(
      layoutLive(view, 80, false, parts, 15000)
        .map((l) => l.text)
        .at(0),
    ).toBe("∴ 思考了 13s（Ctrl+O 展开）");
  });

  it("历史没有秒数；同轮多段分别折叠，窄屏截断并支持 ASCII", () => {
    const parts: ReasoningMap = new Map();
    recordReasoning(parts, delta("m1", "reasoning", "第一段"), 1000);
    recordReasoning(parts, delta("m1", "text", "正文"), 3000);
    recordReasoning(parts, delta("m1", "reasoning", "第二段"), 5000);
    recordReasoning(parts, delta("m1", "text", "后文"), 9000);
    expect(parts.get("m1")).toHaveLength(2);
    expect(parts.get("m1")?.map((p) => reasoningLabel(p, 10000, false))).toEqual([
      "∴ 思考了 2s（Ctrl+O 展开）",
      "∴ 思考了 4s（Ctrl+O 展开）",
    ]);
    const entry = {
      kind: "assistant" as const,
      key: "a1",
      turnId: "t1",
      messageId: "m1",
      seq: 1,
      time: "2026-10-08T02:00:00.000Z",
      text: "正文后文",
      reasoning: "第一段第二段",
      toolCalls: [],
      model: { provider: "fake", model: "fake-1" },
      usage: undefined,
      finishReason: "stop" as const,
    };
    expect(
      layoutEntry(entry, 80, false, parts, 10000)
        .slice(0, 2)
        .map((l) => l.text),
    ).toEqual(["∴ 思考了 2s（Ctrl+O 展开）", "∴ 思考了 4s（Ctrl+O 展开）"]);
    expect(layoutEntry(entry, 14, true, parts, 10000)[0]?.text).toMatch(/^\* 思考\.\.\./);
    expect(layoutEntry(entry, 14, true, parts, 10000)[0]?.text.length).toBeLessThan(14);
    const historic = layoutEntry(entry, 80, false, new Map());
    expect(historic[0]?.text).toBe("∴ 思考（Ctrl+O 展开）");
    const narrow = createSessionView();
    narrow.live.assistants.push({
      kind: "assistant",
      messageId: "m1",
      turnId: "t1",
      reasoning: "1234567890",
      text: "",
    });
    const narrowParts: ReasoningMap = new Map([["m1", [{ text: "1234567890", active: true }]]]);
    expect(layoutLive(narrow, 14, true, narrowParts, 10000).at(-1)?.text).toBe("123456789_");
    const expanded = layoutEntry(entry, 80, false, parts, 10000, true);
    expect(expanded.slice(0, 4).map((l) => l.text)).toEqual([
      "∴ 思考了 2s",
      "  第一段",
      "∴ 思考了 4s",
      "  第二段",
    ]);
  });

  it("历史与活动条目均可原位展开", () => {
    const view = createSessionView();
    view.entries.push({
      kind: "assistant",
      key: "a1",
      turnId: "t1",
      messageId: "m1",
      seq: 1,
      time: "2026-10-08T02:00:00.000Z",
      text: "答",
      reasoning: "历史思考",
      toolCalls: [],
      model: { provider: "fake", model: "fake-1" },
      usage: undefined,
      finishReason: "stop",
    });
    view.live.assistants.push({
      kind: "assistant",
      messageId: "m2",
      turnId: "t2",
      text: "",
      reasoning: "正在想",
    });
    const first = view.entries[0];
    if (first === undefined) throw new Error("缺少历史条目");
    expect(layoutEntry(first, 80, false, new Map(), 0, true).map((l) => l.text)).toContain(
      "  历史思考",
    );
    expect(layoutLive(view, 80, false, new Map(), 0, true).map((l) => l.text)).toContain(
      "  正在想|",
    );
  });

  it("展开时流式全文可见，收起后回到四行窗口", () => {
    const view = createSessionView();
    view.live.assistants.push({
      kind: "assistant",
      messageId: "m",
      turnId: "t",
      text: "",
      reasoning: "",
    });
    const parts: ReasoningMap = new Map();
    recordReasoning(parts, delta("m", "reasoning", "一\n二\n三\n四\n五\n六"), 1000);
    expect(layoutLive(view, 80, false, parts, 2000, true).map((line) => line.text)).toEqual([
      "∴ 思考中 1s",
      "  一",
      "  二",
      "  三",
      "  四",
      "  五",
      "  六|",
    ]);
    expect(layoutLive(view, 80, false, parts, 2000).map((line) => line.text)).toEqual([
      "∴ 思考中 1s（Ctrl+O 展开）",
      "三",
      "四",
      "五",
      "六|",
    ]);
  });

  it("冻结条目与工具行保留原顺序，缓存按展开形态隔离，翻阅锚点保留", () => {
    const view = createSessionView();
    const assistant = (key: string, messageId: string, reasoning: string) => ({
      kind: "assistant" as const,
      key,
      turnId: "t",
      messageId,
      seq: 1,
      time: "2026-10-08T02:00:00.000Z",
      text: "答",
      reasoning,
      toolCalls: [],
      model: { provider: "fake", model: "fake-1" },
      usage: undefined,
      finishReason: "stop" as const,
    });
    const frozen = [
      assistant("old", "old-m", "旧思考"),
      {
        kind: "separator" as const,
        key: "tool-marker",
        text: "工具调用 shell",
      },
    ];
    view.entries.push(assistant("new", "new-m", "新思考"));
    const source = {
      welcome: [],
      notices: [],
      frozen,
      entries: view.entries,
      hide: () => false,
      live: view,
      clientLines: [],
      ascii: false,
    };
    const cache = new Map();
    const folded = transcriptBlocks({ ...source, expanded: false });
    const open = transcriptBlocks({ ...source, expanded: true });
    const foldedText = folded.flatMap((block) =>
      layoutCached(block, 80, cache).map((line) => line.text),
    );
    const openText = open.flatMap((block) =>
      layoutCached(block, 80, cache).map((line) => line.text),
    );
    expect(foldedText).not.toContain("  旧思考");
    expect(openText.indexOf("  旧思考")).toBeLessThan(
      openText.findIndex((line) => line.includes("工具调用 shell")),
    );
    expect(openText.findIndex((line) => line.includes("工具调用 shell"))).toBeLessThan(
      openText.indexOf("  新思考"),
    );
    const oldBlock = folded.find((block) => block.key === "old");
    if (oldBlock === undefined) throw new Error("缺少冻结条目");
    const top = layoutCached(oldBlock, 80, cache)[0];
    const offset = reanchorFromBottom(folded, open, 80, 2, top, cache);
    expect(selectVisible(open, 80, 2, offset, cache).lines[0]?.key).toBe(top?.key);
    expect(selectVisible(folded, 80, 2, 0, cache).atBottom).toBe(true);
    expect(selectVisible(open, 80, 2, 0, cache).atBottom).toBe(true);
  });

  it("展开思考折行复制去缩进，并拼回原文", () => {
    const entry = {
      kind: "assistant" as const,
      key: "a",
      turnId: "t",
      messageId: "m",
      seq: 1,
      time: "2026-10-08T02:00:00.000Z",
      text: "",
      reasoning: "abcdefghij",
      toolCalls: [],
      model: { provider: "fake", model: "fake-1" },
      usage: undefined,
      finishReason: "stop" as const,
    };
    const lines = layoutEntry(entry, 10, false, new Map(), 0, true);
    expect(lines.filter((line) => line.copyIndent === 2).length).toBeGreaterThan(1);
    const last = lines.at(-1);
    if (last === undefined) throw new Error("缺少思考正文");
    expect(
      selCopyText(lines, {
        anchor: { abs: 1, col: 0 },
        head: { abs: lines.length - 1, col: last.text.length },
      }),
    ).toBe("abcdefghij");
  });
});
