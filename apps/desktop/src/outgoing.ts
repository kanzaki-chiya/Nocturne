/**
 * 点发送后、Core 接受前的本地消息。
 *
 * Core 的 `submit` / `enqueueInput` 要等附件准备完才发出 `message.user` 或把
 * 待发行写入快照。界面不等那一步：先放一条和正式行同形的本地条目，正式条目
 * 到达后按发送顺序替换掉。拒收时丢掉本地条目，由输入框把草稿放回去。
 */
import type { ComposerSubmit } from "./Composer.js";
import {
  userEntryText,
  type ContentBlock,
  type FileAttachment,
  type ImageAttachment,
  type ImageMimeType,
  type PendingInputItem,
  type PendingInputsSnapshot,
  type UserEntry,
  type ViewEntry,
} from "@nocturne/core/protocol";

const IMAGE_MIME: readonly ImageMimeType[] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export interface LocalOutgoing {
  id: string;
  place: "turn" | "pending";
  mode: "steer" | "queue";
  /** 输入框里的原文（含 `/plan` 等命令），拒收时原样放回 */
  draftText: string;
  input: ComposerSubmit;
  sentAt: string;
  /** 发送瞬间视图里已有的用户消息 seq，避免对上更早的条目 */
  excludeUserSeqs: readonly number[];
  /** 发送瞬间待发快照里已有的 id */
  excludePendingIds: readonly string[];
  /**
   * Core 已接受这次发送（Turn 已开始）。之后新出现的第一条用户条目就是它，
   * 不再要求正文相同：Core 可能规整过首尾空白或换行。
   */
  accepted?: boolean;
}

export interface OutgoingBook {
  items: readonly LocalOutgoing[];
  /** 正式条目 key → 本地 id，替换后 React key 不变，行不重挂 */
  keys: ReadonlyMap<string, string>;
}

export function emptyOutgoing(): OutgoingBook {
  return { items: [], keys: new Map() };
}

let localSeq = 0;

export function nextLocalId(): string {
  localSeq += 1;
  return `local-${localSeq}`;
}

/** 测试之间互不影响 */
export function resetLocalIds(): void {
  localSeq = 0;
}

export function draftTextOf(input: ComposerSubmit): string {
  return input.draftText ?? input.text;
}

function humanUser(entry: ViewEntry): entry is UserEntry {
  return (
    entry.kind === "user" &&
    entry.subagent === undefined &&
    entry.backgroundShell === undefined &&
    entry.swarm === undefined
  );
}

function sameTurn(local: LocalOutgoing, entry: UserEntry): boolean {
  // 接受后新出现的第一条非插话用户条目就是这次发送（Core 对同一会话串行处理）
  if (local.accepted === true) return entry.steer !== true;
  return (
    userEntryText(entry) === local.input.text &&
    (entry.workMode?.name ?? undefined) === local.input.workMode &&
    (entry.delegate?.agent ?? undefined) === local.input.delegate?.agent
  );
}

function samePending(local: LocalOutgoing, item: PendingInputItem): boolean {
  if (item.mode !== "steer" && item.mode !== "queue") return false;
  if (local.excludePendingIds.includes(item.id)) return false;
  const mode = local.input.workMode ? "queue" : local.mode;
  if (item.mode !== mode) return false;
  if (item.text !== local.input.text) return false;
  if ((item.workMode ?? undefined) !== local.input.workMode) return false;
  const sent = Date.parse(local.sentAt);
  const created = Date.parse(item.createdAt);
  // 服务端时钟略慢时仍算同一条；明显更早的是发送前就在队列里的
  if (!Number.isNaN(sent) && !Number.isNaN(created) && created < sent - 30_000) return false;
  return true;
}

/**
 * 用正式用户条目和待发快照消化本地行。先到的正式条目对上先发送的本地行。
 * 对不上的（插话投递、子代理结果）跳过，不挡住后面那条。
 */
export function reconcileOutgoing(
  book: OutgoingBook,
  entries: readonly ViewEntry[],
  pending: PendingInputsSnapshot,
): OutgoingBook {
  const users = entries.filter(humanUser);
  const keys = new Map(book.keys);
  const claimedSeq = new Set<number>();
  const claimedPending = new Set<string>();
  const items: LocalOutgoing[] = [];
  let userCursor = 0;
  const pendingPool = pending.items.filter(
    (item) => item.mode === "steer" || item.mode === "queue",
  );
  for (const local of book.items) {
    if (local.place === "turn") {
      let matched = false;
      while (userCursor < users.length) {
        const candidate = users[userCursor];
        userCursor += 1;
        if (candidate === undefined || claimedSeq.has(candidate.seq)) continue;
        if (keys.has(candidate.key)) continue;
        if (local.excludeUserSeqs.includes(candidate.seq)) continue;
        if (!sameTurn(local, candidate)) continue;
        claimedSeq.add(candidate.seq);
        keys.set(candidate.key, local.id);
        matched = true;
        break;
      }
      if (!matched) items.push(local);
      continue;
    }
    const index = pendingPool.findIndex(
      (item) => !claimedPending.has(item.id) && samePending(local, item),
    );
    const found = index < 0 ? undefined : pendingPool[index];
    if (found !== undefined) {
      claimedPending.add(found.id);
      continue;
    }
    items.push(local);
  }
  const same =
    items.length === book.items.length && items.every((item, index) => item === book.items[index]);
  if (same && keys.size === book.keys.size) return book;
  return { items, keys };
}

export function pushOutgoing(book: OutgoingBook, item: LocalOutgoing): OutgoingBook {
  return { items: [...book.items, item], keys: book.keys };
}

