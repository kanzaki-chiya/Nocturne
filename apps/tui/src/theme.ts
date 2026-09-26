/**
 * 主题常量（ADR-0019 第 5 条）：TUI 全部颜色集中在这里，
 * 组件不直接写死色值。语义角色 + 状态栏分段色 + 像素 Logo 数据。
 * NO_COLOR / TERM=dumb 时 Ink 自行降级（env.ts 探测）；NOCTURNE_ASCII
 * 退回 ASCII 符号（env.ts 的 glyphs）。
 */

/** 语义色 */
export const theme = {
  /** 主强调色：选中标记、标题、边框 */
  accent: "cyan",
  /** 第二强调色：像素 Logo 右半、"欢迎回来" */
  accentAlt: "magenta",
  /** 成功 / 已配置标记 */
  success: "green",
  /** 警告块、确认框、思考档位"旧→新"过渡段 */
  warning: "yellow",
  /** 错误块、失败状态 */
  error: "red",
  /** 信息块（恢复修复摘要等启动通知） */
  info: "blue",
  /** 弱化：分隔线、按键提示、留空列 */
  muted: "gray",
} as const;

/** 状态栏分段色（tui.md §2：模型 · 思考档位 · 权限预设 · 目录 · 上下文占用） */
export const statusSegmentColors = {
  status: theme.accent,
  model: theme.success,
  effort: theme.accentAlt,
  /** Turn 中切档（旧档→新档）的提示色 */
  effortTransition: theme.warning,
  preset: theme.warning,
  dir: theme.info,
  context: theme.muted,
} as const;

/**
 * Nocturne 像素 Logo（原创双色像素字，5 行高）。
 * 左半（NOCT）用 accent 色、右半（URNE）用 accentAlt 色；
 * LOGO_SPLIT 是每行字符串中两个颜色的分界列。
 */
export const LOGO_ROWS: readonly string[] = (() => {
  const L: Record<string, readonly string[]> = {
    N: ["█   █", "██  █", "█ █ █", "█  ██", "█   █"],
    O: [" ███ ", "█   █", "█   █", "█   █", " ███ "],
    C: [" ███ ", "█    ", "█    ", "█    ", " ███ "],
    T: ["█████", "  █  ", "  █  ", "  █  ", "  █  "],
    U: ["█   █", "█   █", "█   █", "█   █", " ███ "],
    R: ["████ ", "█   █", "████ ", "█ █  ", "█  ██"],
    E: ["█████", "█    ", "████ ", "█    ", "█████"],
  };
  const word = "NOCTURNE";
  const rows: string[] = [];
  for (let r = 0; r < 5; r++) {
    rows.push(
      Array.from(word)
        .map((ch) => L[ch]?.[r] ?? "     ")
        .join(" "),
    );
  }
  return rows;
})();

/** Logo 双色分界列：前 4 个字母（NOCT）= 4×6 = 24 列 */
export const LOGO_SPLIT = 24;

/** Logo 宽度（8 字母 × 5 + 7 空格 = 47 列） */
export const LOGO_WIDTH = 47;

/**
 * 欢迎区小像素标记（ADR-0020）：4 行，只用宽度确定的 █。
 * 服务商页的大号字标仍用 LOGO_ROWS；主界面不再画整词像素字。
 */
export const MARK_ROWS: readonly string[] = ["█  █", "██ █", "█ ██", "█  █"];
