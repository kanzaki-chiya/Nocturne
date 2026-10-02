import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ProviderAuth } from "../../protocol/index.js";
import { ProviderAuthError } from "../errors.js";
import type { AuthResolver } from "../types.js";

export function externalAuthPath(path: string): string {
  return resolve(path.replace(/^~(?=[/\\]|$)/, homedir()));
}

export function createExternalFileAuth(
  auth: Extract<ProviderAuth, { kind: "external-file" }>,
): AuthResolver {
  const path = externalAuthPath(auth.path);
  const message = `未找到可用的外部登录凭据，请先执行 ${auth.renewHint}`;
  let cached: { mtime: number; token: string } | undefined;
  return {
    unauthorizedMessage: `登录凭据已失效，请执行 ${auth.renewHint}`,
    async token(signal) {
      signal.throwIfAborted();
      try {
        const info = await stat(path);
        if (cached?.mtime === info.mtimeMs) return cached.token;
        let value: unknown = JSON.parse(await readFile(path, { encoding: "utf8", signal }));
        for (const key of auth.keyPath) {
          if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) {
            throw new ProviderAuthError(message);
          }
          value = (value as Record<string, unknown>)[key];
        }
        if (typeof value !== "string" || value.trim() === "") throw new ProviderAuthError(message);
        cached = { mtime: info.mtimeMs, token: value };
        signal.throwIfAborted();
        return value;
      } catch {
        cached = undefined;
        signal.throwIfAborted();
        throw new ProviderAuthError(message);
      }
    },
    invalidate() {
      cached = undefined;
      return Promise.resolve();
    },
  };
}
