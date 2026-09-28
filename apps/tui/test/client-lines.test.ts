import { describe, expect, it } from "vitest";

import { createSessionView, type ViewEntry } from "@nocturne/core/protocol";
import { interleaveClient } from "../src/client-lines.js";
import { transcriptBlocks } from "../src/lines.js";

const line = (id: number, after: number) => ({ id, text: `! 提示${id}`, after });

describe("本地提示行定位", () => {
  it("按推入时的条目数插在条目之间，其余排在最后", () => {
    const out = interleaveClient(
      ["a", "b", "c"],
      0,
      [line(2, 3), line(0, 0), line(1, 2)],
      (e) => [e],
      (l) => `#${l.id}`,
    );
    expect(out).toEqual(["#0", "a", "b", "#1", "c", "#2"]);
    // base 偏移：活动区的 tail 从第 base 条开始
    expect(
      interleaveClient(
        ["c"],
        2,
        [line(1, 2)],
        (e) => [e],
        (l) => `#${l.id}`,
      ),
    ).toEqual(["#1", "c"]);
  });

  it("全屏块表里提示行随条目滚走，推入后才有的条目排在它下面", () => {
    const entries = ["e0", "e1"].map((key) => ({ kind: "notice", key }) as unknown as ViewEntry);
    const blocks = transcriptBlocks({
      welcome: [],
      notices: [],
      frozen: [],
      entries,
      hide: () => false,
      live: createSessionView(),
      clientLines: [line(0, 1), line(1, 2)],
      ascii: false,
    });
    expect(blocks.map((b) => b.key)).toEqual([
      "welcome",
      "e0",
      "client:0",
      "e1",
      "live",
      "client:1",
    ]);
  });
});
