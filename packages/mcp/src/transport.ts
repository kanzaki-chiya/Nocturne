/**
 * stdio Transport：platform.spawnPipe 之上实现 MCP SDK 的 Transport 接口。
 * 不用 SDK 自带的 StdioClientTransport——它内部自行 spawn，会绕过 platform 的
 * 进程树管理与环境白名单（ADR-0011）。协议为换行分隔的 JSON（stdio 标准）。
 */
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { PipeProcess } from "@nocturne/core";

/** 单行 JSON-RPC 消息上限：超过即按协议错误断开 */
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
/** stderr 保留的尾部字符数（失败诊断用） */
const STDERR_TAIL = 4_000;

export class StdioPipeTransport implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;
  sessionId?: string;

  private started = false;
  private closedEmitted = false;
  private stderrTail = "";
  private stderrDone = false;

  constructor(private readonly proc: PipeProcess) {}

  /** 进程 stderr 的尾部文本（崩溃/启动失败原因排查；内容可能含服务端任意输出） */
  stderrText(): string {
    return this.stderrTail;
  }

  /** stderr 读尽（连接已关、需要等剩余输出时） */
  whenStderrDrained(): Promise<void> {
    return this.stderrDrained;
  }

  private stderrDrainedResolve!: () => void;
  private readonly stderrDrained = new Promise<void>((r) => {
    this.stderrDrainedResolve = r;
  });

  start(): Promise<void> {
    if (this.started) return Promise.reject(new Error("StdioPipeTransport 已启动"));
    this.started = true;
    void this.pumpStdout();
    void this.pumpStderr();
    // 进程退出即连接关闭（崩溃检测的唯一事实来源）
    void this.proc.wait().then(() => {
      this.emitClosed();
    });
    return Promise.resolve();
  }

  send(message: JSONRPCMessage): Promise<void> {
    if (this.closedEmitted) return Promise.reject(new Error("MCP 连接已关闭"));
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
    return Promise.resolve();
  }

  async close(): Promise<void> {
    this.proc.stdin.end();
    await this.proc.kill();
    this.emitClosed();
  }

  private emitClosed(): void {
    if (this.closedEmitted) return;
    this.closedEmitted = true;
    this.onclose?.();
  }

  private async pumpStdout(): Promise<void> {
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of this.proc.stdoutRaw) {
        buf += decoder.decode(chunk, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (line === "") continue;
          try {
            this.onmessage?.(JSON.parse(line) as JSONRPCMessage);
          } catch (e) {
            this.onerror?.(
              e instanceof Error ? e : new Error(`MCP 消息解析失败：${line.slice(0, 200)}`),
            );
          }
        }
        if (buf.length > MAX_MESSAGE_BYTES) {
          this.onerror?.(new Error("MCP 服务器发送了超过 8MB 的未分行消息"));
          this.emitClosed();
          return;
        }
      }
    } catch (e) {
      if (!this.closedEmitted) {
        this.onerror?.(e instanceof Error ? e : new Error(String(e)));
      }
    } finally {
      // stdout 关闭即连接结束
      this.emitClosed();
    }
  }

  private async pumpStderr(): Promise<void> {
    try {
      for await (const chunk of this.proc.stderr) {
        this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL);
      }
    } catch {
      // stderr 只作诊断，读取失败忽略
    } finally {
      this.stderrDone = true;
      this.stderrDrainedResolve();
    }
  }
}
