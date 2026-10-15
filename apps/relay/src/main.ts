#!/usr/bin/env node
import { parseArgs } from "node:util";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, type ConfigInput } from "./config.js";
import { RelayServer } from "./server.js";
import { requestAdmin, startAdmin, type AdminRequest } from "./admin.js";

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      listen: { type: "string" },
      "public-origin": { type: "string" },
      "data-dir": { type: "string" },
      "web-root": { type: "string" },
      "trust-proxy": { type: "boolean" },
      "push-hosts": { type: "string" },
      "vapid-subject": { type: "string" },
      "allow-insecure-push": { type: "boolean" },
      limits: { type: "string" },
      note: { type: "string" },
      expires: { type: "string" },
      host: { type: "string" },
      version: { type: "boolean" },
    },
  });
  if (values.version) {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    console.log(pkg.version);
    return;
  }
  if (positionals[0] === "serve") {
    const input: ConfigInput = {};
    for (const [option, key] of [
      ["listen", "listen"],
      ["public-origin", "publicOrigin"],
      ["data-dir", "dataDir"],
      ["web-root", "webRoot"],
      ["vapid-subject", "vapidSubject"],
    ] as const)
      if (values[option] !== undefined) input[key] = values[option];
    if (values["trust-proxy"] !== undefined) input.trustProxy = values["trust-proxy"];
    if (values["allow-insecure-push"] !== undefined)
      input.allowInsecurePush = values["allow-insecure-push"];
    if (values["push-hosts"]) input.pushHosts = values["push-hosts"].split(",");
    if (values.limits)
      input.limits = JSON.parse(values.limits) as NonNullable<ConfigInput["limits"]>;
    const relay = new RelayServer(await loadConfig(input));
    await relay.start();
    let admin;
    try {
      admin = await startAdmin(relay);
    } catch (error) {
      await relay.close();
      throw error;
    }
    const stop = (): void => {
      admin.close();
      void relay.close().catch(() => {
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    return;
  }
  const request: AdminRequest = { command: positionals.slice(0, 2).join(" ") };
  if (positionals[2]) request.id = positionals[2];
  if (values.note !== undefined) request.note = values.note;
  if (values.expires !== undefined) request.expires = values.expires;
  if (values.host !== undefined) request.host = values.host;
  const result = await requestAdmin(
    resolve(values["data-dir"] ?? process.env.NOCTURNE_RELAY_DATA_DIR ?? "./relay-data"),
    request,
  );
  console.log(result.output);
  if (!result.ok) process.exitCode = 1;
}
// npm 装出的 bin 是指向 dist/main.mjs 的符号链接（Windows 是 .cmd 包装），比较前先解析真实路径
function invokedDirectly(entry: string | undefined): boolean {
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}
if (invokedDirectly(process.argv[1])) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "中继命令失败");
    process.exitCode = 1;
  });
}
