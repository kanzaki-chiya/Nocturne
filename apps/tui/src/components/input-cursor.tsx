import { useCursor } from "ink";

import { cursorColumn } from "../cursor.js";

/** 仅在当前输入行有焦点时定位 IME 硬件光标；坐标从帧左上角开始。 */
export function InputCursor({
  active,
  prefix,
  text,
  width,
  x = 0,
  y,
}: {
  active: boolean;
  prefix: string;
  text: string;
  width: number;
  x?: number | undefined;
  y: number;
}): null {
  const { setCursorPosition } = useCursor();
  setCursorPosition(active ? { x: x + cursorColumn(prefix, text, width), y } : undefined);
  // Ink 自身在提交阶段传播坐标；此组件不直接写 ANSI。
  return null;
}
