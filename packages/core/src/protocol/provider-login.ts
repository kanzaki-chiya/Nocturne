/** 登录结果不携带密钥、授权码或令牌。ADR-0042 §8。 */
export interface LoginResult {
  providerId: string;
  account?: string | undefined;
}

export interface LoginSession {
  /** 仅草稿登录（表单里尚未保存的服务商）有：完成后交给 addProvider 引用，见 ADR-0044 第 6 节。 */
  loginId?: string | undefined;
  authorizeUrl: string;
  /** `none`：设备码登录，用户在浏览器确认，不向本进程粘贴。 */
  manualInput: "callback-url" | "code" | "none";
  /** 设备码登录时展示，供用户在浏览器核对。不含令牌。 */
  userCode?: string | undefined;
  /** 本次登录等待的截止时刻（Unix 毫秒）：到时以 timeout 失败；客户端倒计时以它为准。 */
  expiresAt: number;
  completion: Promise<LoginResult>;
  submitManual(text: string): Promise<void>;
  cancel(): void;
}

/** 仅凭据存储使用，不属于事件或 ResolvedConfig。 */
export interface OAuthCredentialRecord {
  version: 1;
  clientId: string;
  subject: string;
  email?: string | undefined;
  idToken: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
}

export function parseOAuthCredential(text: string | undefined): OAuthCredentialRecord | undefined {
  if (text === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object") return undefined;
    const record = value as Record<string, unknown>;
    if (
      record.version !== 1 ||
      !["clientId", "subject", "idToken", "accessToken", "refreshToken"].every(
        (key) => typeof record[key] === "string" && record[key] !== "",
      ) ||
      typeof record.expiresAt !== "number" ||
      !Number.isFinite(record.expiresAt) ||
      !Array.isArray(record.scopes) ||
      !record.scopes.every((scope) => typeof scope === "string") ||
      !record.scopes.includes("chatgpt.tokens.use.direct") ||
      (record.email !== undefined && typeof record.email !== "string")
    )
      return undefined;
    return record as unknown as OAuthCredentialRecord;
  } catch {
    return undefined;
  }
}

/** xAI OAuth2 账号记录。只存 Nocturne 自己换到的令牌，不读官方 CLI 文件。ADR-0043。 */
export interface XaiOAuthCredentialRecord {
  version: 1;
  kind: "xai-oauth2";
  clientId: string;
  subject: string;
  email?: string | undefined;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
}

export function parseXaiOAuthCredential(
  text: string | undefined,
): XaiOAuthCredentialRecord | undefined {
  if (text === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object") return undefined;
    const record = value as Record<string, unknown>;
    if (
      record.version !== 1 ||
      record.kind !== "xai-oauth2" ||
      !["clientId", "subject", "accessToken", "refreshToken"].every(
        (key) => typeof record[key] === "string" && record[key] !== "",
      ) ||
      typeof record.expiresAt !== "number" ||
      !Number.isFinite(record.expiresAt) ||
      !Array.isArray(record.scopes) ||
      !record.scopes.every((scope) => typeof scope === "string") ||
      !record.scopes.includes("grok-cli:access") ||
      (record.email !== undefined && typeof record.email !== "string")
    )
      return undefined;
    return record as unknown as XaiOAuthCredentialRecord;
  } catch {
    return undefined;
  }
}
