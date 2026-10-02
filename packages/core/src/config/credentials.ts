/**
 * 凭据存储（provider-setup.md 第 3 节）：密钥交给操作系统后端，
 * credentials.json 存索引（DPAPI 附带密文；账号可显式选择明文）。
 * 密钥永不出现在子进程命令行参数里——写入/读取都经 stdin/stdout 管道。
 */
import { z } from "zod";

import { fsErrorCode, type Platform } from "../platform/index.js";
import { parseOAuthCredential } from "../protocol/index.js";
import { ConfigError } from "./errors.js";
import { writeJsonAtomic } from "./files.js";
import type { CredentialBackend, CredentialStore } from "./types.js";

const INDEX_VERSION = 1;
const SERVICE_NAME = "nocturne";
const BACKEND_TIMEOUT_MS = 15_000;

function validAccount(record: string): boolean {
  return parseOAuthCredential(record) !== undefined;
}

const indexEntrySchema = z.discriminatedUnion("backend", [
  z.object({
    backend: z.enum(["dpapi", "keychain", "libsecret"]),
    ciphertext: z.string().optional(),
  }),
  z.object({ backend: z.literal("plaintext"), value: z.string().refine(validAccount) }),
]);

const indexFileSchema = z.object({
  version: z.literal(INDEX_VERSION),
  entries: z.record(z.string(), indexEntrySchema),
});

type CredentialIndexEntry = z.infer<typeof indexEntrySchema>;

/** 后端不可用（含 none 实现的 set/delete）统一错误 */
function backendUnavailable(detail: string): ConfigError {
  return new ConfigError(
    "credential_backend_unavailable",
    `没有可用的系统凭据后端（${detail}）。请改用环境变量方式配置密钥（provider-setup.md 第 3 节）`,
  );
}

/** 子进程调用结果；密钥内容只经 stdoutRaw 管道往返 */
interface BackendRunResult {
  ok: boolean;
  stdout: string;
}

/**
 * 经 PipeProcess 执行一次后端调用：stdin 写入 input 后关闭，
 * 收集 stdout 并排空 stderr；stderr 可能含密钥，永不保留或进入错误。
 */
async function runBackend(
  platform: Platform,
  command: string,
  args: string[],
  input?: string,
  envStrip?: readonly string[],
): Promise<BackendRunResult> {
  const proc = platform.process.spawnPipe(command, args, {
    timeoutMs: BACKEND_TIMEOUT_MS,
    envStrip,
  });
  if (input !== undefined) proc.stdin.write(input);
  proc.stdin.end();
  const stdoutChunks: Buffer[] = [];
  const pumpOut = (async () => {
    for await (const c of proc.stdoutRaw) stdoutChunks.push(c);
  })();
  const pumpErr = (async () => {
    for await (const _chunk of proc.stderr) {
      // 只排空管道。
    }
  })();
  const [exit] = await Promise.all([proc.wait(), pumpOut, pumpErr]);
  return {
    ok: exit.code === 0 && !exit.timedOut && !exit.killed,
    stdout: Buffer.concat(stdoutChunks).toString("utf8").trim(),
  };
}

// ── DPAPI（Windows）──────────────────────────────────────

// 直接调 .NET ProtectedData（不用 ConvertTo-SecureString：PowerShell 7 的
// PSModulePath 会让 5.1 加载不了 Microsoft.PowerShell.Security 模块——
// provider-setup.md 第 3 节实测记录）。stdin/stdout 双向只传 Base64，
// 避开 5.1 按控制台代码页读 stdin 的编码问题。
const DPAPI_PROTECT = [
  "Add-Type -AssemblyName System.Security;",
  "$i=[Console]::In.ReadToEnd().Trim();",
  "$b=[Convert]::FromBase64String($i);",
  "$e=[System.Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser');",
  "[Console]::Out.Write([Convert]::ToBase64String($e))",
].join("");

const DPAPI_UNPROTECT = [
  "Add-Type -AssemblyName System.Security;",
  "$i=[Console]::In.ReadToEnd().Trim();",
  "$b=[System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($i),$null,'CurrentUser');",
  "[Console]::Out.Write([Convert]::ToBase64String($b))",
].join("");

const POWERSHELL_ARGS = ["-NoProfile", "-NonInteractive", "-Command"];

