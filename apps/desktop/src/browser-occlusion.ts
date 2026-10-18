/**
 * 主界面浮层与面板浏览器的遮挡（desktop.md 5.10）：外壳 webview 叠在主界面上方，主界面
 * 的下拉、右键菜单、对话框、概览浮层、Ctrl+P、状态栏提示一旦伸进浏览器区域就会被盖住。
 * 做法：浮层出现时先把它压成透明，截一张网页截图做占位，换上截图后隐藏 webview，再让
 * 浮层显示出来；浮层都关掉后显示 webview、撤掉占位。截图超时（300ms）就不等截图直接隐藏。
 */

export type CoverState = "live" | "capturing" | "covered";
export type CoverEvent = "overlay" | "clear" | "captured" | "timeout";

export interface CoverStep {
  state: CoverState;
  /** 开始截图（同时计时） */
  capture?: true;
  /** true：把伸进来的浮层压成透明；false：恢复 */
  hold?: boolean;
  webview?: "show" | "hide";
  /** 撤掉占位截图 */
  clearPlaceholder?: true;
}

export const CAPTURE_TIMEOUT_MS = 300;

export function coverStep(state: CoverState, event: CoverEvent): CoverStep {
  switch (state) {
    case "live":
      return event === "overlay"
        ? { state: "capturing", capture: true, hold: true }
        : { state: "live" };
    case "capturing":
      if (event === "overlay") return { state: "capturing", hold: true };
      if (event === "clear") return { state: "live", hold: false, clearPlaceholder: true };
      // captured / timeout：换上占位（timeout 时没有），隐藏 webview，放出浮层
      return { state: "covered", webview: "hide", hold: false };
    case "covered":
      if (event === "clear") return { state: "live", webview: "show", clearPlaceholder: true };
      return { state: "covered" };
  }
}

/** 会伸进面板的浮层（主界面各处的菜单、列表、对话框、提示） */
export const OVERLAY_SELECTOR = [
  '[role="menu"]',
  '[role="dialog"]',
  '[role="listbox"]',
  '[role="tooltip"]',
  ".composer-popup",
  ".ctxmenu",
  ".imenu",
  ".gmenu",
  ".skill-toast",
  ".dialog-backdrop",
  ".dlg",
  ".desktop-dialog",
].join(",");

/** 压成透明的浮层带这个属性（styles.css） */
export const HOLD_ATTRIBUTE = "data-nct-cover-hold";

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/** 和浏览器区域相交的浮层；浏览器面板自己里面的元素不算（它们在 webview 上方的工具栏里） */
export function overlaysOver(root: ParentNode, slot: Rect, exclude?: Element | null): Element[] {
  const hits: Element[] = [];
  for (const node of root.querySelectorAll(OVERLAY_SELECTOR)) {
    if (exclude?.contains(node) === true) continue;
    // 嵌套的浮层只算最外层
    if (hits.some((hit) => hit.contains(node))) continue;
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    if (intersects(rect, slot)) hits.push(node);
  }
  return hits;
}
