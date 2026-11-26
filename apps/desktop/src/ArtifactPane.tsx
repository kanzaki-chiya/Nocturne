/**
 * Open Artifact 受限隔离编辑器面板（ADR-0125）：
 *
 * - 只持稳定 `open-artifact://` 标识；挂载与重开时向后端请求短期视图票据与精确来源列表；
 * - 经 Tauri `artifactViews` 宿主接口在隔离的子 webview（标签 `nct-artifact-<n>`，0 Tauri 权限）
 *   中渲染真实上游编辑器；
 * - 复用 browser-occlusion 在主界面弹出浮层时用截图占位并隐藏原生子 webview，避免遮挡。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { OpenArtifactTheme, OpenArtifactViewTicket } from "@nocturne/core/protocol";

import {
  CAPTURE_TIMEOUT_MS,
  coverStep,
  HOLD_ATTRIBUTE,
  overlaysOver,
  type CoverEvent,
  type CoverState,
} from "./browser-occlusion";
import type { ArtifactViewHost, ArtifactViewMessage, BrowserBounds } from "./host";
import type { ArtifactTab } from "./side-panel";
import { ICON_MD, Icon, IconButton } from "./ui";
import "./artifact-pane.css";

const NOTICE_HIDE_MS = 4000;

export function formatArtifactTypeLabel(type: string): string {
  const lower = type.trim().toLowerCase();
  switch (lower) {
    case "design":
      return "Design";
    case "page":
      return "Page";
    case "slides":
      return "Slides";
    case "docs":
      return "Docs";
    case "sheets":
      return "Sheets";
    case "whiteboard":
      return "Whiteboard";
    case "data":
      return "Data";
    case "motion":
      return "Motion";
    case "design-system":
      return "Design System";
    default:
      return lower === "" ? "Artifact" : lower.charAt(0).toUpperCase() + lower.slice(1);
  }
}

export function readCurrentArtifactTheme(): OpenArtifactTheme {
  const root = document.documentElement;
  const explicit = root.dataset.theme;
  let scheme: "light" | "dark";
  if (explicit === "light" || explicit === "dark") {
    scheme = explicit;
  } else if (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: light)").matches
  ) {
    scheme = "light";
  } else {
    scheme = "dark";
  }
  const accent =
    typeof window !== "undefined"
      ? window.getComputedStyle(root).getPropertyValue("--a-accent").trim() || undefined
      : undefined;
  return { scheme, ...(accent !== undefined ? { accent } : {}) };
}

export interface ArtifactPaneApi {
  openView: (url: string, theme: OpenArtifactTheme) => Promise<OpenArtifactViewTicket>;
  closeView: (view: string) => Promise<void>;
  setTheme: (theme: OpenArtifactTheme) => Promise<void>;
  resolveLocalUrl: (url: string) => Promise<{
    url: string;
    viewUrl: string;
    title?: string | undefined;
    type?: string | undefined;
  }>;
}

export interface ArtifactPaneProps {
  tab: ArtifactTab;
  visible: boolean;
  moving?: boolean;
  host: ArtifactViewHost | undefined;
  api: ArtifactPaneApi | undefined;
  openExternal: (url: string) => Promise<void>;
  /** daemon 重连或更新 origins 时推送的最新精确来源列表 */
  latestOrigins?: readonly string[] | undefined;
  originsVersion?: number | undefined;
  onMetaChange?: ((meta: { title?: string; artifactType?: string }) => void) | undefined;
}

