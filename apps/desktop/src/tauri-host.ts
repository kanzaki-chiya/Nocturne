import { getVersion } from "@tauri-apps/api/app";
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { homeDir } from "@tauri-apps/api/path";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl as tauriOpenUrl, revealItemInDir as tauriReveal } from "@tauri-apps/plugin-opener";
import { relaunch as tauriRelaunch } from "@tauri-apps/plugin-process";
import { check as checkForUpdate } from "@tauri-apps/plugin-updater";

import { isAllowedExternalUrl } from "./external-url";
import type { DesktopHost, TerminalMessage } from "./host";
import type { NotifyResult } from "./notify";
import { decodePickedImages } from "./picked-images";
import type { BackendMessage } from "./types";

export function createTauriHost(): DesktopHost {
  return {
    invoke: (cmd: string, args?: Record<string, unknown>) => invoke<unknown>(cmd, args),
    createChannel(onMessage) {
      const channel = new Channel<BackendMessage>();
      channel.onmessage = onMessage;
      return channel;
    },
    async openUrl(url: string): Promise<void> {
      if (!isAllowedExternalUrl(url)) return;
      await tauriOpenUrl(url);
    },
    // 经外壳命令：会直接执行的文件类型改为在资源管理器中显示（editor.rs）
    async openPath(path) {
      await invoke("open_with_default", { path });
    },
    revealItem: (path) => tauriReveal(path),
    terminals: {
      open({ shell, cwd, cols, rows }, onMessage) {
        const channel = new Channel<TerminalMessage>();
        channel.onmessage = onMessage;
        return invoke<number>("terminal_open", { shell, cwd, cols, rows, channel });
      },
      write: (id, data) => invoke("terminal_write", { id, data }),
      resize: (id, cols, rows) => invoke("terminal_resize", { id, cols, rows }),
      close: (id) => invoke("terminal_close", { id }),
      readClipboard: () => invoke<string>("terminal_read_clipboard"),
      writeClipboard: (text) => invoke("terminal_write_clipboard", { text }),
    },
    async detectEditors() {
      try {
        return await invoke<{ vscode: boolean; cursor: boolean }>("detect_editors");
      } catch {
        return { vscode: false, cursor: false };
      }
    },
    async openInEditor(editor, path, line) {
      await invoke("open_in_editor", {
        editor,
        path,
        ...(line !== undefined ? { line } : {}),
      });
    },
    pickFolder: () => openDialog({ directory: true, multiple: false }),
    async pickImages() {
      return decodePickedImages(await invoke<ArrayBuffer>("pick_images"));
    },
    async homeDir() {
      try {
        return await homeDir();
      } catch {
        return null;
      }
    },
    appVersion: () => getVersion(),
    async checkUpdate() {
      const update = await checkForUpdate();
      if (update === null) return null;
      return {
        version: update.version,
        notes: update.body ?? null,
        downloadAndInstall(onProgress) {
          let downloaded = 0;
          let total: number | undefined;
          return update.downloadAndInstall((event) => {
            if (onProgress === undefined) return;
            if (event.event === "Started") {
              downloaded = 0;
              total = event.data.contentLength;
              onProgress(0, total);
            } else if (event.event === "Progress") {
              downloaded += event.data.chunkLength;
              onProgress(downloaded, total);
            }
          });
        },
      };
    },
    relaunch: () => tauriRelaunch(),
    note(line) {
      void invoke("app_note", { line }).catch(() => undefined);
    },
    // 外壳 WinRT toast：同一会话同 tag/group，新的替换旧的；失败降级成一条外壳日志
    async notify({ sessionId, title, body, sound }) {
      try {
        return await invoke<NotifyResult>("notify_show", { sessionId, title, body, sound });
      } catch (error) {
        return { shown: false, reason: "error", detail: String(error) };
      }
    },
    async dismissNotification(sessionId) {
      try {
        await invoke("notify_dismiss", { sessionId });
      } catch {
        // 撤通知失败无关紧要：窗口已切到该会话，历史里的旧通知会自然过期
      }
    },
    // 任务栏闪烁：Informational（只闪任务栏按钮，不闪整个窗口）——通知不是紧急
    // 错误，只是「回来看一眼」；Windows 上闪到窗口获得焦点为止
    async requestAttention() {
      try {
        await getCurrentWindow().requestUserAttention(UserAttentionType.Informational);
      } catch {
        // 非 Windows 或窗口已关闭：静默
      }
    },
    onNotificationActivated(handler) {
      let stop: (() => void) | undefined;
      void listen<string>("notify-activated", (event) => {
        handler(event.payload);
      }).then((unlisten) => {
        stop = unlisten;
      });
      return () => {
        stop?.();
      };
    },
  };
}
