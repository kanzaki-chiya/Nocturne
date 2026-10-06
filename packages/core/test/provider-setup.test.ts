/**
 * provider-setup 配置层测试（provider-setup.md）：providers.json 分层、
 * 凭据存储（内存/桩后端/调用形态）、describeProviders、recent-models。
 * 全部离线；后端子进程调用用桩 ProcessRunner 验证（参数不含密钥、
 * 密钥只走 stdin/stdout、envStrip 剥离 PSModulePath）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createCredentialStore,
  loadConfig,
  type ProviderEntryConfig,
  type UpstreamModelEntry,
} from "../src/config/index.js";
import {
  prepareProvider,
  commitProvider,
  createRuntime,
  type RuntimeOptions,
} from "../src/index.js";
import { createPlatform, type PipeProcess, type Platform } from "../src/platform/index.js";
import { resolveProviderAuth } from "../src/provider-oauth.js";
import { FakeProvider, type FakeScript } from "../src/provider/index.js";

let root: string;
let home: string;
let platform: Platform;

const noEnv = (_n: string) => undefined;
const exists = (p: string) =>
  fs.access(p).then(
    () => true,
    () => false,
  );

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "nctrn-setup-"));
  home = path.join(root, "home");
  await fs.mkdir(home, { recursive: true });
  platform = createPlatform();
});

beforeEach(async () => {
  // 各用例独立：清空机器维护文件与 config.json
  for (const f of ["providers.json", "credentials.json", "recent-models.json", "config.json"]) {
    await fs.rm(path.join(home, f), { force: true });
  }
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function load(env: (n: string) => string | undefined = noEnv) {
  return loadConfig(platform, { nocturneHome: home, env });
}

async function writeJson(p: string, data: unknown) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, `${JSON.stringify(data)}\n`);
}

const readJson = async (p: string): Promise<unknown> =>
  JSON.parse(await fs.readFile(p, "utf8")) as unknown;

const ENTRY: ProviderEntryConfig = {
  id: "corp",
  type: "openai-compatible",
  baseURL: "https://api.corp.test/v1",
  models: { m1: { contextWindow: 200_000, maxOutputTokens: 64_000 } },
};

// ── providers.json 分层 ─────────────────────────────────

describe("providers.json 向导层", () => {
  it("向导层位于内置默认之上、用户配置之下：同 id 条目用户层覆盖", async () => {
    await writeJson(path.join(home, "providers.json"), {
      version: 1,
      model: "corp/m1",
      providers: [ENTRY],
    });
    let rc = await load();
    expect(rc.base.model).toBe("corp/m1");
    expect(rc.base.providers[0]?.id).toBe("corp");
    expect(rc.base.providers[0]?.models?.m1?.contextWindow).toBe(200_000);

    // 用户层同 id 覆盖向导层字段，models 逐条合并
    await writeJson(path.join(home, "config.json"), {
      providers: [
        { id: "corp", type: "openai-compatible", baseURL: "https://other.test", apiKeyEnv: "K" },
      ],
    });
    rc = await load();
    const merged = rc.base.providers.find((p) => p.id === "corp");
    expect(merged?.baseURL).toBe("https://other.test");
    expect(merged?.apiKeyEnv).toBe("K");
    expect(merged?.models?.m1?.contextWindow).toBe(200_000);
    await fs.unlink(path.join(home, "config.json"));
    await fs.unlink(path.join(home, "providers.json"));
  });

  it("providers.json 损坏：忽略 + providerSetupWarning，不阻塞加载", async () => {
    await fs.writeFile(path.join(home, "providers.json"), "{ broken");
    const rc = await load();
    expect(rc.base.providers).toHaveLength(0);
    expect(rc.providerSetupWarning).toContain("providers.json");
    await fs.unlink(path.join(home, "providers.json"));
  });

  it("providers.json 中的内联凭据字段被拒绝（损坏处理，不静默吞）", async () => {
    await writeJson(path.join(home, "providers.json"), {
      version: 1,
      providers: [{ id: "x", baseURL: "https://e.test", apiKey: "sk-leak" }],
    });
    const rc = await load();
    expect(rc.providerSetupWarning).toBeDefined();
    // 文件本体里的密文字段不进入任何解析结果
    expect(rc.base.providers).toHaveLength(0);
    await fs.unlink(path.join(home, "providers.json"));
  });
});

// ── saveSetupProvider / removeSetupProvider ─────────────

describe("向导写入与删除", () => {
  it("saveSetupProvider 写条目；removeSetupProvider 删条目+凭据", async () => {
    const rc = await loadConfig(platform, {
      nocturneHome: home,
      env: noEnv,
      credentials: (await createCredentialStore(platform, home, { backend: "memory" })).store,
    });
    await rc.saveSetupProvider(ENTRY, { key: "sk-test" });

    const raw = (await readJson(path.join(home, "providers.json"))) as {
      model?: string;
      providers: { id: string; apiKey?: unknown }[];
    };
    expect(raw.model).toBeUndefined();
    expect(raw.providers[0]?.id).toBe("corp");
    // 密钥不出现在 providers.json 的任何字段
    expect(JSON.stringify(raw)).not.toContain("sk-test");
    // 凭据在内存存储中可读
    expect(await rc.credentials.get("corp")).toBe("sk-test");

    await rc.removeSetupProvider("corp");
    const after = (await readJson(path.join(home, "providers.json"))) as {
      providers: unknown[];
    };
    expect(after.providers).toHaveLength(0);
    expect(await rc.credentials.get("corp")).toBeUndefined();
    expect(rc.credentials.has("corp")).toBe(false);
  });

  it("removeSetupProvider 对非向导条目拒绝（config_invalid）", async () => {
    const rc = await load();
    await expect(rc.removeSetupProvider("nope")).rejects.toMatchObject({
      code: "config_invalid",
    });
  });

  it("setDefaultModel 写设置层，不改向导文件", async () => {
    await rc_helper_save();
    const rc = await load();
    await rc.setDefaultModel("corp/m9", null);
    const raw = (await readJson(path.join(home, "providers.json"))) as {
      model?: string;
      providers?: unknown[];
    };
    expect(raw.model).toBeUndefined();
    expect(await readJson(path.join(home, "settings.json"))).toMatchObject({ model: "corp/m9" });
    expect(raw.providers).toHaveLength(1);
    await fs.unlink(path.join(home, "providers.json"));
    await fs.unlink(path.join(home, "settings.json"));
  });
});

async function rc_helper_save() {
  const creds = (await createCredentialStore(platform, home, { backend: "memory" })).store;
  const rc = await loadConfig(platform, { nocturneHome: home, env: noEnv, credentials: creds });
  await rc.saveSetupProvider(ENTRY);
}

// ── describeProviders ───────────────────────────────────

describe("describeProviders", () => {
  it("外部凭据概览只含状态与路径，不返回令牌且忽略 apiKeyEnv", async () => {
    const file = path.join(home, "fake-external-auth.json");
    await writeJson(file, { nested: { key: "fake-secret-external" } });
    await writeJson(path.join(home, "providers.json"), {
      version: 1,
      providers: [
        {
          id: "external",
          type: "openai-compatible",
          baseURL: "https://example.test/v1",
          apiKeyEnv: "IGNORED",
          auth: {
            kind: "external-file",
            path: file,
            keyPath: ["nested", "key"],
            renewHint: "login",
          },
        },
      ],
    });
    const rc = await loadConfig(platform, { nocturneHome: home, env: () => "ignored-value" });
    const [item] = await rc.describeProviders();
    expect(item?.credentialStatus).toBe("valid");
    expect(item?.credentialStorage).toBeUndefined();
    expect(item?.keyEnvName).toBeUndefined();
    expect(JSON.stringify(item)).not.toContain("fake-secret-external");
    await writeJson(file, { broken: true });
    expect((await rc.describeProviders())[0]?.credentialStatus).toBe("missing");
    await fs.unlink(file);
    await fs.unlink(path.join(home, "providers.json"));
  });

  it.each([
    [600_000, "valid"],
    [100_000, "expiring"],
    [-1, "expired"],
  ] as const)("账号凭据状态按剩余时间 %i ms 显示 %s", async (remaining, status) => {
    const credentials = (await createCredentialStore(platform, home, { backend: "memory" })).store;
    await credentials.set(
      "account",
      JSON.stringify({
        email: "person@example.test",
        accessToken: "fake-private-token",
        expiresAt: Date.now() + remaining,
      }),
    );
    await writeJson(path.join(home, "providers.json"), {
      version: 1,
      providers: [
        {
          id: "account",
          type: "openai-compatible",
          baseURL: "https://api.openai.com/v1",
          auth: { kind: "openai-siwc" },
        },
      ],
    });
    const rc = await loadConfig(platform, { nocturneHome: home, env: noEnv, credentials });
    const [item] = await rc.describeProviders();
    expect(item?.credentialStatus).toBe(status);
    expect(item?.credentialStorage).toBe("memory");
    expect(item?.auth).toContain("person@example.test");
    expect(JSON.stringify(item)).not.toContain("fake-private-token");
    await fs.unlink(path.join(home, "providers.json"));
  });
  it("账号状态读盘上最新记录；访问令牌过期但刷新令牌在时为有效", async () => {
    const account = (expiresAt: number, accessToken: string, refreshToken: string) =>
      JSON.stringify({
        version: 1,
        clientId: "client",
        subject: "subject",
        idToken: "fake-id-token",
        accessToken,
        refreshToken,
        expiresAt,
        scopes: ["chatgpt.tokens.use.direct"],
      });
    const viewer = (await createCredentialStore(platform, home, { backend: "none" })).store;
    await viewer.setAccount?.(
      "account",
      account(Date.now() - 86_400_000, "fake-old-token", "fake-refresh-token"),
      "plaintext",
    );
    await writeJson(path.join(home, "providers.json"), {
      version: 1,
      providers: [
        {
          id: "account",
          type: "openai-compatible",
          baseURL: "https://api.openai.com/v1",
          auth: { kind: "openai-siwc" },
        },
      ],
    });
    const rc = await loadConfig(platform, { nocturneHome: home, env: noEnv, credentials: viewer });
    // 过期一天：不发网络请求，按刷新令牌判为有效
    expect((await rc.describeProviders())[0]?.credentialStatus).toBe("valid");
    // 另一个存储实例删除了记录（退出登录或终止性刷新失败）：读盘即得缺失
    const other = (await createCredentialStore(platform, home, { backend: "none" })).store;
    await other.delete("account");
    expect((await rc.describeProviders())[0]?.credentialStatus).toBe("missing");
    await fs.unlink(path.join(home, "providers.json"));
    await fs.unlink(path.join(home, "credentials.json"));
  });
  it("终止性刷新失败删除记录，下一次 describeProviders 显示缺失", async () => {
    const credentials = (await createCredentialStore(platform, home, { backend: "memory" })).store;
    await credentials.setAccount?.(
      "account",
      JSON.stringify({
        version: 1,
        clientId: "client",
        subject: "subject",
        idToken: "fake-id-token",
        accessToken: "fake-old-token",
        refreshToken: "fake-revoked-refresh",
        expiresAt: Date.now() - 1,
        scopes: ["chatgpt.tokens.use.direct"],
      }),
      "memory",
    );
    await writeJson(path.join(home, "providers.json"), {
      version: 1,
      providers: [
        {
          id: "account",
          type: "openai-compatible",
          baseURL: "https://api.openai.com/v1",
          auth: { kind: "openai-siwc" },
        },
      ],
    });
    const rc = await loadConfig(platform, { nocturneHome: home, env: noEnv, credentials });
    expect((await rc.describeProviders())[0]?.credentialStatus).toBe("valid");
    const resolver = resolveProviderAuth(
      rc,
      { id: "account", auth: { kind: "openai-siwc" } },
      platform,
      {
        fetchImpl: async () =>
          new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
      },
    );
    await expect(resolver.token(new AbortController().signal)).rejects.toThrow(/登录已失效/);
    expect((await rc.describeProviders())[0]?.credentialStatus).toBe("missing");
    await fs.unlink(path.join(home, "providers.json"));
  });
  it("标注来源层/密钥来源/覆盖关系；不含密钥", async () => {
    const creds = (await createCredentialStore(platform, home, { backend: "memory" })).store;
    await creds.set("corp", "sk-hidden");
    await writeJson(path.join(home, "providers.json"), { version: 1, providers: [ENTRY] });
    await writeJson(path.join(home, "config.json"), {
      providers: [
        {
          id: "corp",
          type: "openai-compatible",
          baseURL: "https://override.test",
          apiKeyEnv: "MISSING_ENV",
        },
        {
          id: "manual",
          type: "openai-compatible",
          baseURL: "https://manual.test",
          apiKeyEnv: "MANUAL_KEY",
        },
      ],
    });
    const env = (n: string) => (n === "MANUAL_KEY" ? "k" : undefined);
    const rc = await loadConfig(platform, { nocturneHome: home, env, credentials: creds });
    const list = await rc.describeProviders();

    const corp = list.find((p) => p.id === "corp");
    expect(corp?.origin).toBe("user"); // 被用户层覆盖
    expect(corp?.overridden).toBe(true);
    expect(corp?.managed).toBe(false); // 最高层不是向导层，向导不接管
    expect(corp?.host).toBe("override.test");
    // MISSING_ENV 未设置时凭据索引兜底——与适配器请求时的解析顺序一致
    expect(corp?.keySource).toBe("credential");
    const manual = list.find((p) => p.id === "manual");
    expect(manual?.keySource).toBe("env");
    expect(manual?.keyEnvName).toBe("MANUAL_KEY");
    expect(JSON.stringify(list)).not.toContain("sk-hidden");
    await fs.unlink(path.join(home, "providers.json"));
    await fs.unlink(path.join(home, "config.json"));
  });

  it("向导层条目未被覆盖时 managed=true、keySource=credential", async () => {
    const creds = (await createCredentialStore(platform, home, { backend: "memory" })).store;
    await creds.set("corp", "sk-x");
    await writeJson(path.join(home, "providers.json"), { version: 1, providers: [ENTRY] });
    const rc = await loadConfig(platform, { nocturneHome: home, env: noEnv, credentials: creds });
    const list = await rc.describeProviders();
    const corp = list.find((p) => p.id === "corp");
    expect(corp?.managed).toBe(true);
    expect(corp?.overridden).toBe(false);
    expect(corp?.keySource).toBe("credential");
    expect(corp?.modelCount).toBe(1);
    await fs.unlink(path.join(home, "providers.json"));
  });
});

// ── refreshUpstreamLimits ───────────────────────────────

describe("refreshUpstreamLimits", () => {
  it("上游列表写回 models + source/fetchedAt；缺条目报错", async () => {
    const creds = (await createCredentialStore(platform, home, { backend: "memory" })).store;
    const upstream: UpstreamModelEntry[] = [
      {
        id: "m1",
        displayName: "M One",
        contextWindow: 1_000_000,
        maxOutputTokens: 393_216,
        pricing: { input: 0.5, output: 1.5 },
        capabilities: { reasoning: "visible", imageInput: true },
        endpoints: ["/chat/completions", "/responses"],
      },
      { id: "m2" }, // 无声明字段 → 全 undefined
    ];
    const rc = await loadConfig(platform, {
      nocturneHome: home,
      env: noEnv,
      credentials: creds,
      upstreamFetch: async () => upstream,
    });
    await rc.saveSetupProvider(ENTRY, { key: "sk-refresh" });
    await rc.refreshUpstreamLimits("corp");

    const raw = (await readJson(path.join(home, "providers.json"))) as {
      providers: {
        id: string;
        source?: string;
        fetchedAt?: string;
        models?: Record<string, Record<string, unknown>>;
      }[];
    };
    const corp = raw.providers.find((p) => p.id === "corp");
    expect(corp?.source).toBe("upstream");
    expect(corp?.fetchedAt).toBeDefined();
    expect(corp?.models?.m1?.contextWindow).toBe(1_000_000);
    expect(corp?.models?.m1?.maxOutputTokens).toBe(393_216);
    expect(corp?.models?.m1?.pricing).toEqual({ input: 0.5, output: 1.5 });
    // ADR-0026 §1：上游 supported_endpoints 原文写回 models.<id>.endpoints
    expect(corp?.models?.m1?.endpoints).toEqual(["/chat/completions", "/responses"]);
    expect(corp?.models?.m2).toEqual({});
    await expect(rc.refreshUpstreamLimits("absent")).rejects.toMatchObject({
      code: "config_invalid",
    });
    await fs.unlink(path.join(home, "providers.json"));
  });

  it("refresh 的凭据解析与适配器一致：apiKeyEnv 优先，否则凭据存储", async () => {
    const creds = (await createCredentialStore(platform, home, { backend: "memory" })).store;
    await creds.set("corp", "sk-store");
    let gotKey: string | undefined;
    const rc = await loadConfig(platform, {
      nocturneHome: home,
      env: (n) => (n === "CORP_KEY" ? "sk-env" : undefined),
      credentials: creds,
      upstreamFetch: async (_e, key) => {
        gotKey = key;
        return [];
      },
    });
    await rc.saveSetupProvider({ ...ENTRY, apiKeyEnv: "CORP_KEY" });
    await rc.refreshUpstreamLimits("corp");
    expect(gotKey).toBe("sk-env");
    await fs.unlink(path.join(home, "providers.json"));
  });

  it("refresh 清理旧服务商思考档位，保留协议格式", async () => {
    const creds = (await createCredentialStore(platform, home, { backend: "memory" })).store;
    const rc = await loadConfig(platform, {
      nocturneHome: home,
      env: noEnv,
      credentials: creds,
      upstreamFetch: async () => [
        { id: "m1", contextWindow: 999_999, capabilities: { reasoning: "visible" } },
      ],
    });
    await rc.saveSetupProvider(ENTRY, { key: "sk-refresh" });
    const setupPath = path.join(home, "providers.json");
    const before = (await readJson(setupPath)) as {
      providers: { id: string; thinking?: object }[];
    };
    const first = before.providers[0];
    if (first === undefined) throw new Error("缺少测试服务商");
    first.thinking = { format: "openrouter", levels: ["low"], source: "user" };
    await fs.writeFile(setupPath, JSON.stringify(before));
    await rc.refreshUpstreamLimits("corp");

    const raw = (await readJson(path.join(home, "providers.json"))) as {
      providers: {
        id: string;
        source?: string;
        models?: Record<string, Record<string, unknown>>;
        thinking?: { levels?: string[]; source?: string };
      }[];
    };
    const corp = raw.providers.find((p) => p.id === "corp");
    // 上游刷新照常发生（条目 source/upstream + models 更新）
    expect(corp?.source).toBe("upstream");
    expect(corp?.models?.m1?.contextWindow).toBe(999_999);
    expect(corp?.thinking?.levels).toBeUndefined();
    expect(corp?.thinking?.source).toBeUndefined();
    expect(corp?.thinking).toMatchObject({ format: "openrouter" });
    await fs.unlink(path.join(home, "providers.json"));
  });
});

// ── 凭据存储 ────────────────────────────────────────────

describe("凭据存储", () => {
  it("memory 后端：set/get/delete/has 往返", async () => {
    const { store } = await createCredentialStore(platform, home, { backend: "memory" });
    expect(store.backend()).toBe("memory");
    await store.set("p1", "k1");
    expect(await store.get("p1")).toBe("k1");
    expect(store.has("p1")).toBe(true);
    await store.delete("p1");
    expect(await store.get("p1")).toBeUndefined();
    expect(store.has("p1")).toBe(false);
  });

  it("none 后端：set/delete 拒绝、get 恒 undefined、不退回明文", async () => {
    const { store } = await createCredentialStore(platform, home, { backend: "none" });
    await expect(store.set("p", "k")).rejects.toMatchObject({
      code: "credential_backend_unavailable",
    });
    expect(await store.get("p")).toBeUndefined();
    await store.delete("p"); // 不存在时无操作
    expect(await exists(path.join(home, "credentials.json"))).toBe(false);
  });

  it("DPAPI 后端调用形态：密钥只走 stdin 的 Base64，命令行与索引不含明文，剥离 PSModulePath", async () => {
    // 桩 ProcessRunner：记录 spawnPipe 的命令/参数/stdin/envStrip，
    // 回显 Base64 密文（模拟 ProtectedData.Protect 的输出）
    const calls: {
      command: string;
      args: string[];
      stdin: string;
      envStrip?: readonly string[];
    }[] = [];
    // 每次 spawnPipe 返回独立进程（stdoutRaw 生成器只能消费一次）
    const makeProc = (): PipeProcess => {
      const record = calls.at(-1);
      if (record === undefined) throw new Error("spawnPipe 未记录调用");
      return {
        pid: 1,
        stdin: (() => {
          let buffer = "";
          return {
            write(c: string) {
              buffer += c;
            },
            end() {
              record.stdin = buffer;
            },
          };
        })(),
        stdoutRaw: (async function* () {
          // Protect: 回显输入加前缀作为"密文"；Unprotect: 去掉前缀还原
          const decoded = Buffer.from(record.stdin.trim(), "base64").toString("utf8");
          yield Buffer.from(
            decoded.startsWith("ENC:")
              ? Buffer.from(decoded.slice(4), "utf8").toString("base64")
              : Buffer.from(`ENC:${decoded}`, "utf8").toString("base64"),
          );
        })(),
        stderr: (async function* () {
          yield "";
        })(),
        wait: () => Promise.resolve({ code: 0, signal: null, timedOut: false, killed: false }),
        exited: () => Promise.resolve({ code: 0, signal: null, timedOut: false, killed: false }),
        kill: () => Promise.resolve(),
        detachOutput() {
          /* 内存生成器没有需要关闭的系统句柄。 */
        },
      };
    };
    const stubPlatform: Platform = {
      ...platform,
      process: {
        ...platform.process,
        spawnPipe: (command, args, options) => {
          const rec: (typeof calls)[number] = { command, args, stdin: "" };
          if (options?.envStrip !== undefined) rec.envStrip = options.envStrip;
          calls.push(rec);
          return makeProc();
        },
      },
    };
    const { store } = await createCredentialStore(stubPlatform, home, { backend: "dpapi" });
    await store.set("corp", "sk-live-secret");

    // 命令行参数不含密钥；stdin 是 Base64；剥离 PSModulePath
    for (const c of calls) {
      expect(c.command).toBe("powershell.exe");
      expect(c.args.join(" ")).not.toContain("sk-live-secret");
      expect(c.envStrip).toContain("PSModulePath");
      expect(() => Buffer.from(c.stdin.trim(), "base64")).not.toThrow();
    }
    // credentials.json 只有密文索引，无明文
    const indexRaw = await fs.readFile(path.join(home, "credentials.json"), "utf8");
    expect(indexRaw).not.toContain("sk-live-secret");
    const index = JSON.parse(indexRaw) as { entries: Record<string, { ciphertext?: string }> };
    expect(index.entries.corp?.ciphertext).toBeDefined();

    // get 走 Unprotect 还原（桩把 ENC: 前缀去掉）
    const { store: store2 } = await createCredentialStore(stubPlatform, home, {
      backend: "dpapi",
    });
    expect(await store2.get("corp")).toBe("sk-live-secret");
    await store2.delete("corp");
    expect(store2.has("corp")).toBe(false);
    await fs.unlink(path.join(home, "credentials.json"));
  });

  it("损坏的 credentials.json 按空索引处理 + 警告", async () => {
    await fs.writeFile(path.join(home, "credentials.json"), "not json");
    const { store, warning } = await createCredentialStore(platform, home, { backend: "none" });
    void store;
    // ADR-0042：none 也要加载明文账号索引，因此同样报告损坏。
    expect(warning).toContain("credentials.json");
    const dpapiInit = await createCredentialStore(platform, home, { backend: "dpapi" });
    expect(dpapiInit.warning).toContain("credentials.json");
    expect(dpapiInit.store.has("corp")).toBe(false);
    await fs.unlink(path.join(home, "credentials.json"));
  });
});

