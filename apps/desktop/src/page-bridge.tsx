import { useLayoutEffect, useRef, useState } from "react";
import type { PagePermissionReply, PagePermissionRequestedPayload } from "@nocturne/core/protocol";
import { RpcError, type RpcSession } from "@nocturne/rpc/client";
import { Button, Icon, IconButton, ICON_MD } from "./ui";

export type PageSession = Pick<RpcSession, "readAttachment"> &
  Partial<
    Pick<
      RpcSession,
      | "onEvent"
      | "getPageData"
      | "setPageData"
      | "deletePageData"
      | "listPageDataKeys"
      | "callPageModel"
      | "respondPagePermission"
      | "stopPageModel"
    >
  >;

export function usePageBridge(
  session: PageSession | undefined,
  page: string | undefined,
  id: string,
) {
  const [busy, setBusy] = useState(false);
  const [permission, setPermission] = useState<PagePermissionRequestedPayload>();
  const [replyError, setReplyError] = useState<string>();
  const requests = useRef(new Set<number>());
  const effects = useRef<object | undefined>(undefined);
  const enabled = page !== undefined && session?.callPageModel !== undefined;

  useLayoutEffect(() => {
    const generation = {};
    effects.current = generation;
    const pending = requests.current;
    setBusy(false);
    setPermission(undefined);
    setReplyError(undefined);
    const unsubscribe = session?.onEvent?.((event) => {
      if (
        event.type === "page.permission_requested" &&
        event.payload.page === page &&
        pending.size > 0
      ) {
        setPermission(event.payload);
        setReplyError(undefined);
      }
    });
    return () => {
      effects.current = undefined;
      unsubscribe?.();
      if (page !== undefined && pending.size > 0) {
        void session?.stopPageModel?.(page).catch(() => undefined);
        pending.clear();
      }
    };
  }, [session, page, id]);

  function onMessage(event: MessageEvent, source: Window) {
    if (!enabled) return;
    const value: unknown = event.data;
    if (typeof value !== "object" || value === null) return;
    const msg = value as Record<string, unknown>;
    const { requestId, method, key } = msg;
    if (
      msg.type !== "nocturne:inline-html:request" ||
      msg.id !== id ||
      typeof requestId !== "number" ||
      !Number.isSafeInteger(requestId) ||
      requestId < 1
    )
      return;
    const generation = effects.current;
    const pending = requests.current;
    async function dispatch(session: PageSession, page: string) {
      switch (method) {
        case "get":
          if (typeof key === "string") return session.getPageData?.(page, key);
          break;
        case "set":
          if (typeof key === "string" && Object.hasOwn(msg, "value"))
            return session.setPageData?.(page, key, msg.value);
          break;
        case "delete":
          if (typeof key === "string") return session.deletePageData?.(page, key);
          break;
        case "keys":
          return session.listPageDataKeys?.(page);
        case "ask": {
          const { prompt, system, maxTokens } = msg;
          if (
            typeof prompt !== "string" ||
            (system !== undefined && typeof system !== "string") ||
            (maxTokens !== undefined && typeof maxTokens !== "number")
          )
            break;
          if (pending.has(requestId as number)) throw new Error("页面请求编号已在使用");
          pending.add(requestId as number);
          setBusy(true);
          try {
            return await session.callPageModel?.(page, { prompt, system, maxTokens });
          } finally {
            if (effects.current === generation) {
              pending.delete(requestId as number);
              if (pending.size === 0) {
                setBusy(false);
                setPermission(undefined);
              }
            }
          }
        }
      }
      throw new Error("无效的页面请求");
    }
    const reply = { type: "nocturne:inline-html:response", id, requestId };
    void dispatch(session, page).then(
      (value) => {
        if (effects.current === generation) source.postMessage({ ...reply, ok: true, value }, "*");
      },
      (error: unknown) => {
        if (effects.current !== generation) return;
        source.postMessage(
          {
            ...reply,
            ok: false,
            error: {
              message: error instanceof Error ? error.message : String(error),
              code: error instanceof RpcError ? error.code : undefined,
            },
          },
          "*",
        );
      },
    );
  }

  function stop() {
    if (page === undefined) return;
    void session?.stopPageModel?.(page).catch(() => undefined);
  }

  async function respond(request: PagePermissionRequestedPayload, reply: PagePermissionReply) {
    const generation = effects.current;
    try {
      await session?.respondPagePermission?.(request.page, request.requestId, reply);
      if (effects.current === generation) {
        setPermission((current) =>
          current?.requestId === request.requestId ? undefined : current,
        );
      }
    } catch (error) {
      if (effects.current !== generation) return;
      if (error instanceof RpcError && error.code === "unknown_request") {
        setPermission((current) =>
          current?.requestId === request.requestId ? undefined : current,
        );
      } else {
        setReplyError(error instanceof Error ? error.message : String(error));
      }
    }
  }

  return { enabled, onMessage, busy, stop, permission, respond, replyError };
}

export function PageModelStop({
  bridge,
  className,
}: {
  bridge: ReturnType<typeof usePageBridge>;
  className: string;
}) {
  if (!bridge.busy) return null;
  return (
    <IconButton className={className} aria-label="停止" title="停止" onClick={bridge.stop}>
      <Icon name="stop" size={ICON_MD} />
    </IconButton>
  );
}

export function PageModelPermission({
  bridge,
  remote,
}: {
  bridge: ReturnType<typeof usePageBridge>;
  remote?: boolean | undefined;
}) {
  const { permission, replyError } = bridge;
  if (!permission) return null;
  return (
    <div className="page-model-permission" role="group" aria-label={permission.title}>
      <span title={permission.title}>{permission.title}</span>
      <div className="page-model-permission-actions">
        <Button
          size="sm"
          variant="primary"
          onClick={() => void bridge.respond(permission, { action: "allow" })}
        >
          允许一次
        </Button>
        {!remote && (
          <Button
            size="sm"
            onClick={() =>
              void bridge.respond(permission, { action: "allow", remember: "project" })
            }
          >
            这个页面以后都允许
          </Button>
        )}
        <Button size="sm" onClick={() => void bridge.respond(permission, { action: "deny" })}>
          拒绝
        </Button>
      </div>
      {replyError !== undefined && <span role="alert">{replyError}</span>}
    </div>
  );
}
