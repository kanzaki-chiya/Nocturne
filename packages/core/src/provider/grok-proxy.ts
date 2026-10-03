/**
 * Grok 代理（cli-chat-proxy.grok.com）要求的请求头（ADR-0043）。
 * 缺版本门头时代理回 426；版本号对齐当前能过门的官方 CLI，不是 Nocturne 版本，
 * 代理提高门槛时只改这里。User-Agent 仍是 nocturne/<version>。
 * xai-oauth2 通道把它声明为 requestHeaders，每次请求覆盖条目里保存的旧值。
 */
export const GROK_PROXY_HEADERS: Readonly<Record<string, string>> = {
  "X-XAI-Token-Auth": "xai-grok-cli",
  "x-grok-client-version": "1.0.44",
  "x-grok-client-identifier": "nocturne",
  "x-authenticateresponse": "authenticate-response",
  "x-grok-client-mode": "headless",
};
