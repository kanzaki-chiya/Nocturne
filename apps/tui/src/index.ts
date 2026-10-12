/**
 * @nocturne/tui — Nocturne TUI 客户端（ADR-0010：Ink + React）。
 * 由 `nctrn --tui` 惰性 import 加载；只依赖 @nocturne/core 与
 * @nocturne/core/protocol 的公开 API，不包含 Agent 逻辑。
 */
import { render } from "ink";
import { createElement, useState } from "react";

import type { Clipboard, Runtime, RuntimeSession } from "@nocturne/core";

import type { spawn } from "node:child_process";

import { App, type AppProps, type SetupFlowSpec } from "./app.js";
import type { ProviderBridge } from "./commands.js";
import { CursorClaimsContext } from "./components/input-cursor.js";
import { createCursorStream } from "./cursor.js";
import { detectTuiEnv } from "./env.js";
import { sessionSavedLine } from "./exit-note.js";
import { stripControls } from "./format.js";
import { palettes, resolveTheme, ThemeContext } from "./theme.js";

/** 首帧前同步读取偏好；保存成功后只换 context，App 会以主题 ID 重排全屏行。 */
export function ThemeApp(props: AppProps): React.JSX.Element {
  const [id, setId] = useState(() => resolveTheme(props.runtime.getPreference("theme")));
  return createElement(
    ThemeContext.Provider,
    { value: palettes[id] },
    createElement(App, { ...props, onThemeChange: setId }),
  );
}
import {
  FOCUS_DISABLE,
  FOCUS_ENABLE,
  MOUSE_DISABLE,
  MOUSE_ENABLE,
  wrapMouseStdin,
  type FocusSource,
  type MouseSource,
} from "./mouse.js";
import { captureConsole } from "./console-capture.js";

/** 复位全部文字属性：退出路径统一收尾，保证不把颜色留给后续的 shell */
const SGR_RESET = "\x1b[0m";

import type { NewSessionFn, SwitchSessionFn } from "./types.js";

