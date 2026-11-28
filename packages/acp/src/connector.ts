import {
  client,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type ClientConnection,
  type AnyMessage,
  type McpServer as AcpMcpServer,
  CLIENT_METHODS,
  AGENT_METHODS,
} from "@agentclientprotocol/sdk";
import type {
  Diagnostics,
  ExternalAgentConfig,
  ExternalAgentConnector,
  ExternalAgentOutcome,
  ExternalAgentOutput,
  ExternalAgentPermissionDecision,
  ExternalAgentRequest,
  ExternalWorkerRecord,
  ExternalWorkerStore,
  McpServerConfig,
  PipeProcess,
  Platform,
  ToolContext,
} from "@nocturne/core";
import { createExternalWorkerStore, createWorkerId } from "@nocturne/core";
import { computeProviderDigest, tryAcquireWorkerLock } from "@nocturne/core";
import { stripVTControlCharacters } from "node:util";
import { probeAgent } from "./probe.js";
import { permissionOutcome, permissionSubjects } from "./permissions.js";

const CANCEL_GRACE_MS = 250;
const CLIENT_VERSION = "0.70.0";

class AcpFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  setTimeout(() => {
    resolve(undefined);
  }, ms);
  return promise;
}

function singleLine(text: string): string {
  return stripVTControlCharacters(text)
    .replace(/\p{Cc}+/gu, " ")
    .trim();
}

/**
 * ADR-0127 第五阶段：把宿主按任务显式限定的团队 MCP 工具翻译为 ACP 线格式。
 *
 * 凭据边界：`{ stored: true }` 引用的是宿主凭据库，外部进程无权访问；
 * 若原样丢弃会静默降级（工具以缺失凭据启动失败），若解析宿主凭据库则
 * 违反"凭据不跨 worker 泄露"。因此遇到 stored 直接拒绝整个注入并说明，
 * 由调用方显式提供本次任务需要的明文值（它本就序列化到线格式上）。
 */
function translateSessionMcpServers(
  servers: readonly McpServerConfig[] | undefined,
): AcpMcpServer[] {
  if (servers === undefined || servers.length === 0) return [];
  const result: AcpMcpServer[] = [];
  const seenNames = new Set<string>();
  for (const server of servers) {
    const name = server.name.trim();
    if (name.length === 0) throw new AcpFailure("invalid_input", "注入 MCP 服务器名称不能为空");
    const lowerName = name.toLowerCase();
    if (seenNames.has(lowerName))
      throw new AcpFailure("invalid_input", `注入 MCP 服务器名称重复：${name}`);
    seenNames.add(lowerName);
    const type = server.type ?? (server.command !== undefined ? "stdio" : "http");
    if (type === "http") {
      if (server.url === undefined)
        throw new AcpFailure("invalid_input", `注入 MCP 服务器 ${name} 缺少 url`);
      const headers: { name: string; value: string }[] = [];
      for (const [headerName, value] of Object.entries(server.headers ?? {})) {
        if (typeof value !== "string")
          throw new AcpFailure(
            "invalid_input",
            `注入 MCP 服务器 ${name} 的请求头 ${headerName} 是宿主凭据引用（stored）；` +
              `凭据不跨进程泄露——如需注入请由调用方显式提供本次任务的明文值`,
          );
        headers.push({ name: headerName, value });
      }
      result.push({ type: "http", name, url: server.url, headers });
      continue;
    }
    // type 只有 stdio/http 两种（schema 限定），http 分支已 continue——此处必为 stdio。
    if (server.command === undefined || server.command.trim().length === 0)
      throw new AcpFailure("invalid_input", `注入 MCP 服务器 ${name} 缺少 command`);
    const env: { name: string; value: string }[] = [];
    for (const [varName, value] of Object.entries(server.env ?? {})) {
      if (typeof value !== "string")
        throw new AcpFailure(
          "invalid_input",
          `注入 MCP 服务器 ${name} 的环境变量 ${varName} 是宿主凭据引用（stored）；` +
            `凭据不跨进程泄露——如需注入请由调用方显式提供本次任务的明文值`,
        );
      env.push({ name: varName, value });
    }
    result.push({
      name,
      command: server.command,
      args: [...(server.args ?? [])],
      env,
    });
  }
  return result;
}

