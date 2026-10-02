/** 用户级鉴权声明；不包含凭据。ADR-0042。 */
export type ProviderAuth =
  | { kind: "apiKey" }
  | { kind: "openai-siwc" }
  | { kind: "external-file"; path: string; keyPath: string[]; renewHint: string };
