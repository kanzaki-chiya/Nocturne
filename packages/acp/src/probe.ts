import {
  AGENT_METHODS,
  client,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
} from "@agentclientprotocol/sdk";
import type { ClientConnection } from "@agentclientprotocol/sdk";
import type {
  ExternalAgentConfig,
  ExternalAgentProbeResult,
  PipeProcess,
  Platform,
} from "@nocturne/core";

const PROBE_TIMEOUT_MS = 10_000;

/** 探测仅握手与建立会话，绝不调用 prompt 或 authenticate。 */
export async function probeAgent(
  platform: Platform,
  config: ExternalAgentConfig,
  input: { nocturneHome: string; timeoutMs?: number | undefined },
): Promise<ExternalAgentProbeResult> {
  const started = Date.now();
  const result: ExternalAgentProbeResult = { ok: false, durationMs: 0, configOptions: [] };
  let cwd: string | undefined;
  let proc: PipeProcess | undefined;
  let connection: ClientConnection | undefined;
  let abortInput: (() => void) | undefined;
  let stopped = false;
  const failed = Promise.withResolvers<never>();
  void failed.promise.catch(() => undefined);
  const timer = setTimeout(() => {
    failed.reject(
      Object.assign(new Error(`外部 agent ${config.name} 探测超时`), { code: "timeout" }),
    );
  }, input.timeoutMs ?? PROBE_TIMEOUT_MS);
  const wait = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, failed.promise]);
  try {
    const env = Object.fromEntries(
      Object.entries(config.env ?? {}).map(([key, value]) => [
        key,
        value.replaceAll(
          /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
          (_match, name: string) => platform.env(name) ?? "",
        ),
      ]),
    );
    const windows = process.platform === "win32";
    const envValue = (name: string) =>
      Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1] ?? platform.env(name);
    const hasPath = /[/\\]/.test(config.command);
    const directories = hasPath
      ? [""]
      : (envValue("PATH") ?? "").split(windows ? ";" : ":").filter(Boolean);
    const extensions =
      windows && !/\.[^/\\.]+$/.test(config.command)
        ? ["", ...(envValue("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";")]
        : [""];
    let command: string | undefined;
    for (const directory of directories) {
      for (const extension of extensions) {
        const candidate = platform.paths.resolve(
          directory.replace(/^"|"$/g, ""),
          config.command + extension,
        );
        try {
          if ((await wait(platform.fs.stat(candidate))).type === "file") {
            command = candidate;
            break;
          }
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "timeout") throw error;
        }
      }
      if (command !== undefined) break;
    }
    if (command === undefined)
      throw Object.assign(new Error(`PATH 中未找到外部 agent 命令 ${config.command}`), {
        code: "external_agent_not_installed",
      });
    await wait(platform.fs.mkdir(input.nocturneHome, { mode: 0o700 }));
    // 目录分配必须等待完成，避免超时后迟到的目录无人清理。
    cwd = await platform.fs.mkdtemp(platform.paths.join(input.nocturneHome, "acp-probe-"));
    await wait(Promise.resolve());
    proc = platform.process.spawnPipe(command, config.args, { cwd, envMode: "minimal", env });
    const processHandle = proc;
    void processHandle.exited().then(() => {
      if (!stopped)
        failed.reject(
          Object.assign(new Error(`外部 agent ${config.name} 探测进程退出`), {
            code: "external_agent_crashed",
          }),
        );
    });
    void (async () => {
      try {
        for await (const _chunk of processHandle.stderr) {
          /* drain */
        }
      } catch {
        /* 非协议通道 */
      }
    })();
    const iterator = processHandle.stdoutRaw[Symbol.asyncIterator]();
    const incoming = new ReadableStream<Uint8Array>({
      start(controller) {
        abortInput = () => {
          controller.error(new Error("ACP 探测连接已关闭"));
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
    connection = client().connect(ndJsonStream(outgoing, incoming));
    void connection.closed.then(() => {
      if (!stopped)
        failed.reject(
          Object.assign(new Error(`外部 agent ${config.name} 探测连接关闭`), {
            code: "external_agent_crashed",
          }),
        );
    });
    const initialized = await wait(
      connection.agent.request(AGENT_METHODS.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: "nocturne", version: "0.6.0" },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      }),
    );
    if (initialized.agentInfo)
      result.agentInfo = {
        name: initialized.agentInfo.name,
        version: initialized.agentInfo.version,
        ...(initialized.agentInfo.title ? { title: initialized.agentInfo.title } : {}),
      };
    result.authMethods = (initialized.authMethods ?? []).map(({ id, name, description }) => ({
      id,
      name,
      ...(description ? { description } : {}),
    }));
    const session = await wait(
      connection.agent.request(AGENT_METHODS.session_new, { cwd, mcpServers: [] }),
    );
    result.configOptions = (session.configOptions ?? []).map((option) => ({
      id: option.id,
      name: option.name,
      ...(option.description ? { description: option.description } : {}),
      ...(option.category ? { category: option.category } : {}),
      currentValue: String(option.currentValue),
      options:
        option.type === "select"
          ? option.options
              .flatMap((entry) => ("group" in entry ? entry.options : [entry]))
              .map(({ value, name }) => ({ value, name }))
          : [],
    }));
    result.ok = true;
  } catch (error) {
    const code =
      error instanceof RequestError && error.code === -32000
        ? "external_agent_auth_required"
        : error instanceof Error && "code" in error && typeof error.code === "string"
          ? error.code
          : "external_agent_failed";
    result.error = {
      code,
      message:
        code === "external_agent_auth_required"
          ? `外部 agent ${config.name} 需要认证，请先在该命令行工具中登录后重试`
          : error instanceof Error
            ? error.message
            : String(error),
    };
  } finally {
    stopped = true;
    clearTimeout(timer);
    await proc?.kill();
    connection?.close();
    proc?.detachOutput();
    abortInput?.();
    proc?.stdin.end();
    if (cwd !== undefined) await platform.fs.rm(cwd, { recursive: true, force: true });
    result.durationMs = Date.now() - started;
  }
  return result;
}
