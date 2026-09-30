import * as http from "node:http";

interface ProxyApi {
  setGlobalProxyFromEnv?: (env: NodeJS.ProcessEnv) => unknown;
}

/** Explicit process-entry initialization; importing Core never changes global agents. */
export function configureEnvProxy(
  env: NodeJS.ProcessEnv = process.env,
  api: ProxyApi = http as ProxyApi,
): string | undefined {
  if (env.NODE_USE_ENV_PROXY === "1") return;
  const variables = [
    ["http_proxy", "HTTP_PROXY"],
    ["https_proxy", "HTTPS_PROXY"],
  ]
    .map((names) => names.find((name) => Boolean(env[name])))
    .filter((name) => name !== undefined);
  if (variables.length === 0) return;
  if (api.setGlobalProxyFromEnv === undefined) {
    return "当前 Node 版本不支持自动使用代理，请升级到 Node 24.14.0 或设置 NODE_USE_ENV_PROXY=1。";
  }
  try {
    api.setGlobalProxyFromEnv(env);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      (error.code !== "ERR_PROXY_INVALID_CONFIG" && error.code !== "UND_ERR_INVALID_ARG")
    ) {
      throw error;
    }
    // Node's error may contain credentials; only return variable names.
    const invalid = variables.filter((name) => {
      const value = env[name];
      const url = URL.parse(value ?? "");
      return (
        url === null ||
        !["http:", "https:"].includes(url.protocol) ||
        (value !== undefined && error.message.includes(value))
      );
    });
    return `代理配置无效：${(invalid.length > 0 ? invalid : variables).join("、")}；请检查代理地址。`;
  }
}
