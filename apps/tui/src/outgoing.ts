/**
 * 点发送后、Core 接受前的本地行。正式用户消息或待发快照对上后撤掉，
 * 避免和 Static 里的正式行叠成两条。
 */
import {
  userEntryText,
  type FileAttachment,
  type ImageAttachment,
  type ImageMimeType,
  type PendingInputItem,
  type PendingInputsSnapshot,
  type UserEntry,
  type ViewEntry,
  type WorkModeName,
} from "@nocturne/core/protocol";

export interface TuiLocal {
  id: string;
  place: "turn" | "pending";
  mode: "steer" | "queue";
  /** 发给模型的文本 */
  text: string;
  workMode?: WorkModeName | undefined;
  images: { data: Uint8Array; mimeType: ImageMimeType; label: string }[];
  files: { data: Uint8Array; mimeType: string; label: string; source: "paste" | "upload" }[];
  sentAt: string;
  excludeUserSeqs: readonly number[];
  excludePendingIds: readonly string[];
  /**
   * 发送瞬间视图的 Turn 数。之后有新 Turn 开始就说明 Core 已接受这次发送
   * （空闲发送时 Core 串行处理，下一个 Turn 一定是它），此后新出现的第一条
   * 用户条目就归它，不再要求正文相同。
   */
  turnCount?: number | undefined;
}

function human(entry: ViewEntry): entry is UserEntry {
  return (
    entry.kind === "user" &&
    entry.subagent === undefined &&
    entry.backgroundShell === undefined &&
    entry.ensemble === undefined
  );
}

function sameTurn(local: TuiLocal, entry: UserEntry, turnCount: number | undefined): boolean {
  const accepted =
    local.turnCount !== undefined && turnCount !== undefined && turnCount > local.turnCount;
  if (accepted) return entry.steer !== true;
  return (
    userEntryText(entry) === local.text && (entry.workMode?.name ?? undefined) === local.workMode
  );
}

export function reconcileLocals(
  items: readonly TuiLocal[],
  entries: readonly ViewEntry[],
  pending: PendingInputsSnapshot,
  turnCount?: number,
): TuiLocal[] {
  const users = entries.filter(human);
  const kept: TuiLocal[] = [];
  let cursor = 0;
  const pool = pending.items.filter((item) => item.mode === "steer" || item.mode === "queue");
  const claimed = new Set<string>();
  for (const local of items) {
    if (local.place === "turn") {
      let matched = false;
      while (cursor < users.length) {
        const candidate = users[cursor];
        cursor += 1;
        if (candidate === undefined || local.excludeUserSeqs.includes(candidate.seq)) continue;
        if (!sameTurn(local, candidate, turnCount)) continue;
        matched = true;
        break;
      }
      if (!matched) kept.push(local);
      continue;
    }
    const found = pool.find((item) => !claimed.has(item.id) && samePending(local, item));
    if (found !== undefined) {
      claimed.add(found.id);
      continue;
    }
    kept.push(local);
  }
  return kept.length === items.length && kept.every((item, index) => item === items[index])
    ? (items as TuiLocal[])
    : kept;
}

/**
 * `enqueueInput` 返回了 id：去掉本地行（快照里有就由快照显示，没有就是已被取走），
 * 其余本地行不再拿这个 id 按正文去对。
 */
export function bindLocalPending(
  items: readonly TuiLocal[],
  id: string,
  pendingId: string,
): TuiLocal[] {
  return items
    .filter((item) => item.id !== id)
    .map((item) =>
      item.place !== "pending" || item.excludePendingIds.includes(pendingId)
        ? item
        : { ...item, excludePendingIds: [...item.excludePendingIds, pendingId] },
    );
}

function samePending(local: TuiLocal, item: PendingInputItem): boolean {
  if (local.excludePendingIds.includes(item.id)) return false;
  if (item.mode !== local.mode) return false;
  if (item.text !== local.text) return false;
  if ((item.workMode ?? undefined) !== local.workMode) return false;
  const sent = Date.parse(local.sentAt);
  const created = Date.parse(item.createdAt);
  if (!Number.isNaN(sent) && !Number.isNaN(created) && created < sent - 30_000) return false;
  return true;
}

export function localUserEntry(local: TuiLocal): UserEntry {
  const attachments: ImageAttachment[] = local.images.map((image, index) => ({
    type: "image",
    file: `local:${local.id}:${index}`,
    mimeType: image.mimeType,
    bytes: image.data.byteLength,
    sha256: `local:${local.id}:${index}`,
    source: "paste",
    label: image.label,
  }));
  const files: FileAttachment[] = local.files.map((file, index) => ({
    type: "file",
    file: `local:${local.id}:f:${index}`,
    mimeType: file.mimeType,
    bytes: file.data.byteLength,
    sha256: `local:${local.id}:f:${index}`,
    label: file.label,
    source: file.source,
  }));
  return {
    kind: "user",
    key: local.id,
    seq: -1,
    turnId: local.id,
    content: [{ type: "text", text: local.text }],
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(files.length > 0 ? { files } : {}),
    ...(local.workMode ? { workMode: { name: local.workMode, body: "" } } : {}),
  };
}

export function localPendingItems(items: readonly TuiLocal[]): PendingInputItem[] {
  return items
    .filter((item) => item.place === "pending")
    .map((item) => ({
      id: item.id,
      mode: item.mode,
      text: item.text,
      attachments: item.images.length + item.files.length,
      ...(item.files.length > 0
        ? { files: item.files.map((file) => ({ label: file.label, bytes: file.data.byteLength })) }
        : {}),
      createdAt: item.sentAt,
      paused: false,
      ...(item.workMode ? { workMode: item.workMode } : {}),
    }));
}
