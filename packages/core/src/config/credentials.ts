/**
 * 凭据存储（provider-setup.md 第 3 节）：密钥交给操作系统后端，
 * credentials.json 只存索引（后端标识；DPAPI 附带密文）。
 * 密钥永不出现在子进程命令行参数里——写入/读取都经 stdin/stdout 管道。
 */
import { z } from "zod";

import type { Platform } from "../platform/index.js";
import { ConfigError } from "./errors.js";
import { writeJsonAtomic } from "./files.js";
import type { CredentialBackend, CredentialStore } from "./types.js";

const INDEX_VERSION = 1;
const SERVICE_NAME = "nocturne";
const BACKEND_TIMEOUT_MS = 15_000;

const indexEntrySchema = z.object({
  backend: z.enum(["dpapi", "keychain", "libsecret"]),
  ciphertext: z.string().optional(),
});

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
  stderr: string;
}

/**
 * 经 PipeProcess 执行一次后端调用：stdin 写入 input 后关闭，
 * 收集 stdout/stderr。stderr 进入错误信息前截断（不含密钥——
 * 密钥只走 stdin/stdout，命令行参数永不含密钥）。
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
  const stderrChunks: string[] = [];
  const pumpOut = (async () => {
    for await (const c of proc.stdoutRaw) stdoutChunks.push(c);
  })();
  const pumpErr = (async () => {
    for await (const c of proc.stderr) stderrChunks.push(c);
  })();
  const [exit] = await Promise.all([proc.wait(), pumpOut, pumpErr]);
  return {
    ok: exit.code === 0 && !exit.timedOut && !exit.killed,
    stdout: Buffer.concat(stdoutChunks).toString("utf8").trim(),
    stderr: stderrChunks.join("").slice(0, 500).trim(),
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
    throw new ConfigError(
      "credential_backend_unavailable",
      `DPAPI 调用失败${r.stderr !== "" ? `：${r.stderr}` : ""}`,
    );
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
      if (entry.ciphertext === undefined) return undefined;
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
        throw new ConfigError(
          "credential_backend_unavailable",
          `macOS 钥匙串写入失败${r.stderr !== "" ? `：${r.stderr}` : ""}`,
        );
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
      await runBackend(platform, "security", [
        "delete-generic-password",
        "-s",
        SERVICE_NAME,
        "-a",
        id,
      ]);
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
        throw new ConfigError(
          "credential_backend_unavailable",
          `Secret Service 写入失败${r.stderr !== "" ? `：${r.stderr}` : ""}`,
        );
      }
      return {};
    },
    async load(id, entry) {
      if (entry.backend !== "libsecret") return undefined;
      const r = await runBackend(platform, "secret-tool", ["lookup", ...attrs, id]);
      return r.ok && r.stdout !== "" ? r.stdout : undefined;
    },
    async remove(id) {
      await runBackend(platform, "secret-tool", ["clear", ...attrs, id]);
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
 * 传 "none" 或无可用后端时 set/delete 拒绝、get 恒 undefined（不退回明文）。
 */
export async function createCredentialStore(
  platform: Platform,
  nocturneHome: string,
  options?: { backend?: CredentialBackend | undefined },
): Promise<CredentialStoreInit> {
  const { fs, paths } = platform;
  const indexPath = paths.join(nocturneHome, "credentials.json");

  // 内存实现：不进索引文件，不落盘（仅供测试）
  if (options?.backend === "memory") {
    const mem = new Map<string, string>();
    return {
      store: {
        get: (id) => Promise.resolve(mem.get(id)),
        set: (id, key) => {
          mem.set(id, key);
          return Promise.resolve();
        },
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

  // 索引加载：损坏/版本不符按空索引处理 + 警告（与其他机器维护文件一致）
  const entries = new Map<string, CredentialIndexEntry>();
  let warning: string | undefined;
  if (driver !== undefined && (await fs.exists(indexPath))) {
    try {
      const raw: unknown = JSON.parse(await fs.readTextFile(indexPath));
      const parsed = indexFileSchema.safeParse(raw);
      if (!parsed.success) throw new Error("schema mismatch");
      for (const [id, e] of Object.entries(parsed.data.entries)) entries.set(id, e);
    } catch {
      warning = `凭据索引 ${indexPath} 损坏或版本不符，已按空索引处理`;
    }
  }

  const persistIndex = async (): Promise<void> => {
    await writeJsonAtomic(
      fs,
      paths,
      indexPath,
      {
        version: INDEX_VERSION,
        entries: Object.fromEntries(entries),
      },
      { fileMode: 0o600, dirMode: 0o700 },
    );
  };

  // 解密结果进程内缓存：避免每次请求都起子进程（DPAPI 一次解密约 0.3s）
  const cache = new Map<string, string>();

  const store: CredentialStore = {
    async get(providerId) {
      const cached = cache.get(providerId);
      if (cached !== undefined) return cached;
      const entry = entries.get(providerId);
      if (entry === undefined || driver === undefined) return undefined;
      const key = await driver.load(providerId, entry);
      if (key === undefined) return undefined;
      cache.set(providerId, key);
      return key;
    },
    async set(providerId, key) {
      if (driver === undefined) throw backendUnavailable(backend);
      const result = await driver.store(providerId, key);
      entries.set(providerId, {
        backend: backend as Exclude<CredentialBackend, "memory" | "none">,
        ...(result.ciphertext !== undefined ? { ciphertext: result.ciphertext } : {}),
      });
      await persistIndex();
      cache.set(providerId, key);
    },
    async delete(providerId) {
      cache.delete(providerId);
      if (!entries.delete(providerId)) return;
      await driver?.remove(providerId).catch(() => undefined);
      await persistIndex();
    },
    has: (providerId) => entries.has(providerId),
    backend: () => backend,
  };
  return { store, warning };
}