export function createAcpConnector(
  platform: Platform,
  diagnostics?: Diagnostics,
): ExternalAgentConnector {
  // ADR-0127 第五阶段：worker 持久化 store 由 connector 自己管理——
  // 目录派生自 platform.nocturneHome()，调用方不需要关心装配。
  // 同一 NOCTURNE_HOME 下不同 Runtime/进程看到同一份 worker 登记。
  const store = createExternalWorkerStore({
    fs: platform.fs,
    paths: platform.paths,
    dir: platform.paths.join(platform.nocturneHome(), "external-workers"),
    onCorrupt: (workerId, reason) => {
      diagnostics?.record("external_worker.store_corrupt", { workerId, reason });
    },
  });
  // ADR-0127 第五阶段返工：同一 worker 的并发续派需要跨进程互斥。
  // 进程内 Promise 链只在单 connector 实例生效，且完成后键不释放会单调增长；
  // 共享同一 NOCTURNE_HOME 的独立宿主/connector（两个 CLI 进程、宿主重启叠加）
  // 不受其约束，可能同时 session/load 同一外部会话导致重复轮次与上下文错序。
  // 因此互斥改为两层：
  //   1. 进程内链（本实例内严格串行，且完成后删除键——Map 不再单调增长）；
  //   2. `<NOCTURNE_HOME>/external-workers/<workerId>.lock.db` 跨进程互斥锁
  //      （tryAcquireWorkerLock）：每 worker 一个独立 SQLite 数据库文件，获取锁即
  //      `BEGIN IMMEDIATE` 写事务并保持不提交。持有者存活时竞争者立即
  //      `database is locked` → 可识别的 worker_busy，不等待、不重复 prompt；
  //      持有进程崩溃时 OS 关闭句柄、SQLite 回滚未完成事务，锁自动释放——
  //      无 pid/开机时间/token 失效判定，不存在"检查与回收"临界区，不留永久锁。
  // 独立 worker（不同 workerId）锁文件独立、写事务互不干扰，天然保持并行。
  const workerChains = new Map<string, Promise<unknown>>();
  const runSerialized = (
    workerId: string,
    config: ExternalAgentConfig,
    request: ExternalAgentRequest,
    ctx: ToolContext,
  ): Promise<ExternalAgentOutcome> => {
    const invoke = (): Promise<ExternalAgentOutcome> =>
      runAgent(platform, config, request, ctx, diagnostics, store);
    const previous = workerChains.get(workerId) ?? Promise.resolve();
    const current = previous.then(invoke, invoke);
    // 完成后删除键：链尾 Promise 只作串行纽带，保留已完成键会让 Map 单调增长。
    const tail = current.then(
      () => undefined,
      () => undefined,
    );
    workerChains.set(workerId, tail);
    void tail.then(() => {
      // 只在自己仍是链尾时删除——后续调用已接上新链则保留纽带。
      if (workerChains.get(workerId) === tail) workerChains.delete(workerId);
    });
    return current;
  };
  return {
    async run(config, request, ctx) {
      // 续派或新建可续派 worker 的调用按 workerId 串行；
      // 一次性调用（无 workerId 且不支持 loadSession）不入链——它本就是独立进程独立会话。
      const chainKey = request.workerId;
      if (chainKey === undefined) {
        return runAgent(platform, config, request, ctx, diagnostics, store);
      }
      return runSerialized(chainKey, config, request, ctx);
    },
    async probe(config, input) {
      return probeAgent(platform, config, input);
    },
  };
}

