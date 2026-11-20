/**
 * 右侧面板的插件 MCP App 页面标签（ADR-0101 第 5、6 节）。
 * - 第一次显示时才读取页面（session.readAppResource）与调用 open.tool；
 * - 同一会话内切走标签保持挂载与状态；关闭或卸载前发 ui/resource-teardown（最多等 1 秒）；
 * - 严格按 event.source === iframe.contentWindow 校验，所有 RPC 绑定标签自身的 sessionId/pluginId/serverId。
 */
import { useEffect, useRef, useState } from "react";
import type { RpcSession } from "@nocturne/rpc/client";
import { RpcError } from "@nocturne/rpc/client";

import {
  buildInitializeResult,
  extractUiMessageText,
  isAllowedHttpsLink,
  MCP_APP_TEARDOWN_TIMEOUT_MS,
  readMcpAppHostContext,
  readMcpAppTheme,
  resolveAppSandboxFrameSrc,
  type McpAppToolDelivery,
} from "./mcp-app-host";
import type { AppTab } from "./side-panel";

export interface AppPaneProps {
  tab: AppTab;
  sessionId: string;
  session: RpcSession | undefined;
  visible: boolean;
  /** 最近一次由模型调用触发并需转交页面的工具数据 */
  delivery?: McpAppToolDelivery | undefined;
  /** 点文件引用触发 open.tool 的单调序号；变化时重新调用 tab.openCall */
  openCallSeq?: number | undefined;
  /** 本标签所属插件是否仍处于启用状态；停用或卸载时显示错误页、不自动关闭 */
  pluginDisabled?: boolean | undefined;
  /** ui/message：将文本插入对应会话草稿末尾并聚焦（不自动发送） */
  onAppMessage: (sessionId: string, text: string) => void;
  /** ui/open-link：仅 https: 交给系统浏览器 */
  openExternalUrl: (url: string) => Promise<void>;
  /** notifications/message：写入诊断日志 */
  onDiagnosticLog?: ((message: string) => void) | undefined;
  /** 登记优雅卸载回调：关闭标签前先发 ui/resource-teardown 并最多等 1 秒 */
  registerTeardown?:
    ((tabId: string, fn: (reason: string) => Promise<void>) => () => void) | undefined;
}

interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: string | number | null | undefined;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCodeOf(error: unknown): string | undefined {
  if (error instanceof RpcError) return error.code;
  if (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return (error as { code: string }).code;
  }
  return undefined;
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function AppPane({
  tab,
  sessionId,
  session,
  visible,
  delivery,
  openCallSeq,
  pluginDisabled,
  onAppMessage,
  openExternalUrl,
  onDiagnosticLog,
  registerTeardown,
}: AppPaneProps) {
  // 首次显示前不读页面、不调用 open.tool、不启动插件服务器（ADR-0101 第 5 节）
  const [activated, setActivated] = useState(visible);
  useEffect(() => {
    if (visible && !activated) setActivated(true);
  }, [visible, activated]);

  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [frameKey, setFrameKey] = useState(0);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const frameReadyRef = useRef(false);
  const htmlLoadedRef = useRef(false);
  const htmlRef = useRef<string | null>(null);
  htmlRef.current = html;

  const initializedRef = useRef(false);
  const sentDeliveriesRef = useRef<Set<number>>(new Set());
  const queuedDeliveriesRef = useRef<McpAppToolDelivery[]>([]);
  const deliveryRef = useRef(delivery);
  deliveryRef.current = delivery;
  const nextHostReqIdRef = useRef(1);
  const teardownWaitersRef = useRef<Map<number, () => void>>(new Map());
  const tornDownRef = useRef(false);
  const lastThemeSnapshotRef = useRef<string | null>(null);

  // 最新回调引用，避免监听器重复绑定
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const onAppMessageRef = useRef(onAppMessage);
  onAppMessageRef.current = onAppMessage;
  const openExternalUrlRef = useRef(openExternalUrl);
  openExternalUrlRef.current = openExternalUrl;
  const onDiagnosticLogRef = useRef(onDiagnosticLog);
  onDiagnosticLogRef.current = onDiagnosticLog;

  const postToFrame = (msg: unknown): boolean => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return false;
    win.postMessage(msg, "*");
    return true;
  };

  const sendDelivery = (item: McpAppToolDelivery): void => {
    if (sentDeliveriesRef.current.has(item.seq)) return;
    sentDeliveriesRef.current.add(item.seq);
    if (item.kind === "result") {
      postToFrame({
        jsonrpc: "2.0",
        method: "ui/notifications/tool-input",
        params: { arguments: item.arguments },
      });
      postToFrame({
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: item.result,
      });
    } else {
      if (item.arguments !== undefined) {
        postToFrame({
          jsonrpc: "2.0",
          method: "ui/notifications/tool-input",
          params: { arguments: item.arguments },
        });
      }
      postToFrame({
        jsonrpc: "2.0",
        method: "ui/notifications/tool-cancelled",
        params: { reason: item.reason },
      });
    }
  };

  const enqueueDelivery = (item: McpAppToolDelivery): void => {
    if (sentDeliveriesRef.current.has(item.seq)) return;
    if (initializedRef.current) {
      sendDelivery(item);
      return;
    }
    if (!queuedDeliveriesRef.current.some((q) => q.seq === item.seq)) {
      queuedDeliveriesRef.current.push(item);
    }
  };

  const flushQueuedDeliveries = (): void => {
    if (!initializedRef.current) return;
    const items = queuedDeliveriesRef.current.splice(0);
    for (const item of items) sendDelivery(item);
  };

  const isDisabled = pluginDisabled === true;

  // 1. 首次激活（或资源 URI 变化）时经 RPC 读取页面 HTML
  useEffect(() => {
    if (!activated) return;
    if (isDisabled) {
      setHtml(null);
      setError("插件已停用或已卸载");
      return;
    }
    if (session === undefined) return;
    let cancelled = false;
    setError(null);
    setHtml(null);
    frameReadyRef.current = false;
    htmlLoadedRef.current = false;
    initializedRef.current = false;
    tornDownRef.current = false;
    sentDeliveriesRef.current.clear();
    queuedDeliveriesRef.current = deliveryRef.current !== undefined ? [deliveryRef.current] : [];
    setFrameKey((k) => k + 1);
    void session
      .readAppResource({
        pluginId: tab.pluginId,
        serverId: tab.serverId,
        uri: tab.resourceUri,
      })
      .then((res) => {
        if (cancelled) return;
        setHtml(res.html);
        if (frameReadyRef.current && !htmlLoadedRef.current) {
          htmlLoadedRef.current = true;
          postToFrame({ type: "nocturne:mcp-app:load", html: res.html });
        }
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(errorMessageOf(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [activated, isDisabled, session, tab.pluginId, tab.serverId, tab.resourceUri]);

  // 2. 收到新的外部 delivery（模型工具调用或文件打开）时入队/发送
  useEffect(() => {
    if (!activated || delivery === undefined) return;
    enqueueDelivery(delivery);
  }, [activated, delivery]);

  // 3. 首次激活恢复带 openCall 的标签，或用户点击文件引用触发新的 openCallSeq 时，调用 open.tool
  const handledOpenKeyRef = useRef<string | null>(null);
  const openSeqCounterRef = useRef(-1);
  const openCallJson = tab.openCall !== undefined ? JSON.stringify(tab.openCall) : null;
  useEffect(() => {
    if (!activated || isDisabled || session === undefined || html === null) return;
    if (tab.openCall === undefined || openCallJson === null) return;
    // 恢复标签在首次激活前若已有实时模型调用 delivery，不再用旧的持久化 openCall 覆盖
    if (openCallSeq === undefined && delivery !== undefined && handledOpenKeyRef.current === null) {
      handledOpenKeyRef.current = `restored:${openCallJson}`;
      return;
    }
    const openKey =
      openCallSeq !== undefined
        ? `live:${openCallSeq}:${openCallJson}`
        : `restored:${openCallJson}`;
    if (handledOpenKeyRef.current === openKey) return;
    handledOpenKeyRef.current = openKey;
    let cancelled = false;
    const call = tab.openCall;
    const seq = openSeqCounterRef.current--;
    void session
      .callAppTool({
        pluginId: tab.pluginId,
        serverId: tab.serverId,
        tool: call.tool,
        arguments: call.arguments,
      })
      .then((result) => {
        if (cancelled) return;
        enqueueDelivery({
          kind: "result",
          seq,
          arguments: call.arguments,
          result,
        });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        enqueueDelivery({
          kind: "result",
          seq,
          arguments: call.arguments,
          result: {
            content: [{ type: "text", text: errorMessageOf(cause) }],
            isError: true,
          },
        });
      });
    return () => {
      cancelled = true;
    };
  }, [
    activated,
    isDisabled,
    session,
    html,
    openCallJson,
    openCallSeq,
    delivery,
    tab.pluginId,
    tab.serverId,
    tab.openCall,
  ]);

  // 4. 优雅卸载：发送 ui/resource-teardown，最多等 1 秒
  useEffect(() => {
    const sendTeardown = (reason: string): Promise<void> => {
      if (tornDownRef.current || !initializedRef.current) return Promise.resolve();
      tornDownRef.current = true;
      const id = nextHostReqIdRef.current++;
      const posted = postToFrame({
        jsonrpc: "2.0",
        id,
        method: "ui/resource-teardown",
        params: { reason },
      });
      if (!posted) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const timer = window.setTimeout(() => {
          teardownWaitersRef.current.delete(id);
          resolve();
        }, MCP_APP_TEARDOWN_TIMEOUT_MS);
        teardownWaitersRef.current.set(id, () => {
          window.clearTimeout(timer);
          teardownWaitersRef.current.delete(id);
          resolve();
        });
      });
    };
    const unregister = registerTeardown?.(tab.id, sendTeardown);
    return () => {
      unregister?.();
      if (!tornDownRef.current && initializedRef.current) {
        tornDownRef.current = true;
        const id = nextHostReqIdRef.current++;
        postToFrame({
          jsonrpc: "2.0",
          id,
          method: "ui/resource-teardown",
          params: { reason: "unmount" },
        });
      }
      for (const resolve of teardownWaitersRef.current.values()) resolve();
      teardownWaitersRef.current.clear();
    };
  }, [registerTeardown, tab.id]);

  // 5. postMessage JSON-RPC 2.0 双向监听（只接受 event.source === iframe.contentWindow）
  useEffect(() => {
    if (!activated) return;
    const onMessage = (event: MessageEvent) => {
      const win = iframeRef.current?.contentWindow;
      if (win === null || win === undefined || event.source !== win) return;
      const raw = event.data as unknown;
      if (!isPlainObject(raw)) return;

      // 空壳页就绪信号：把页面 HTML 交过去装载（单层 iframe，不使用 sandbox-* 保留消息）
      if (raw.type === "nocturne:mcp-app:ready") {
        frameReadyRef.current = true;
        if (!htmlLoadedRef.current && htmlRef.current !== null) {
          htmlLoadedRef.current = true;
          win.postMessage({ type: "nocturne:mcp-app:load", html: htmlRef.current }, "*");
        }
        return;
      }

      const msg = raw as JsonRpcMessage;
      if (msg.jsonrpc !== "2.0") return;

      // 处理宿主发出的 ui/resource-teardown 应答
      if (msg.method === undefined && typeof msg.id === "number") {
        const waiter = teardownWaitersRef.current.get(msg.id);
        if (waiter !== undefined) waiter();
        return;
      }

      if (typeof msg.method !== "string") return;
      const method = msg.method;
      const id = msg.id;
      const hasId = id !== undefined && id !== null;
      const params = msg.params;

      const replyResult = (result: unknown) => {
        if (!hasId) return;
        win.postMessage({ jsonrpc: "2.0", id, result }, "*");
      };
      const replyError = (code: number, message: string, data?: Record<string, unknown>) => {
        if (!hasId) return;
        win.postMessage(
          {
            jsonrpc: "2.0",
            id,
            error: { code, message, ...(data !== undefined ? { data } : {}) },
          },
          "*",
        );
      };

      switch (method) {
        case "ui/initialize": {
          const rect = containerRef.current?.getBoundingClientRect();
          const hostContext = readMcpAppHostContext(
            rect !== undefined && rect.width > 0 && rect.height > 0
              ? { width: rect.width, height: rect.height }
              : undefined,
          );
          lastThemeSnapshotRef.current = JSON.stringify({
            theme: hostContext.theme,
            variables: hostContext.styles.variables,
          });
          replyResult(buildInitializeResult(hostContext));
          return;
        }
        case "ui/notifications/initialized": {
          initializedRef.current = true;
          flushQueuedDeliveries();
          return;
        }
        case "ping": {
          replyResult({});
          return;
        }
        case "notifications/message": {
          const level =
            isPlainObject(params) && typeof params.level === "string" ? params.level : "info";
          const logger =
            isPlainObject(params) && typeof params.logger === "string" ? `/${params.logger}` : "";
          const payload = isPlainObject(params) ? params.data : params;
          const text = typeof payload === "string" ? payload : JSON.stringify(payload);
          onDiagnosticLogRef.current?.(
            `mcp-app[${tab.pluginId}/${tab.serverId}${logger}] ${level}: ${text}`,
          );
          return;
        }
        case "ui/request-display-mode": {
          replyResult({ mode: "inline" });
          return;
        }
        case "ui/notifications/size-changed": {
          // 面板标签铺满容器，忽略尺寸通知（ADR-0101 第 6 节）
          return;
        }
        case "ui/open-link": {
          const url = isPlainObject(params) ? params.url : undefined;
          if (!isAllowedHttpsLink(url)) {
            replyError(-32000, "Only https: URLs are allowed");
            return;
          }
          void openExternalUrlRef.current(url).then(
            () => {
              replyResult({});
            },
            (cause: unknown) => {
              replyError(-32000, errorMessageOf(cause));
            },
          );
          return;
        }
        case "ui/message": {
          const text = extractUiMessageText(params);
          if (text === undefined) {
            replyError(-32602, "Invalid message format");
            return;
          }
          onAppMessageRef.current(sessionId, text);
          replyResult({});
          return;
        }
        case "tools/call": {
          const curSession = sessionRef.current;
          if (curSession === undefined) {
            replyError(-32000, "Session unavailable", { code: "session_unavailable" });
            return;
          }
          if (!isPlainObject(params) || typeof params.name !== "string" || params.name === "") {
            replyError(-32602, "Invalid tools/call params");
            return;
          }
          const args = isPlainObject(params.arguments) ? params.arguments : {};
          // 绑定标签自身的 sessionId / pluginId / serverId，忽略页面传来的同名字段（ADR-0101 第 6 节）
          void curSession
            .callAppTool({
              pluginId: tab.pluginId,
              serverId: tab.serverId,
              tool: params.name,
              arguments: args,
            })
            .then(
              (result) => {
                replyResult(result);
              },
              (cause: unknown) => {
                const code = errorCodeOf(cause);
                replyError(
                  -32000,
                  errorMessageOf(cause),
                  code !== undefined ? { code } : undefined,
                );
              },
            );
          return;
        }
        case "resources/read": {
          const curSession = sessionRef.current;
          if (curSession === undefined) {
            replyError(-32000, "Session unavailable", { code: "session_unavailable" });
            return;
          }
          if (!isPlainObject(params) || typeof params.uri !== "string" || params.uri === "") {
            replyError(-32602, "Invalid resources/read params");
            return;
          }
          void curSession
            .readAppResource({
              pluginId: tab.pluginId,
              serverId: tab.serverId,
              uri: params.uri,
            })
            .then(
              (res) => {
                replyResult({
                  contents: [{ uri: res.uri, mimeType: res.mimeType, text: res.html }],
                });
              },
              (cause: unknown) => {
                const code = errorCodeOf(cause);
                replyError(
                  -32000,
                  errorMessageOf(cause),
                  code !== undefined ? { code } : undefined,
                );
              },
            );
          return;
        }
        default: {
          if (hasId) {
            replyError(-32601, `Method not found: ${method}`);
          }
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
    };
  }, [activated, sessionId, tab.pluginId, tab.serverId]);

  // 6. 深浅色或主题变量变化时发送 ui/notifications/host-context-changed
  useEffect(() => {
    if (!activated || html === null) return;
    lastThemeSnapshotRef.current ??= JSON.stringify(readMcpAppTheme());
    const pushIfChanged = () => {
      if (!initializedRef.current) return;
      const next = readMcpAppTheme();
      const snapshot = JSON.stringify(next);
      if (snapshot === lastThemeSnapshotRef.current) return;
      lastThemeSnapshotRef.current = snapshot;
      postToFrame({
        jsonrpc: "2.0",
        method: "ui/notifications/host-context-changed",
        params: {
          theme: next.theme,
          styles: { variables: next.variables },
        },
      });
    };
    const observer =
      typeof MutationObserver !== "undefined" ? new MutationObserver(pushIfChanged) : undefined;
    observer?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-theme-preset", "style", "class"],
    });
    const media =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-color-scheme: light)")
        : undefined;
    media?.addEventListener("change", pushIfChanged);
    return () => {
      observer?.disconnect();
      media?.removeEventListener("change", pushIfChanged);
    };
  }, [activated, html]);

  if (!activated) {
    return <div className="sp-app-pane" ref={containerRef} />;
  }

  if (error !== null) {
    return (
      <div className="sp-empty" role="alert">
        <p>{error}</p>
      </div>
    );
  }

  return (
    <div className="sp-app-pane" ref={containerRef}>
      {html !== null && (
        <iframe
          key={`${tab.id}-${frameKey}`}
          ref={iframeRef}
          className="sp-app-frame"
          aria-label={tab.title}
          sandbox="allow-scripts"
          src={resolveAppSandboxFrameSrc()}
        />
      )}
    </div>
  );
}
