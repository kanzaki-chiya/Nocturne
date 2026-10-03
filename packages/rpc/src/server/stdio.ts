/**
 * stdio 传输：从输入流按行读、向输出流按行写（ADR-0044 第 1 节）。
 * 输出流只写 JSON-RPC 报文；诊断一律走 stderr，由调用方负责。
 */
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import type { LineTransport } from "../shared/transport.js";

export function createStdioTransport(input: Readable, output: Writable): LineTransport {
  let lineHandler: ((line: string) => void) | undefined;
  let closeHandler: (() => void) | undefined;
  const pending: string[] = [];
  let ended = false;
  let closeNotified = false;

  const notifyClose = (): void => {
    if (closeNotified || closeHandler === undefined || !ended) return;
    closeNotified = true;
    closeHandler();
  };

  const reader = createInterface({ input, crlfDelay: Infinity });
  reader.on("line", (line) => {
    if (lineHandler === undefined) pending.push(line);
    else lineHandler(line);
  });
  reader.on("close", () => {
    ended = true;
    notifyClose();
  });
  // 输出管道被对端关掉（EPIPE）：当作连接结束，不让它变成未处理错误
  output.on("error", () => {
    reader.close();
  });

  return {
    send(line) {
      if (ended) return;
      output.write(`${line}\n`);
    },
    onLine(handler) {
      lineHandler = handler;
      for (const line of pending.splice(0)) handler(line);
    },
    onClose(handler) {
      closeHandler = handler;
      notifyClose();
    },
    close() {
      reader.close();
    },
  };
}
