/** 登录结果不携带密钥、授权码或令牌。ADR-0042 §8。 */
export interface LoginResult {
  providerId: string;
  account?: string | undefined;
}

export interface LoginSession {
  authorizeUrl: string;
  manualInput: "callback-url" | "code";
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
