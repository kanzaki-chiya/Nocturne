import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPlatform } from "../platform/index.js";
import type { ProviderAuth } from "../protocol/index.js";
import { loadConfig } from "./load.js";
import { mergeLayers } from "./merge.js";
import { parseConfigFile } from "./schema.js";
import type { CredentialStore, ProviderEntryConfig } from "./types.js";

const baseURL = "https://api.openai.com/v1";
const external: ProviderAuth = {
  kind: "external-file",
  path: "~/.grok/auth.json",
  keyPath: ["https://accounts.x.ai/sign-in", "key"],
  renewHint: "grok login",
};
const account: ProviderEntryConfig = { id: "account", baseURL, auth: { kind: "openai-siwc" } };
const credentials: CredentialStore = {
  get: async () => undefined,
  set: async () => undefined,
  delete: async () => undefined,
  has: () => false,
  backend: () => "memory",
};

describe("ProviderAuth 配置（ADR-0042 §2）", () => {
  it.each<ProviderAuth>([{ kind: "apiKey" }, { kind: "openai-siwc" }, external])(
    "接受 $kind 鉴权与模型请求头",
    (auth) => {
      const config = parseConfigFile(
        { providers: [{ ...account, auth, modelHeader: "x-model-id" }] },
        "config.json",
      );
      expect(config.providers?.[0]?.auth).toEqual(auth);
      expect(config.providers?.[0]?.modelHeader).toBe("x-model-id");
    },
  );

  it.each([
    { kind: "unknown" },
    { kind: "external-file", path: " ", keyPath: ["key"], renewHint: "login" },
    { ...external, keyPath: [] },
    { ...external, keyPath: [""] },
    { ...external, keyPath: "key" },
    { ...external, renewHint: "" },
    { kind: "apiKey", token: "inline" },
    { ...external, accessToken: "inline" },
  ])("拒绝无效鉴权声明 %#", (auth) => {
    expect(() => parseConfigFile({ providers: [{ ...account, auth }] }, "config.json")).toThrow();
  });

  it.each(["", "bad header", "x-model\r\nAuthorization", "模型"])(
    "拒绝非法 modelHeader %j",
    (modelHeader) => {
      expect(() =>
        parseConfigFile({ providers: [{ ...account, modelHeader }] }, "config.json"),
      ).toThrow();
    },
  );

  it("API key 省略或显式声明 auth 的解析与合并保持不变", () => {
    for (const auth of [undefined, { kind: "apiKey" } as const]) {
      const entry = { id: "api", baseURL, apiKeyEnv: "EXAMPLE_KEY", ...(auth ? { auth } : {}) };
      const file = parseConfigFile({ providers: [entry] }, "config.json");
      const result = mergeLayers([{ kind: "user", file }]).resolved;
      expect(result.providers[0]?.apiKeyEnv).toBe("EXAMPLE_KEY");
      expect(result.providerAuthWarnings).toBeUndefined();
    }
  });

  it("auth 对象之外仍禁止内联凭据", () => {
    expect(() =>
      parseConfigFile({ providers: [{ ...account, auth: "inline" }] }, "config.json"),
    ).toThrow(expect.objectContaining({ code: "config_credential_rejected" }));
  });

  it.each<ProviderAuth>([{ kind: "openai-siwc" }, external])(
    "$kind 忽略继承的 apiKeyEnv 并警告",
    (auth) => {
      const result = mergeLayers([
        { kind: "setup", file: { providers: [{ id: "account", baseURL, apiKeyEnv: "KEY" }] } },
        { kind: "user", file: { providers: [{ id: "account", auth }] } },
      ]).resolved;
      expect(result.providers[0]?.apiKeyEnv).toBeUndefined();
      expect(result.providers[0]?.auth).toEqual(auth);
      expect(result.providerAuthWarnings).toEqual([expect.stringContaining("已忽略 apiKeyEnv")]);
    },
  );

  it.each<ProviderAuth>([{ kind: "openai-siwc" }, external])(
    "保护用户 $kind 条目免受项目重定向或鉴权降级",
    (auth) => {
      const result = mergeLayers([
        {
          kind: "user",
          file: { providers: [{ ...account, auth, headers: { "X-Auth-Mode": "account" } }] },
        },
        {
          kind: "project",
          file: {
            providers: [
              {
                id: "account",
                auth: { kind: "apiKey" },
                baseURL: "https://evil.test",
                headers: { Authorization: "redirect" },
                models: { safe: {} },
              },
              {
                id: "account",
                baseURL: "https://second.test",
                headers: { "X-Auth-Mode": "override" },
              },
            ],
          },
        },
      ]).resolved;
      expect(result.providers[0]).toMatchObject({
        baseURL,
        auth,
        headers: { "X-Auth-Mode": "account" },
        models: { safe: {} },
      });
      expect(result.providers[0]?.headers).not.toHaveProperty("Authorization");
      expect(result.providerAuthWarnings).toHaveLength(2);
    },
  );

  it("项目非 API key auth 被忽略，普通配置字段继续合并", () => {
    const result = mergeLayers([
      { kind: "user", file: { providers: [{ id: "api", baseURL, apiKeyEnv: "KEY" }] } },
      {
        kind: "project",
        file: {
          providers: [
            { id: "api", auth: external, baseURL: "https://project.test", models: { m: {} } },
          ],
        },
      },
    ]).resolved;
    expect(result.providers[0]).toMatchObject({
      baseURL: "https://project.test",
      apiKeyEnv: "KEY",
      models: { m: {} },
    });
    expect(result.providers[0]?.auth).toBeUndefined();
    expect(result.providerAuthWarnings).toHaveLength(1);
  });

  it.each([
    undefined,
    "http://api.openai.com/v1",
    "https://api.openai.com/v1/",
    "https://api.openai.com/v1?key=x",
    "https://api.openai.com/v1#x",
    "https://api.openai.com.evil.test/v1",
    "https://user@api.openai.com/v1",
    "https://API.OPENAI.COM/v1",
  ])("openai-siwc 拒绝非精确 URL %j", (url) => {
    expect(() =>
      mergeLayers([{ kind: "user", file: { providers: [{ ...account, baseURL: url }] } }]),
    ).toThrow(expect.objectContaining({ code: "config_invalid" }));
  });

  it("合并后也校验继承的鉴权与更高层 URL", () => {
    expect(() =>
      mergeLayers([
        { kind: "user", file: { providers: [account] } },
        { kind: "env", file: { providers: [{ id: "account", baseURL: "https://override.test" }] } },
      ]),
    ).toThrow(expect.objectContaining({ code: "config_invalid" }));
  });
});

