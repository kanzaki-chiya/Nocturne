/**
 * 渲染环境（tui.md §5）：NOCTURNE_ASCII 显式退回 ASCII；
 * NO_COLOR/TERM=dumb 禁用颜色与转轮动画（颜色由 Ink/chalk 自行降级）。
 * 不做 TERM 探测——Windows 上 TERM 通常未设置，识别 conhost 不可靠。
 */
import { createContext, useContext } from "react";

export interface TuiEnv {
  /** NOCTURNE_ASCII=1：框线/徽标退回 ASCII */
  ascii: boolean;
  /** 是否允许转轮动画（NO_COLOR / TERM=dumb 时禁用） */
  animated: boolean;
}

export function detectTuiEnv(env: NodeJS.ProcessEnv = process.env): TuiEnv {
  const asciiFlag = env.NOCTURNE_ASCII;
  return {
    ascii: asciiFlag === "1" || asciiFlag === "true",
    animated: env.NO_COLOR === undefined && env.TERM !== "dumb",
  };
}

export const TuiEnvContext = createContext<TuiEnv>({ ascii: false, animated: true });

export function useTuiEnv(): TuiEnv {
  return useContext(TuiEnvContext);
}

export interface Glyphs {
  dot: string;
  ok: string;
  err: string;
  wait: string;
  notice: string;
  prompt: string;
  ellipsis: string;
  /** 转轮帧；animated=false 时只用第一帧 */
  spinner: string[];
}

export function glyphs(env: TuiEnv): Glyphs {
  return env.ascii
    ? {
        dot: "*",
        ok: "+",
        err: "x",
        wait: "?",
        notice: "-",
        prompt: ">",
        ellipsis: "...",
        spinner: ["*", "|", "/", "-", "\\"],
      }
    : {
        dot: "●",
        ok: "✓",
        err: "✗",
        wait: "?",
        notice: "◇",
        prompt: "›",
        ellipsis: "…",
        spinner: ["●", "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
      };
}
