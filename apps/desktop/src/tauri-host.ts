import { getVersion } from "@tauri-apps/api/app";
import { Channel, invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl as tauriOpenUrl, revealItemInDir as tauriReveal } from "@tauri-apps/plugin-opener";
import { relaunch as tauriRelaunch } from "@tauri-apps/plugin-process";
import { check as checkForUpdate } from "@tauri-apps/plugin-updater";

import { isAllowedExternalUrl } from "./external-url";
import type { DesktopHost } from "./host";
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
  };
}
