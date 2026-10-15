/**
 * 只存在这台手机上的偏好与诊断（localStorage）。读写都可能因隐私模式或
 * 清除网站数据而失败，失败时退回默认值，不影响连接与会话。
 */

export type PhoneTheme = "system" | "light" | "dark";

const THEME_KEY = "nocturne.phone.theme";
const DIAGNOSTICS_KEY = "nocturne.phone.diagnostics";
const DIAGNOSTICS_LIMIT = 8;

export interface DisconnectRecord {
  at: number;
  /** 电脑名称（多台电脑时区分） */
  host: string;
  reason: string;
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 存不下只影响下次打开的默认值
  }
}

export function loadTheme(): PhoneTheme {
  const value = read(THEME_KEY);
  return value === "light" || value === "dark" ? value : "system";
}

export function applyTheme(theme: PhoneTheme): void {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

export function saveTheme(theme: PhoneTheme): void {
  write(THEME_KEY, theme);
  applyTheme(theme);
}

export function loadDisconnects(): DisconnectRecord[] {
  try {
    const parsed = JSON.parse(read(DIAGNOSTICS_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is DisconnectRecord =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as DisconnectRecord).at === "number" &&
        typeof (item as DisconnectRecord).reason === "string" &&
        typeof (item as DisconnectRecord).host === "string",
    );
  } catch {
    return [];
  }
}

/** 记一次断线（只含时间、电脑名与原因，不含会话内容） */
export function recordDisconnect(host: string, reason: string, now = Date.now()): void {
  const list = [{ at: now, host, reason }, ...loadDisconnects()].slice(0, DIAGNOSTICS_LIMIT);
  write(DIAGNOSTICS_KEY, JSON.stringify(list));
}

export function clearDisconnects(): void {
  write(DIAGNOSTICS_KEY, "[]");
}

/** 中继关闭码 → 断线原因 */
export function closeReason(code: number | undefined): string {
  switch (code) {
    case undefined:
      return "加密连接中断";
    case 4000:
      return "协议错误";
    case 4001:
      return "连接被新的连接取代";
    case 4002:
      return "电脑离线";
    case 4003:
    case 4004:
      return "这台手机已被移除或吊销";
    case 4005:
      return "连接过于频繁，被中继限流";
    case 4006:
      return "这台电脑的手机连接数已满";
    case 4007:
      return "网络太慢，中继断开了连接";
    case 1006:
      return "网络中断";
    default:
      return `中继关闭连接（${code}）`;
  }
}
