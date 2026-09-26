/**
 * 对话区滚动（ADR-0020）：停在底部时跟随新输出；离开底部后停止跟随。
 * fromBottom 是视口底边之下还藏着多少行。0 = 在最新。
 */
export interface ScrollState {
  fromBottom: number;
  follow: boolean;
  newContent: boolean;
}

export function scrollFollow(): ScrollState {
  return { fromBottom: 0, follow: true, newContent: false };
}

export function scrollPage(state: ScrollState, delta: number): ScrollState {
  const fromBottom = Math.max(0, state.fromBottom + delta);
  return {
    ...state,
    fromBottom,
    follow: fromBottom === 0,
    newContent: fromBottom > 0 && state.newContent,
  };
}

export function scrollToTop(): ScrollState {
  return { fromBottom: Number.MAX_SAFE_INTEGER, follow: false, newContent: false };
}

export function scrollToBottom(): ScrollState {
  return scrollFollow();
}

/** 视口算出的实际 fromBottom（到顶后夹紧）。跟随态不被夹紧结果打断。 */
export function applyClamp(state: ScrollState, clampedFromBottom: number): ScrollState {
  if (state.follow) return state;
  return {
    ...state,
    fromBottom: clampedFromBottom,
    follow: clampedFromBottom === 0,
    newContent: clampedFromBottom > 0 && state.newContent,
  };
}