export function ArtifactPane({
  tab,
  visible,
  moving = false,
  host,
  api,
  openExternal,
  latestOrigins,
  originsVersion = 0,
  onMetaChange,
}: ArtifactPaneProps) {
  const root = useRef<HTMLDivElement>(null);
  const slot = useRef<HTMLDivElement>(null);
  const viewIdRef = useRef<number | null>(null);
  const ticketViewRef = useRef<string | undefined>(undefined);
  const visibleRef = useRef(visible);
  const movingRef = useRef(moving);
  const coverState = useRef<CoverState>("live");
  const openExternalRef = useRef(openExternal);
  const onMetaChangeRef = useRef(onMetaChange);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; seq: number } | null>(null);
  const [cover, setCover] = useState<string | undefined>(undefined);
  const [reloadNonce, setReloadNonce] = useState(0);

  visibleRef.current = visible;
  movingRef.current = moving;
  openExternalRef.current = openExternal;
  onMetaChangeRef.current = onMetaChange;

  const pushNotice = useCallback((text: string) => {
    setNotice((prev) => ({ text, seq: (prev?.seq ?? 0) + 1 }));
  }, []);

  useEffect(() => {
    if (notice === null) return;
    const seq = notice.seq;
    const timer = setTimeout(() => {
      setNotice((current) => (current?.seq === seq ? null : current));
    }, NOTICE_HIDE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [notice]);

  const currentBounds = useCallback((): BrowserBounds | null => {
    const node = slot.current;
    if (
      !visibleRef.current ||
      movingRef.current ||
      coverState.current === "covered" ||
      node === null
    ) {
      return null;
    }
    const r = node.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }, []);

  const syncLayout = useCallback(() => {
    const id = viewIdRef.current;
    if (id === null || host === undefined) return;
    void host.layout(id, currentBounds()).catch(() => undefined);
  }, [host, currentBounds]);

  // ── 打开短期票据并挂载受限子 WebView ──
  useEffect(() => {
    if (api === undefined) {
      setLoading(false);
      setError("后台尚未连接");
      return;
    }
    if (host === undefined) {
      setLoading(false);
      setError("当前环境不支持内嵌视图");
      return;
    }
    const status = { cancelled: false };
    const isCancelled = () => status.cancelled;
    setLoading(true);
    setError(null);

    const onMessage = (message: ArtifactViewMessage) => {
      if (isCancelled()) return;
      if (message.kind === "loading") {
        setLoading(message.loading);
      } else if (message.kind === "title") {
        const nextTitle = message.title.trim();
        if (nextTitle !== "" && nextTitle !== "Open Artifact") {
          onMetaChangeRef.current?.({ title: nextTitle });
        }
      } else if (message.kind === "newWindow") {
        void openExternalRef.current(message.url).catch(() => undefined);
      } else if (message.kind === "blocked") {
        pushNotice(message.message);
      } else {
        if (message.state === "finished") pushNotice(`已导出 ${message.name}`);
        else if (message.state === "failed") pushNotice(`导出失败：${message.name}`);
        else pushNotice(`正在导出 ${message.name}…`);
      }
    };

    void (async () => {
      const theme = readCurrentArtifactTheme();
      const ticket = await api.openView(tab.url, theme);
      if (isCancelled()) {
        if (ticket.view !== undefined) {
          void api.closeView(ticket.view).catch(() => undefined);
        }
        return;
      }
      const prevView = ticketViewRef.current;
      ticketViewRef.current = ticket.view;
      if (prevView !== undefined && prevView !== ticket.view) {
        void api.closeView(prevView).catch(() => undefined);
      }
      if (ticket.title !== undefined || ticket.type !== undefined) {
        onMetaChangeRef.current?.({
          ...(ticket.title !== undefined ? { title: ticket.title } : {}),
          ...(ticket.type !== undefined ? { artifactType: ticket.type } : {}),
        });
      }
      const existingId = viewIdRef.current;
      if (existingId !== null) {
        await host.navigate(existingId, ticket.embedUrl, ticket.allowedOrigins);
      } else {
        const createdId = await host.create(
          ticket.embedUrl,
          ticket.allowedOrigins,
          currentBounds(),
          onMessage,
        );
        if (isCancelled()) {
          void host.destroy(createdId).catch(() => undefined);
          return;
        }
        viewIdRef.current = createdId;
      }
      syncLayout();
    })().catch((err: unknown) => {
      if (isCancelled()) return;
      setLoading(false);
      setError(err instanceof Error ? err.message : String(err));
    });

    return () => {
      status.cancelled = true;
    };
  }, [api, host, tab.url, reloadNonce, currentBounds, syncLayout, pushNotice]);

  // ── 卸载时销毁子 WebView 并关闭视图票据通道 ──
  useEffect(() => {
    return () => {
      const id = viewIdRef.current;
      viewIdRef.current = null;
      if (id !== null && host !== undefined) {
        void host.destroy(id).catch(() => undefined);
      }
      const viewToken = ticketViewRef.current;
      ticketViewRef.current = undefined;
      if (viewToken !== undefined && api !== undefined) {
        void api.closeView(viewToken).catch(() => undefined);
      }
    };
  }, [host, api]);

  // ── daemon 更新精确来源白名单时同步到子 WebView ──
  useEffect(() => {
    const id = viewIdRef.current;
    if (id === null || host === undefined || latestOrigins === undefined || originsVersion === 0) {
      return;
    }
    void host.setOrigins(id, [...latestOrigins]).catch(() => undefined);
  }, [host, latestOrigins, originsVersion]);

  // ── 同步深浅色主题变化 ──
  useEffect(() => {
    if (api === undefined || typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => {
      void api.setTheme(readCurrentArtifactTheme()).catch(() => undefined);
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => {
      observer.disconnect();
    };
  }, [api]);

  // ── 位置与可见性同步 ──
  useLayoutEffect(() => {
    const node = slot.current;
    if (!visible || moving || node === null) {
      const id = viewIdRef.current;
      if (id !== null && host !== undefined) {
        void host.layout(id, null).catch(() => undefined);
      }
      return;
    }
    syncLayout();
    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(syncLayout);
    observer?.observe(node);
    window.addEventListener("resize", syncLayout);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", syncLayout);
      const id = viewIdRef.current;
      if (id !== null && host !== undefined) {
        void host.layout(id, null).catch(() => undefined);
      }
    };
  }, [visible, moving, host, syncLayout]);

  // ── 主界面浮层遮挡时截图占位，避免原生 WebView2 挡住菜单/弹窗 ──
  useEffect(() => {
    const node = slot.current;
    if (
      !visible ||
      moving ||
      host === undefined ||
      node === null ||
      typeof MutationObserver === "undefined"
    ) {
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let placeholder: string | undefined;
    const held = new Set<Element>();
    const capturing = () => alive && coverState.current === "capturing";
    let hits: Element[] = [];

    const fire = (event: CoverEvent) => {
      const step = coverStep(coverState.current, event);
      const leaving = coverState.current === "capturing" && step.state !== "capturing";
      coverState.current = step.state;
      if (leaving && timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (step.hold === true) {
        for (const hit of hits) {
          hit.setAttribute(HOLD_ATTRIBUTE, "");
          held.add(hit);
        }
      }
      const id = viewIdRef.current;
      if (step.webview === "hide" && id !== null) {
        void host.layout(id, null).catch(() => undefined);
      }
      if (step.hold === false) {
        for (const el of held) el.removeAttribute(HOLD_ATTRIBUTE);
        held.clear();
      }
      if (step.webview === "show") {
        syncLayout();
      }
      if (step.clearPlaceholder === true) {
        const stale = placeholder;
        placeholder = undefined;
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (!alive) return;
            setCover((current) => (current === stale ? undefined : current));
            if (stale !== undefined) URL.revokeObjectURL(stale);
          });
        });
      }
      if (step.capture === true && id !== null) {
        timer = setTimeout(() => {
          timer = undefined;
          fire("timeout");
        }, CAPTURE_TIMEOUT_MS);
        void host
          .capture(id)
          .then(async (png) => {
            if (!capturing()) return;
            const url = URL.createObjectURL(new Blob([png as BlobPart], { type: "image/png" }));
            const image = new Image();
            image.src = url;
            await image.decode().catch(() => undefined);
            if (!capturing()) {
              URL.revokeObjectURL(url);
              return;
            }
            placeholder = url;
            setCover(url);
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                if (alive) fire("captured");
              });
            });
          })
          .catch(() => undefined);
      }
    };

    const check = () => {
      const r = node.getBoundingClientRect();
      hits = overlaysOver(
        document,
        { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
        root.current,
      );
      fire(hits.length > 0 ? "overlay" : "clear");
    };
    const observer = new MutationObserver(check);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden", "open", "role"],
    });
    check();
    return () => {
      alive = false;
      observer.disconnect();
      if (timer !== undefined) clearTimeout(timer);
      for (const el of held) el.removeAttribute(HOLD_ATTRIBUTE);
      held.clear();
      coverState.current = "live";
      if (placeholder !== undefined) URL.revokeObjectURL(placeholder);
      setCover(undefined);
    };
  }, [visible, moving, host, syncLayout]);

  const handleOpenExternal = () => {
    if (api === undefined) return;
    void api
      .resolveLocalUrl(tab.url)
      .then((res) => openExternalRef.current(res.viewUrl))
      .catch((err: unknown) => {
        pushNotice(`无法打开：${err instanceof Error ? err.message : String(err)}`);
      });
  };

  return (
    <div className="sp-artifact" ref={root} data-artifact-url={tab.url}>
      <div className="sp-artifact-bar">
        <span className="sp-artifact-badge">{formatArtifactTypeLabel(tab.artifactType)}</span>
        <span className="sp-artifact-title" title={tab.title}>
          {tab.title}
        </span>
        <div className="sp-artifact-actions">
          <IconButton
            aria-label="重新加载作品"
            title="重新加载"
            onClick={() => {
              setReloadNonce((n) => n + 1);
            }}
          >
            <Icon name="refresh_2" size={ICON_MD} className="sp-glyph" />
          </IconButton>
          <IconButton
            aria-label="在系统浏览器打开"
            title="在系统浏览器打开"
            onClick={handleOpenExternal}
          >
            <Icon name="external_link" size={ICON_MD} className="sp-glyph" />
          </IconButton>
        </div>
      </div>
      {notice !== null && (
        <div className="sp-artifact-notice" role="status">
          {notice.text}
        </div>
      )}
      <div className="sp-artifact-stage" ref={slot}>
        {cover !== undefined && (
          <img className="sp-artifact-cover" src={cover} alt="" aria-hidden="true" />
        )}
        {error !== null ? (
          <div className="sp-artifact-state">
            <div className="sp-artifact-error">{error}</div>
            <button
              type="button"
              className="sp-artifact-retry"
              onClick={() => {
                setReloadNonce((n) => n + 1);
              }}
            >
              重试
            </button>
          </div>
        ) : loading ? (
          <div className="sp-artifact-state" aria-live="polite">
            <span className="sp-glyph sp-spinner" aria-hidden="true" />
          </div>
        ) : null}
      </div>
    </div>
  );
}
