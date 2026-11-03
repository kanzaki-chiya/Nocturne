/**
 * 外链白名单（ADR-0046 第 6 节）：https 与 http://127.0.0.1 / http://localhost
 * （本机回调页）放行，其他协议与解析失败一律忽略。
 */
export function isAllowedExternalUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  if (parsed.protocol !== "http:") return false;
  return parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
}

/** 本机地址的主机名（URL.hostname 的写法：IPv6 带方括号） */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * 模型回复里链接的种类（设置 › 浏览器 › 打开方式，ADR-0078）：http(s) 且主机是
 * localhost / 127.0.0.1 / [::1] 为本地网址，其余 http(s) 为网页链接；别的协议与解析失败为 null。
 */
export function linkKind(url: string): "web" | "local" | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return LOCAL_HOSTS.has(parsed.hostname) ? "local" : "web";
}

/** 模型回复里的链接按设置该去哪：缺省系统浏览器 */
export function replyLinkOpener(
  url: string,
  prefs: {
    webLinkOpener?: "system" | "panel" | undefined;
    localLinkOpener?: "system" | "panel" | undefined;
  },
): "system" | "panel" {
  const kind = linkKind(url);
  const opener =
    kind === "local" ? prefs.localLinkOpener : kind === "web" ? prefs.webLinkOpener : undefined;
  return opener ?? "system";
}
