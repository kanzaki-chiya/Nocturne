/**
 * 面板「终端」标签（ADR-0060 第 4 节及 2026-10-18 两次修订）：一个标签一个进程，
 * 默认 shell 跟随设置里的 Shell，头部 Shell 下拉只换这一个标签（结束旧进程、同一标签
 * 开新进程），进程退出后显示退出码与「重新启动」。右键按 Windows Terminal 的规则复制或
 * 粘贴，剪贴板由外壳读写。终端是用户自己的，agent 看不到也操作不了，不经过权限层。
 */
import { useEffect, useMemo, useRef, useState } from "react";

import { Dropdown } from "./Dropdown";
import type { TerminalHost } from "./host";
import { terminalShell, type ShellOption, type TerminalTab } from "./side-panel";
import { TerminalSession, type TerminalStatus } from "./terminal-session";
import type { MountedTerminal } from "./terminal-view";

/** 外壳只认这几个可执行文件名（src-tauri/src/terminal.rs），下拉里也只列它们 */
const TERMINAL_EXECUTABLES = new Set(["pwsh.exe", "powershell.exe", "bash.exe", "cmd.exe"]);

export function terminalShells(shells: readonly ShellOption[]): ShellOption[] {
  return shells.filter((shell) => {
    if (!shell.available || shell.executable === undefined) return false;
    const name = shell.executable.split(/[\\/]/).pop()?.toLowerCase() ?? "";
    // 非 Windows 没有 .exe 后缀：外壳同样只按文件名放行
    return TERMINAL_EXECUTABLES.has(name) || TERMINAL_EXECUTABLES.has(`${name}.exe`);
  });
}

export function exitText(code: number | undefined): string {
  return code === undefined ? "进程已退出" : `进程已退出（代码 ${String(code)}）`;
}

/**
 * 右键做什么（Windows Terminal 的规则，不弹菜单）：程序开了鼠标上报时交给程序；
 * 否则有选区就复制并清掉选区，没有选区就粘贴。
 */
export function rightClickAction(
  mouseTracking: boolean,
  selection: string,
): "program" | "copy" | "paste" {
  if (mouseTracking) return "program";
  return selection === "" ? "paste" : "copy";
}

/** runtime.listShells 的结果和设置里 Shell 的生效值（种类名或路径；读不到时 undefined） */
export interface TerminalShellChoice {
  shells: readonly ShellOption[];
  setting: string | undefined;
}

export interface TerminalPaneProps {
  tab: TerminalTab;
  host: TerminalHost;
  /** runtime.listShells + describeSettings（后台还没连上时等它连上），按终端工作目录取 */
  loadShells: (cwd: string) => Promise<TerminalShellChoice>;
  /** 标签可见：可见时重排并聚焦 */
  visible: boolean;
  onShellChange: (tabId: string, executable: string) => void;
}

