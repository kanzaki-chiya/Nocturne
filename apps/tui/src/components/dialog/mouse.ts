import type { DOMElement } from "ink";
import type { HitBox } from "../../click.js";
import type { MouseEvent } from "../../mouse.js";

export interface DialogMouseFrame {
  layer: string;
  boxes: readonly HitBox[];
  click: (id: string, event: MouseEvent) => void;
  wheel: (event: Extract<MouseEvent, { type: "wheel" }>) => void;
}

/** Ink 已布局节点的绝对显示列/行；与 SGR 一样为 1 基。 */
export function screenRect(node: DOMElement | undefined): {
  row: number;
  col: number;
  width: number;
  height: number;
} {
  const layout = node?.yogaNode?.getComputedLayout();
  let row = 1,
    col = 1;
  for (let parent = node; parent !== undefined; parent = parent.parentNode) {
    const offset = parent.yogaNode?.getComputedLayout();
    row += offset?.top ?? 0;
    col += offset?.left ?? 0;
  }
  return { row, col, width: layout?.width ?? 0, height: layout?.height ?? 0 };
}
