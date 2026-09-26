/**
 * 可见行窗口（ADR-0020）：只布局、只返回视口内的行。
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
}

export interface LaidLine {
  key: string;
  text: string;
  color?: string | undefined;
  dim?: boolean | undefined;
  bold?: boolean | undefined;
  segments?: readonly LineSegment[] | undefined;
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
    return { lines: [], atTop: true, atBottom: true, clampedFromBottom: 0 };
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
  };
}