export function TerminalPane({ tab, host, loadShells, visible, onShellChange }: TerminalPaneProps) {
  const container = useRef<HTMLDivElement>(null);
  const view = useRef<MountedTerminal | null>(null);
  const session = useRef<TerminalSession | null>(null);
  const [shells, setShells] = useState<ShellOption[]>();
  const [setting, setSetting] = useState<string>();
  const [shellError, setShellError] = useState<string>();
  const [status, setStatus] = useState<TerminalStatus>({ kind: "starting" });
  const [ready, setReady] = useState(false);
  const [clipError, setClipError] = useState<string>();
  const [restarts, setRestarts] = useState(0);

  // 开标签时取一次：之后改设置不影响已经开着的终端，新开的标签才跟随
  const cwd = tab.cwd;
  useEffect(() => {
    let alive = true;
    loadShells(cwd)
      .then((choice) => {
        if (!alive) return;
        setShells(terminalShells(choice.shells));
        setSetting(choice.setting);
      })
      .catch((e: unknown) => {
        if (alive) setShellError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [loadShells, cwd]);

  const shell = useMemo(
    () => (shells === undefined ? undefined : terminalShell(shells, tab.shell, setting)),
    [shells, tab.shell, setting],
  );

  // 复制失败的提示几秒后自己消失
  useEffect(() => {
    if (clipError === undefined) return;
    const timer = setTimeout(() => {
      setClipError(undefined);
    }, 4000);
    return () => {
      clearTimeout(timer);
    };
  }, [clipError]);

  // 剪贴板都由外壳读写：WebView2 里 navigator.clipboard.writeText 静默失败，readText 会弹权限框
  const copy = (clear: boolean) => {
    const text = view.current?.selection() ?? "";
    if (text === "") return;
    if (clear) view.current?.clearSelection();
    host.writeClipboard(text).then(
      () => {
        setClipError(undefined);
      },
      (e: unknown) => {
        setClipError(`复制失败：${e instanceof Error ? e.message : String(e)}`);
      },
    );
  };
  const paste = () => {
    void host
      .readClipboard()
      .then((text) => {
        if (text !== "") view.current?.paste(text);
      })
      .catch((e: unknown) => {
        setClipError(`粘贴失败：${e instanceof Error ? e.message : String(e)}`);
      });
  };
  const actions = useRef({ copy, paste });
  actions.current = { copy, paste };

  // xterm 与进程控制器：标签在就一直在，关闭标签（卸载）时结束进程
  useEffect(() => {
    const parent = container.current;
    if (parent === null) return;
    let disposed = false;
    const controller = new TerminalSession(host, {
      output: (data) => {
        view.current?.write(data);
      },
      status: setStatus,
    });
    session.current = controller;
    void import("./terminal-view").then(({ mountTerminal }) => {
      if (disposed) return;
      view.current = mountTerminal(parent, {
        onData: (data) => {
          controller.write(data);
        },
        onResize: (cols, rows) => {
          controller.resize(cols, rows);
        },
        onCopy: (clear) => {
          actions.current.copy(clear);
        },
      });
      setReady(true);
    });
    return () => {
      disposed = true;
      controller.dispose();
      session.current = null;
      view.current?.dispose();
      view.current = null;
    };
  }, [host]);

  // shell 定下来（或换了、或点了重新启动）就开进程
  const executable = shell?.executable;
  useEffect(() => {
    const term = view.current;
    const controller = session.current;
    if (!ready || term === null || controller === null || executable === undefined) return;
    term.clear();
    term.fit();
    void controller.start({ shell: executable, cwd: tab.cwd, ...term.size() });
  }, [ready, executable, tab.cwd, restarts]);

  useEffect(() => {
    if (!visible || !ready) return;
    view.current?.fit();
    view.current?.focus();
  }, [visible, ready]);

  const options = (shells ?? []).map((s) => ({
    value: s.executable ?? s.kind,
    label: s.name,
    ...(s.executable !== undefined ? { description: s.executable } : {}),
  }));
  const noShell = shells !== undefined && shell === undefined;
  return (
    <div className="sp-term">
      <header className="sp-term-head">
        <span className="sp-crumb" title={tab.cwd}>
          <span className="sp-crumb-path">{tab.cwd}</span>
        </span>
        <Dropdown
          label="Shell"
          variant="pill"
          triggerClassName="sp-btn sp-term-shell"
          heading="Shell"
          note="换 shell 会结束当前进程，在这个标签里重新开始"
          value={executable}
          options={options}
          disabled={shells === undefined ? "正在检测 shell" : undefined}
          onChange={(value) => {
            if (value !== executable) onShellChange(tab.id, value);
          }}
        >
          {shell?.name ?? "Shell"}
          <span className="sp-term-caret" aria-hidden="true">
            ▾
          </span>
        </Dropdown>
      </header>
      {(status.kind === "exited" || status.kind === "error") && (
        <div className="sp-term-exit" role="status">
          <span>{status.kind === "exited" ? exitText(status.code) : status.message}</span>
          <button
            type="button"
            className="sp-btn"
            onClick={() => {
              setRestarts((n) => n + 1);
              // 按钮随横条一起消失，焦点交回终端，不然要再点一下才能打字
              view.current?.focus();
            }}
          >
            重新启动
          </button>
        </div>
      )}
      {clipError !== undefined && (
        <div className="sp-term-exit sp-term-clip" role="alert">
          <span>{clipError}</span>
        </div>
      )}
      {(shellError !== undefined || noShell) && (
        <div className="sp-term-exit" role="alert">
          <span>
            {shellError ?? "没有找到可用的 shell（pwsh、Windows PowerShell、Git Bash、cmd）"}
          </span>
        </div>
      )}
      <div
        className="sp-term-body"
        aria-label="终端"
        onContextMenu={(event) => {
          // 永远不弹浏览器菜单；鼠标上报模式下 xterm 已把右键交给程序
          event.preventDefault();
          const term = view.current;
          if (term === null) return;
          const action = rightClickAction(term.mouseTracking(), term.selection());
          if (action === "copy") actions.current.copy(true);
          else if (action === "paste") actions.current.paste();
          term.focus();
        }}
      >
        <div className="sp-term-host" ref={container} />
      </div>
    </div>
  );
}