async function dpapiRun(platform: Platform, script: string, inputB64: string): Promise<string> {
  const r = await runBackend(platform, "powershell.exe", [...POWERSHELL_ARGS, script], inputB64, [
    "PSModulePath",
  ]);
  if (!r.ok) {
    throw backendUnavailable("DPAPI");
  }
  return r.stdout;
}

// ── 后端驱动 ─────────────────────────────────────────────

interface BackendDriver {
  /** 写入密钥；dpapi 返回密文（写入索引），其余后端返回 undefined */
  store(id: string, key: string): Promise<{ ciphertext?: string | undefined }>;
  /** 读取密钥；entry 是索引条目（dpapi 需要其中的 ciphertext） */
  load(id: string, entry: CredentialIndexEntry): Promise<string | undefined>;
  /** 删除系统侧凭据；dpapi 无系统侧残留，只需删索引 */
  remove(id: string): Promise<void>;
}

/** security -i 命令行的引号转义（命令经 stdin 传入，密钥在 -w 参数值里） */
function securityQuote(s: string): string {
  return `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function dpapiDriver(platform: Platform): BackendDriver {
  return {
    async store(id, key) {
      const ciphertext = await dpapiRun(
        platform,
        DPAPI_PROTECT,
        Buffer.from(key, "utf8").toString("base64"),
      );
      return { ciphertext };
    },
    async load(id, entry) {
      if (entry.backend !== "dpapi" || entry.ciphertext === undefined) return undefined;
      try {
        const out = await dpapiRun(platform, DPAPI_UNPROTECT, entry.ciphertext);
        return Buffer.from(out, "base64").toString("utf8");
      } catch {
        // 密文损坏或跨机器拷贝（DPAPI 仅当前用户本机可解）——按缺少凭据处理
        return undefined;
      }
    },
    async remove() {
      // 密文存于索引文件，删除索引条目即完成
    },
  };
}

function keychainDriver(platform: Platform): BackendDriver {
  return {
    async store(id, key) {
      const r = await runBackend(
        platform,
        "security",
        ["-i"],
        `add-generic-password -s ${SERVICE_NAME} -a ${securityQuote(id)} -U -w ${securityQuote(key)}\n`,
      );
      if (!r.ok) {
        throw backendUnavailable("macOS 钥匙串");
      }
      return {};
    },
    async load(id, entry) {
      if (entry.backend !== "keychain") return undefined;
      const r = await runBackend(platform, "security", [
        "find-generic-password",
        "-s",
        SERVICE_NAME,
        "-a",
        id,
        "-w",
      ]);
      return r.ok ? r.stdout : undefined;
    },
    async remove(id) {
      const result = await runBackend(platform, "security", [
        "delete-generic-password",
        "-s",
        SERVICE_NAME,
        "-a",
        id,
      ]);
      if (!result.ok) throw backendUnavailable("macOS 钥匙串");
    },
  };
}

function libsecretDriver(platform: Platform): BackendDriver {
  const attrs = ["service", SERVICE_NAME, "provider"];
  return {
    async store(id, key) {
      const r = await runBackend(
        platform,
        "secret-tool",
        ["store", `--label=Nocturne ${id}`, ...attrs, id],
        `${key}\n`,
      );
      if (!r.ok) {
        throw backendUnavailable("Secret Service");
      }
      return {};
    },
    async load(id, entry) {
      if (entry.backend !== "libsecret") return undefined;
      const r = await runBackend(platform, "secret-tool", ["lookup", ...attrs, id]);
      return r.ok && r.stdout !== "" ? r.stdout : undefined;
    },
    async remove(id) {
      const result = await runBackend(platform, "secret-tool", ["clear", ...attrs, id]);
      if (!result.ok) throw backendUnavailable("Secret Service");
    },
  };
}

/** 在 PATH 中探测可执行文件（libsecret 的 secret-tool 需要它存在才有后端） */
async function findOnPath(platform: Platform, name: string): Promise<boolean> {
  const pathEnv = platform.env("PATH");
  if (pathEnv === undefined) return false;
  for (const dir of pathEnv.split(process.platform === "win32" ? ";" : ":")) {
    if (dir === "") continue;
    if (await platform.fs.exists(platform.paths.join(dir, name))) return true;
  }
  return false;
}

async function detectBackend(platform: Platform): Promise<CredentialBackend> {
  if (process.platform === "win32") return "dpapi";
  if (process.platform === "darwin") {
    return (await platform.fs.exists("/usr/bin/security")) ? "keychain" : "none";
  }
  return (await findOnPath(platform, "secret-tool")) ? "libsecret" : "none";
}

export interface CredentialStoreInit {
  store: CredentialStore;
  /** credentials.json 损坏时的警告（按空索引处理，不阻塞） */
  warning?: string | undefined;
}

/**
 * 创建凭据存储。backend 缺省按平台探测；传 "memory" 为不落盘的测试实现；
 * API key 的 set 不退回明文；账号的 setAccount 在无系统后端时必须显式选择。
 */
export async function createCredentialStore(
  platform: Platform,
  nocturneHome: string,
  options?: { backend?: CredentialBackend | undefined },
): Promise<CredentialStoreInit> {
  const { fs, paths } = platform;
  const indexPath = paths.join(nocturneHome, "credentials.json");

  const validateAccount = (record: string) => {
    if (!validAccount(record)) {
      throw new ConfigError("config_credential_rejected", "账号凭据记录无效，无法保存。");
    }
  };

  // 显式内存后端兼容已有测试；不读取或写入任何索引。
  if (options?.backend === "memory") {
    const mem = new Map<string, string>();
    return {
      store: {
        get: (id) => Promise.resolve(mem.get(id)),
        set: (id, key) => {
          mem.set(id, key);
          return Promise.resolve();
        },
        setAccount: (id, record) => {
          return Promise.resolve().then(() => {
            validateAccount(record);
            mem.set(id, record);
          });
        },
        storage: (id) => (mem.has(id) ? "memory" : undefined),
        delete: (id) => {
          mem.delete(id);
          return Promise.resolve();
        },
        has: (id) => mem.has(id),
        backend: () => "memory",
      },
    };
  }

  const backend = options?.backend ?? (await detectBackend(platform));
  const driver: BackendDriver | undefined =
    backend === "dpapi"
      ? dpapiDriver(platform)
      : backend === "keychain"
        ? keychainDriver(platform)
        : backend === "libsecret"
          ? libsecretDriver(platform)
          : undefined;

  async function readIndex(): Promise<Map<string, CredentialIndexEntry>> {
    try {
      const raw: unknown = JSON.parse(await fs.readTextFile(indexPath));
      const parsed = indexFileSchema.safeParse(raw);
      if (!parsed.success) throw new Error("schema mismatch");
      return new Map(Object.entries(parsed.data.entries));
    } catch (error) {
      if (fsErrorCode(error) === "ENOENT") return new Map();
      throw new ConfigError("config_unavailable", "无法读取凭据索引。");
    }
  }

  // none 也读取明文账号条目；初始化损坏时保持既有空索引与警告语义。
  let entries = new Map<string, CredentialIndexEntry>();
  let warning: string | undefined;
  try {
    entries = await readIndex();
  } catch {
    warning = `凭据索引 ${indexPath} 损坏或版本不符，已按空索引处理`;
  }

  const persistIndex = async (next: Map<string, CredentialIndexEntry>): Promise<void> => {
    try {
      await writeJsonAtomic(
        fs,
        paths,
        indexPath,
        { version: INDEX_VERSION, entries: Object.fromEntries(next) },
        { fileMode: 0o600, dirMode: 0o700 },
      );
    } catch {
      // writeJsonAtomic 的 cause 可能含写入内容，凭据边界不传播原异常。
      throw new ConfigError("config_unavailable", "无法保存凭据索引。");
    }
  };

  // 解密结果进程内缓存：避免每次请求都起子进程（DPAPI 一次解密约 0.3s）
  const cache = new Map<string, string>();
  const memory = new Map<string, string>();
  let mutations = Promise.resolve();

  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const pending = mutations.then(task);
    mutations = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  function commit(next: Map<string, CredentialIndexEntry>) {
    entries = next;
    cache.clear();
  }

  async function load(providerId: string): Promise<string | undefined> {
    const ephemeral = memory.get(providerId);
    if (ephemeral !== undefined) return ephemeral;
    const entry = entries.get(providerId);
    if (entry === undefined) return undefined;
    let key: string | undefined;
    if (entry.backend === "plaintext") key = entry.value;
    else if (entry.backend === backend && driver !== undefined) {
      try {
        key = await driver.load(providerId, entry);
      } catch {
        // 后端读取失败按缺少凭据处理，不传播 stderr 或原异常。
        return undefined;
      }
    }
    if (key !== undefined && entries.get(providerId) === entry && !memory.has(providerId)) {
      cache.set(providerId, key);
    }
    return key;
  }

  // 钥匙串/Secret Service 的值不在索引内；索引写失败时恢复之前的系统值。
  async function previousSystemValue(providerId: string, previous?: CredentialIndexEntry) {
    if (!driver || backend === "dpapi" || previous?.backend !== backend) return undefined;
    try {
      return await driver.load(providerId, previous);
    } catch {
      throw backendUnavailable(backend);
    }
  }

  async function restoreSystemValue(providerId: string, previous: string | undefined) {
    if (!driver || backend === "dpapi") return;
    try {
      if (previous === undefined) await driver.remove(providerId);
      else await driver.store(providerId, previous);
    } catch {
      // 保留原操作的固定错误；绝不把回滚失败异常或秘密附加为 cause。
    }
  }

  const store: CredentialStore = {
    async get(providerId, options) {
      if (options?.fresh) {
        return serialize(async () => {
          if (memory.has(providerId)) return memory.get(providerId);
          cache.clear();
          const next = await readIndex();
          commit(next);
          return load(providerId);
        });
      }
      if (memory.has(providerId)) return memory.get(providerId);
      const cached = cache.get(providerId);
      if (cached !== undefined) return cached;
      return load(providerId);
    },
    set(providerId, key) {
      return serialize(async () => {
        if (driver === undefined) throw backendUnavailable(backend);
        const next = await readIndex();
        const previous = await previousSystemValue(providerId, next.get(providerId));
        try {
          const result = await driver.store(providerId, key);
          next.set(providerId, {
            backend: backend as "dpapi" | "keychain" | "libsecret",
            ...(result.ciphertext !== undefined ? { ciphertext: result.ciphertext } : {}),
          });
        } catch {
          await restoreSystemValue(providerId, previous);
          throw backendUnavailable(backend);
        }
        try {
          await persistIndex(next);
        } catch {
          await restoreSystemValue(providerId, previous);
          throw new ConfigError("config_unavailable", "无法保存凭据索引。");
        }
        commit(next);
        memory.delete(providerId);
        cache.set(providerId, key);
      });
    },
    async setAccount(providerId, record, storage) {
      validateAccount(record);
      if (driver !== undefined) {
        await store.set(providerId, record);
        return;
      }
      if (storage !== "plaintext" && storage !== "memory") throw backendUnavailable(backend);
      await serialize(async () => {
        // 新的内存账号无需文件 I/O；如有持久记录，先原子删除再切换。
        if (storage === "memory" && !entries.has(providerId)) {
          memory.set(providerId, record);
          cache.delete(providerId);
          return;
        }
        const next = await readIndex();
        if (storage === "plaintext") next.set(providerId, { backend: "plaintext", value: record });
        else next.delete(providerId);
        await persistIndex(next);
        commit(next);
        if (storage === "memory") memory.set(providerId, record);
        else {
          memory.delete(providerId);
          cache.set(providerId, record);
        }
      });
    },
    delete(providerId) {
      return serialize(async () => {
        const next = await readIndex();
        const entry = next.get(providerId);
        if (entry === undefined) {
          commit(next);
          memory.delete(providerId);
          return;
        }
        const previous = await previousSystemValue(providerId, entry);
        if (entry.backend === backend && driver !== undefined) {
          try {
            await driver.remove(providerId);
          } catch {
            throw backendUnavailable(backend);
          }
        }
        next.delete(providerId);
        try {
          await persistIndex(next);
        } catch {
          await restoreSystemValue(providerId, previous);
          throw new ConfigError("config_unavailable", "无法保存凭据索引。");
        }
        commit(next);
        memory.delete(providerId);
      });
    },
    has: (providerId) => memory.has(providerId) || entries.has(providerId),
    storage(providerId) {
      if (memory.has(providerId)) return "memory";
      const entry = entries.get(providerId);
      if (entry === undefined) return undefined;
      return entry.backend === "plaintext" ? "plaintext" : "system";
    },
    backend: () => backend,
  };
  return { store, warning };
}
