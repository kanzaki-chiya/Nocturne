/**
 * @nocturne/tui — Nocturne TUI 客户端（ADR-0010：Ink + React）。
 * 由 `nctrn --tui` 惰性 import 加载；只依赖 @nocturne/core 与
 * @nocturne/core/protocol 的公开 API，不包含 Agent 逻辑。
 */
import { render } from "ink";
import { createElement } from "react";

import type { Runtime, RuntimeSession } from "@nocturne/core";

import { App, type SetupFlowSpec } from "./app.js";
import type { ProviderBridge } from "./commands.js";
import { detectTuiEnv } from "./env.js";

import type { SwitchSessionFn } from "./types.js";

export interface TuiOptions {
  stdin?: NodeJS.ReadStream | undefined;
  stdout?: NodeJS.WriteStream | undefined;
  stderr?: NodeJS.WriteStream | undefined;
  /**
   * 会话入口，两选一：
   * - session：直接进入主界面（常规形态）；
   * - setup：首次配置流程——服务商页 → 模型页（ADR-0019 第 4 条），
   *   完成后经 spec.openSession 开新会话，或（setup 命令形态）直接退出。
   */
  session?: RuntimeSession | undefined;
  setup?: SetupFlowSpec | undefined;
  /**
   * /resume 会话切换回调（tui.md §3）：由 CLI 注入，打开逻辑只此一份。
   * 缺省时 /resume 提示不可用。
   */
  switchSession?: SwitchSessionFn | undefined;
  /**
   * /provider 与模型选择页的配置桥（provider-setup.md 第 6 节）：
   * config + reloadConfig + updateProviders。缺省时相关命令提示不可用。
   */
  provider?: ProviderBridge | undefined;
}

/**
 * 运行 TUI 主界面，直到用户退出；返回进程退出码（与 REPL 同口径）。
 * 调用方（CLI）负责：参数解析、配置加载、会话打开/恢复与跨目录确认，
 * TUI 只消费已打开的 Session 或 setup 描述。
 */
export async function runTui(
  entry: { session: RuntimeSession } | { setup: SetupFlowSpec } | { session?: undefined },
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
  // Windows 控制台 stdin：Ink suspendTerminal 的 pauseInput 会 unref() stdin，
  // 撤销挂起的控制台读请求，而 resumeInput 的 ref() 不会重发——多次
  // 备用屏切换后 stdin 永久饿死（实测第 2~3 个周期必现）。本应用里挂起
  // 只用于备用屏切换，没有子进程接管终端，unref 没有意义；吞掉它并在
  // 退出时补一次真正的 unref 让事件循环能排空。
  const realUnref = stdin.unref.bind(stdin);
  stdin.unref = () => stdin;
  let exitCode = 0;
  let exitMessage: string | undefined;
  const app = render(
    createElement(App, {
      session: "session" in entry ? entry.session : undefined,
      setup: "setup" in entry ? entry.setup : options.setup,
      runtime,
      env: detectTuiEnv(),
      switchSession: options.switchSession,
      provider: options.provider,
      onExitResult: (code: number, message?: string) => {
        exitCode = code;
        exitMessage = message;
      },
    }),
    {
      stdout,
      stdin,
      stderr,
      // Ctrl+C 由 App 的 useInput 路由（中断/退出语义）
      exitOnCtrlC: false,
    },
  );
  try {
    await app.waitUntilExit();
  } finally {
    realUnref();
  }
  if (exitMessage !== undefined && exitMessage !== "") {
    stderr.write(`${exitMessage}\n`);
  }
  return exitCode;
}

export { App } from "./app.js";
export type { SetupFlowSpec } from "./app.js";
export type { SessionSwitchResult, SwitchSessionFn } from "./types.js";
