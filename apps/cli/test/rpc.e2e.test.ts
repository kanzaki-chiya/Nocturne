/**
 * `nctrn rpc --stdio` 端到端（ADR-0044 第 9 节）：启动真实的 nctrn 子进程，经 stdin/stdout 上的
 * JSON-RPC 跑完一轮会话，核对回放视图与磁盘日志一致、stdout 只有协议报文、断开与 shutdown
 * 之后会话锁被释放。模型是本地假 SSE 服务（OpenAI 兼容），不访问网络。
 *
 * 子进程跑的是构建产物，所以 beforeAll 先执行一次 `pnpm build`（几秒），避免用过期 dist 给出假通过。
 */
import { execSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  replaySessionView,
  type DurableEvent,
  type RuntimeEvent,
  type SessionView,
} from "@nocturne/core/protocol";
import { createRpcClient, RPC_PROTOCOL_VERSION } from "@nocturne/rpc/client";
import type { LineTransport } from "@nocturne/rpc/server";
import { createProcessCleanup, removeTempDirs } from "../../../scripts/test/process-cleanup.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const cli = path.join(repoRoot, "apps/cli/dist/main.js");

let fake: Server;
let baseURL = "";
/** 为 true 时假模型服务收到请求后不回复（制造"Turn 进行中"） */
let hang = false;
const hanging: ServerResponse[] = [];
let modelRequests = 0;

