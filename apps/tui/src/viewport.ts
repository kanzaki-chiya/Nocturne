/**
 * 已排版行与可见行窗口（ADR-0020/0021）：普通屏幕模式下 LaidLine 描述
 * 活动区行；全屏模式下 LineBlock/selectVisible 只布局、只返回视口内的行。
 * 跟随底部时从末尾向前布局，直到填满视口；翻到顶部才会碰到开头。
 * 已布局的块按 key+revision+宽度缓存，流式更新只重算变化的块。
 */
/** 行内分段着色（欢迎区弯月等）；text 仍是整行纯文本 */
export interface LineSegment {
  text: string;
  color?: string | undefined;
  backgroundColor?: string | undefined;
  dim?: boolean | undefined;
  bold?: boolean | undefined;
  italic?: boolean | undefined;
  /** 选区高亮（反色）；由 selSegments 拆分标注 */
  inverse?: boolean | undefined;
}

/** 已按终端显示宽度排好的行。 */
export interface LaidLine {
  key: string;
  text: string;
  color?: string | undefined;
  dim?: boolean | undefined;
  bold?: boolean | undefined;
  italic?: boolean | undefined;
  segments?: readonly LineSegment[] | undefined;
  /**
   * 本行是上一行被自动折行断开的续行（复制时拼回一行；真换行不标）。
   */
  continued?: boolean | undefined;
  /** 仅显示用的左缩进；复制时去掉。 */
  copyIndent?: number | undefined;
}

export interface LineBlock {
  key: string;
  revision: string;
  layout: (width: number) => LaidLine[];
}

export interface VisibleWindow {
  lines: LaidLine[];
  atTop: boolean;
  atBottom: boolean;
  /** 到顶后夹紧的 fromBottom；未到顶时等于请求值 */
  clampedFromBottom: number;
  /**
   * 视口定位信息（选区坐标换算用）：collected 是从块表末尾向前收集到的
   * 行数，lines = collected.slice(sliceStart, sliceEnd)。若 exhausted 为真
   * 则 collected 即完整行表，lines[i] 的绝对序号为 sliceStart + i；否则需要
   * 调用方用 countLaidLines 求总数后换算：abs = total - collectedLength
   * + sliceStart + i。
   */
  collectedLength: number;
  sliceStart: number;
  exhausted: boolean;
}

function cacheKey(block: LineBlock, width: number): string {
  return `${block.key}\0${block.revision}\0${width}`;
}

export function layoutCached(
  block: LineBlock,
  width: number,
  cache: Map<string, LaidLine[]>,
): LaidLine[] {
  const key = cacheKey(block, width);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const lines = block.layout(width);
  cache.set(key, lines);
  return lines;
}

/** 离开底部后用来发现“尾部长了多少行”。跟随态不要调用，以免布局全部历史。 */
export function countLaidLines(
  blocks: readonly LineBlock[],
  width: number,
  cache: Map<string, LaidLine[]>,
): number {
  let n = 0;
  for (const block of blocks) n += layoutCached(block, width, cache).length;
  return n;
}

/** 切换排版形态时以顶部条目及条目内行偏移恢复翻阅位置。 */
export function reanchorFromBottom(
  before: readonly LineBlock[],
  after: readonly LineBlock[],
  width: number,
  viewport: number,
  top: LaidLine | undefined,
  cache: Map<string, LaidLine[]>,
): number {
  if (top === undefined) return 0;
  const owner = before.find((block) =>
    layoutCached(block, width, cache).some((line) => line.key === top.key),
  );
  if (owner === undefined) return 0;
  const offset = layoutCached(owner, width, cache).findIndex((line) => line.key === top.key);
  let start = 0;
  let total = 0;
  for (const block of after) {
    const length = layoutCached(block, width, cache).length;
    if (block.key === owner.key) start = total + Math.min(offset, Math.max(0, length - 1));
    total += length;
  }
  return Math.max(0, total - start - viewport);
}

/**
 * 从末尾向前取行，直到够 fromBottom + viewport 行或块用尽。
 * 未用尽时不布局更早的块。
 */
export function selectVisible(
  blocks: readonly LineBlock[],
  width: number,
  viewport: number,
  fromBottom: number,
  cache: Map<string, LaidLine[]>,
): VisibleWindow {
  if (viewport <= 0) {
    return {
      lines: [],
      atTop: true,
      atBottom: true,
      clampedFromBottom: 0,
      collectedLength: 0,
      sliceStart: 0,
      exhausted: true,
    };
  }
  const need = fromBottom + viewport;
  const collected: LaidLine[] = [];
  let exhausted = true;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block === undefined) continue;
    const lines = layoutCached(block, width, cache);
    for (let j = lines.length - 1; j >= 0; j--) {
      const line = lines[j];
      if (line !== undefined) collected.push(line);
    }
    if (collected.length >= need && i > 0) {
      exhausted = false;
      break;
    }
  }
  collected.reverse();
  const maxFromBottom = Math.max(0, collected.length - viewport);
  const clamped = exhausted ? Math.min(fromBottom, maxFromBottom) : fromBottom;
  const end = collected.length - clamped;
  const start = Math.max(0, end - viewport);
  return {
    lines: collected.slice(start, end),
    atTop: exhausted && start === 0,
    atBottom: clamped === 0,
    clampedFromBottom: clamped,
    collectedLength: collected.length,
    sliceStart: start,
    exhausted,
  };
}