async function runAgent(
  platform: Platform,
  config: ExternalAgentConfig,
  request: ExternalAgentRequest,
  ctx: ToolContext,
  diagnostics: Diagnostics | undefined,
  workerStore?: ExternalWorkerStore,
): Promise<ExternalAgentOutcome> {
  const output: ExternalAgentOutput = {
    agent: config.name,
    transcriptPath: request.transcriptPath,
    stopReason: "error",
    permissionDecisions: { allowed: 0, denied: 0 },
  };
  // ADR-0127 第五阶段：续派路径预处理。
  // - 无 store 时 workerId 不被支持（旧一次性语义）；
  // - 续派时按 worker 记录的 cwd 覆盖本次执行 cwd——任务的工作树属于 worker，
  //   调用方传入的 cwd 不再适用（不匹配由 Core 上层在调用前已经判定）。
  let existingWorker: ExternalWorkerRecord | undefined;
  if (request.workerId !== undefined) {
    if (workerStore === undefined) {
      const message = `外部 worker 续派未启用（无 worker store）`;
      output.stopReason = "worker_unavailable";
      return {
        status: "error",
        modelContent: message,
        error: { code: "worker_unavailable", message },
        output,
      };
    }
    existingWorker = await workerStore.read(request.workerId);
    if (existingWorker === undefined) {
      const message = `外部 worker ${request.workerId} 不存在或记录已损坏`;
      output.stopReason = "worker_not_found";
      output.resumeFailure = message;
      return {
        status: "error",
        modelContent: message,
        error: { code: "worker_not_found", message },
        output,
      };
    }
    if (existingWorker.agentName.toLowerCase() !== config.name.toLowerCase()) {
      const message =
        `外部 worker ${request.workerId} 属于 agent ${existingWorker.agentName}，` +
        `与本次调用 agent ${config.name} 不匹配`;
      output.stopReason = "worker_mismatch";
      output.resumeFailure = message;
      return {
        status: "error",
        modelContent: message,
        error: { code: "worker_mismatch", message },
        output,
      };
    }
    if (!existingWorker.loadSessionCapable) {
      const message =
        `外部 worker ${request.workerId} 所属的 agent ${existingWorker.agentName} ` +
        `不支持会话恢复（loadSession=false），无法续派`;
      output.stopReason = "worker_unresumable";
      output.resumeFailure = message;
      return {
        status: "error",
        modelContent: message,
        error: { code: "worker_unresumable", message },
        output,
      };
    }
  }
  let proc: PipeProcess | undefined;
  let connection: ClientConnection | undefined;
  let sessionId: string | undefined;
  let stopped = false;
  let interrupted: "cancelled" | "timeout" | undefined;
  let abortInput: (() => void) | undefined;
  let transcript = Promise.resolve();
  const titles = new Map<string, { title: string; failed: boolean }>();
  const recentProgress: string[] = [];
  const agentName = singleLine(config.name).slice(0, 100);
  const timeoutMessage = () =>
    `外部 agent ${agentName} 执行超时${recentProgress.length ? `；最近进度：${recentProgress.join("；")}` : ""}。它可能已修改工作区文件，请先检查 git status`;
  const { promise: failed, reject: rejectFailure } = Promise.withResolvers<never>();
  // 有些失败可能发生在启动前，始终安装 rejection handler。
  void failed.catch(() => undefined);
  const cancellation = new AbortController();
  const onAbort = () => {
    interrupted =
      ctx.signal.reason instanceof Error && ctx.signal.reason.name === "TimeoutError"
        ? "timeout"
        : "cancelled";
    cancellation.abort();
    rejectFailure(
      new AcpFailure(
        interrupted,
        interrupted === "timeout" ? timeoutMessage() : `外部 agent ${agentName} 已中断`,
      ),
    );
  };
  let timer: NodeJS.Timeout | undefined;
  let text = "";
  const transcriptFailed = () => {
    if (output.transcriptError) return;
    output.transcriptError = true;
    diagnostics?.record("external_agent.transcript_failed", {
      agent: config.name,
      callId: ctx.callId,
      transcriptPath: request.transcriptPath,
    });
  };
  const record = (data: unknown): Promise<void> => {
    if (output.transcriptError) return transcript;
    transcript = transcript.then(async () => {
      // 已排队的写入也必须在执行时检查，避免首个失败后继续触碰文件。
      if (output.transcriptError) return;
      try {
        await platform.fs.appendFile(request.transcriptPath, `${JSON.stringify(data)}\n`, {
          mode: 0o600,
        });
      } catch {
        transcriptFailed();
      }
    });
    return transcript;
  };
  const wait = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, failed]);
  // ADR-0127 第五阶段返工：跨进程互斥锁在 worker 记录校验通过之后、任何副作用
  // （transcript 落盘、spawn、session/load）之前取得。顺序很关键——若先取锁再读记录，
  // 对不存在/归属不符/不可恢复的 worker 也会空持锁，且 external-workers 目录可能
  // 尚未创建（worker_not_found 场景）导致锁数据库无从落盘。
  // 用 holder 变量把锁带进 try/finally：只有成功取锁才在 finally 释放；
  // 校验失败（worker_not_found 等早期 return）发生在取锁之前，不触碰锁。
  let workerLock: Awaited<ReturnType<typeof tryAcquireWorkerLock>> | undefined;
  if (existingWorker !== undefined) {
    const lockDir = platform.paths.join(platform.nocturneHome(), "external-workers");
    await platform.fs.mkdir(lockDir, { mode: 0o700 }).catch(() => undefined);
    const lockPath = platform.paths.join(lockDir, `${existingWorker.workerId}.lock`);
    workerLock = await tryAcquireWorkerLock(platform, lockPath);
    if (workerLock === undefined) {
      const message =
        `外部 worker ${existingWorker.workerId} 正被另一个宿主进程续派（锁 ${lockPath}）；` +
        `同一 worker 不能并发恢复，请稍后重试`;
      output.stopReason = "worker_busy";
      output.resumeFailure = message;
      return {
        status: "error",
        modelContent: message,
        error: { code: "worker_busy", message },
        output,
      };
    }
  }
  try {
    // ADR-0127 第五阶段返工：真正的归属核对已上移到 Core 装配侧
    // （按调用方真实工作区比对 worker 记录 cwd，见 externalRunner）。
    // 这里的比较是纵深防御的兜底一致性检查：Core 现在传入的 request.cwd
    // 已是「worker 原工作树」，正常情况下恒等于 existingWorker.cwd；
    // 仅在调用方绕过装配层直传不一致 cwd 时才可能触发。保留它作为
    // spawn 前的最后防线，不依赖上层必然正确。
    if (existingWorker !== undefined && !platform.paths.equals(existingWorker.cwd, request.cwd)) {
      const message =
        `外部 worker ${existingWorker.workerId} 的原工作树是 ${existingWorker.cwd}，` +
        `与本次调用 cwd ${request.cwd} 不匹配`;
      output.stopReason = "worker_mismatch";
      output.resumeFailure = message;
      return {
        status: "error",
        modelContent: message,
        error: { code: "worker_mismatch", message },
        output,
      };
    }
    // ADR-0127 第五阶段：按任务显式限定的注入 MCP 翻译同样提前——
    // 配置非法（stored 凭据引用、缺字段、重名）在 spawn 进程前拒绝。
    // 每次调用（新建或恢复）都只绑定当前请求明确提供的工具：
    // 恢复路径不会沿用 worker 首次创建时的注入——那些属于当时那次调用，
    // 不在本次任务范围内，避免工具/凭据跨任务残留。
    let sessionMcpServers: AcpMcpServer[];
    try {
      sessionMcpServers = translateSessionMcpServers(request.sessionMcpServers);
    } catch (error) {
      if (error instanceof AcpFailure) {
        output.stopReason = "invalid_input";
        return {
          status: "error",
          modelContent: error.message,
          error: { code: error.code, message: error.message },
          output,
        };
      }
      throw error;
    }
    try {
      await platform.fs.mkdir(platform.paths.dirname(request.transcriptPath), { mode: 0o700 });
      await platform.fs.writeFile(request.transcriptPath, "", { mode: 0o600 });
    } catch {
      transcriptFailed();
    }
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    if (ctx.signal.aborted) onAbort();
    if (interrupted) await failed;
    if (request.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        interrupted = "timeout";
        cancellation.abort();
        rejectFailure(new AcpFailure("timeout", timeoutMessage()));
      }, request.timeoutMs);
      timer.unref();
    }
    const env =
      config.env === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(config.env).map(([key, value]) => [
              key,
              value.replaceAll(
                /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
                (_match, name: string) => platform.env(name) ?? "",
              ),
            ]),
          );
    proc = platform.process.spawnPipe(config.command, config.args, {
      // ADR-0127 第五阶段：续派时进程 cwd 用 worker 原工作树——
      // 外部 agent 进程的工作目录与会话工作树一致，避免换目录后路径错位。
      cwd: existingWorker?.cwd ?? request.cwd,
      envMode: "minimal",
      env,
    });
    const processHandle = proc;
    void processHandle.exited().then(async (exit) => {
      // 成功退出可能早于管道中已写入的最终 response；给 SDK 一个有界排空机会。
      if (exit.code === 0 && !stopped) {
        await Promise.race([connection?.closed ?? delay(CANCEL_GRACE_MS), delay(CANCEL_GRACE_MS)]);
      }
      if (!stopped)
        rejectFailure(
          new AcpFailure(
            "external_agent_crashed",
            `外部 agent ${config.name} 进程退出（${exit.code ?? exit.signal ?? "启动失败"}）`,
          ),
        );
    });
    // stderr 必须持续排空，但不混入模型内容、用户进度或原始诊断。
    void (async () => {
      try {
        for await (const _chunk of processHandle.stderr) {
          /* drain */
        }
      } catch {
        /* stderr 不参与协议 */
      }
    })();
    const iterator = processHandle.stdoutRaw[Symbol.asyncIterator]();
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        abortInput = () => {
          controller.error(new Error("ACP 连接已关闭"));
        };
      },
      async pull(controller) {
        try {
          const next = await iterator.next();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        } catch (error) {
          controller.error(error);
        }
      },
    });
    const decoder = new TextDecoder();
    const outgoing = new WritableStream<Uint8Array>({
      write(chunk) {
        processHandle.stdin.write(decoder.decode(chunk, { stream: true }));
      },
      close() {
        processHandle.stdin.end();
      },
    });
    const stream = ndJsonStream(outgoing, input);
    const audited = stream.readable.pipeThrough(
      new TransformStream<AnyMessage, AnyMessage>({
        async transform(message, controller) {
          if ("method" in message && message.method === CLIENT_METHODS.session_update && !stopped) {
            // 在 SDK schema 归一化之前保存原始 params，保留扩展字段与原始 tool 数据。
            await record(message.params);
          }
          controller.enqueue(message);
        },
      }),
    );
    const app = client()
      .onNotification(CLIENT_METHODS.session_update, ({ params: notification }) => {
        if (stopped) return;
        const update = notification.update;
        if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
          text += update.content.text;
        } else if (
          update.sessionUpdate === "tool_call" ||
          update.sessionUpdate === "tool_call_update"
        ) {
          const previous = titles.get(update.toolCallId);
          const title =
            update.title === undefined || update.title === null
              ? update.status === "failed"
                ? previous?.title
                : undefined
              : singleLine(update.title).slice(0, 300);
          if (!title) return;
          const failed = update.status === "failed";
          if (previous?.title === title && (!failed || previous.failed)) return;
          titles.set(update.toolCallId, { title, failed });
          const progress = `${title}${failed ? "（失败）" : ""}`;
          recentProgress.push(progress);
          if (recentProgress.length > 5) recentProgress.shift();
          ctx.progress(`${agentName}：${progress}`, "info");
        }
      })
      .onRequest(CLIENT_METHODS.session_request_permission, async ({ params }) => {
        const subjects = permissionSubjects(params.toolCall, request.cwd, platform.paths);
        let decision: ExternalAgentPermissionDecision = {
          decision: "deny",
          source: "unsupported_kind",
        };
        if (subjects !== undefined && !cancellation.signal.aborted && !stopped) {
          const pending = Promise.withResolvers<ExternalAgentPermissionDecision>();
          const cancel = () => {
            pending.resolve({ decision: "deny", source: "cancelled" });
          };
          cancellation.signal.addEventListener("abort", cancel, { once: true });
          try {
            decision = await Promise.race([request.requestPermission(subjects), pending.promise]);
          } finally {
            cancellation.signal.removeEventListener("abort", cancel);
          }
        }
        const selected = permissionOutcome(
          params.options,
          decision.decision === "allow" && !cancellation.signal.aborted && !stopped,
        );
        if (cancellation.signal.aborted) selected.response = { outcome: { outcome: "cancelled" } };
        const effective = {
          decision: selected.allowed ? "allow" : "deny",
          source: cancellation.signal.aborted
            ? "cancelled"
            : decision.decision === "allow" && !selected.allowed
              ? "missing_allow_once"
              : decision.source,
        };
        if (!stopped) {
          output.permissionDecisions[selected.allowed ? "allowed" : "denied"]++;
          const entry = {
            type: "permission",
            request: params,
            subjects: subjects ?? [],
            ...effective,
            outcome: selected.response.outcome,
          };
          await record(entry);
          diagnostics?.record("external_agent.permission", {
            agent: config.name,
            callId: ctx.callId,
            ...entry,
          });
        }
        return selected.response;
      });
    connection = app.connect({ writable: stream.writable, readable: audited });
    void connection.closed.then(() => {
      if (!stopped)
        rejectFailure(
          new AcpFailure("external_agent_crashed", `外部 agent ${config.name} 连接关闭`),
        );
    });
    const initialized = await wait(
      connection.agent.request(AGENT_METHODS.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: "nocturne", version: CLIENT_VERSION },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      }),
    );
    if (initialized.agentInfo?.version) output.agentVersion = initialized.agentInfo.version;
    const loadSessionCapable = initialized.agentCapabilities?.loadSession === true;
    // ADR-0127 第五阶段：续派走 session/load；首次走 session/new 并视能力登记 worker。
    if (existingWorker !== undefined) {
      try {
        await wait(
          connection.agent.request(AGENT_METHODS.session_load, {
            sessionId: existingWorker.externalSessionId,
            cwd: existingWorker.cwd,
            mcpServers: sessionMcpServers,
          }),
        );
        sessionId = existingWorker.externalSessionId;
        output.resumed = true;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        const message =
          `外部 worker ${existingWorker.workerId} 恢复失败：${detail}。` +
          `不自动新建会话冒充恢复。`;
        output.stopReason = "worker_resume_failed";
        output.resumeFailure = message;
        return {
          status: "error",
          modelContent: message,
          error: { code: "worker_resume_failed", message },
          output,
        };
      }
    } else {
      sessionId = (
        await wait(
          connection.agent.request(AGENT_METHODS.session_new, {
            cwd: request.cwd,
            mcpServers: sessionMcpServers,
          }),
        )
      ).sessionId;
      output.externalSessionId = sessionId;
      output.resumed = false;
    }
    // ADR-0127 第五阶段：mode/configOptions 仅在新建会话时下发；
    // 恢复路径会话状态由外部 agent 自己持久化，重发会重置已建立的会话配置。
    if (existingWorker === undefined) {
      if (config.mode !== undefined)
        await wait(
          connection.agent.request(AGENT_METHODS.session_set_mode, {
            sessionId,
            modeId: config.mode,
          }),
        );
      for (const [configId, value] of Object.entries(config.configOptions ?? {})) {
        try {
          await wait(
            connection.agent.request(AGENT_METHODS.session_set_config_option, {
              sessionId,
              configId,
              value,
            }),
          );
        } catch (error) {
          if (error instanceof RequestError && error.code !== -32000)
            throw new AcpFailure(
              "external_agent_config_rejected",
              `外部 agent ${config.name} 拒绝配置项 ${configId}：${error.message}`,
            );
          throw error;
        }
      }
    }
    const response = await wait(
      connection.agent.request(AGENT_METHODS.session_prompt, {
        sessionId,
        prompt: [{ type: "text", text: request.task }],
      }),
    );
    output.stopReason = response.stopReason;
    await wait(transcript);
    stopped = true;
    // ADR-0127 第五阶段：登记/续用 worker。
    // 一次性调用且 agent 支持 loadSession 时登记新 worker；
    // 续派成功时仅更新 lastUsedAt——记录其余字段不可变。
    if (workerStore !== undefined) {
      if (existingWorker !== undefined) {
        output.workerId = existingWorker.workerId;
        await workerStore.touch(existingWorker.workerId, new Date().toISOString()).catch(() => {
          diagnostics?.record("external_agent.worker_touch_failed", {
            agent: config.name,
            workerId: existingWorker.workerId,
          });
        });
      } else if (loadSessionCapable) {
        const workerId = createWorkerId();
        const now = new Date().toISOString();
        const identity = {
          command: config.command,
          args: [...config.args],
          envKeys: Object.keys(config.env ?? {}),
          ...(config.mode !== undefined ? { mode: config.mode } : {}),
          ...(config.configOptions !== undefined
            ? { configOptions: { ...config.configOptions } }
            : {}),
        };
        const record: ExternalWorkerRecord = {
          formatVersion: 1,
          workerId,
          agentName: config.name,
          externalSessionId: sessionId,
          cwd: request.cwd,
          // 返工：写入身份摘要——续派时 Core 重算当前同名 agent 配置的摘要并比对，
          // 启动目标改变（command/args 等）在披露会话 ID 或注入 MCP 前拒绝。
          providerDigest: computeProviderDigest(identity),
          providerSnapshot: {
            command: config.command,
            envKeys: Object.keys(config.env ?? {}),
          },
          loadSessionCapable: true,
          agentReportedName: initialized.agentInfo?.name,
          agentVersion: initialized.agentInfo?.version,
          createdAt: now,
          lastUsedAt: now,
        };
        try {
          await workerStore.write(record);
          output.workerId = workerId;
        } catch (err) {
          diagnostics?.record("external_agent.worker_write_failed", {
            agent: config.name,
            workerId,
            detail: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    return { status: "ok", modelContent: text, output };
  } catch (error) {
    const code =
      interrupted ??
      (error instanceof RequestError && error.code === -32000
        ? "external_agent_auth_required"
        : error instanceof AcpFailure
          ? error.code
          : "external_agent_failed");
    const message =
      code === "external_agent_auth_required"
        ? `外部 agent ${config.name} 需要认证，请先在该命令行工具中登录后重试`
        : error instanceof Error
          ? error.message
          : String(error);
    output.stopReason = code;
    diagnostics?.record("external_agent.failed", { agent: config.name, callId: ctx.callId, code });
    return { status: "error", modelContent: message, error: { code, message }, output };
  } finally {
    clearTimeout(timer);
    ctx.signal.removeEventListener("abort", onAbort);
    cancellation.abort();
    if (interrupted && sessionId !== undefined && connection !== undefined) {
      // cancel 是通知；对忽略 cancel 的 agent 只给固定宽限，绝不等 prompt 永久返回。
      await Promise.race([
        connection.agent.notify(AGENT_METHODS.session_cancel, { sessionId }).catch(() => undefined),
        delay(CANCEL_GRACE_MS),
      ]);
      await delay(CANCEL_GRACE_MS);
    }
    stopped = true;
    await proc?.kill();
    connection?.close();
    proc?.detachOutput();
    abortInput?.();
    proc?.stdin.end();
    await transcript.catch(() => undefined);
    // 跨进程互斥锁最后释放——保证进程树清理、transcript 落盘全部完成后，
    // 其他宿主才允许对同一 worker 发起新的 session/load。
    await workerLock?.release();
  }
}