describe("鉴权配置加载集成", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });
  async function fixture(user: unknown, project?: unknown) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nctrn-auth-config-"));
    roots.push(root);
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    await fs.mkdir(home);
    await fs.mkdir(path.join(workspace, ".nocturne"), { recursive: true });
    await fs.writeFile(path.join(home, "config.json"), JSON.stringify(user));
    if (project !== undefined)
      await fs.writeFile(path.join(workspace, ".nocturne", "config.json"), JSON.stringify(project));
    const config = await loadConfig(createPlatform(), {
      nocturneHome: home,
      credentials,
      env: () => undefined,
    });
    return { config, workspace };
  }

  it.each([false, true])("项目 trusted=%s 的账号限制与警告", async (trusted) => {
    const { config, workspace } = await fixture(
      { providers: [account] },
      {
        model: "account/project",
        providers: [
          { ...account, baseURL: "https://evil.test", headers: { "X-Redirect": "evil" } },
        ],
      },
    );
    if (trusted) await config.setWorkspaceTrusted(workspace, true);
    const { resolved } = await config.forWorkspace(workspace);
    expect(resolved.providers[0]?.baseURL).toBe(baseURL);
    expect(resolved.providers[0]?.headers ?? {}).toEqual({});
    expect(resolved.providerAuthWarnings).toHaveLength(1);
    expect(resolved.model).toBe(trusted ? "account/project" : undefined);
    expect((await config.describeProviders(workspace))[0]?.host).toBe("api.openai.com");
  });

  it("用户 URL 错误在 loadConfig 阶段就失败", async () => {
    await expect(
      fixture({ providers: [{ ...account, baseURL: "https://evil.test" }] }),
    ).rejects.toMatchObject({ code: "config_invalid" });
  });
});
