/**
 * 只为被更高层覆盖的设置值返回悬停警告，不显示配置来源文字。
 */
import type { SettingItem } from "./rpc-types";

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

export function settingOverrideTitle(
  item: Pick<SettingItem, "source" | "overridden"> | undefined,
): string | undefined {
  return item?.overridden
    ? `保存的值被更高层（${LAYER_TEXT[item.source]}）覆盖，改了也不生效`
    : undefined;
}
