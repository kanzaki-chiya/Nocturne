/**
 * @nocturne/tui — Nocturne TUI 客户端（ADR-0010：Ink + React）。
 * 由 `nctrn --tui` 惰性 import 加载；只依赖 @nocturne/core 与
 * @nocturne/core/protocol 的公开 API，不包含 Agent 逻辑。
 */
import { render } from "ink";
import { createElement } from "react";

import type { Runtime, RuntimeSession } from "@nocturne/core";

import { App } from "./app.js";

export interface TuiOptions {
  stdin?: NodeJS.ReadStream | undefined;
  stdout?: NodeJS.WriteStream | undefined;
  stderr?: NodeJS.WriteStream | undefined;
}

/**
 * 运行 TUI 主界面，直到用户退出；返回进程退出码（与 REPL 同口径）。
 * 调用方（CLI）负责：参数解析、配置加载、会话打开/恢复与跨目录确认，
 * TUI 只消费已打开的 Session。
 */
export async function runTui(
  session: RuntimeSession,
  _runtime: Runtime,
  options: TuiOptions = {},
): Promise<number> {
  const app = render(createElement(App, { session }), {
    stdout: options.stdout ?? process.stdout,
    stdin: options.stdin ?? process.stdin,
    stderr: options.stderr ?? process.stderr,
    // Ctrl+C 由 App 的 useInput 处理（中断语义在后续提交接入）
    exitOnCtrlC: false,
  });
  await app.waitUntilExit();
  return 0;
}

export { App } from "./app.js";