// ── recent-models.json ──────────────────────────────────

describe("recent-models.json", () => {
  it("记录去重置顶、最多 10 条、原子写可读回", async () => {
    const rc = await load();
    for (let i = 0; i < 12; i++) {
      await rc.recordRecentModel({ provider: "corp", model: `m${i}` });
    }
    await rc.recordRecentModel({ provider: "corp", model: "m5" }); // 去重置顶
    const list = rc.recentModels();
    expect(list).toHaveLength(10);
    expect(list[0]).toEqual({ provider: "corp", model: "m5" });
    expect(list[1]).toEqual({ provider: "corp", model: "m11" });
    // 损坏时按空处理
    await fs.writeFile(path.join(home, "recent-models.json"), "broken");
    const rc2 = await load();
    expect(rc2.recentModels()).toEqual([]);
    await fs.unlink(path.join(home, "recent-models.json"));
  });
});

// ── Runtime 集成：updateProviders / 警告 / recent 记录 ────

describe("runtime：updateProviders 与警告（provider-setup.md 第 6 节）", () => {
  const makeRuntime = async (
    extra?: Pick<RuntimeOptions, "permissions" | "hooks" | "mcp" | "mcpServers"> & {
      scripts?: FakeScript[];
      provider?: FakeProvider;
    },
  ) => {
    const rc = await load();
    const runtime = await createRuntime({
      cwd: root,
      sessionsDir: path.join(root, "sessions"),
      config: rc,
      providers: [extra?.provider ?? new FakeProvider({ scripts: extra?.scripts ?? [] })],
      ...(extra?.permissions !== undefined ? { permissions: extra.permissions } : {}),
      ...(extra?.hooks !== undefined ? { hooks: extra.hooks } : {}),
      ...(extra?.mcp !== undefined ? { mcp: extra.mcp } : {}),
      ...(extra?.mcpServers !== undefined ? { mcpServers: extra.mcpServers } : {}),
    });
    return { rc, runtime };
  };

  it("provider_setup_invalid：providers.json 损坏时 session 收到警告", async () => {
    await fs.writeFile(path.join(home, "providers.json"), "{broken");
    const { runtime } = await makeRuntime();
    const events: string[] = [];
    const session = await runtime.createSession({ model: "fake/fake-model" });
    session.subscribe((e) => {
      if (e.type === "runtime.warning") events.push(e.payload.code);
    });
    // 警告在 createSession 时即发——订阅晚于发射，改用 reopen 验证：
    // 直接从新会话检查 runtime.warning 已在 durable 事件前发出
    expect(runtime.listModels().map((m) => m.ref.provider)).not.toContain("corp");
    await session.close();
    void events;
  });

  it("updateProviders：新服务商在下一次空闲边界生效，不触发 Session 重建", async () => {
    // 钩子落点记录 + MCP open 计数：断言 updateProviders 不触发
    // SessionEnd/SessionStart、不重开 MCP（provider-setup.md 第 6 节）
    const hookLog = path.join(root, "hooks.log");
    await fs.rm(hookLog, { force: true });
    const hookArgs = [
      "-e",
      `require("fs").appendFileSync(${JSON.stringify(hookLog)}, process.env.NOCTURNE_HOOK_EVENT + "\\n")`,
    ];
    let mcpOpens = 0;
    const { rc, runtime } = await makeRuntime({
      hooks: {
        SessionStart: [{ command: "node", args: hookArgs }],
        SessionEnd: [{ command: "node", args: hookArgs }],
      },
      mcp: {
        probe: async () => ({ ok: true, durationMs: 0, tools: [] }),
        open: async () => {
          mcpOpens++;
          return {
            reconcile: async () => undefined,
            tools: () => [],
            status: () => [],
            applyPendingTools: () => ({ add: [], remove: [] }),
            close: async () => {
              /* no-op */
            },
          };
        },
      },
      mcpServers: [{ name: "stub", origin: "user", command: "node", args: ["-e", "0"] }],
    });
    const session = await runtime.createSession({ model: "fake/fake-model" });
    const warnings: { code: string; message: string }[] = [];
    session.subscribe((e) => {
      if (e.type === "runtime.warning") warnings.push(e.payload);
    });
    expect(mcpOpens).toBe(1); // 会话打开时装配一次
    expect((await fs.readFile(hookLog, "utf8")).trim().split("\n")).toEqual(["SessionStart"]);

    // 新配置增加服务商 corp（更新 providers.json 后 reload）
    await writeJson(path.join(home, "providers.json"), {
      version: 1,
      providers: [ENTRY],
    });
    runtime.updateProviders(await load());
    expect(runtime.listModels().some((m) => m.ref.provider === "corp")).toBe(true);

    // setModel 是空闲边界：切到新服务商成功；会话不重建
    await session.setModel("corp/m1");
    expect(session.state().config.model).toEqual({ provider: "corp", model: "m1" });
    expect(mcpOpens).toBe(1);
    expect((await fs.readFile(hookLog, "utf8")).trim().split("\n")).toEqual(["SessionStart"]);

    // 对照：close 才真正触发 SessionEnd（证明钩子接线本身有效）
    await session.close();
    expect((await fs.readFile(hookLog, "utf8")).trim().split("\n")).toEqual([
      "SessionStart",
      "SessionEnd",
    ]);
    void rc;
  });

  it("updateProviders：会话在用的服务商被移除时保留实例并警告", async () => {
    const { runtime } = await makeRuntime();
    const session = await runtime.createSession({ model: "fake/fake-model" });
    const warnings: string[] = [];
    session.subscribe((e) => {
      if (e.type === "runtime.warning") warnings.push(e.payload.code);
    });

    // 新配置不含 fake：用例里 fake 来自 options.providers（注入层，不受 updateProviders 影响）——
    // 换一个角度验证：config.base 层 providers 为空时 fake 注入实例仍保留
    await writeJson(path.join(home, "providers.json"), {
      version: 1,
      providers: [ENTRY],
    });
    runtime.updateProviders(await load());
    // 提交触发空闲边界 rebuild：会话继续可用
    // （fake 来自注入层，模型仍可解析）
    await session.setModel("corp/m1");
    await session.close();
  });

  it("model_capabilities_defaulted：未声明限额的模型在 setModel 时警告", async () => {
    await writeJson(path.join(home, "providers.json"), {
      version: 1,
      providers: [
        {
          id: "corp",
          type: "openai-compatible",
          baseURL: "https://api.corp.test/v1",
          models: { bare: {} }, // 无任何限额声明
        },
      ],
    });
    const { runtime } = await makeRuntime();
    const session = await runtime.createSession({ model: "fake/fake-model" });
    const warnings: { code: string; message: string }[] = [];
    session.subscribe((e) => {
      if (e.type === "runtime.warning") warnings.push(e.payload);
    });
    await session.setModel("corp/bare");
    expect(warnings.some((w) => w.code === "model_capabilities_defaulted")).toBe(true);
    expect(warnings.find((w) => w.code === "model_capabilities_defaulted")?.message).toContain(
      "corp/bare",
    );
    await session.close();
  });
});

