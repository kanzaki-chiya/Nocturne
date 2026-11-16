import type { RpcClient } from "@nocturne/rpc/client";
import { parseCustomThemesJson, themePresetId, type CustomTheme } from "./theme-presets";

export interface ThemeSettingsState {
  id: string;
  customThemes: CustomTheme[];
}

/** 订阅先于首读；请求版本与清理标记阻止迟到响应覆盖新连接。 */
export function subscribeThemeSettings(
  client: RpcClient,
  apply: (state: ThemeSettingsState) => void,
): () => void {
  let active = true;
  let version = 0;
  const read = () => {
    const request = ++version;
    void client.runtime
      .describeSettings()
      .then((items) => {
        if (!active || request !== version) return;
        const customThemes = parseCustomThemesJson(
          items.find((item) => item.key === "appearance.customThemes")?.effective,
        );
        const id = themePresetId(
          items.find((item) => item.key === "appearance.themePreset")?.effective,
          customThemes,
        );
        apply({ id, customThemes });
      })
      .catch(() => undefined);
  };
  const stop = client.onSettingsChanged(read);
  read();
  return () => {
    active = false;
    stop();
  };
}

export function subscribeThemePreset(client: RpcClient, apply: (id: string) => void): () => void {
  return subscribeThemeSettings(client, ({ id }) => {
    apply(id);
  });
}
