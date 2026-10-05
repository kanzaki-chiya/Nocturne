import { createHash, randomBytes } from "node:crypto";
import type { LoginResult } from "../protocol/index.js";
import { ProviderLoginError } from "./errors.js";

/** SIWC 可复用生成的 nonce；具体签名、scope 校验由流程负责。 */
export function createLoginSecrets() {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
    state: randomBytes(32).toString("base64url"),
    nonce: randomBytes(32).toString("base64url"),
  };
}

/** 一次性任务、超时、取消与资源释放，供各登录实现共享。 */
export interface LoginLifecycle {
  completion: Promise<LoginResult>;
  /** 超时截止时刻（Unix 毫秒），随 LoginSession.expiresAt 交给客户端 */
  expiresAt: number;
  signal: AbortSignal;
  readonly accepting: boolean;
  addCleanup: (cleanup: () => void) => void;
  fail: (error: ProviderLoginError) => void;
  cancel: () => void;
  run: (task: (signal: AbortSignal) => Promise<LoginResult>) => Promise<void>;
}

export function createLoginLifecycle(timeoutMs = 5 * 60_000): LoginLifecycle {
  const controller = new AbortController();
  const cleanups = new Set<() => void>();
  let phase: "waiting" | "running" | "settled" = "waiting";
  let resolve!: (result: LoginResult) => void;
  let reject!: (error: ProviderLoginError) => void;
  const completion = new Promise<LoginResult>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // 客户端可能尚未开始 await；保留原 Promise 的拒绝语义。
  void completion.catch(() => undefined);
  const expiresAt = Date.now() + timeoutMs;
  const timer = setTimeout(() => {
    fail(new ProviderLoginError("timeout"));
  }, timeoutMs);

  function finish() {
    phase = "settled";
    clearTimeout(timer);
    for (const cleanup of cleanups) cleanup();
    cleanups.clear();
  }

  function fail(error: ProviderLoginError) {
    if (phase === "settled") return;
    finish();
    controller.abort();
    reject(error);
  }

  return {
    completion,
    expiresAt,
    signal: controller.signal,
    get accepting() {
      return phase === "waiting";
    },
    addCleanup(cleanup: () => void) {
      if (phase === "settled") cleanup();
      else cleanups.add(cleanup);
    },
    fail,
    cancel() {
      fail(new ProviderLoginError("cancelled"));
    },
    run(task: (signal: AbortSignal) => Promise<LoginResult>): Promise<void> {
      if (phase === "waiting") {
        phase = "running";
        void Promise.resolve()
          .then(() => {
            controller.signal.throwIfAborted();
            return task(controller.signal);
          })
          .then((result) => {
            if (phase === "settled") return;
            finish();
            resolve(result);
          })
          .catch((error: unknown) => {
            fail(error instanceof ProviderLoginError ? error : new ProviderLoginError("exchange"));
          });
      }
      return completion.then(() => undefined);
    },
  };
}
