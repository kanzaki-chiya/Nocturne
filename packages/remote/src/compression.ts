import { concat, MAX_MESSAGE, MESSAGE_TERMINATOR, type Bytes } from "./encoding.js";
import { RemoteChannelError } from "./errors.js";

export type ChannelCompression = "deflate-raw";

/** 发送端共享压缩流接口：由宿主运行时（如 Node zlib）提供，保持本包同构无 Node 依赖 */
export interface StreamCompressor {
  /** 将单条已附带终止字节的明文写入共享 deflate-raw 流并执行 Z_SYNC_FLUSH，返回本次刷出的压缩字节 */
  compress(data: Uint8Array): Promise<Uint8Array>;
  /** 通道关闭时释放底层压缩流 */
  close(): void;
}

export interface StreamDecompressor {
  /** 串行解压单条完整压缩载荷，读到消息结束哨兵即返回明文字节；超 MAX_MESSAGE 立即中止 */
  decompress(payload: Uint8Array): Promise<Bytes>;
  /** 关闭并释放底层解压流 */
  close(): void;
}

/** 运行时能力检测：仅当当前环境支持 DecompressionStream("deflate-raw") 时返回 true */
export function supportsDeflateRawDecompression(): boolean {
  try {
    new DecompressionStream("deflate-raw");
    return true;
  } catch {
    return false;
  }
}

/**
 * 基于标准 Web API `DecompressionStream("deflate-raw")` 的长期存活解压流。
 * 每次调用必须由上层串行执行以保证消息顺序与窗口状态一致。
 */
export function createDeflateRawDecompressor(): StreamDecompressor {
  const stream = new DecompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  let closed = false;

  const close = (): void => {
    if (closed) return;
    closed = true;
    void reader.cancel().catch(() => undefined);
    void writer.abort().catch(() => undefined);
  };

  return {
    async decompress(payload: Uint8Array): Promise<Bytes> {
      if (closed) throw new RemoteChannelError("closed");
      let rejectWrite!: (error: unknown) => void;
      const writeFailed = new Promise<never>((_resolve, reject) => {
        rejectWrite = reject;
      });
      // 防止 reader 先失败或中止时 writeFailed 变成未处理拒绝
      writeFailed.catch(() => undefined);

      const writePromise = writer.write(new Uint8Array(payload)).then(
        () => true,
        (error: unknown) => {
          rejectWrite(error);
          return false;
        },
      );

      const parts: Uint8Array[] = [];
      let total = 0;

      try {
        for (;;) {
          const { value, done } = await Promise.race([reader.read(), writeFailed]);
          if (done) {
            close();
            throw new RemoteChannelError("decrypt_failed");
          }
          if (value.byteLength === 0) continue;
          const sep = value.indexOf(MESSAGE_TERMINATOR);
          if (sep === -1) {
            total += value.byteLength;
            if (total > MAX_MESSAGE) {
              close();
              throw new RemoteChannelError("frame_too_large");
            }
            parts.push(value);
          } else {
            if (sep !== value.byteLength - 1) {
              close();
              throw new RemoteChannelError("decrypt_failed");
            }
            total += sep;
            if (total > MAX_MESSAGE) {
              close();
              throw new RemoteChannelError("frame_too_large");
            }
            if (sep > 0) parts.push(value.subarray(0, sep));
            break;
          }
        }
      } catch (error) {
        close();
        if (error instanceof RemoteChannelError) throw error;
        throw new RemoteChannelError("decrypt_failed");
      }

      if (!(await writePromise)) {
        close();
        throw new RemoteChannelError("decrypt_failed");
      }
      return concat(...parts);
    },
    close,
  };
}
