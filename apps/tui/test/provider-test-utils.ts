import { type render } from "ink-testing-library";
import { expect, vi } from "vitest";
import { createClickTracker, type HitBox } from "../src/click.js";
import type { DialogMouseFrame } from "../src/components/dialog/mouse.js";
import type { MouseEvent } from "../src/mouse.js";

export async function settle(check: () => boolean): Promise<void> {
  await vi.waitFor(() => expect(check()).toBe(true), { timeout: 5000, interval: 20 });
  // Ink 写帧之后，等新层 useInput 的 effect 接上再发送下一键。
  await new Promise<void>((resolve) => setImmediate(resolve));
}
export async function changedFrame(ui: ReturnType<typeof render>, action: () => void) {
  const before = ui.lastFrame();
  action();
  await settle(() => ui.lastFrame() !== before);
}
/** 使用实际命中框与共用点击判定，不绕过 press/drag/release 规则。 */
export function providerMouse() {
  let frame: DialogMouseFrame | undefined;
  const tracker = createClickTracker();
  const report = (next: DialogMouseFrame | undefined): void => {
    if (next?.layer !== frame?.layer) tracker.reset();
    frame = next;
  };
  const at = (id: string): HitBox => {
    const hit = frame?.boxes.find((box) => box.id === id);
    if (!hit) throw new Error(`Missing ${id} in ${frame?.layer}`);
    return hit;
  };
  const feed = (event: MouseEvent): void => {
    if (!frame) return;
    if (event.type === "wheel") frame.wheel(event);
    else {
      const id = tracker.feed(event, frame.boxes);
      if (id !== undefined) frame.click(id, event);
    }
  };
  const click = (id: string, offset = 0): void => {
    const box = at(id);
    const point = { button: 0, x: box.colStart + offset, y: box.row };
    feed({ type: "press", ...point });
    feed({ type: "release", ...point });
  };
  return {
    report,
    at,
    feed,
    click,
    get frame() {
      return frame;
    },
  };
}
