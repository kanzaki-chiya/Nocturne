import type { ProviderAuth } from "../protocol/index.js";
import { ProviderAuthError } from "./errors.js";
import { createExternalFileAuth } from "./adapters/external-file-auth.js";
import type { AuthResolver, CredentialResolver } from "./types.js";

export interface AuthConfig {
  id: string;
  auth?: ProviderAuth | undefined;
  apiKeyEnv?: string | undefined;
  credentials?: CredentialResolver | undefined;
  authResolver?: AuthResolver | undefined;
}

export function createAuthResolver(
  config: AuthConfig,
  env: (name: string) => string | undefined = (name) => process.env[name],
): AuthResolver {
  if (config.authResolver !== undefined) return config.authResolver;
  if (config.auth?.kind === "external-file") return createExternalFileAuth(config.auth);
  if (config.auth?.kind === "openai-siwc") {
    const message = `登录凭据缺少或已失效，请执行 /provider login ${config.id}`;
    return {
      unauthorizedMessage: message,
      token: () => Promise.reject(new ProviderAuthError(message)),
      invalidate: () => Promise.resolve(),
    };
  }
  const keyFromEnv = config.apiKeyEnv === undefined ? undefined : env(config.apiKeyEnv);
  return {
    async token(signal) {
      signal.throwIfAborted();
      const key =
        keyFromEnv !== undefined && keyFromEnv !== ""
          ? keyFromEnv
          : await config.credentials?.(config.id);
      if (!key) {
        throw new ProviderAuthError(
          config.apiKeyEnv === undefined
            ? `Provider "${config.id}" 未配置凭据，请运行 nctrn setup 或 /provider key ${config.id}`
            : `环境变量 ${config.apiKeyEnv} 未设置，凭据存储中也没有 "${config.id}" 的密钥，请运行 nctrn setup 或 /provider key ${config.id}`,
        );
      }
      signal.throwIfAborted();
      return key;
    },
    invalidate: () => Promise.resolve(),
  };
}
