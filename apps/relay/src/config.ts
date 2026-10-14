import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_FRAME } from "@nocturne/remote";

export interface RelayConfig {
  listen: string;
  publicOrigin: string;
  dataDir: string;
  webRoot: string;
  trustProxy: boolean;
  pushHosts: string[];
  vapidSubject: string;
  allowInsecurePush: boolean;
  limits: {
    devices: number;
    connections: number;
    ratePerMinute: number;
    maxFrame: number;
    slowConsumer: number;
    authTimeoutMs: number;
    pairLifetimeMs: number;
    slotLifetimeMs: number;
    heartbeatMs: number;
  };
}
export type ConfigInput = Partial<Omit<RelayConfig, "limits">> & {
  limits?: Partial<RelayConfig["limits"]>;
};
export function config(input: ConfigInput): RelayConfig {
  if (!input.publicOrigin) throw new Error("必须配置 publicOrigin");
  const origin = new URL(input.publicOrigin);
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.origin !== input.publicOrigin ||
    input.publicOrigin !== input.publicOrigin.toLowerCase()
  )
    throw new Error("publicOrigin 必须是小写、无尾斜杠的 URL origin");
  const result: RelayConfig = {
    listen: "127.0.0.1:8787",
    webRoot: fileURLToPath(new URL("../public/", import.meta.url)),
    trustProxy: false,
    pushHosts: [
      "fcm.googleapis.com",
      "updates.push.services.mozilla.com",
      "web.push.apple.com",
      "notify.windows.com",
    ],
    vapidSubject: input.publicOrigin,
    allowInsecurePush: false,
    ...input,
    publicOrigin: input.publicOrigin,
    dataDir: resolve(input.dataDir ?? "./relay-data"),
    limits: {
      devices: 5,
      connections: 10,
      ratePerMinute: 10,
      maxFrame: MAX_FRAME,
      slowConsumer: 8 * 1024 * 1024,
      authTimeoutMs: 10000,
      pairLifetimeMs: 60000,
      slotLifetimeMs: 300000,
      heartbeatMs: 30000,
      ...input.limits,
    },
  };
  if (Object.values(result.limits).some((value) => !Number.isSafeInteger(value) || value <= 0))
    throw new Error("limits 必须是正整数");
  if (
    !Array.isArray(result.pushHosts) ||
    result.pushHosts.some((host) => typeof host !== "string" || !host)
  )
    throw new Error("pushHosts 必须是非空主机名数组");
  return result;
}
export async function loadConfig(
  cli: ConfigInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RelayConfig> {
  const dataDir = resolve(cli.dataDir ?? env.NOCTURNE_RELAY_DATA_DIR ?? "./relay-data");
  let file: ConfigInput = {};
  try {
    file = JSON.parse(await readFile(resolve(dataDir, "relay.json"), "utf8")) as ConfigInput;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const fromEnv: ConfigInput = {};
  for (const [key, suffix] of Object.entries({
    listen: "LISTEN",
    publicOrigin: "PUBLIC_ORIGIN",
    webRoot: "WEB_ROOT",
    vapidSubject: "VAPID_SUBJECT",
  }) as ["listen" | "publicOrigin" | "webRoot" | "vapidSubject", string][]) {
    const value = env[`NOCTURNE_RELAY_${suffix}`];
    if (value !== undefined) fromEnv[key] = value;
  }
  for (const [key, suffix] of [
    ["trustProxy", "TRUST_PROXY"],
    ["allowInsecurePush", "ALLOW_INSECURE_PUSH"],
  ] as const) {
    const value = env[`NOCTURNE_RELAY_${suffix}`];
    if (value !== undefined) {
      if (value !== "true" && value !== "false") throw new Error("布尔配置必须是 true 或 false");
      fromEnv[key] = value === "true";
    }
  }
  if (env.NOCTURNE_RELAY_PUSH_HOSTS) fromEnv.pushHosts = env.NOCTURNE_RELAY_PUSH_HOSTS.split(",");
  if (env.NOCTURNE_RELAY_LIMITS)
    fromEnv.limits = JSON.parse(env.NOCTURNE_RELAY_LIMITS) as RelayConfig["limits"];
  return config({
    ...file,
    ...fromEnv,
    ...cli,
    dataDir,
    limits: { ...file.limits, ...fromEnv.limits, ...cli.limits },
  });
}
