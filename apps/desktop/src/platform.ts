/**
 * 桌面端平台判定与修饰键归一化（ADR-0110 第 4 节）：前端只在这一处读取
 * `navigator.userAgent` 判断 macOS / Windows；测试通过 `setPlatformForTest` 注入平台。
 */

export type DesktopPlatform = "windows" | "macos" | "other";

let platformOverride: DesktopPlatform | null = null;

/** 测试用：注入平台；传 null 恢复按 navigator.userAgent 自动判断。 */
export function setPlatformForTest(platform: DesktopPlatform | null): void {
  platformOverride = platform;
}

/** 是否运行在 macOS 桌面环境（`navigator.userAgent` 含 `Macintosh`）。 */
export function isMacOS(): boolean {
  if (platformOverride !== null) return platformOverride === "macos";
  return typeof navigator !== "undefined" && navigator.userAgent.includes("Macintosh");
}

/** 是否运行在 Windows 桌面环境（`navigator.userAgent` 含 `Windows`）。 */
export function isWindows(): boolean {
  if (platformOverride !== null) return platformOverride === "windows";
  return typeof navigator !== "undefined" && navigator.userAgent.includes("Windows");
}

export interface ModifierKeyLike {
  ctrlKey: boolean;
  metaKey: boolean;
}

/**
 * 仅主应用修饰键按下（排除另一个主修饰键）：
 * - macOS：仅 `metaKey`（Cmd），不占用 `ctrlKey`；
 * - Windows / 其他：仅 `ctrlKey`，排除 `metaKey`。
 */
export function hasPrimaryMod(event: ModifierKeyLike, mac = isMacOS()): boolean {
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/**
 * 兼容原本允许 `ctrlKey || metaKey` 的快捷键：
 * - macOS：只认 `metaKey`（Cmd），排除 `ctrlKey`，保证 `Ctrl` 留给系统、终端与输入框；
 * - Windows / 其他：保持原有 `ctrlKey || metaKey` 行为不变。
 */
export function hasPrimaryModOrMetaOnOther(event: ModifierKeyLike, mac = isMacOS()): boolean {
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey || event.metaKey;
}

const MAC_MOD_ORDER = ["ctrl", "alt", "shift", "cmd"] as const;
const MAC_MOD_SYMBOL: Record<(typeof MAC_MOD_ORDER)[number], string> = {
  ctrl: "⌃",
  alt: "⌥",
  shift: "⇧",
  cmd: "⌘",
};

function normalizeModifier(token: string, mac: boolean): (typeof MAC_MOD_ORDER)[number] | null {
  switch (token.toLowerCase()) {
    case "ctrl":
    case "control":
      return "ctrl";
    case "alt":
    case "option":
      return "alt";
    case "shift":
      return "shift";
    case "cmd":
    case "meta":
      return "cmd";
    case "mod":
      return mac ? "cmd" : "ctrl";
    default:
      return null;
  }
}

/**
 * 格式化 `<Kbd>` 等处显示的快捷键文字：
 * - 规范输入使用 `Mod` 表示主修饰键（如 `"Mod+Shift+G"`、`"Mod+P"`、``"Mod+`"``）；
 * - Windows / 其他：`Mod` 渲染为 `Ctrl`，以 `+` 连接；
 * - macOS：按系统习惯输出 `⌃` `⌥` `⇧` `⌘` 符号前缀加按键。
 */
export function formatShortcut(shortcut: string, mac = isMacOS()): string {
  const parts = shortcut
    .split("+")
    .map((p) => p.trim())
    .filter((p) => p !== "");
  if (!mac) {
    return parts.map((part) => (part.toLowerCase() === "mod" ? "Ctrl" : part)).join("+");
  }
  const mods = new Set<(typeof MAC_MOD_ORDER)[number]>();
  const keys: string[] = [];
  for (const part of parts) {
    const mod = normalizeModifier(part, true);
    if (mod !== null) mods.add(mod);
    else keys.push(part);
  }
  const prefix = MAC_MOD_ORDER.filter((m) => mods.has(m))
    .map((m) => MAC_MOD_SYMBOL[m])
    .join("");
  return `${prefix}${keys.join("+")}`;
}
