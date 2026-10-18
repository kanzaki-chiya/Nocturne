/**
 * 冒烟测试的环境变量小工具（只被 *.smoke.ts 与其单测引用）。
 */

/**
 * 主组服务商的会话头（ADR-0031 §3）：设置了 `NOCTURNE_SMOKE_SESSION_HEADER` 时给 provider
 * 配置带上 `sessionHeader`（如 OpenCode Go 要求的 `x-opencode-session`），未设置或为空时不加。
 */
export function smokeSessionHeader(
  env: Readonly<Record<string, string | undefined>> = process.env,
): { sessionHeader?: string } {
  const header = env.NOCTURNE_SMOKE_SESSION_HEADER?.trim();
  return header === undefined || header === "" ? {} : { sessionHeader: header };
}
