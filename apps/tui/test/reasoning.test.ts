import { describe, expect, it } from "vitest";

import { createSessionView, type RuntimeEvent } from "@nocturne/core/protocol";

import { layoutEntry, layoutLive, reasoningPageLines } from "../src/lines.js";
import {
  reasoningLabel,
  reasoningTurns,
  recordReasoning,
  type ReasoningMap,
} from "../src/reasoning.js";

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
      "∴ 思考中 12s（Ctrl+O 查看）",
      "一",
      "二|",
    ]);
    recordReasoning(parts, delta("m1", "reasoning", "\n三\n四\n五"), 2000);
    const full = layoutLive(view, 80, false, parts, 13000).map((l) => l.text);
    expect(full).toHaveLength(5);
    expect(full).toEqual(["∴ 思考中 12s（Ctrl+O 查看）", "二", "三", "四", "五|"]);
    recordReasoning(parts, delta("m1", "reasoning", "\n六"), 3000);
    expect(layoutLive(view, 80, false, parts, 13000).map((l) => l.text)).toEqual([
      "∴ 思考中 12s（Ctrl+O 查看）",
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
    ).toBe("∴ 思考了 13s（Ctrl+O 查看）");
  });

  it("历史没有秒数；同轮多段分别折叠，窄屏截断并支持 ASCII", () => {
    const parts: ReasoningMap = new Map();
    recordReasoning(parts, delta("m1", "reasoning", "第一段"), 1000);
    recordReasoning(parts, delta("m1", "text", "正文"), 3000);
    recordReasoning(parts, delta("m1", "reasoning", "第二段"), 5000);
    recordReasoning(parts, delta("m1", "text", "后文"), 9000);
    expect(parts.get("m1")).toHaveLength(2);
    expect(parts.get("m1")?.map((p) => reasoningLabel(p, 10000, false))).toEqual([
      "∴ 思考了 2s（Ctrl+O 查看）",
      "∴ 思考了 4s（Ctrl+O 查看）",
    ]);
    const entry = {
      kind: "assistant" as const,
      key: "a1",
      turnId: "t1",
      messageId: "m1",
      seq: 1,
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
    ).toEqual(["∴ 思考了 2s（Ctrl+O 查看）", "∴ 思考了 4s（Ctrl+O 查看）"]);
    expect(layoutEntry(entry, 14, true, parts, 10000)[0]?.text).toMatch(/^\* 思考\.\.\./);
    expect(layoutEntry(entry, 14, true, parts, 10000)[0]?.text.length).toBeLessThan(14);
    const historic = layoutEntry(entry, 80, false, new Map());
    expect(historic[0]?.text).toBe("∴ 思考（Ctrl+O 查看）");
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
    const page = reasoningPageLines({ id: "t1", parts: parts.get("m1") ?? [] }, 80, 10000, false);
    expect(page.map((l) => l.text)).toContain("第一段");
    expect(page.map((l) => l.text)).toContain("第二段");
    expect(page.some((l) => l.key.startsWith("sep:"))).toBe(true);
    expect(page.find((l) => l.text === "第一段")?.dim).toBeUndefined();
  });

  it("思考页只计有思考的轮次，历史与活动轮次并存", () => {
    const view = createSessionView();
    view.entries.push({
      kind: "assistant",
      key: "a1",
      turnId: "t1",
      messageId: "m1",
      seq: 1,
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
    const turns = reasoningTurns(view, new Map([["m2", [{ text: "正在想", active: true }]]]));
    expect(turns.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(turns[0]?.parts[0]?.text).toBe("历史思考");
    expect(turns[1]?.parts[0]?.text).toBe("正在想");
  });
});
