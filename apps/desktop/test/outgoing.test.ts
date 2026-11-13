import { describe, expect, it } from "vitest";
import type { PendingInputsSnapshot, UserEntry, ViewEntry } from "@nocturne/core/protocol";
import {
  acceptOutgoing,
  bindPending,
  emptyOutgoing,
  localTurnEntries,
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

  it("接受后正文与本地不同（如首尾空白规整）仍能按位置替换", () => {
    resetLocalIds();
    const first = local({ place: "turn", text: "  先发送  \r\n", excludeUserSeqs: [1] });
    const book = acceptOutgoing(pushOutgoing(emptyOutgoing(), first), first.id);
    const entries: ViewEntry[] = [user(1, "旧消息"), user(2, "先发送")];
    const next = reconcileOutgoing(book, entries, emptyPending);
    expect(next.items).toEqual([]);
    expect(next.keys.get("u-2")).toBe(first.id);
  });

  it("enqueueInput 绑定 id 后，即使快照从未出现该 id 本地行也消失，且不误伤下一条", () => {
    resetLocalIds();
    const first = local({ place: "pending", text: "插话", excludePendingIds: [] });
    const second = local({ place: "pending", text: "插话", excludePendingIds: [] });
    let book = pushOutgoing(pushOutgoing(emptyOutgoing(), first), second);
    book = bindPending(book, first.id, "pi-gone");
    expect(book.items.map((item) => item.id)).toEqual([second.id]);
    const staleSnapshot: PendingInputsSnapshot = {
      paused: false,
      items: [
        {
          id: "pi-gone",
          mode: "steer",
          text: "插话",
          attachments: 0,
          createdAt: "2026-11-13T00:00:05.000Z",
          paused: false,
        },
      ],
    };
    // 下一条还没拿到自己的 id，不会被上一条的 id 错配消掉
    expect(reconcileOutgoing(book, [], staleSnapshot).items.map((item) => item.id)).toEqual([
      second.id,
    ]);
  });
});

it("本地图片带文件名：解码失败时显示文件名而不是内部键", () => {
  const item = local({
    place: "turn",
    text: "看图",
    input: {
      text: "看图",
      attachments: [{ data: new Uint8Array([1, 2]), mimeType: "image/png", label: "shot.png" }],
    },
  });
  const [entry] = localTurnEntries(pushOutgoing(emptyOutgoing(), item), () => undefined);
  expect(entry?.attachments?.[0]?.label).toBe("shot.png");
});
