import type { LineTransport } from "@nocturne/rpc/client";

import type { DesktopHost } from "./host";
import type { BackendMessage } from "./types";

/** Rust 外壳命令失败（{ code, message }）。 */
export class DesktopError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DesktopError";
    this.code = code;
  }
}

function asDesktopError(error: unknown): DesktopError {
  if (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { code?: unknown }).code === "string" &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    const e = error as { code: string; message: string };
    return new DesktopError(e.code, e.message);
  }
  return new DesktopError("io", error instanceof Error ? error.message : String(error));
}

/**
 * 把 Tauri 后端命令包装成 rpc/client 的 LineTransport（ADR-0046 第 3 节）。
 * send 经 backend_send 逐行写入（promise 链串行保证顺序）；
 * stdout 行与退出通知经 backend_open 传入的 channel 推回。
 */
export class TauriLineTransport implements LineTransport {
  readonly backendId: number;
  /** 后台进程退出（或被强杀）时 resolve；code 为退出码（强杀/拿不到为 null） */
  readonly exited: Promise<{ code: number | null; stderr: string[] }>;

  private readonly host: DesktopHost;
  private buffered: string[] = [];
  private lineHandler: ((line: string) => void) | undefined;
  private closeHandler: (() => void) | undefined;
  private closedResult: { code: number | null; stderr: string[] } | undefined;
  private closeFired = false;
  private closeInvoked = false;
  private chain: Promise<void> = Promise.resolve();

  private constructor(host: DesktopHost, backendId: number) {
    this.host = host;
    this.backendId = backendId;
    let resolveExited!: (v: { code: number | null; stderr: string[] }) => void;
    this.exited = new Promise((resolve) => {
      resolveExited = resolve;
    });
    this.resolveExited = resolveExited;
  }

  private readonly resolveExited: (v: { code: number | null; stderr: string[] }) => void;

  static async open(host: DesktopHost, workspace: string): Promise<TauriLineTransport> {
    // transport 建成之前到达的消息先存起来，之后按序灌给它
    const dispatch: { fn?: (m: BackendMessage) => void } = {};
    const early: BackendMessage[] = [];
    const channel = host.createChannel((m) => {
      if (dispatch.fn !== undefined) dispatch.fn(m);
      else early.push(m);
    });
    let backendId: number;
    try {
      backendId = (await host.invoke("backend_open", { workspace, channel })) as number;
    } catch (error) {
      throw asDesktopError(error);
    }
    const transport = new TauriLineTransport(host, backendId);
    dispatch.fn = (m) => {
      transport.handle(m);
    };
    for (const m of early) transport.handle(m);
    early.length = 0;
    return transport;
  }

  private handle(message: BackendMessage): void {
    if (message.kind === "line") {
      if (this.lineHandler !== undefined) this.lineHandler(message.line);
      else this.buffered.push(message.line);
      return;
    }
    // closed：在已交付完缓冲行之后触发 onClose
    this.closedResult = { code: message.code, stderr: message.stderr };
    this.resolveExited(this.closedResult);
    this.maybeFireClose();
  }

  private maybeFireClose(): void {
    if (
      this.closedResult !== undefined &&
      this.buffered.length === 0 &&
      this.closeHandler !== undefined &&
      !this.closeFired
    ) {
      this.closeFired = true;
      this.closeHandler();
    }
  }

  send(line: string): void {
    if (this.closedResult !== undefined) return;
    const backendId = this.backendId;
    // promise 链串行：invoke 完成顺序与调用顺序一致，写失败吞掉（断开会经 closed 体现）
    this.chain = this.chain.then(() =>
      this.host.invoke("backend_send", { backendId, line }).then(
        () => undefined,
        () => undefined,
      ),
    );
  }

  onLine(handler: (line: string) => void): void {
    this.lineHandler = handler;
    const lines = this.buffered;
    this.buffered = [];
    for (const line of lines) handler(line);
    this.maybeFireClose();
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
    this.maybeFireClose();
  }

  flush(): Promise<void> {
    return this.chain;
  }

  close(): void {
    if (this.closeInvoked) return;
    this.closeInvoked = true;
    void this.host.invoke("backend_close", { backendId: this.backendId }).catch(() => undefined);
  }
}
