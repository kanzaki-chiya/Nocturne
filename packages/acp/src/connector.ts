import {
  client,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type ClientConnection,
  type AnyMessage,
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
  PipeProcess,
  Platform,
  ToolContext,
} from "@nocturne/core";
import { stripVTControlCharacters } from "node:util";
import { probeAgent } from "./probe.js";
import { permissionOutcome, permissionSubjects } from "./permissions.js";

const CANCEL_GRACE_MS = 250;
const CLIENT_VERSION = "0.6.0";

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

export function createAcpConnector(
  platform: Platform,
  diagnostics?: Diagnostics,
): ExternalAgentConnector {
  return {
    async run(config, request, ctx) {
      return runAgent(platform, config, request, ctx, diagnostics);
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
): Promise<ExternalAgentOutcome> {
  const output: ExternalAgentOutput = {
    agent: config.name,
    transcriptPath: request.transcriptPath,
    stopReason: "error",
    permissionDecisions: { allowed: 0, denied: 0 },
  };
  let proc: PipeProcess | undefined;
  let connection: ClientConnection | undefined;
  let sessionId: string | undefined;
  let stopped = false;
  let interrupted: "cancelled" | "timeout" | undefined;
  let abortInput: (() => void) | undefined;
  let transcript = Promise.resolve();
  const { promise: failed, reject: rejectFailure } = Promise.withResolvers<never>();
  // 有些失败可能发生在启动前，始终安装 rejection handler。
  void failed.catch(() => undefined);
  const cancellation = new AbortController();
  const onAbort = () => {
    interrupted = "cancelled";
    cancellation.abort();
    rejectFailure(new AcpFailure("cancelled", `外部 agent ${config.name} 已中断`));
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
  try {
    try {
      await platform.fs.mkdir(platform.paths.dirname(request.transcriptPath), { mode: 0o700 });
      await platform.fs.writeFile(request.transcriptPath, "", { mode: 0o600 });
    } catch {
      transcriptFailed();
    }
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    if (ctx.signal.aborted) onAbort();
    if (interrupted) throw new AcpFailure(interrupted, `外部 agent ${config.name} 已中断`);
    if (request.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        interrupted = "timeout";
        cancellation.abort();
        rejectFailure(new AcpFailure("timeout", `外部 agent ${config.name} 执行超时`));
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
      cwd: request.cwd,
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
          const title = update.title ?? update.kind ?? update.status ?? "工具更新";
          ctx.progress(`${singleLine(config.name)}：${singleLine(title).slice(0, 300)}`, "info");
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
    sessionId = (
      await wait(
        connection.agent.request(AGENT_METHODS.session_new, { cwd: request.cwd, mcpServers: [] }),
      )
    ).sessionId;
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
    const response = await wait(
      connection.agent.request(AGENT_METHODS.session_prompt, {
        sessionId,
        prompt: [{ type: "text", text: request.task }],
      }),
    );
    output.stopReason = response.stopReason;
    await wait(transcript);
    stopped = true;
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
  }
}
