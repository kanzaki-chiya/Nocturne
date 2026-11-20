import { constants, createDeflateRaw } from "node:zlib";
import type { StreamCompressor } from "@nocturne/remote";

/**
 * 每条远程连接独享一个 deflate-raw 压缩流（level 6，windowBits 15），
 * 每条消息写入后执行 Z_SYNC_FLUSH，将本次刷出的字节作为该消息的压缩载荷。
 */
export function createDeflateRawCompressor(): StreamCompressor {
  const deflate = createDeflateRaw({ level: 6, windowBits: 15 });
  let closed = false;

  return {
    compress(data: Uint8Array): Promise<Uint8Array> {
      if (closed) {
        return Promise.reject(new Error("压缩流已关闭"));
      }
      return new Promise<Uint8Array>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let settled = false;
        const cleanup = () => {
          deflate.off("data", onData);
          deflate.off("error", onError);
          deflate.off("close", onClose);
        };
        const finishError = (err: Error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(err);
        };
        const onData = (chunk: Buffer) => {
          chunks.push(chunk);
        };
        const onError = (err: Error) => {
          finishError(err);
        };
        const onClose = () => {
          finishError(new Error("压缩流已关闭"));
        };
        deflate.on("data", onData);
        deflate.on("error", onError);
        deflate.on("close", onClose);
        deflate.write(data);
        deflate.flush(constants.Z_SYNC_FLUSH, () => {
          if (settled || closed) return;
          settled = true;
          cleanup();
          const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
          const output = new Uint8Array(total);
          let offset = 0;
          for (const chunk of chunks) {
            output.set(chunk, offset);
            offset += chunk.byteLength;
          }
          resolve(output);
        });
      });
    },
    close(): void {
      if (closed) return;
      closed = true;
      deflate.on("error", () => undefined);
      deflate.destroy();
    },
  };
}
