/**
 * 面板「终端」标签（ADR-0060 第 4 节及 2026-10-18 修订）：一个标签一个进程，
 * 头部 Shell 下拉换 shell（结束旧进程、同一标签开新进程），进程退出后显示退出码与
 * 「重新启动」。终端是用户自己的，agent 看不到也操作不了，不经过权限层。
 */
import { useEffect, useMemo, useRef, useState } from "react";

import { Dropdown } from "./Dropdown";
import type { TerminalHost } from "./host";
import { Menu, MenuItem } from "./Menu";
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

export interface TerminalPaneProps {
  tab: TerminalTab;
  host: TerminalHost;
  /** runtime.listShells（后台还没连上时等它连上） */
  listShells: () => Promise<readonly ShellOption[]>;
  /** 标签可见：可见时重排并聚焦 */
  visible: boolean;
  onShellChange: (tabId: string, executable: string) => void;
}

export function TerminalPane({ tab, host, listShells, visible, onShellChange }: TerminalPaneProps) {
  const container = useRef<HTMLDivElement>(null);
  const view = useRef<MountedTerminal | null>(null);
  const session = useRef<TerminalSession | null>(null);
  const [shells, setShells] = useState<ShellOption[]>();
  const [shellError, setShellError] = useState<string>();
  const [status, setStatus] = useState<TerminalStatus>({ kind: "starting" });
  const [ready, setReady] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const menuAnchor = useRef<HTMLSpanElement>(null);
  const [restarts, setRestarts] = useState(0);

  useEffect(() => {
    let alive = true;
    listShells()
      .then((list) => {
        if (alive) setShells(terminalShells(list));
      })
      .catch((e: unknown) => {
        if (alive) setShellError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [listShells]);

  const shell = useMemo(
    () => (shells === undefined ? undefined : terminalShell(shells, tab.shell)),
    [shells, tab.shell],
  );

  const copy = () => {
    const text = view.current?.selection() ?? "";
    if (text !== "") void navigator.clipboard.writeText(text).catch(() => undefined);
  };
  // 菜单「粘贴」由外壳读剪贴板；navigator.clipboard.readText 在 WebView2 里会弹权限框
  const paste = () => {
    void host
      .readClipboard()
      .then((text) => {
        if (text !== "") view.current?.paste(text);
      })
      .catch(() => undefined);
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
        onCopy: () => {
          actions.current.copy();
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
          event.preventDefault();
          setMenu({ x: event.clientX, y: event.clientY });
        }}
      >
        <div className="sp-term-host" ref={container} />
      </div>
      <span
        ref={menuAnchor}
        className="sp-term-anchor"
        style={menu === null ? undefined : { left: menu.x, top: menu.y }}
      />
      {menu !== null && (
        <Menu
          anchor={menuAnchor.current}
          label="终端"
          onClose={() => {
            setMenu(null);
            view.current?.focus();
          }}
        >
          <MenuItem
            label="复制"
            right="Ctrl+Shift+C"
            onSelect={() => {
              copy();
              setMenu(null);
              view.current?.focus();
            }}
          />
          <MenuItem
            label="粘贴"
            right="Ctrl+Shift+V"
            onSelect={() => {
              paste();
              setMenu(null);
              view.current?.focus();
            }}
          />
        </Menu>
      )}
    </div>
  );
}