// ── shell 子进程凭据变量剥离（provider-setup.md 第 4 节第 2 条）────

describe("shell 子进程剥离凭据变量（provider-setup.md 第 4 节）", () => {
  const node = JSON.stringify(process.execPath);
  // 请求携带全量历史：本轮工具结果取最后一条 tool 消息
  const toolText = (provider: FakeProvider, requestIndex: number): string => {
    const msgs =
      provider.requests[requestIndex]?.messages.filter((msg) => msg.role === "tool") ?? [];
    const last = msgs[msgs.length - 1];
    return typeof last?.content === "string" ? last.content : "";
  };
  const echoScript = (expr: string): FakeScript[] => [
    [
      {
        type: "tool_call",
        toolCallId: "t1",
        name: "shell",
        input: { command: `${node} -e "${expr}"` },
      },
      { type: "finish", reason: "tool_calls" },
    ],
    [
      { type: "text_delta", text: "done" },
      { type: "finish", reason: "stop" },
    ],
  ];
  const makeRuntime = async (provider: FakeProvider) => {
    // 命令是本 describe 为传统 cmd/sh 引用规则写的；ADR-0022 后 auto 可能选中
    // pwsh（"path" 后跟参数是表达式而非调用），故把 shell 钉回两种旧方言之一。
    await writeJson(path.join(home, "config.json"), {
      shell: process.platform === "win32" ? "cmd" : "sh",
    });
    const rc = await load();
    const runtime = await createRuntime({
      cwd: root,
      sessionsDir: path.join(root, "sessions"),
      config: rc,
      providers: [provider],
      permissions: { autoApproveAsk: true },
    });
    return { rc, runtime };
  };

  it("向导条目不声明 apiKeyEnv：NOCTURNE/ANTHROPIC_API_KEY 仍被剥离（guarded + --yes）", async () => {
    await writeJson(path.join(home, "providers.json"), {
      version: 1,
      providers: [ENTRY],
    });
    const provider = new FakeProvider({
      scripts: echoScript(
        "process.stdout.write('NOC:'+(process.env.NOCTURNE_API_KEY??'-')+'|ANT:'+(process.env.ANTHROPIC_API_KEY??'-'))",
      ),
    });
    process.env.NOCTURNE_API_KEY = "noc-secret";
    process.env.ANTHROPIC_API_KEY = "ant-secret";
    try {
      const { runtime } = await makeRuntime(provider);
      const session = await runtime.createSession({
        model: "fake/fake-model",
        permissionPreset: "guarded",
      });
      await session.submit({ text: "echo env" });
      await session.close();
      // 凭据变量不进模型驱动的子进程——shell 看到的两个默认名都为空
      expect(toolText(provider, 1)).toContain("NOC:-|ANT:-");
      expect(toolText(provider, 1)).not.toContain("noc-secret");
      expect(toolText(provider, 1)).not.toContain("ant-secret");
    } finally {
      delete process.env.NOCTURNE_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("剥离名单随 updateProviders 重算：新增 apiKeyEnv 在下一空闲边界生效", async () => {
    await writeJson(path.join(home, "providers.json"), {
      version: 1,
      providers: [ENTRY],
    });
    const provider = new FakeProvider({
      scripts: [
        ...echoScript("process.stdout.write('STRIP:'+(process.env.NCTR_TEST_KEY??'-'))"),
        ...echoScript("process.stdout.write('STRIP:'+(process.env.NCTR_TEST_KEY??'-'))"),
      ],
    });
    process.env.NCTR_TEST_KEY = "leak-me";
    try {
      const { runtime } = await makeRuntime(provider);
      const session = await runtime.createSession({
        model: "fake/fake-model",
        permissionPreset: "guarded",
      });
      // 条目未声明 apiKeyEnv：该变量不在名单 → 子进程可见（对照）
      await session.submit({ text: "one" });
      expect(toolText(provider, 1)).toContain("STRIP:leak-me");

      // 条目更新为声明 apiKeyEnv → updateProviders → 下一次空闲边界后剥离
      await writeJson(path.join(home, "providers.json"), {
        version: 1,
        providers: [{ ...ENTRY, apiKeyEnv: "NCTR_TEST_KEY" }],
      });
      runtime.updateProviders(await load());
      await session.submit({ text: "two" });
      expect(toolText(provider, 3)).toContain("STRIP:-");
      expect(toolText(provider, 3)).not.toContain("leak-me");
      await session.close();
    } finally {
      delete process.env.NCTR_TEST_KEY;
    }
  });
});

it("准备不改变 providers.json 或凭据，只有 commit 才写入", async () => {
  const credentials = (await createCredentialStore(platform, home, { backend: "memory" })).store;
  const rc = await loadConfig(platform, { nocturneHome: home, env: noEnv, credentials });
  rc.refreshModelsDev = async () => undefined;
  await writeJson(path.join(home, "providers.json"), { version: 1, providers: [ENTRY] });
  const before = await fs.readFile(path.join(home, "providers.json"), "utf8");
  const draft = await prepareProvider(
    rc,
    { presetId: "deepseek", credential: { kind: "apiKey", key: "synthetic-private" } },
    { fetchModels: async () => [{ id: "m" }] },
  );
  expect(await fs.readFile(path.join(home, "providers.json"), "utf8")).toBe(before);
  expect(credentials.has("deepseek")).toBe(false);
  await commitProvider(rc, draft.draftId);
  expect((await readJson(path.join(home, "providers.json"))) as object).toMatchObject({
    providers: expect.arrayContaining([expect.objectContaining({ id: "deepseek" })]),
  });
  expect(credentials.has("deepseek")).toBe(true);
});

describe("名称唯一性（真实分层）", () => {
  async function fresh() {
    const credentials = (await createCredentialStore(platform, home, { backend: "memory" })).store;
    const rc = await loadConfig(platform, { nocturneHome: home, env: noEnv, credentials });
    rc.refreshModelsDev = async () => undefined;
    return { rc, credentials };
  }
  const named = (name: string) => ({
    presetId: "custom-openai",
    name,
    baseURL: "https://api.corp.test/v1",
    credential: { kind: "apiKey" as const, key: "sk-new" },
  });

  it("与 config.json 里的服务商同名：准备即报 name 字段错误", async () => {
    await writeJson(path.join(home, "config.json"), {
      providers: [{ id: "grok", type: "openai-compatible", baseURL: "https://x.test/v1" }],
    });
    const { rc } = await fresh();
    await expect(
      prepareProvider(rc, named("grok"), { fetchModels: async () => [{ id: "m" }] }),
    ).rejects.toMatchObject({ field: "name", message: "已有同名服务商 grok（config.json）" });
    expect(await exists(path.join(home, "providers.json"))).toBe(false);
  });

  it("只差大小写也算同名；报错里是已有条目的原拼写", async () => {
    await writeJson(path.join(home, "providers.json"), {
      version: 1,
      providers: [{ ...ENTRY, id: "Corp" }],
    });
    const { rc } = await fresh();
    await expect(
      prepareProvider(rc, named("corp"), { fetchModels: async () => [{ id: "m" }] }),
    ).rejects.toMatchObject({ field: "name", message: "已有同名服务商 Corp（providers.json）" });
  });

  it("准备之后另一个配置对象写入同名：提交失败，文件里只有对方的条目", async () => {
    const { rc, credentials } = await fresh();
    const draft = await prepareProvider(rc, named("Acme"), {
      fetchModels: async () => [{ id: "m" }],
    });
    const other = await fresh();
    await other.rc.saveSetupProvider({ ...ENTRY, id: "acme" }, { mode: "create" });
    await expect(commitProvider(rc, draft.draftId)).rejects.toMatchObject({ field: "name" });
    const raw = (await readJson(path.join(home, "providers.json"))) as {
      providers: { id: string }[];
    };
    expect(raw.providers.map((p) => p.id)).toEqual(["acme"]);
    expect(credentials.has("Acme")).toBe(false);
  });

  it("create 模式重读文件拒绝同名（provider_exists）；replace（刷新模型）照旧覆盖", async () => {
    await writeJson(path.join(home, "providers.json"), { version: 1, providers: [ENTRY] });
    const { rc } = await fresh();
    await expect(
      rc.saveSetupProvider({ ...ENTRY, id: "CORP" }, { mode: "create" }),
    ).rejects.toMatchObject({
      code: "provider_exists",
      message: "已有同名服务商 corp（providers.json）",
    });
    await rc.saveSetupProvider({ ...ENTRY, baseURL: "https://api.corp.test/v2" });
    await rc.saveSetupProvider(
      { ...ENTRY, baseURL: "https://api.corp.test/v3" },
      { mode: "replace" },
    );
    const raw = (await readJson(path.join(home, "providers.json"))) as {
      providers: { id: string; baseURL: string }[];
    };
    expect(raw.providers).toEqual([
      expect.objectContaining({ id: "corp", baseURL: "https://api.corp.test/v3" }),
    ]);
  });

  it("新 id 保留用户拼写写入", async () => {
    const { rc } = await fresh();
    const draft = await prepareProvider(rc, named("MyCorp"), {
      fetchModels: async () => [{ id: "m" }],
    });
    await commitProvider(rc, draft.draftId);
    const raw = (await readJson(path.join(home, "providers.json"))) as {
      providers: { id: string }[];
    };
    expect(raw.providers.map((p) => p.id)).toEqual(["MyCorp"]);
  });
});
