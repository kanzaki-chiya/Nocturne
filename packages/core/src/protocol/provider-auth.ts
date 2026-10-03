/** 用户级鉴权声明；不包含凭据。ADR-0042、ADR-0043。 */
export type ProviderAuth =
  | { kind: "apiKey" }
  | { kind: "openai-siwc" }
  | { kind: "xai-oauth2" }
  | { kind: "external-file"; path: string; keyPath: string[]; renewHint: string };
