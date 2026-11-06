import type { Platform } from "../platform/index.js";
import { fsErrorCode } from "../platform/index.js";
import type { PermissionAction, PermissionRule } from "../protocol/index.js";
import { enqueueConfigWrite, writeJsonAtomic } from "./files.js";
import { parseConfigFile } from "./schema.js";

export interface AppPermissionStore {
  list(): PermissionRule[];
  set(
    identity: string,
    action: PermissionAction | undefined,
    app?: PermissionRule["app"],
  ): Promise<void>;
  subscribe(listener: () => void): () => void;
}

export async function loadAppPermissions(
  platform: Platform,
  home: string,
): Promise<AppPermissionStore> {
  const file = platform.paths.join(home, "config.json");
  async function read(): Promise<Record<string, unknown>> {
    try {
      const raw: unknown = JSON.parse(await platform.fs.readTextFile(file));
      parseConfigFile(raw, file);
      return raw as Record<string, unknown>;
    } catch (error) {
      if (fsErrorCode(error) === "ENOENT") return {};
      throw error;
    }
  }
  const initial = parseConfigFile(await read(), file);
  let rules = initial.permissions?.rules?.filter((rule) => rule.kind === "app") ?? [];
  const listeners = new Set<() => void>();
  return {
    list: () => rules.map((rule) => ({ ...rule })),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async set(identity, action, app) {
      if (
        identity.length === 0 ||
        identity.trim() !== identity ||
        (identity !== "*" && /[?*\\/\r\n]/u.test(identity))
      ) {
        throw new Error("无效的软件身份");
      }
      await enqueueConfigWrite(platform.fs, async () => {
        const raw = await read();
        const parsed = parseConfigFile(raw, file);
        const previous = parsed.permissions?.rules ?? [];
        const others = previous.filter((rule) => rule.kind !== "app");
        const apps = previous.filter((rule) => rule.kind === "app" && rule.pattern !== identity);
        const existing = previous.find((rule) => rule.kind === "app" && rule.pattern === identity);
        if (action !== undefined) {
          const meta = app ?? existing?.app;
          apps.push({
            kind: "app",
            pattern: identity,
            action,
            ...(meta === undefined ? {} : { app: meta }),
          });
        }
        apps.sort((a, b) => Number(b.pattern === "*") - Number(a.pattern === "*"));
        const permissions = raw.permissions as Record<string, unknown> | undefined;
        await writeJsonAtomic(platform.fs, platform.paths, file, {
          ...raw,
          permissions: { ...permissions, rules: [...others, ...apps] },
        });
        rules = apps;
      });
      for (const listener of listeners) listener();
    },
  };
}
