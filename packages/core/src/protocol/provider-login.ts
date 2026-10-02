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