beforeAll(async () => {
  execSync("pnpm build", { cwd: repoRoot, stdio: "pipe" });
  fake = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      if (request.method === "POST") modelRequests++;
      if (hang && request.method === "POST") {
        hanging.push(response);
        return;
      }
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "e2e-model", context_length: 128000 }] }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunk = (delta: object, finish?: string) => ({
        id: "e2e",
        object: "chat.completion.chunk",
        created: 1,
        model: "e2e-model",
        choices: [{ index: 0, delta, finish_reason: finish ?? null }],
      });
      const send = (value: object) => response.write(`data: ${JSON.stringify(value)}\n\n`);
      send(chunk({ role: "assistant", content: "你好，" }));
      send(chunk({ content: "RPC" }));
      send(chunk({}, "stop"));
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  baseURL = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1`;
}, 180_000);

afterAll(async () => {
  for (const r of hanging) r.destroy();
  await new Promise<void>((resolve) => fake.close(() => resolve()));
});

interface Child {
  proc: ChildProcessWithoutNullStreams;
  home: string;
  workspace: string;
  /** stdout 的每一行原文（协议之外不应有任何内容） */
  stdoutLines: string[];
  stderr: () => string;
  transport: LineTransport;
  exit: Promise<number | null>;
}

const temps: string[] = [];
const processes = createProcessCleanup();

interface SpawnExtras {
  /** 追加/覆盖子进程环境变量 */
  env?: Record<string, string>;
  /** 子进程启动前向 home 预写文件（config.json、providers.json 等） */
  seedHome?: (home: string) => void;
}

function spawnRpc(args: string[] = ["rpc", "--stdio"], extras: SpawnExtras = {}): Child {
  const root = mkdtempSync(path.join(tmpdir(), "nct-rpc-e2e-"));
  temps.push(root);
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  mkdirSync(home);
  mkdirSync(workspace);
  extras.seedHome?.(home);
  const proc = processes.trackChild(
    spawn(process.execPath, [cli, ...args], {
      cwd: workspace,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        NOCTURNE_HOME: home,
        NOCTURNE_API_KEY: "e2e-placeholder",
        NOCTURNE_BASE_URL: baseURL,
        NOCTURNE_MODEL: "e2e-model",
        ...extras.env,
      },
    }),
  );
  let stderr = "";
  proc.stderr.on("data", (c: Buffer) => {
    stderr += c.toString();
  });
  const stdoutLines: string[] = [];
  let lineHandler: ((line: string) => void) | undefined;
  let closeHandler: (() => void) | undefined;
  const reader = createInterface({ input: proc.stdout, crlfDelay: Infinity });
  reader.on("line", (line) => {
    stdoutLines.push(line);
    lineHandler?.(line);
  });
  reader.on("close", () => closeHandler?.());
  const transport: LineTransport = {
    send: (line) => {
      proc.stdin.write(`${line}\n`);
    },
    onLine: (h) => {
      lineHandler = h;
    },
    onClose: (h) => {
      closeHandler = h;
    },
    close: () => {
      proc.stdin.end();
    },
  };
  const exit = new Promise<number | null>((resolve) => {
    proc.on("close", (code) => resolve(code));
  });
  const child: Child = {
    proc,
    home,
    workspace,
    stdoutLines,
    stderr: () => stderr,
    transport,
    exit,
  };
  return child;
}

afterEach(async () => {
  hang = false;
  await processes.cleanup();
  for (const r of hanging.splice(0)) r.destroy();
  await removeTempDirs(temps.splice(0));
});

const sessionsDirOf = (c: Child) => path.join(c.home, "sessions");
const lockOf = (c: Child, id: string) => path.join(sessionsDirOf(c), `${id}.lock`);

function readLog(c: Child, id: string): DurableEvent[] {
  return readFileSync(path.join(sessionsDirOf(c), `${id}.jsonl`), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as DurableEvent);
}

function comparable(view: SessionView) {
  const { revision: _revision, notices: _notices, ...rest } = view;
  return rest;
}

async function until(check: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`等待超时：${label}`);
}

async function exitWithin(c: Child, ms = 20_000): Promise<number | null> {
  return await Promise.race([
    c.exit,
    new Promise<never>((_, reject) =>
      setTimeout(() => {
        reject(new Error(`子进程未在 ${ms}ms 内退出；stderr：${c.stderr()}`));
      }, ms),
    ),
  ]);
}

describe("nctrn rpc --stdio（真实子进程）", () => {
  it("管线化握手和查询后立即关闭 stdin：全部回复写出再退出", async () => {
    const c = spawnRpc();
    c.proc.stdin.end(
      [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: 1,
            clientName: "probe",
            capabilities: { interactive: false },
          },
        },
        { jsonrpc: "2.0", id: 2, method: "runtime.listSessions", params: {} },
      ]
        .map((message) => JSON.stringify(message))
        .join("\n") + "\n",
    );
    expect(await exitWithin(c), c.stderr()).toBe(0);
    expect(c.stdoutLines.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({
        jsonrpc: "2.0",
        id: 1,
        result: expect.objectContaining({
          protocolVersion: 1,
          sessionsDir: sessionsDirOf(c),
        }),
      }),
      { jsonrpc: "2.0", id: 2, result: [] },
    ]);
  }, 60_000);

  it("握手 → 跑一轮会话 → 经 RPC 折叠的视图与磁盘日志重放相等；stdout 只有 JSON-RPC 报文", async () => {
    const c = spawnRpc();
    const client = createRpcClient(c.transport, { clientName: "e2e" });
    const init = await client.initialize();
    expect(init).toMatchObject({ protocolVersion: RPC_PROTOCOL_VERSION });
    expect(init.sessionsDir).toBe(sessionsDirOf(c));

    const models = await client.runtime.listModels();
    const ref = models[0]?.ref;
    if (ref === undefined) throw new Error("假服务没有给出模型");
    const { session } = await client.runtime.createSession({ model: ref });
    const events: RuntimeEvent[] = [];
    await session.subscribe((e) => events.push(e));
    expect(existsSync(lockOf(c, session.id))).toBe(true);

    expect(await session.submit({ text: "你好" })).toBe("done");
    expect(modelRequests).toBeGreaterThan(0);
    const log = readLog(c, session.id);
    const live = events.filter((e): e is DurableEvent => "seq" in e);
    expect(live.map((e) => e.seq)).toEqual(log.map((e) => e.seq));
    expect(events.some((e) => e.type === "message.assistant.delta")).toBe(true);

    // 全新订阅（重放）的视图 == 磁盘日志的进程内重放
    const replayed: RuntimeEvent[] = [];
    await session.subscribe((e) => replayed.push(e));
    const viaRpc = replaySessionView(replayed.filter((e): e is DurableEvent => "seq" in e));
    expect(comparable(viaRpc)).toEqual(comparable(replaySessionView(log)));
    expect(viaRpc.status).toBe("idle");

    // stdout 上只有协议报文：每一行都是 JSON-RPC 2.0 对象
    expect(c.stdoutLines.length).toBeGreaterThan(0);
    for (const line of c.stdoutLines) {
      const parsed = JSON.parse(line) as { jsonrpc?: string };
      expect(parsed.jsonrpc).toBe("2.0");
    }

    // 关闭 stdin：清理后正常退出，会话锁释放，日志完整
    c.proc.stdin.end();
    expect(await exitWithin(c), c.stderr()).toBe(0);
    expect(existsSync(lockOf(c, session.id))).toBe(false);
    expect(readLog(c, session.id).at(-1)?.type).toBe("turn.completed");
  }, 60_000);

  it("shutdown 请求：清理后回复，进程退出码 0，会话锁释放", async () => {
    const c = spawnRpc();
    const client = createRpcClient(c.transport, { clientName: "e2e" });
    await client.initialize();
    const ref = (await client.runtime.listModels())[0]?.ref;
    if (ref === undefined) throw new Error("假服务没有给出模型");
    const { session } = await client.runtime.createSession({ model: ref });
    expect(existsSync(lockOf(c, session.id))).toBe(true);
    await client.shutdown();
    expect(await exitWithin(c), c.stderr()).toBe(0);
    expect(existsSync(lockOf(c, session.id))).toBe(false);
  }, 60_000);

  it("stdin 关闭时中断运行中的 Turn：日志收束为 aborted，锁释放，进程退出", async () => {
    const c = spawnRpc();
    const client = createRpcClient(c.transport, { clientName: "e2e" });
    await client.initialize();
    const ref = (await client.runtime.listModels())[0]?.ref;
    if (ref === undefined) throw new Error("假服务没有给出模型");
    const { session } = await client.runtime.createSession({ model: ref });
    const events: RuntimeEvent[] = [];
    await session.subscribe((e) => events.push(e));

    hang = true;
    const turn = session.submit({ text: "会卡住的一轮" });
    turn.catch(() => undefined);
    await until(() => events.some((e) => e.type === "turn.started"), "Turn 开始");
    await until(() => hanging.length > 0, "假模型服务收到请求");

    c.proc.stdin.end();
    expect(await exitWithin(c), c.stderr()).toBe(0);
    await expect(turn).resolves.toBe("aborted");
    expect(existsSync(lockOf(c, session.id))).toBe(false);
    const completed = readLog(c, session.id).find((e) => e.type === "turn.completed");
    expect(completed?.type === "turn.completed" && completed.payload.reason).toBe("aborted");
  }, 60_000);

  it("不能交互的客户端（interactive:false）：握手成功，未创建会话就不产生日志文件", async () => {
    const c = spawnRpc();
    const client = createRpcClient(c.transport, { clientName: "e2e", interactive: false });
    await client.initialize();
    // 未创建会话：sessions 目录里没有日志
    const files = existsSync(sessionsDirOf(c)) ? readdirSync(sessionsDirOf(c)) : [];
    expect(files.filter((f) => f.endsWith(".jsonl"))).toEqual([]);
    await client.shutdown();
    expect(await exitWithin(c), c.stderr()).toBe(0);
  }, 60_000);

  it("经 RPC 用 custom-openai 预设 prepare + commit 添加服务商，listModels 立刻含新模型", async () => {
    // modelsDev:false 关闭 models.dev 联网刷新（config.md）：commit 内的
    // refreshModelsDev 不再访问网络，整个用例完全离线
    const c = spawnRpc(["rpc", "--stdio"], {
      env: { NCT_E2E_KEY: "e2e-credential" },
      seedHome: (home) => {
        writeFileSync(path.join(home, "config.json"), JSON.stringify({ modelsDev: false }));
      },
    });
    const client = createRpcClient(c.transport, { clientName: "e2e" });
    let changed = 0;
    client.onProvidersChanged(() => {
      changed += 1;
    });
    await client.initialize();

    const prepared = await client.provider.prepareProvider({
      presetId: "custom-openai",
      name: "e2e-setup",
      baseURL,
      credential: { kind: "env", name: "NCT_E2E_KEY" },
    });
    expect(prepared.modelCount).toBe(1);
    const result = await client.provider.commitProvider(prepared.draftId);
    expect(result).toMatchObject({ providerId: "e2e-setup", modelCount: 1 });
    // providersChanged 在 commit 响应之前到达，listModels 已是新值
    expect(changed).toBe(1);
    const models = await client.runtime.listModels();
    expect(models.map((m) => `${m.ref.provider}/${m.ref.model}`)).toContain("e2e-setup/e2e-model");

    c.proc.stdin.end();
    expect(await exitWithin(c), c.stderr()).toBe(0);
  }, 60_000);

  it("没有传输参数是用法错误：退出码 2，stdout 无输出", async () => {
    const c = spawnRpc(["rpc"]);
    expect(await exitWithin(c)).toBe(2);
    expect(c.stdoutLines).toEqual([]);
    expect(c.stderr()).toContain("--stdio");
  }, 60_000);

  it("握手前就关闭 stdin：干净退出，stdout 不写任何内容", async () => {
    const c = spawnRpc();
    c.proc.stdin.end();
    expect(await exitWithin(c), c.stderr()).toBe(0);
    expect(c.stdoutLines).toEqual([]);
  }, 60_000);
});
