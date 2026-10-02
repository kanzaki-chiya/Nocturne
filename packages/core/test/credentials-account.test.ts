import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCredentialStore, type CredentialStore } from "../src/config/index.js";
import { createPlatform, type PipeProcess, type Platform } from "../src/platform/index.js";
import type { OAuthCredentialRecord } from "../src/protocol/index.js";

let root: string;
let home: string;
let platform: Platform;
const syntheticSecret = "synthetic-secret-never-log";

function account(generation = 1): string {
  const record: OAuthCredentialRecord = {
    version: 1,
    clientId: "synthetic-client",
    subject: "synthetic-subject",
    email: "synthetic@example.test",
    idToken: `synthetic-id-${generation}`,
    accessToken: `synthetic-access-${generation}`,
    refreshToken: `synthetic-refresh-${generation}`,
    expiresAt: 2_000_000_000_000 + generation,
    scopes: ["openid", "chatgpt.tokens.use.direct"],
  };
  return JSON.stringify(record);
}

function setAccount(
  store: CredentialStore,
  record: string,
  storage?: "plaintext" | "memory",
  id = "chat",
) {
  if (!store.setAccount) throw new Error("missing production setAccount");
  return store.setAccount(id, record, storage);
}

function storedAt(store: CredentialStore, id = "chat") {
  if (!store.storage) throw new Error("missing production storage");
  return store.storage(id);
}

interface Index {
  version: number;
  entries: Record<string, { backend: string; value?: string; ciphertext?: string }>;
}

async function index(): Promise<Index> {
  return JSON.parse(await fs.readFile(path.join(home, "credentials.json"), "utf8")) as Index;
}

function stubBackend() {
  const calls: { command: string; args: string[]; input: string }[] = [];
  const keys = new Map<string, string>();
  let fail = false;
  let spawnError = false;
  const stub: Platform = {
    ...platform,
    process: {
      ...platform.process,
      spawnPipe(command, args) {
        if (spawnError) throw new Error(syntheticSecret);
        const call = { command, args, input: "" };
        calls.push(call);
        const proc: PipeProcess = {
          pid: 1,
          stdin: {
            write(text) {
              call.input += text;
            },
            end() {
              // stdout 桩在管道结束后读取 input。
            },
          },
          stdoutRaw: (async function* () {
            if (fail) {
              yield Buffer.from(syntheticSecret);
              return;
            }
            if (command === "powershell.exe") {
              if (args.join(" ").includes("::Unprotect")) {
                const decoded = Buffer.from(call.input, "base64").toString("utf8");
                yield Buffer.from(Buffer.from(decoded.slice(4)).toString("base64"));
              } else {
                const decoded = Buffer.from(call.input, "base64").toString("utf8");
                yield Buffer.from(Buffer.from(`ENC:${decoded}`).toString("base64"));
              }
            } else if (command === "secret-tool") {
              const id = args.at(-1) ?? "";
              if (args[0] === "store") keys.set(id, call.input.trim());
              if (args[0] === "lookup") yield Buffer.from(keys.get(id) ?? "");
              if (args[0] === "clear") keys.delete(id);
            } else if (args[0] === "-i") {
              const id = /-a "([^"]*)"/.exec(call.input)?.[1] ?? "";
              const value = /-w "(.*)"\n$/.exec(call.input)?.[1] ?? "";
              keys.set(id, value.replaceAll('\\"', '"').replaceAll("\\\\", "\\"));
            } else {
              const id = args[args.indexOf("-a") + 1] ?? "";
              if (args[0] === "find-generic-password") yield Buffer.from(keys.get(id) ?? "");
              else keys.delete(id);
            }
          })(),
          stderr: (async function* () {
            yield syntheticSecret;
          })(),
          wait: async () => ({ code: fail ? 1 : 0, signal: null, killed: false, timedOut: false }),
          kill: async () => undefined,
        };
        return proc;
      },
    },
  };
  return {
    platform: stub,
    calls,
    keys,
    fail: () => {
      fail = true;
    },
    failSpawn: () => {
      spawnError = true;
    },
  };
}

