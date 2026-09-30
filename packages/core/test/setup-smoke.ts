import { configureEnvProxy } from "../src/platform/proxy.js";

// Vitest workers inherit env, but not the config process's global dispatcher.
const proxyWarning = configureEnvProxy();
if (proxyWarning !== undefined) process.stderr.write(`! ${proxyWarning}\n`);
