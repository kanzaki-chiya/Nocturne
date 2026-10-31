/**
 * 设置值来源 → 来源标记（docs/apps/desktop.md §9「来源标记」）：值等于默认时不显示；
 * 来自某个配置文件时显示文件名；被更高层覆盖时用 warn，title 写明覆盖它的那一层。
 */
import type { SettingItem } from "./rpc-types";
import type { SourceMarkerProps } from "./ui";

export const LAYER_TEXT: Record<SettingItem["source"], string> = {
  default: "默认",
  setup: "providers.json",
  settings: "settings.json",
  user: "config.json",
  magpie: "magpie.json",
  project: "项目配置",
  env: "环境变量",
  cli: "命令行参数",
};

export function sourceMarker(
  item: Pick<SettingItem, "source" | "overridden"> | undefined,
): SourceMarkerProps | undefined {
  if (item === undefined) return undefined;
  const layer = LAYER_TEXT[item.source];
  if (item.overridden) {
    return {
      label: layer,
      tone: "warn",
      title: `保存的值被更高层（${layer}）覆盖，改了也不生效`,
    };
  }
  if (item.source === "default") return undefined;
  return { label: layer };
}