function brokenRename(base: Platform): Platform {
  return {
    ...base,
    fs: {
      ...base.fs,
      rename: vi.fn(async () => {
        throw new Error(syntheticSecret);
      }),
    },
  };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "nctrn-account-store-"));
  home = path.join(root, "home");
  platform = createPlatform();
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("账号凭据存储边界", () => {
  it("none 必须显式选择；API key 永不退回明文", async () => {
    const { store } = await createCredentialStore(platform, home, { backend: "none" });
    await expect(setAccount(store, account())).rejects.toMatchObject({
      code: "credential_backend_unavailable",
    });
    await expect(store.set("chat", syntheticSecret)).rejects.toMatchObject({
      code: "credential_backend_unavailable",
    });
    expect(store.has("chat")).toBe(false);
    expect(storedAt(store)).toBeUndefined();
    expect(await platform.fs.exists(path.join(home, "credentials.json"))).toBe(false);
  });

  it("显式明文账号原子写入；none 重启仍能读取与显示位置", async () => {
    const { store } = await createCredentialStore(platform, home, { backend: "none" });
    const mkdir = vi.spyOn(platform.fs, "mkdir");
    const write = vi.spyOn(platform.fs, "writeFile");
    const rename = vi.spyOn(platform.fs, "rename");
    await setAccount(store, account(), "plaintext");
    expect(await store.get("chat")).toBe(account());
    expect(storedAt(store)).toBe("plaintext");
    expect(store.backend()).toBe("none");
    expect(await index()).toEqual({
      version: 1,
      entries: { chat: { backend: "plaintext", value: account() } },
    });
    expect(mkdir).toHaveBeenCalledWith(home, { mode: 0o700 });
    expect(write).toHaveBeenCalledWith(
      expect.stringContaining("credentials.json.tmp-"),
      expect.any(String),
      { mode: 0o600 },
    );
    expect(rename).toHaveBeenCalledWith(
      expect.stringContaining("credentials.json.tmp-"),
      path.join(home, "credentials.json"),
    );
    if (process.platform !== "win32") {
      expect((await fs.stat(path.join(home, "credentials.json"))).mode & 0o777).toBe(0o600);
      expect((await fs.stat(home)).mode & 0o777).toBe(0o700);
    }
    const restarted = (await createCredentialStore(platform, home, { backend: "none" })).store;
    expect(restarted.has("chat")).toBe(true);
    expect(storedAt(restarted)).toBe("plaintext");
    expect(await restarted.get("chat", { fresh: true })).toBe(account());
  });

  it("fresh 跨实例读取明文轮换与删除，普通读取保留缓存", async () => {
    const writer = (await createCredentialStore(platform, home, { backend: "none" })).store;
    await setAccount(writer, account(), "plaintext");
    const reader = (await createCredentialStore(platform, home, { backend: "none" })).store;
    expect(await reader.get("chat")).toBe(account());
    await setAccount(writer, account(2), "plaintext");
    expect(await reader.get("chat")).toBe(account());
    expect(await reader.get("chat", { fresh: true })).toBe(account(2));
    await writer.delete("chat");
    expect(await reader.get("chat", { fresh: true })).toBeUndefined();
    expect(reader.has("chat")).toBe(false);
    expect(storedAt(reader)).toBeUndefined();
  });

  it("none 内存账号读写、轮换、fresh、delete 均不落盘，重启丢失", async () => {
    const store = (await createCredentialStore(platform, home, { backend: "none" })).store;
    const read = vi.spyOn(platform.fs, "readTextFile");
    const write = vi.spyOn(platform.fs, "writeFile");
    await setAccount(store, account(), "memory");
    await setAccount(store, account(2), "memory");
    expect(await store.get("chat", { fresh: true })).toBe(account(2));
    expect(store.has("chat")).toBe(true);
    expect(storedAt(store)).toBe("memory");
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    const restarted = (await createCredentialStore(platform, home, { backend: "none" })).store;
    expect(await restarted.get("chat")).toBeUndefined();
    await store.delete("chat");
    expect(await store.get("chat")).toBeUndefined();
    expect(storedAt(store)).toBeUndefined();
    expect(write).not.toHaveBeenCalled();
  });

  it("从明文转内存删除旧持久记录；delete 清除所有形式", async () => {
    const store = (await createCredentialStore(platform, home, { backend: "none" })).store;
    await setAccount(store, account(), "plaintext");
    await setAccount(store, account(2), "memory");
    expect((await index()).entries.chat).toBeUndefined();
    expect(await store.get("chat")).toBe(account(2));
    const restarted = (await createCredentialStore(platform, home, { backend: "none" })).store;
    expect(await restarted.get("chat")).toBeUndefined();
    await store.delete("chat");
    expect(store.has("chat")).toBe(false);
  });

  it("已保存明文账号仍不允许省略选择，API key set 不覆盖它", async () => {
    const store = (await createCredentialStore(platform, home, { backend: "none" })).store;
    await setAccount(store, account(), "plaintext");
    await expect(setAccount(store, account(2))).rejects.toMatchObject({
      code: "credential_backend_unavailable",
    });
    await expect(store.set("chat", syntheticSecret)).rejects.toMatchObject({
      code: "credential_backend_unavailable",
    });
    expect(await store.get("chat")).toBe(account());
    expect((await index()).entries.chat?.value).toBe(account());
  });

  it.each([
    syntheticSecret,
    "null",
    "[]",
    "{}",
    JSON.stringify({ version: 1, apiKey: syntheticSecret }),
    account().replace('"version":1', '"version":2'),
    account().replace('"refreshToken":"synthetic-refresh-1"', '"refreshToken":""'),
    account().replace('"expiresAt":2000000000001', '"expiresAt":"forever"'),
    account().replace('"chatgpt.tokens.use.direct"', '"unrelated.scope"'),
  ])("拒绝伪装或无效账号记录 %#，错误无输入", async (record) => {
    const store = (await createCredentialStore(platform, home, { backend: "none" })).store;
    const error = await setAccount(store, record, "plaintext").catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "config_credential_rejected" });
    expect(String(error)).not.toContain(syntheticSecret);
    expect(error).not.toHaveProperty("cause");
    expect(store.has("chat")).toBe(false);
    expect(await platform.fs.exists(path.join(home, "credentials.json"))).toBe(false);
  });

  it("plaintext 索引里的 API key 伪装按损坏处理，不读取或缓存", async () => {
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(
      path.join(home, "credentials.json"),
      JSON.stringify({
        version: 1,
        entries: { chat: { backend: "plaintext", value: syntheticSecret } },
      }),
    );
    const { store, warning } = await createCredentialStore(platform, home, { backend: "none" });
    expect(warning).toContain("损坏");
    expect(warning).not.toContain(syntheticSecret);
    expect(await store.get("chat")).toBeUndefined();
    await expect(store.get("chat", { fresh: true })).rejects.toMatchObject({
      code: "config_unavailable",
    });
  });

  it("明文刷新原子 rename 失败保留旧磁盘、缓存、索引且清理临时文件", async () => {
    const good = (await createCredentialStore(platform, home, { backend: "none" })).store;
    await setAccount(good, account(), "plaintext");
    const store = (await createCredentialStore(brokenRename(platform), home, { backend: "none" }))
      .store;
    await store.get("chat");
    const error = await setAccount(store, account(2), "plaintext").catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "config_unavailable", message: "无法保存凭据索引。" });
    expect(error).not.toHaveProperty("cause");
    expect(String(error)).not.toContain(syntheticSecret);
    expect(await store.get("chat")).toBe(account());
    expect((await index()).entries.chat?.value).toBe(account());
    expect(storedAt(store)).toBe("plaintext");
    expect(await fs.readdir(home)).toEqual(["credentials.json"]);
  });

  it("首次原子写失败不提前登记或缓存账号", async () => {
    const store = (await createCredentialStore(brokenRename(platform), home, { backend: "none" }))
      .store;
    await expect(setAccount(store, account(), "plaintext")).rejects.toMatchObject({
      code: "config_unavailable",
    });
    expect(store.has("chat")).toBe(false);
    expect(storedAt(store)).toBeUndefined();
    expect(await store.get("chat")).toBeUndefined();
    expect(await fs.readdir(home)).toEqual([]);
  });

  it("删除明文的原子写失败保留索引与缓存", async () => {
    const good = (await createCredentialStore(platform, home, { backend: "none" })).store;
    await setAccount(good, account(), "plaintext");
    const store = (await createCredentialStore(brokenRename(platform), home, { backend: "none" }))
      .store;
    await store.get("chat");
    await expect(store.delete("chat")).rejects.toMatchObject({ code: "config_unavailable" });
    expect(store.has("chat")).toBe(true);
    expect(await store.get("chat")).toBe(account());
    expect((await index()).entries.chat?.value).toBe(account());
  });

  it("fresh 索引读取失败抛安全错误，不返回缓存旧账号", async () => {
    const store = (await createCredentialStore(platform, home, { backend: "none" })).store;
    await setAccount(store, account(), "plaintext");
    vi.spyOn(platform.fs, "readTextFile").mockRejectedValueOnce(new Error(syntheticSecret));
    const error = await store.get("chat", { fresh: true }).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "config_unavailable", message: "无法读取凭据索引。" });
    expect(error).not.toHaveProperty("cause");
  });

  it("显式 memory 测试后端兼容 API key 并提供账号接口", async () => {
    const store = (await createCredentialStore(platform, home, { backend: "memory" })).store;
    await store.set("api", syntheticSecret);
    await setAccount(store, account());
    expect(await store.get("api", { fresh: true })).toBe(syntheticSecret);
    expect(await store.get("chat", { fresh: true })).toBe(account());
    expect(storedAt(store)).toBe("memory");
    await expect(setAccount(store, syntheticSecret)).rejects.toMatchObject({
      code: "config_credential_rejected",
    });
    await store.delete("chat");
    expect(store.has("chat")).toBe(false);
    expect(await platform.fs.exists(home)).toBe(false);
  });
});