export interface TuiOptions {
  stdin?: NodeJS.ReadStream | undefined;
  stdout?: NodeJS.WriteStream | undefined;
  stderr?: NodeJS.WriteStream | undefined;
  /**
   * 普通屏幕（行内）模式：<Static> 回滚区 + 页面临时备用屏，不开鼠标上报。
   * 缺省为全屏（ADR-0021 第 1 条：Ink alternateScreen + 视口滚动 + 拖动选中复制）。
   */
  inline?: boolean | undefined;
  /** 测试注入：自定义鼠标事件源（缺省时包装 stdin 解析 SGR 序列） */
  mouse?: MouseSource | undefined;
  /** 测试注入：终端焦点源（缺省时来自 stdin 包装的焦点回送 CSI I/O） */
  focus?: FocusSource | undefined;
  /** 测试注入：系统剪贴板 spawn */
  copySpawn?: typeof spawn | undefined;
  /** 测试注入：图片剪贴板读取器及平台标识 */
  clipboard?: Clipboard | undefined;
  clipboardPlatform?: NodeJS.Platform | undefined;
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
  newSession?: NewSessionFn | undefined;
  /**
   * /provider 与模型选择页的配置桥（provider-setup.md 第 6 节）：
   * config + reloadConfig + updateProviders。缺省时相关命令提示不可用。
   */
  provider?: ProviderBridge | undefined;
  /** 测试注入：异常路径不要真的 process.exit */
  exitProcess?: ((code: number) => void) | undefined;
  /** 假 stdout 上 patch-console 会失败；生产路径保持默认 true */
  patchConsole?: boolean | undefined;
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
  const inline = options.inline === true;
  let exitCode = 0;
  let exitMessage: string | undefined;
  let sessionId = "session" in entry ? entry.session?.id : undefined;
  let announced = false;
  const announce = (): void => {
    if (announced || sessionId === undefined) return;
    announced = true;
    // 全屏：unmount 已写 ?1049l 回主屏，对话行与提示都在主屏上。
    // 先复位 SGR：ConPTY 下漏出的颜色会被 shell 当成默认色，整个标签页一直带色
    stdout.write(`${SGR_RESET}${sessionSavedLine(sessionId)}\n`);
  };
  // stdin 预处理：进 Ink 前摘除 SGR 鼠标序列与焦点回送（?1004 的 CSI I/O），
  // 跨块截断由包装层拼接。全屏与 --inline 都一样走这一层——焦点报告两者都开。
  const mouseStdin = wrapMouseStdin(stdin);
  const stdinForInk = mouseStdin.stdin;
  const mouseSource = options.mouse ?? mouseStdin.mouse;
  const focusSource = options.focus ?? mouseStdin.focus;
  // 全屏退出时把对话按当前宽度铺成纯文本行打回主屏（App 填实现）
  const transcriptOut: { current?: (() => string[]) | undefined } = {};
  // 全屏从 Ink 标准 log-update 取得整帧，自有输出层做终端差异写出；inline 保持原路径。
  // 鼠标上报与备用屏切换绑在同一笔写出：进备用屏后开、回主屏前关。
  // 焦点报告亦随进出：全屏页切换的 ?1049l 复位点（alt-screen.ts）与 unmount 终帧
  // 同走 beforeExitAlt——?1004l 与回主屏原子同笔，异常/页面路径同样关闭。
  const beforeExitFocus = `${SGR_RESET}${MOUSE_DISABLE}${FOCUS_DISABLE}`;
  const cursorOut = createCursorStream(
    stdout,
    inline
      ? { afterEnterAlt: FOCUS_ENABLE, beforeExitAlt: FOCUS_DISABLE }
      : {
          fullscreen: true,
          afterEnterAlt: MOUSE_ENABLE + FOCUS_ENABLE,
          beforeExitAlt: beforeExitFocus,
        },
  );
  // Windows Terminal: suspendTerminal 的 pauseInput 不应撤销控制台读请求。
  const unref = stdin.unref.bind(stdin);
  stdin.unref = () => stdin;
  // 焦点报告（ADR-0056 §3）：启动即开（终端不支持时收不到回送，按「没在看」处理），
  // 所有退出路径关闭（见 disableFocus 的各调用点）。序列是终端级的，对主屏同样安全。
  stdout.write(FOCUS_ENABLE);
  let focusOn = true;
  const disableFocus = (): void => {
    if (!focusOn) return;
    focusOn = false;
    try {
      stdout.write(FOCUS_DISABLE);
    } catch {
      /* 进程退出路径忽略 */
    }
  };
  // 全屏：console 输出（含 Node 进程警告）改为对话区提示行，不用 Ink 的 patchConsole
  //（它把文字写在帧上方，备用屏里会压进输入行）；inline 仍由 Ink 写进回滚区
  const patchConsole = options.patchConsole ?? true;
  const captured = !inline && patchConsole ? captureConsole() : undefined;
  const cleanup = (): void => {
    disableFocus();
    cursorOut.stop();
    captured?.restore();
    mouseStdin.dispose();
    stdin.unref = unref;
    unref();
  };
  let app: ReturnType<typeof render>;
  try {
    app = render(
      createElement(
        CursorClaimsContext.Provider,
        { value: cursorOut.claims },
        createElement(ThemeApp, {
          session: "session" in entry ? entry.session : undefined,
          setup: "setup" in entry ? entry.setup : options.setup,
          runtime,
          env: detectTuiEnv(),
          switchSession: options.switchSession,
          newSession: options.newSession,
          provider: options.provider,
          inline,
          mouse: mouseSource,
          focus: focusSource,
          writeOob: cursorOut.writeOob,
          onOutputLayout: cursorOut.setLayout,
          copySpawn: options.copySpawn,
          clipboard: options.clipboard,
          clipboardPlatform: options.clipboardPlatform,
          transcriptOut,
          onSessionId: (id: string) => {
            sessionId = id;
          },
          onExitResult: (code: number, message?: string) => {
            exitCode = code;
            exitMessage = message;
          },
          consoleLines: captured?.lines,
        }),
      ),
      {
        stdout: cursorOut.stream,
        stdin: stdinForInk,
        stderr,
        exitOnCtrlC: false,
        incrementalRendering: inline,
        alternateScreen: !inline,
        patchConsole: inline && patchConsole,
      },
    );
  } catch (error) {
    cleanup();
    throw error;
  }
  const exitProcess = options.exitProcess ?? ((code: number) => process.exit(code));
  const onCrash = (err: unknown): void => {
    try {
      app.unmount();
    } catch {
      /* 已经在卸载 */
    }
    disableFocus();
    announce();
    const text = err instanceof Error ? (err.stack ?? err.message) : String(err);
    stderr.write(`${text}\n`);
    exitCode = 1;
    exitProcess(1);
  };
  process.on("uncaughtException", onCrash);
  process.on("unhandledRejection", onCrash);
  // 兜底：无论哪条路径离开进程，鼠标上报（仅全屏开启）与焦点报告都关一遍
  //（序列对主屏同样安全）
  const onProcessExit = (): void => {
    try {
      stdout.write((inline ? "" : MOUSE_DISABLE) + FOCUS_DISABLE + SGR_RESET);
    } catch {
      /* 进程退出路径忽略 */
    }
  };
  process.once("exit", onProcessExit);
  try {
    await app.waitUntilExit();
  } finally {
    cleanup();
    process.off("exit", onProcessExit);
    process.off("uncaughtException", onCrash);
    process.off("unhandledRejection", onCrash);
  }
  // 全屏：备用屏已回主屏（unmount 终帧含 ?1049l），对话按当前宽度铺行
  const dump = transcriptOut.current;
  if (dump !== undefined) {
    // 回主屏后 DECRC 可能恢复进备用屏前的颜色；打印前统一复位
    stdout.write(SGR_RESET);
    for (const line of dump()) {
      // 兜底：主屏上漏出的控制序列（颜色码）会染到后面所有输出
      stdout.write(`${stripControls(line)}\n`);
    }
  }
  announce();
  if (exitMessage !== undefined && exitMessage !== "") {
    stderr.write(`${exitMessage}\n`);
  }
  return exitCode;
}

export { App } from "./app.js";
export type { SetupFlowSpec } from "./app.js";
export type { SessionSwitchResult, SwitchSessionFn } from "./types.js";
