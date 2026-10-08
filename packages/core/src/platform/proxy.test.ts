import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import * as http from "node:http";
import { connect } from "node:net";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureEnvProxy } from "./proxy.js";
import { createProcessCleanup } from "../../../../scripts/test/process-cleanup.mjs";

const processes = createProcessCleanup();
afterEach(async () => {
  await processes.cleanup();
});

describe("configureEnvProxy", () => {
  it("leaves Node's startup proxy configuration alone", () => {
    const setGlobalProxyFromEnv = vi.fn();
    expect(
      configureEnvProxy(
        { NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: "http://127.0.0.1:7897" },
        { setGlobalProxyFromEnv },
      ),
    ).toBeUndefined();
    expect(setGlobalProxyFromEnv).not.toHaveBeenCalled();
  });

  it.each([{}, { NO_PROXY: "127.0.0.1" }, { HTTP_PROXY: "", HTTPS_PROXY: "" }])(
    "does nothing without a proxy address: %j",
    (env) => {
      const setGlobalProxyFromEnv = vi.fn();
      expect(configureEnvProxy(env, { setGlobalProxyFromEnv })).toBeUndefined();
      expect(setGlobalProxyFromEnv).not.toHaveBeenCalled();
      expect(configureEnvProxy(env, {})).toBeUndefined();
    },
  );

  it.each(["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"])(
    "passes %s and bypass settings to Node exactly once",
    (name) => {
      const env = { [name]: "http://127.0.0.1:7897", NO_PROXY: "127.0.0.1" };
      const setGlobalProxyFromEnv = vi.fn();
      expect(configureEnvProxy(env, { setGlobalProxyFromEnv })).toBeUndefined();
      expect(setGlobalProxyFromEnv).toHaveBeenCalledExactlyOnceWith(env);
    },
  );

  it("warns with the minimum version when the API is unavailable", () => {
    const warning = configureEnvProxy({ HTTPS_PROXY: "http://127.0.0.1:7897" }, {});
    expect(warning).toContain("Node 24.14.0");
    expect(warning).toContain("NODE_USE_ENV_PROXY=1");
  });

  it.each(["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"])(
    "identifies invalid %s without exposing credentials or the address",
    (name) => {
      const value = "invalid://private-user:private-password@proxy.invalid";
      const setGlobalProxyFromEnv = vi.fn(() => {
        throw Object.assign(new Error(`Invalid proxy URL: ${value}`), {
          code: "ERR_PROXY_INVALID_CONFIG",
        });
      });
      const warning = configureEnvProxy(
        { [name]: value, NO_PROXY: "127.0.0.1" },
        { setGlobalProxyFromEnv },
      );
      expect(warning).toContain(name);
      expect(warning).not.toContain("private-user");
      expect(warning).not.toContain("private-password");
      expect(warning).not.toContain("proxy.invalid");
      expect(setGlobalProxyFromEnv).toHaveBeenCalledTimes(1);
    },
  );

  it("does not hide unexpected initialization errors", () => {
    const error = new Error("unexpected");
    expect(() =>
      configureEnvProxy(
        { HTTPS_PROXY: "http://127.0.0.1:7897" },
        {
          setGlobalProxyFromEnv: () => {
            throw error;
          },
        },
      ),
    ).toThrow(error);
  });

  it("also warns when Node's fetch dispatcher rejects the proxy protocol", () => {
    const warning = configureEnvProxy(
      {
        HTTP_PROXY: "http://127.0.0.1:7897",
        HTTPS_PROXY: "invalid://private-user:private-password@proxy.invalid",
      },
      {
        setGlobalProxyFromEnv: () => {
          throw Object.assign(new Error("Invalid URL protocol"), { code: "UND_ERR_INVALID_ARG" });
        },
      },
    );
    expect(warning).toBe("代理配置无效：HTTPS_PROXY；请检查代理地址。");
  });

  it("reports the effective lowercase variable when both cases are set", () => {
    const warning = configureEnvProxy(
      { https_proxy: "invalid://proxy.invalid", HTTPS_PROXY: "http://127.0.0.1:7897" },
      {
        setGlobalProxyFromEnv: () => {
          throw Object.assign(new Error("Invalid URL protocol"), { code: "UND_ERR_INVALID_ARG" });
        },
      },
    );
    expect(warning).toBe("代理配置无效：https_proxy；请检查代理地址。");
  });
});

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing server port");
  return address.port;
}

it.skipIf(!("setGlobalProxyFromEnv" in http))(
  "routes child-process fetch through a loopback proxy and honors NO_PROXY",
  async () => {
    const requests: string[] = [];
    const proxyRequests: string[] = [];
    const origin = createServer((req, res) => {
      requests.push(req.url ?? "");
      res.end("local-ok");
    });
    const proxy = createServer();
    const originPort = await listen(origin);
    proxy.on("connect", (req, socket, head) => {
      proxyRequests.push(req.url ?? "");
      // Even the fictitious destination is forwarded only to our loopback origin.
      const upstream = connect(originPort, "127.0.0.1", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
      socket.on("close", () => upstream.destroy());
    });
    try {
      const proxyPort = await listen(proxy);
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !/^(https?_proxy|no_proxy|node_use_env_proxy|node_options)$/i.test(key),
        ),
      );
      env.HTTP_PROXY = `http://127.0.0.1:${proxyPort}`;
      const moduleUrl = new URL("./proxy.ts", import.meta.url).href;
      const run = promisify(execFile);
      const fetchInChild = (url: string, noProxy: string) => {
        const result = run(
          process.execPath,
          [
            "--input-type=module",
            "--eval",
            `import { configureEnvProxy } from ${JSON.stringify(moduleUrl)};
             const warning = configureEnvProxy();
             if (warning) throw new Error(warning);
             const response = await fetch(${JSON.stringify(url)}, { signal: AbortSignal.timeout(5000) });
             console.log(await response.text());`,
          ],
          { env: { ...env, NO_PROXY: noProxy }, timeout: 8000 },
        );
        processes.trackChild(result.child);
        return result;
      };

      const proxied = await fetchInChild("http://proxy-target.invalid/via-proxy", "");
      expect(proxied.stdout.trim()).toBe("local-ok");
      expect(proxyRequests).toEqual(["proxy-target.invalid:80"]);
      const direct = await fetchInChild(`http://127.0.0.1:${originPort}/direct`, "127.0.0.1");
      expect(direct.stdout.trim()).toBe("local-ok");
      expect(proxyRequests).toEqual(["proxy-target.invalid:80"]);
      expect(requests).toEqual(["/via-proxy", "/direct"]);
    } finally {
      origin.closeAllConnections();
      proxy.closeAllConnections();
      await Promise.all([
        promisify(origin.close.bind(origin))(),
        promisify(proxy.close.bind(proxy))(),
      ]);
    }
  },
  15_000,
);
