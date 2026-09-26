/**
 * 紧凑欢迎区（ADR-0020）：对话区第一项，随滚动离开。
 * 左侧 4 行小像素标记，右侧版本、模型与档位、目录、一行提示。
 * 不做会话 id、最近会话和 MCP 分栏；MCP 失败由调用方另给通知。
 */
import stringWidth from "string-width";

import { boxSafe, truncateLine } from "./format.js";
import { MARK_ROWS } from "./theme.js";
import type { LaidLine } from "./viewport.js";

export interface WelcomeInfo {
  version: string;
  model: string;
  effort: string | undefined;
  cwd: string;
  ascii: boolean;
  width: number;
}

function clip(text: string, width: number): string {
  return truncateLine(boxSafe(text), Math.max(1, width - 4), "...");
}

export function welcomeLines(info: WelcomeInfo): LaidLine[] {
  const sep = info.ascii ? " - " : " • ";
  const modelLine =
    info.effort !== undefined && info.effort !== ""
      ? `${info.model}${sep}${info.effort}`
      : info.model;
  const hint = info.ascii
    ? "/ 帮助  Shift+Tab 档位  Alt+M 权限"
    : "/ 帮助  Shift+Tab 档位  Alt+M 权限";
  const right = [`Nocturne ${info.version}`, modelLine, info.cwd, hint];
  const markW = Math.max(...MARK_ROWS.map((row) => stringWidth(row)));
  const gap = 2;
  const twoCol = info.width >= 40 && info.width - markW - gap >= 16;
  if (!twoCol) {
    return right.map((text, i) => ({
      key: `welcome:${i}`,
      text: clip(text, info.width),
      color: i === 0 ? "cyan" : undefined,
      dim: i > 0,
    }));
  }
  return MARK_ROWS.map((mark, i) => {
    const side = right[i] ?? "";
    const text = `${info.ascii ? mark.replaceAll("█", "#") : mark}${" ".repeat(gap)}${side}`;
    return {
      key: `welcome:${i}`,
      text: clip(text, info.width),
      color: i === 0 ? "cyan" : undefined,
      dim: i > 0,
    };
  });
}
