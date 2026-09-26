import { createContext, useContext, useLayoutEffect, useRef } from "react";

import { cursorColumn, noopCursorClaims, type CursorClaims } from "../cursor.js";

/** runTui 注入 createCursorStream 的登记表；测试等无注入场景为空操作。 */
export const CursorClaimsContext = createContext<CursorClaims>(noopCursorClaims);

/**
 * 仅在当前输入行有焦点时登记 IME 硬件光标；坐标从帧左上角开始。
 * 登记在提交后生效并一直保留到下次变化或卸载，不依赖本组件每帧重渲染。
 */
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
  const claims = useContext(CursorClaimsContext);
  const id = useRef(Symbol("input-cursor")).current;
  const cx = active ? x + cursorColumn(prefix, text, width) : undefined;
  useLayoutEffect(() => {
    claims.set(id, cx === undefined ? undefined : { x: cx, y });
  }, [claims, id, cx, y]);
  useLayoutEffect(
    () => () => {
      claims.delete(id);
    },
    [claims, id],
  );
  return null;
}
