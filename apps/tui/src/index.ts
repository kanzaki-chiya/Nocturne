/**
 * @nocturne/tui — Nocturne TUI 客户端（ADR-0010：Ink + React）。
 * 由 `nctrn --tui` 惰性 import 加载；只依赖 @nocturne/core 与
 * @nocturne/core/protocol 的公开 API，不包含 Agent 逻辑。
 */
import { render } from "ink";
import { createElement } from "react";

import type { Runtime, RuntimeSession } from "@nocturne/core";

import { App } from "./app.js";
import { detectTuiEnv } from "./env.js";

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
  runtime: Runtime,
  options: TuiOptions = {},
): Promise<number> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  // 非 TTY 兜底（tui.md §5）：CLI 启动时已检查，这里是直接调用时的防线
  if (!stdin.isTTY || !stdout.isTTY) {
    stderr.write('! --tui 需要交互式终端；请用 nctrn（行式 REPL）或 nctrn -p "<prompt>"\n');
    return 2;
  }
  const app = render(createElement(App, { session, runtime, env: detectTuiEnv() }), {
    stdout,
    stdin,
    stderr,
    // Ctrl+C 由 App 的 useInput 路由（中断/退出语义）
    exitOnCtrlC: false,
  });
  await app.waitUntilExit();
  return 0;
}

export { App } from "./app.js";
