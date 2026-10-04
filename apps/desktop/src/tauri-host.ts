import { Channel, invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl as tauriOpenUrl } from "@tauri-apps/plugin-opener";

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
  };
}
