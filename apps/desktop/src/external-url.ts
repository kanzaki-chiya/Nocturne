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
