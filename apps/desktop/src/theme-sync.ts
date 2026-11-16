import type { RpcClient } from "@nocturne/rpc/client";
import { themePresetId, type ThemePresetId } from "./theme-presets";

/** 订阅先于首读；请求版本与清理标记阻止迟到响应覆盖新连接。 */
export function subscribeThemePreset(
  client: RpcClient,
  apply: (id: ThemePresetId) => void,
): () => void {
  let active = true;
  let version = 0;
  const read = () => {
    const request = ++version;
    void client.runtime
      .describeSettings()
      .then((items) => {
        if (active && request === version)
          apply(
            themePresetId(items.find((item) => item.key === "appearance.themePreset")?.effective),
          );
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
