import { describe, expect, it } from "vitest";
import type { PendingInputsSnapshot, ViewEntry } from "@nocturne/core/protocol";
import {
  bindLocalPending,
  localPendingItems,
  localUserEntry,
  reconcileLocals,
  type TuiLocal,
} from "../src/outgoing.js";

function row(partial: Partial<TuiLocal> & Pick<TuiLocal, "place" | "text">): TuiLocal {
  return {
    id: partial.id ?? "t1",
    place: partial.place,
    mode: partial.mode ?? "steer",
    text: partial.text,
    images: [],
    files: [],
    sentAt: partial.sentAt ?? "2026-11-13T00:00:00.000Z",
    excludeUserSeqs: partial.excludeUserSeqs ?? [],
    excludePendingIds: partial.excludePendingIds ?? [],
  };
}

describe("TUI 本地发送", () => {
  it("正式用户消息到达后撤掉本地行，外观仍是用户消息", () => {
    const local = row({ place: "turn", text: "你好", excludeUserSeqs: [] });
    const entry = localUserEntry(local);
    expect(entry.kind).toBe("user");
    expect(entry.content).toEqual([{ type: "text", text: "你好" }]);
    const entries: ViewEntry[] = [
      {
        kind: "user",
        key: "u1",
        seq: 1,
        turnId: "t",
        content: [{ type: "text", text: "你好" }],
      },
    ];
    expect(reconcileLocals([local], entries, { items: [], paused: false })).toEqual([]);
  });

  it("待发本地行在快照到达前保留，到达后撤掉", () => {
    const local = row({ place: "pending", text: "排队", mode: "queue" });
    expect(localPendingItems([local]).map((item) => item.text)).toEqual(["排队"]);
    const pending: PendingInputsSnapshot = {
      paused: false,
      items: [
        {
          id: "p1",
          mode: "queue",
          text: "排队",
          attachments: 0,
          createdAt: "2026-11-13T00:00:01.000Z",
          paused: false,
        },
      ],
    };
    expect(reconcileLocals([local], [], pending)).toEqual([]);
  });

  it("新 Turn 开始后正文不同也能替换本地行", () => {
    const local: TuiLocal = {
      ...row({ place: "turn", text: "  第一行\r\n" }),
      turnCount: 0,
    };
    const entries: ViewEntry[] = [
      {
        kind: "user",
        key: "u1",
        seq: 1,
        turnId: "t1",
        content: [{ type: "text", text: "第一行" }],
      },
    ];
    expect(reconcileLocals([local], entries, { items: [], paused: false }, 1)).toEqual([]);
  });

  it("enqueueInput 绑定 id 后即使快照从未出现该 id 也会撤掉，且不误伤下一条", () => {
    const first = row({ id: "t1", place: "pending", text: "插话" });
    const second = row({ id: "t2", place: "pending", text: "插话" });
    const bound = bindLocalPending([first, second], "t1", "pi-gone");
    expect(bound.map((item) => item.id)).toEqual(["t2"]);
    const pending: PendingInputsSnapshot = {
      paused: false,
      items: [
        {
          id: "pi-gone",
          mode: "steer",
          text: "插话",
          attachments: 0,
          createdAt: "2026-11-13T00:00:01.000Z",
          paused: false,
        },
      ],
    };
    expect(reconcileLocals(bound, [], pending).map((item) => item.id)).toEqual(["t2"]);
  });
});
