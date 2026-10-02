import type { RuntimeConfig } from "./config/index.js";
import type { LoginSession } from "./protocol/index.js";
import { listProviderPresets } from "./provider/index.js";
import { ProviderLoginError, type ProviderLoginOptions } from "./provider-login/errors.js";
import { createOpenRouterLogin } from "./provider-login/openrouter.js";
import { createSiwcLogin } from "./provider-login/openai-siwc.js";
import { createPlatform } from "./platform/index.js";

export { ProviderLoginError, type ProviderLoginErrorCode } from "./provider-login/errors.js";
export type { ProviderLoginOptions } from "./provider-login/errors.js";

export async function startProviderLogin(
  config: RuntimeConfig,
  providerId: string,
  options: ProviderLoginOptions = {},
): Promise<LoginSession> {
  const entry = options.entry ?? config.base.providers.find((item) => item.id === providerId);
  if (entry?.id !== providerId) throw new ProviderLoginError("missing");
  if (entry.auth?.kind === "openai-siwc") {
    return createSiwcLogin(
      entry,
      config.credentials,
      createPlatform(),
      config.nocturneHome,
      options,
    );
  }
  if (entry.auth?.kind !== undefined && entry.auth.kind !== "apiKey") {
    throw new ProviderLoginError("unsupported");
  }
  const preset = listProviderPresets().find(
    (item) => item.baseURL !== undefined && item.baseURL === entry.baseURL,
  );
  if (preset?.login !== "openrouter" || (entry.type && entry.type !== preset.type)) {
    throw new ProviderLoginError("unsupported");
  }
  return createOpenRouterLogin(entry, config.credentials, options);
}

export async function logoutProvider(config: RuntimeConfig, providerId: string): Promise<void> {
  const entry = config.base.providers.find((item) => item.id === providerId);
  if (!entry) throw new ProviderLoginError("missing");
  if (entry.auth?.kind === "external-file") return;
  try {
    await config.credentials.delete(providerId);
  } catch {
    throw new ProviderLoginError("storage");
  }
}
