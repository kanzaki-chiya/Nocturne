import type { CSSProperties } from "react";
import type { EnsembleAuthorKind } from "@nocturne/core/protocol";

import { Icon, ICON_SM, type IconName } from "./ui";

export type EnsembleAvatarKind = EnsembleAuthorKind | "group" | "all";

export interface EnsembleAvatarProps {
  kind: EnsembleAvatarKind;
  /** 成员颜色 token（如 `var(--a-cat1)`）；未传时用中性底色与图标色 */
  color?: string | undefined;
  /** `md` 用于留言板作者列，`sm` 用于概览行、成员页与 `@` 候选 */
  size?: "sm" | "md" | undefined;
  /** 成员存在待确认权限时给头像加警告色描边 */
  warn?: boolean | undefined;
}

const AVATAR_ICONS: Record<EnsembleAvatarKind, IconName> = {
  maestro: "group",
  member: "robot",
  user: "chat_1",
  runtime: "shield",
  group: "group",
  all: "at",
};

export function EnsembleAvatar({ kind, color, size = "md", warn = false }: EnsembleAvatarProps) {
  const classes = ["ensemble-av"];
  if (size === "sm") classes.push("sm");
  if (color !== undefined) classes.push("tinted");
  if (warn) classes.push("warn");
  const style =
    color !== undefined ? ({ "--ensemble-av-color": color } as CSSProperties) : undefined;
  return (
    <span className={classes.join(" ")} style={style} aria-hidden="true">
      <Icon name={AVATAR_ICONS[kind]} size={size === "sm" ? 12 : ICON_SM} />
    </span>
  );
}
