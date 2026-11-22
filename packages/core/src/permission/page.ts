import { randomUUID } from "node:crypto";
import type {
  Grant,
  PagePermissionReply,
  PagePermissionRequestedPayload,
} from "../protocol/index.js";
import type { PermissionPolicy } from "./types.js";

export function createPagePermissionGate(options: {
  sessionId: string;
  policy: () => PermissionPolicy;
  emit: (request: PagePermissionRequestedPayload) => void;
  grant: (grant: Grant) => Promise<void>;
}) {
  const pending = new Map<
    string,
    {
      page: string;
      resolve: (reply: PagePermissionReply) => void;
    }
  >();

  return {
    async check(page: string, title: string, model: string, signal: AbortSignal) {
      signal.throwIfAborted();
      const target = `${options.sessionId}/${page}`;
      const { decision } = options.policy().evaluate([{ kind: "page", target }], {
        caller: { kind: "page", page },
      });
      if (decision.action !== "ask") return decision.action;

      const requestId = randomUUID();
      let abort: (() => void) | undefined;
      try {
        const reply = await new Promise<PagePermissionReply>((resolve, reject) => {
          abort = () => {
            reject(new Error("页面模型调用已停止", { cause: signal.reason }));
          };
          signal.addEventListener("abort", abort, { once: true });
          pending.set(requestId, { page, resolve });
          options.emit({ requestId, page, title, model });
        });
        signal.throwIfAborted();
        if (reply.remember === "project") {
          await options.grant({ kind: "page", target, title, createdAt: new Date().toISOString() });
        }
        return reply.action;
      } finally {
        pending.delete(requestId);
        if (abort) signal.removeEventListener("abort", abort);
      }
    },
    respond(
      page: string,
      requestId: string,
      { action, remember }: { action: unknown; remember?: unknown },
    ) {
      const request = pending.get(requestId);
      if (request?.page !== page) return "unknown_request";
      if (
        (action !== "allow" && action !== "deny") ||
        (remember !== undefined && (remember !== "project" || action !== "allow"))
      )
        return "invalid_reply";
      pending.delete(requestId);
      request.resolve({ action, remember });
      return "ok";
    },
  };
}
