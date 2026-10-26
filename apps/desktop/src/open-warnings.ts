/**
 * 会话打开时的警告（`SessionOpened.warnings`：配置降级、未信任的项目配置、技能解析、
 * MCP 装配失败等）。它们在 Core 里先于任何订阅者产生，不会经事件流到达视图，
 * 所以由对话页单独显示。纯逻辑，不依赖 React。
 */
import type { SessionNotice } from "@nocturne/core/protocol";

/** 去掉重复项，并略过视图提示里已经有同样文字的警告（同一件事只显示一次） */
export function openWarningsToShow(
  warnings: readonly string[] | undefined,
  notices: readonly Pick<SessionNotice, "message">[],
): string[] {
  const seen = new Set(notices.map((notice) => notice.message));
  const out: string[] = [];
  for (const warning of warnings ?? []) {
    if (seen.has(warning)) continue;
    seen.add(warning);
    out.push(warning);
  }
  return out;
}

/**
 * 手机网页不出现 CLI 命令（视觉规范「文案与分隔」）：含 `nctrn trust` 的分句
 * 改成「请在电脑上信任该项目」。桌面端指向设置授权页。
 */
export function desktopWarningText(warning: string): string {
  return warning
    .split("；")
    .map((clause) =>
      clause.includes("nctrn trust") ? "可在 设置 › 授权 中信任，新开或重新打开会话生效" : clause,
    )
    .join("；");
}

export function phoneWarningText(warning: string): string {
  return warning
    .split("；")
    .map((clause) => (clause.includes("nctrn trust") ? "请在电脑上信任该项目" : clause))
    .join("；");
}
