import type { CredentialStore, ProviderEntryConfig } from "../config/index.js";
import type { LoginSession } from "../protocol/index.js";
import { ProviderLoginError, type ProviderLoginOptions } from "./errors.js";
import { openLoginLoopback } from "./loopback.js";
import { createLoginLifecycle, createLoginSecrets } from "./session.js";

interface OpenRouterDependencies {
  authorizeEndpoint?: string;
  tokenEndpoint?: string;
  timeoutMs?: number;
}

/** 内部测试 factory；不由 Core 公开导出，生产入口不接受端点覆盖。 */
export async function createOpenRouterLogin(
  entry: ProviderEntryConfig,
  credentials: CredentialStore,
  options: ProviderLoginOptions = {},
  deps: OpenRouterDependencies = {},
): Promise<LoginSession> {
  if (entry.auth?.kind !== undefined && entry.auth.kind !== "apiKey") {
    throw new ProviderLoginError("unsupported");
  }
  if (credentials.backend() === "none" && !options.onUnstoredKey) {
    throw new ProviderLoginError("unstored");
  }
  const secrets = createLoginSecrets();
  const authorize = new URL(deps.authorizeEndpoint ?? "https://openrouter.ai/auth");
  const lifecycle = createLoginLifecycle(deps.timeoutMs);
  authorize.searchParams.set("state", secrets.state);
  authorize.searchParams.set("code_challenge", secrets.challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  let loopback: Awaited<ReturnType<typeof openLoginLoopback>> | undefined;

  function validCode(code: string) {
    return code.length > 0 && code.length <= 4096 && !/\s/.test(code);
  }

  function exchange(code: string): Promise<void> {
    return lifecycle.run(async (signal) => {
      let response;
      try {
        response = await fetch(deps.tokenEndpoint ?? "https://openrouter.ai/api/v1/auth/keys", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code,
            code_verifier: secrets.verifier,
            code_challenge_method: "S256",
          }),
          redirect: "error",
          signal,
        });
      } catch {
        throw new ProviderLoginError("network");
      }
      if (!response.ok) throw new ProviderLoginError("exchange");
      let data: unknown;
      try {
        data = await response.json();
      } catch {
        throw new ProviderLoginError("exchange");
      }
      if (
        !data ||
        typeof data !== "object" ||
        !("key" in data) ||
        typeof data.key !== "string" ||
        !data.key.trim()
      ) {
        throw new ProviderLoginError("exchange");
      }
      signal.throwIfAborted();
      try {
        if (credentials.backend() === "none") {
          if (!options.onUnstoredKey) throw new ProviderLoginError("unstored");
          await options.onUnstoredKey(data.key, entry.apiKeyEnv ?? "OPENROUTER_API_KEY");
        } else {
          await credentials.set(entry.id, data.key);
        }
      } catch {
        throw new ProviderLoginError("storage");
      }
      signal.throwIfAborted();
      return { providerId: entry.id };
    });
  }

  try {
    if (!options.remote) {
      loopback = await openLoginLoopback({
        state: secrets.state,
        path: "/callback",
        dualStack: true,
        accept(url) {
          if (!lifecycle.accepting) return false;
          if (url.searchParams.has("error")) {
            // 推迟清理到响应发出之后。
            setImmediate(() => {
              lifecycle.fail(new ProviderLoginError("exchange"));
            });
            return true;
          }
          const codes = url.searchParams.getAll("code");
          const code = codes[0];
          if (codes.length !== 1 || !code || !validCode(code)) return false;
          void exchange(code).catch(() => undefined);
          return true;
        },
      });
      lifecycle.addCleanup(loopback.close);
      authorize.searchParams.set("callback_url", loopback.callbackUrl);
    }
    if (lifecycle.signal.aborted) await lifecycle.completion;
  } catch (error) {
    lifecycle.fail(new ProviderLoginError("callback"));
    throw error instanceof ProviderLoginError ? error : new ProviderLoginError("callback");
  }

  return {
    authorizeUrl: authorize.toString(),
    manualInput: "code",
    completion: lifecycle.completion,
    async submitManual(text) {
      const code = text.trim();
      if (!validCode(code)) throw new ProviderLoginError("input");
      const pending = exchange(code);
      loopback?.close();
      await pending;
    },
    cancel: lifecycle.cancel,
  };
}
