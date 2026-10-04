import { useEffect, useState, type ReactNode } from "react";

import type { DesktopHost } from "./host";
import "./window-frame.css";

/** 窗口操作仍走宿主；会话、后台与权限判定不进入标题栏。 */
export function WindowFrame({ host, children }: { host: DesktopHost; children: ReactNode }) {
  const [maximized, setMaximized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    const refresh = () => {
      void host.invoke("plugin:window|is_maximized", { label: "main" }).then(
        (value) => {
          if (!disposed) setMaximized(value === true);
        },
        (reason: unknown) => {
          if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
        },
      );
    };
    refresh();
    window.addEventListener("resize", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      disposed = true;
      window.removeEventListener("resize", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [host]);
  const act = async (command: string) => {
    try {
      setError(null);
      await host.invoke(`plugin:window|${command}`, { label: "main" });
      if (command === "toggle_maximize") {
        setMaximized((await host.invoke("plugin:window|is_maximized", { label: "main" })) === true);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  return (
    <div className="window-frame">
      <header className="window-titlebar" aria-label="窗口标题栏">
        <div className="window-drag-region" data-tauri-drag-region />
        <div className="window-controls">
          <button
            type="button"
            aria-label="最小化"
            title="最小化"
            onClick={() => void act("minimize")}
          >
            <svg viewBox="0 0 12 12" aria-hidden="true">
              <path d="M1 6h10" />
            </svg>
          </button>
          <button
            type="button"
            aria-label={maximized ? "还原" : "最大化"}
            title={maximized ? "还原" : "最大化"}
            onClick={() => void act("toggle_maximize")}
          >
            <svg viewBox="0 0 12 12" aria-hidden="true">
              {maximized ? (
                <path d="M3.5 3.5v-2h7v7h-2M1.5 3.5h7v7h-7z" />
              ) : (
                <path d="M1.5 1.5h9v9h-9z" />
              )}
            </svg>
          </button>
          <button
            type="button"
            className="window-close"
            aria-label="关闭"
            title="关闭"
            onClick={() => void act("close")}
          >
            <svg viewBox="0 0 12 12" aria-hidden="true">
              <path d="m1.5 1.5 9 9m0-9-9 9" />
            </svg>
          </button>
        </div>
      </header>
      {children}
      {error !== null && (
        <div className="window-error" role="alert">
          窗口操作失败：{error}
        </div>
      )}
    </div>
  );
}
