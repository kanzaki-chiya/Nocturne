import {
  isRuntimeWorkMode,
  userEntryText,
  type UserEntry,
  type ViewEntry,
} from "@nocturne/core/protocol";

export interface TurnRailItem {
  /** 开启该轮的用户消息持久事件 seq */
  seq: number;
  /** 该条目在 view.entries 中的下标 */
  entryIndex: number;
  /** 用户消息第一行非空文字 */
  label: string;
}

export const MIN_TURNS_FOR_RAIL = 3;
export const MIN_WIDTH_FOR_RAIL = 640;
export const RAIL_CLOSE_DELAY_MS = 150;
export const RAIL_MAX_HEIGHT_RATIO = 0.6;

const TICK_HEIGHT_PX = 2;
const TICK_GAP_PX = 7;
const RAIL_PAD_Y_PX = 16;
const DEFAULT_RAIL_CONTAINER_HEIGHT = 600;

/**
 * 判断条目是否为开启新 Turn 的用户消息。
 * 排除插话（steer）、子代理结果、后台任务结果、合奏帖子送达、组曲汇报与 Runtime 写入的模式消息。
 */
export function isTurnStartEntry(entry: ViewEntry): entry is UserEntry {
  return (
    entry.kind === "user" &&
    entry.steer !== true &&
    entry.subagent === undefined &&
    entry.backgroundShell === undefined &&
    entry.ensemble === undefined &&
    entry.suiteReport === undefined &&
    !isRuntimeWorkMode(entry.workMode)
  );
}

/** 提取用户消息正文的第一行非空文字；无文字时回退为命令名、附件名或「[图片]」。 */
export function firstLineOfUserEntry(entry: UserEntry): string {
  const raw = userEntryText(entry);
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed !== "") return trimmed;
  }
  if (entry.delegate !== undefined) return `/${entry.delegate.agent}`;
  if (entry.workMode !== undefined) return `/${entry.workMode.name}`;
  if (entry.skill !== undefined) return `/${entry.skill.name}`;
  if (entry.files !== undefined && entry.files.length > 0) {
    return entry.files[0]?.label ?? "";
  }
  if (entry.attachments !== undefined && entry.attachments.length > 0) {
    return "[图片]";
  }
  return "";
}

/** 从全量 view.entries 提取全部轮次项。 */
export function extractConversationTurns(entries: readonly ViewEntry[]): TurnRailItem[] {
  const turns: TurnRailItem[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry === undefined || !isTurnStartEntry(entry)) continue;
    turns.push({
      seq: entry.seq,
      entryIndex: i,
      label: firstLineOfUserEntry(entry),
    });
  }
  return turns;
}

/** 根据视口中线命中的条目下标，定位当前所在轮次（最后一个 entryIndex <= midEntryIndex 的轮）。 */
export function findCurrentTurnIndex(
  turns: readonly TurnRailItem[],
  midEntryIndex: number,
): number {
  if (turns.length === 0) return -1;
  let current = 0;
  for (let i = 0; i < turns.length; i += 1) {
    const turn = turns[i];
    if (turn !== undefined && turn.entryIndex <= midEntryIndex) {
      current = i;
    } else {
      break;
    }
  }
  return current;
}

/** 上一轮（-1）/ 下一轮（+1），在首尾夹紧不循环。 */
export function stepTurnIndex(currentIndex: number, total: number, direction: -1 | 1): number {
  if (total <= 0) return -1;
  if (currentIndex < 0 || currentIndex >= total) {
    return direction === 1 ? 0 : total - 1;
  }
  return Math.max(0, Math.min(total - 1, currentIndex + direction));
}

export interface TurnTickLayout {
  trackHeight: number;
  tops: number[];
}

/**
 * 计算轮次导航短横线的轨道高度与各条横线的纵坐标。
 * 轮数少时按等间距排列；放不下时限制在对话区高度的 60% 内按比例分布。
 */
export function computeTurnTickLayout(count: number, containerHeight: number): TurnTickLayout {
  if (count <= 0) return { trackHeight: 0, tops: [] };
  if (count === 1) return { trackHeight: TICK_HEIGHT_PX, tops: [0] };

  const naturalHeight = count * TICK_HEIGHT_PX + (count - 1) * TICK_GAP_PX;
  const effectiveHeight = containerHeight > 0 ? containerHeight : DEFAULT_RAIL_CONTAINER_HEIGHT;
  const maxTrackHeight = Math.max(
    TICK_HEIGHT_PX,
    Math.floor(effectiveHeight * RAIL_MAX_HEIGHT_RATIO) - RAIL_PAD_Y_PX,
  );
  const trackHeight = Math.min(naturalHeight, maxTrackHeight);
  const span = Math.max(0, trackHeight - TICK_HEIGHT_PX);
  const tops: number[] = [];
  for (let i = 0; i < count; i += 1) {
    tops.push(Math.round((i / (count - 1)) * span * 100) / 100);
  }
  return { trackHeight, tops };
}
