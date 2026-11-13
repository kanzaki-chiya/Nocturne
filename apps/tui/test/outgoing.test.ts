import { describe, expect, it } from "vitest";
import type { PendingInputsSnapshot, ViewEntry } from "@nocturne/core/protocol";
import {
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
});