describe("系统后端、fresh 与失败隔离", () => {
  it.each(["dpapi", "keychain", "libsecret"] as const)(
    "%s 账号强制使用系统存储，fresh 跨实例读取轮换",
    async (backend) => {
      const stub = stubBackend();
      const writer = (await createCredentialStore(stub.platform, home, { backend })).store;
      await setAccount(writer, account(), "plaintext");
      expect(storedAt(writer)).toBe("system");
      expect((await index()).entries.chat?.backend).toBe(backend);
      expect((await index()).entries.chat?.value).toBeUndefined();
      expect(await fs.readFile(path.join(home, "credentials.json"), "utf8")).not.toContain(
        "synthetic-access",
      );
      const reader = (await createCredentialStore(stub.platform, home, { backend })).store;
      expect(await reader.get("chat")).toBe(account());
      await setAccount(writer, account(2));
      expect(await reader.get("chat")).toBe(account());
      const callsBeforeFresh = stub.calls.length;
      expect(await reader.get("chat", { fresh: true })).toBe(account(2));
      expect(stub.calls.length).toBeGreaterThan(callsBeforeFresh);
      for (const call of stub.calls) expect(call.args.join(" ")).not.toContain("synthetic-access");
      await writer.delete("chat");
      expect(await reader.get("chat", { fresh: true })).toBeUndefined();
      expect(stub.keys.has("chat")).toBe(false);
    },
  );

  it.each(["dpapi", "keychain", "libsecret"] as const)(
    "%s 轮换落盘失败不提交索引或缓存，系统值可恢复",
    async (backend) => {
      const stub = stubBackend();
      const writer = (await createCredentialStore(stub.platform, home, { backend })).store;
      await setAccount(writer, account());
      const before = await fs.readFile(path.join(home, "credentials.json"), "utf8");
      const store = (await createCredentialStore(brokenRename(stub.platform), home, { backend }))
        .store;
      expect(await store.get("chat")).toBe(account());
      await expect(setAccount(store, account(2))).rejects.toMatchObject({
        code: "config_unavailable",
      });
      expect(await store.get("chat")).toBe(account());
      expect(await store.get("chat", { fresh: true })).toBe(account());
      expect(await fs.readFile(path.join(home, "credentials.json"), "utf8")).toBe(before);
      expect(await fs.readdir(home)).toEqual(["credentials.json"]);
    },
  );

  it.each(["dpapi", "keychain", "libsecret"] as const)(
    "%s 后端失败不泄露 stderr/stdout 且不登记",
    async (backend) => {
      const stub = stubBackend();
      stub.fail();
      const store = (await createCredentialStore(stub.platform, home, { backend })).store;
      const error = await setAccount(store, account()).catch((value: unknown) => value);
      expect(error).toMatchObject({ code: "credential_backend_unavailable" });
      expect(String(error)).not.toContain(syntheticSecret);
      expect(error).not.toHaveProperty("cause");
      expect(store.has("chat")).toBe(false);
      expect(await store.get("chat")).toBeUndefined();
      expect(await platform.fs.exists(home)).toBe(false);
    },
  );

  it("spawn 异常也不泄露原始错误或凭据", async () => {
    const stub = stubBackend();
    stub.failSpawn();
    const store = (await createCredentialStore(stub.platform, home, { backend: "dpapi" })).store;
    const error = await store.set("api", syntheticSecret).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "credential_backend_unavailable" });
    expect(String(error)).not.toContain(syntheticSecret);
    expect(error).not.toHaveProperty("cause");
  });

  it("两实例保存不同服务商保留对方索引，单实例并发写不会丢条目", async () => {
    const one = (await createCredentialStore(platform, home, { backend: "none" })).store;
    const two = (await createCredentialStore(platform, home, { backend: "none" })).store;
    await setAccount(one, account(), "plaintext", "one");
    await setAccount(two, account(2), "plaintext", "two");
    await Promise.all([
      setAccount(one, account(), "plaintext", "three"),
      setAccount(one, account(2), "plaintext", "four"),
    ]);
    expect(Object.keys((await index()).entries).sort()).toEqual(["four", "one", "three", "two"]);
  });
});
