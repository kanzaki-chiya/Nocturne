import type { MouseEvent } from "./mouse.js";

/** 终端绝对坐标，1 基；两端显示列均包含在命中框内。 */
export interface HitBox {
  id: string;
  row: number;
  colStart: number;
  colEnd: number;
}

/** 松开才触发；任何 drag 都永久取消这次按下。调用方换层时 reset。 */
export function createClickTracker(): {
  feed: (event: MouseEvent, boxes: readonly HitBox[]) => string | undefined;
  reset: () => void;
} {
  let pressed: string | undefined;
  const reset = (): void => {
    pressed = undefined;
  };
  return {
    reset,
    feed(event, boxes) {
      const hit = (): string | undefined =>
        boxes.find((box) => box.row === event.y && event.x >= box.colStart && event.x <= box.colEnd)
          ?.id;
      if (event.type === "press") pressed = event.button === 0 ? hit() : undefined;
      else if (event.type === "drag") reset();
      else if (event.type === "release") {
        const id = pressed;
        reset();
        if (event.button === 0 && id !== undefined && hit() === id) return id;
      }
      return undefined;
    },
  };
}
