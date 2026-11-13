/**
 * 图片后台处理宿主（ADR-0090）：管理单个 Node Worker 线程、串行队列、
 * 空闲自动退出与中断终止，防止图像解码/编码阻塞主线程或长期占用 WASM 线性内存。
 */
import { Worker } from "node:worker_threads";
import { loadImageWasmBytes, resolveImageWorkerUrl } from "../platform/index.js";
import type { ImageRegion } from "../protocol/index.js";
import {
  IMAGE_JPEG_QUALITIES,
  IMAGE_MAX_PIXELS,
  IMAGE_TARGET_MAX_BYTES,
  ImageCorruptError,
  ImageTooLargeError,
  type ImageProcessingPlan,
} from "./image.js";
import type { WorkerJobRequest, WorkerJobResponse } from "./image-worker.js";

/** 空闲后自动退出 worker 的默认时长：10 秒（ADR-0090） */
export const DEFAULT_IMAGE_WORKER_IDLE_MS = 10_000;

export interface EncodedImageTile {
  index: number;
  data: Uint8Array;
  width: number;
  height: number;
  region: ImageRegion;
}

export interface ProcessImageInput {
  data: Uint8Array;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  plan: Exclude<ImageProcessingPlan, { kind: "none" }>;
}

export interface ImageProcessor {
  process(
    input: ProcessImageInput,
    opts: {
      signal?: AbortSignal | undefined;
      onTile: (tile: EncodedImageTile) => Promise<void> | void;
    },
  ): Promise<void>;
  /** 仅用于测试/诊断观察当前是否有存活中的 worker */
  hasWorker(): boolean;
  close(): Promise<void>;
}

function abortError(signal?: AbortSignal): Error {
  const reason: unknown = signal?.reason;
  if (reason instanceof Error) return reason;
  const err = new Error(typeof reason === "string" ? reason : "图片处理已取消");
  err.name = "AbortError";
  return err;
}

export function createImageProcessor(opts?: {
  idleTimeoutMs?: number | undefined;
}): ImageProcessor {
  const idleTimeoutMs = opts?.idleTimeoutMs ?? DEFAULT_IMAGE_WORKER_IDLE_MS;
  let worker: Worker | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let closed = false;
  let nextJobId = 1;
  let activeAbort: (() => void) | undefined;

  function clearIdleTimer(): void {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  }

  async function terminateWorker(): Promise<void> {
    clearIdleTimer();
    const current = worker;
    worker = undefined;
    if (current !== undefined) {
      await current.terminate().catch(() => undefined);
    }
  }

  function scheduleIdleExit(): void {
    clearIdleTimer();
    if (worker === undefined || closed) return;
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      void terminateWorker();
    }, idleTimeoutMs);
    idleTimer.unref();
  }

  async function ensureWorker(): Promise<Worker> {
    if (closed) throw new Error("图片处理器已关闭");
    if (worker !== undefined) return worker;
    const wasm = await loadImageWasmBytes(import.meta.url);
    const isClosed = (): boolean => closed;
    if (isClosed()) throw new Error("图片处理器已关闭");
    const url = resolveImageWorkerUrl(import.meta.url);
    const created = new Worker(url, { workerData: { wasm } });
    created.unref();
    worker = created;
    return created;
  }

  async function runOne(
    input: ProcessImageInput,
    runOpts: {
      signal?: AbortSignal | undefined;
      onTile: (tile: EncodedImageTile) => Promise<void> | void;
    },
  ): Promise<void> {
    const { signal, onTile } = runOpts;
    const isClosed = (): boolean => closed;
    if (isClosed()) throw new Error("图片处理器已关闭");
    if (signal?.aborted) throw abortError(signal);

    clearIdleTimer();
    const activeWorker = await ensureWorker();
    if (isClosed()) {
      await terminateWorker();
      throw new Error("图片处理器已关闭");
    }
    if (signal?.aborted) throw abortError(signal);

    const jobId = nextJobId++;
    let settled = false;
    let terminating = false;
    let workerDone = false;
    let tileChain: Promise<void> = Promise.resolve();

    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        activeAbort = undefined;
        signal?.removeEventListener("abort", onAbort);
        activeWorker.off("message", onMessage);
        activeWorker.off("error", onError);
        activeWorker.off("exit", onExit);
      };

      const fail = (err: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      const succeed = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };

      const onAbort = (): void => {
        if (terminating || settled) return;
        terminating = true;
        const err = abortError(signal);
        void terminateWorker().finally(() => {
          fail(err);
        });
      };

      activeAbort = () => {
        if (terminating || settled) return;
        terminating = true;
        const err = new Error("图片处理器已关闭");
        void terminateWorker().finally(() => {
          fail(err);
        });
      };

      const onError = (err: Error): void => {
        if (worker === activeWorker) worker = undefined;
        if (!terminating) fail(err);
      };

      const onExit = (code: number): void => {
        if (worker === activeWorker) worker = undefined;
        if (!settled && !terminating) fail(new Error(`图片处理 worker 异常退出（code=${code}）`));
      };

      const onMessage = (msg: WorkerJobResponse): void => {
        if (msg.id !== jobId || settled) return;
        if (msg.type === "tile") {
          const bytes = new Uint8Array(msg.data);
          tileChain = tileChain.then(async () => {
            if (signal?.aborted) throw abortError(signal);
            await onTile({
              index: msg.index,
              data: bytes,
              width: msg.width,
              height: msg.height,
              region: msg.region,
            });
          });
          tileChain.catch((err: unknown) => {
            if (signal?.aborted) {
              onAbort();
            } else {
              fail(err);
            }
          });
          return;
        }
        if (msg.type === "done") {
          workerDone = true;
          void tileChain.then(
            () => {
              if (workerDone) succeed();
            },
            (err: unknown) => {
              fail(err);
            },
          );
          return;
        } else {
          const err =
            msg.kind === "too_large"
              ? new ImageTooLargeError(msg.message)
              : msg.kind === "corrupt"
                ? new ImageCorruptError(msg.message)
                : new Error(msg.message);
          fail(err);
        }
      };

      signal?.addEventListener("abort", onAbort, { once: true });
      activeWorker.on("message", onMessage);
      activeWorker.on("error", onError);
      activeWorker.on("exit", onExit);

      const req: WorkerJobRequest = {
        id: jobId,
        data: input.data,
        mimeType: input.mimeType,
        maxPixels: IMAGE_MAX_PIXELS,
        targetMaxBytes: IMAGE_TARGET_MAX_BYTES,
        qualities: IMAGE_JPEG_QUALITIES,
        plan: input.plan,
      };
      activeWorker.postMessage(req);
    }).finally(() => {
      if (!closed && worker === activeWorker) scheduleIdleExit();
    });
  }

  return {
    process(input, processOpts) {
      if (closed) return Promise.reject(new Error("图片处理器已关闭"));
      if (processOpts.signal?.aborted) return Promise.reject(abortError(processOpts.signal));
      const p = queue.then(() => runOne(input, processOpts));
      queue = p.then(
        () => undefined,
        () => undefined,
      );
      return p;
    },
    hasWorker: () => worker !== undefined,
    async close() {
      closed = true;
      activeAbort?.();
      await terminateWorker();
      await queue;
    },
  };
}

let defaultProcessor: ImageProcessor | undefined;

export function getDefaultImageProcessor(): ImageProcessor {
  defaultProcessor ??= createImageProcessor();
  return defaultProcessor;
}
