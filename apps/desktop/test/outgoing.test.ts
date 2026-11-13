import { describe, expect, it } from "vitest";
import type { PendingInputsSnapshot, UserEntry, ViewEntry } from "@nocturne/core/protocol";
import {
  emptyOutgoing,
  nextLocalId,
  pushOutgoing,
  reconcileOutgoing,
  resetLocalIds,
  type LocalOutgoing,
} from "../src/outgoing";

function local(
  partial: Partial<LocalOutgoing> & { place: LocalOutgoing["place"]; text: string },
): LocalOutgoing {
  return {
    id: partial.id ?? nextLocalId(),
    place: partial.place,
    mode: partial.mode ?? "steer",
    draftText: partial.draftText ?? partial.text,
    input: partial.input ?? { text: partial.text, attachments: [] },
    sentAt: partial.sentAt ?? "2026-11-13T00:00:00.000Z",
    excludeUserSeqs: partial.excludeUserSeqs ?? [],
    excludePendingIds: partial.excludePendingIds ?? [],
  };
}

function user(seq: number, text: string): UserEntry {
  return {
    kind: "user",
    key: `u-${seq}`,
    seq,
    turnId: `t-${seq}`,
    content: [{ type: "text", text }],
  };
}

const emptyPending: PendingInputsSnapshot = { items: [], paused: false };

describe("本地发送与正式条目对上", () => {
  it("按发送顺序替换，跳过对不上的旧消息", () => {
    resetLocalIds();
    const first = local({ place: "turn", text: "先", excludeUserSeqs: [1] });
    const second = local({ place: "turn", text: "后", excludeUserSeqs: [1] });
    const book = pushOutgoing(pushOutgoing(emptyOutgoing(), first), second);
    const entries: ViewEntry[] = [user(1, "更早"), user(2, "先"), user(3, "后")];
    const next = reconcileOutgoing(book, entries, emptyPending);
    expect(next.items).toEqual([]);
    expect(next.keys.get("u-2")).toBe(first.id);
    expect(next.keys.get("u-3")).toBe(second.id);
  });

  it("待发快照里的新行按文本消化本地行，更早的同文不抢", () => {
    resetLocalIds();
    const queued = local({
      place: "pending",
      text: "插话",
      sentAt: "2026-11-13T00:00:10.000Z",
      excludePendingIds: ["old"],
    });
    const book = pushOutgoing(emptyOutgoing(), queued);
    const pending: PendingInputsSnapshot = {
      paused: false,
      items: [
        {
          id: "old",
          mode: "steer",
          text: "插话",
          attachments: 0,
          createdAt: "2026-11-13T00:00:00.000Z",
          paused: false,
        },
        {
          id: "new",
          mode: "steer",
          text: "插话",
          attachments: 0,
          createdAt: "2026-11-13T00:00:11.000Z",
          paused: false,
        },
      ],
    };
    expect(reconcileOutgoing(book, [], pending).items).toEqual([]);
  });
});