export function dropOutgoing(book: OutgoingBook, id: string): OutgoingBook {
  const items = book.items.filter((item) => item.id !== id);
  if (items.length === book.items.length) return book;
  return { items, keys: book.keys };
}

/**
 * `enqueueInput` 返回了这条待发输入的 id：去掉本地行。快照里有这个 id 就由快照显示；
 * 没有（已在安全点取走或已投递）也不再等。其余本地行不再拿这个 id 按正文去对。
 */
export function bindPending(book: OutgoingBook, id: string, pendingId: string): OutgoingBook {
  const items = book.items
    .filter((item) => item.id !== id)
    .map((item) =>
      item.place !== "pending" || item.excludePendingIds.includes(pendingId)
        ? item
        : { ...item, excludePendingIds: [...item.excludePendingIds, pendingId] },
    );
  return { items, keys: book.keys };
}

/** 待发本地行被 Core 直接开成了新 Turn（`queued: false`）：转为对话里的本地消息。 */
export function retargetOutgoing(
  book: OutgoingBook,
  id: string,
  place: "turn" | "pending",
): OutgoingBook {
  const items = book.items.map((item) =>
    item.id !== id || item.place === place ? item : { ...item, place },
  );
  if (items.every((item, index) => item === book.items[index])) return book;
  return { items, keys: book.keys };
}

/** Core 已接受这次发送：此后按位置而不是正文对上正式条目。 */
export function acceptOutgoing(book: OutgoingBook, id: string): OutgoingBook {
  const items = book.items.map((item) =>
    item.id !== id || item.accepted === true ? item : { ...item, accepted: true },
  );
  if (items.every((item, index) => item === book.items[index])) return book;
  return { items, keys: book.keys };
}

function isImageMime(mime: string): mime is ImageMimeType {
  return (IMAGE_MIME as readonly string[]).includes(mime);
}

/** 本地图片键。正式消息的 sha256 登记到同一条 blob URL 后，替换不会换图。 */
export function localImageKey(id: string, index: number): string {
  return `local:${id}:${index}`;
}

export function localTurnEntries(
  book: OutgoingBook,
  preview: (key: string, data: Uint8Array, mimeType: string) => void,
): UserEntry[] {
  const turns = book.items.filter((item) => item.place === "turn");
  return turns.map((item, index) => toUserEntry(item, index, preview));
}

function toUserEntry(
  local: LocalOutgoing,
  index: number,
  preview: (key: string, data: Uint8Array, mimeType: string) => void,
): UserEntry {
  const images: ImageAttachment[] = [];
  const files: FileAttachment[] = [];
  local.input.attachments.forEach((attachment, attachmentIndex) => {
    if (isImageMime(attachment.mimeType)) {
      const key = localImageKey(local.id, attachmentIndex);
      preview(key, attachment.data, attachment.mimeType);
      images.push({
        type: "image",
        file: key,
        mimeType: attachment.mimeType,
        bytes: attachment.data.byteLength,
        sha256: key,
        source: "paste",
      });
      return;
    }
    files.push({
      type: "file",
      file: `local:${local.id}:${attachmentIndex}`,
      mimeType: attachment.mimeType,
      bytes: attachment.data.byteLength,
      sha256: `local:${local.id}:${attachmentIndex}`,
      label: attachment.label,
      source: attachment.source === "paste" ? "paste" : "upload",
    });
  });
  const content: ContentBlock[] = [{ type: "text", text: local.input.text }];
  return {
    kind: "user",
    key: local.id,
    seq: -(index + 1),
    turnId: local.id,
    content,
    ...(images.length > 0 ? { attachments: images } : {}),
    ...(files.length > 0 ? { files } : {}),
    ...(local.input.delegate ? { delegate: local.input.delegate } : {}),
    ...(local.input.workMode ? { workMode: { name: local.input.workMode, body: "" } } : {}),
  };
}

export function localPendingItems(book: OutgoingBook): PendingInputItem[] {
  return book.items
    .filter((item) => item.place === "pending")
    .map((item) => ({
      id: item.id,
      mode: item.input.workMode ? "queue" : item.mode,
      text: item.input.text,
      attachments: item.input.attachments.length,
      ...(item.input.attachments.some((attachment) => !isImageMime(attachment.mimeType))
        ? {
            files: item.input.attachments
              .filter((attachment) => !isImageMime(attachment.mimeType))
              .map((attachment) => ({
                label: attachment.label,
                bytes: attachment.data.byteLength,
              })),
          }
        : {}),
      createdAt: item.sentAt,
      paused: false,
      ...(item.input.workMode ? { workMode: item.input.workMode } : {}),
    }));
}

/** 正式快照在前，还没对上的本地行按发送顺序接在后面。 */
export function mergePending(
  snapshot: PendingInputsSnapshot,
  book: OutgoingBook,
): PendingInputsSnapshot {
  const local = localPendingItems(book);
  if (local.length === 0) return snapshot;
  return { ...snapshot, items: [...snapshot.items, ...local] };
}

export function userSeqs(entries: readonly ViewEntry[]): number[] {
  return entries.filter(humanUser).map((entry) => entry.seq);
}

/** 交给 Core 的输入：去掉只在界面上用的 `draftText`。 */
export function submitBody(input: ComposerSubmit): ComposerSubmit {
  if (input.draftText === undefined) return input;
  const { draftText: _draft, ...rest } = input;
  return rest;
}

/** 本地消息的首行，作为侧栏标题（规则同 Core 的 firstUserText：第一个非空行） */
export function outgoingTitle(book: OutgoingBook): string | undefined {
  const first = book.items.find((item) => item.place === "turn");
  if (first === undefined) return undefined;
  for (const raw of first.input.text.split("\n")) {
    const line = raw.trim();
    if (line !== "") return line;
  }
  return undefined;
}
