import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { FileAttachment } from "@nocturne/core/protocol";
import type { RpcSession } from "@nocturne/rpc/client";

import {
  triggerBytesDownload,
  useCustomOverlay,
  useFullscreenDialogTrap,
  useSaveFile,
} from "./ImageViewer";
import { ICON_LG, ICON_MD, Icon, IconButton } from "./ui";
import "./inline-page.css";

export const INLINE_PAGE_COLLAPSE_HEIGHT = 420;
export const INLINE_PAGE_MIN_HEIGHT = 48;
export const INLINE_PAGE_MAX_HEIGHT = 4096;
const INLINE_PAGE_INITIAL_HEIGHT = 160;

/** 注入给内嵌页面的稳定主题变量及对应的宿主 CSS 自定义属性名（ADR-0088） */
export const INLINE_THEME_SOURCES: readonly (readonly [target: string, source: string])[] = [
  ["--bg", "--a-panel"],
  ["--raised", "--a-raised"],
  ["--text", "--a-text"],
  ["--secondary", "--a-secondary"],
  ["--muted", "--a-muted"],
  ["--border", "--a-border"],
  ["--accent", "--a-accent"],
  ["--ok", "--a-success"],
  ["--warn", "--a-warning"],
  ["--bad", "--a-error"],
  ["--sans", "--sans"],
  ["--mono", "--mono"],
] as const;

interface ThemePayload {
  theme: Record<string, string>;
  colorScheme: "light" | "dark";
  fontSize: string;
}

export function readInlineTheme(): ThemePayload {
  const root = document.documentElement;
  const computed = window.getComputedStyle(root);
  const theme: Record<string, string> = {};
  for (const [target, source] of INLINE_THEME_SOURCES) {
    const val = computed.getPropertyValue(source).trim();
    if (val !== "") {
      theme[target] = val;
    }
  }
  const explicit = root.dataset.theme;
  let colorScheme: "light" | "dark";
  if (explicit === "light" || explicit === "dark") {
    colorScheme = explicit;
  } else if (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: light)").matches
  ) {
    colorScheme = "light";
  } else {
    colorScheme = "dark";
  }
  const fontSize = computed.getPropertyValue("--fs-3").trim() || "14px";
  return { theme, colorScheme, fontSize };
}

export function resolveSandboxFrameSrc(): string {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
    if (window.location.origin === "http://tauri.localhost" || /Windows|Android/i.test(ua)) {
      return "http://nct-sandbox.localhost/sandbox.html";
    }
    return "nct-sandbox://localhost/sandbox.html";
  }
  return "/sandbox.html";
}

function isValidResizeMessage(
  data: unknown,
  expectedId: string,
): data is { type: "nocturne:inline-html:resize"; id?: string; height: number } {
  if (typeof data !== "object" || data === null) return false;
  const rec = data as Record<string, unknown>;
  if (rec.type !== "nocturne:inline-html:resize") return false;
  if (rec.id !== undefined && rec.id !== expectedId) return false;
  return typeof rec.height === "number" && Number.isFinite(rec.height);
}

function isReadyMessage(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as Record<string, unknown>).type === "nocturne:inline-html:ready"
  );
}

function isEscapeMessage(data: unknown, expectedId: string): boolean {
  if (typeof data !== "object" || data === null) return false;
  const rec = data as Record<string, unknown>;
  if (rec.type !== "nocturne:inline-html:escape") return false;
  return rec.id === undefined || rec.id === expectedId;
}

function useSandboxedHtmlFrame(opts: {
  html: string | undefined;
  instanceId: string;
  fullscreen: boolean;
  onResize?: ((height: number) => void) | undefined;
  onEscape?: (() => void) | undefined;
}) {
  const { html, instanceId, fullscreen, onResize, onEscape } = opts;
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;
  const htmlRef = useRef(html);
  htmlRef.current = html;

  const postRender = useCallback(() => {
    const win = iframeRef.current?.contentWindow;
    const currentHtml = htmlRef.current;
    if (!win || currentHtml === undefined) return;
    const { theme, colorScheme, fontSize } = readInlineTheme();
    win.postMessage(
      {
        type: "nocturne:inline-html:render",
        id: instanceId,
        html: currentHtml,
        theme,
        colorScheme,
        fontSize,
        fullscreen,
      },
      "*",
    );
  }, [fullscreen, instanceId]);

  const postTheme = useCallback(() => {
    const win = iframeRef.current?.contentWindow;
    if (!win || htmlRef.current === undefined) return;
    const { theme, colorScheme, fontSize } = readInlineTheme();
    win.postMessage(
      {
        type: "nocturne:inline-html:theme",
        theme,
        colorScheme,
        fontSize,
      },
      "*",
    );
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const targetWindow = iframeRef.current?.contentWindow ?? null;
      if (targetWindow === null) return;
      if (event.source !== targetWindow) return;
      if (isReadyMessage(event.data)) {
        postRender();
        return;
      }
      if (isEscapeMessage(event.data, instanceId)) {
        onEscapeRef.current?.();
        return;
      }
      if (isValidResizeMessage(event.data, instanceId)) {
        const clamped = Math.max(
          INLINE_PAGE_MIN_HEIGHT,
          Math.min(INLINE_PAGE_MAX_HEIGHT, Math.ceil(event.data.height)),
        );
        onResizeRef.current?.(clamped);
      }
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
    };
  }, [instanceId, postRender]);

  // 切换深浅色或修改外观字体/字号时，直接推送新主题变量，不重新加载 iframe
  useEffect(() => {
    if (html === undefined) return;
    const observer =
      typeof MutationObserver !== "undefined"
        ? new MutationObserver(() => {
            postTheme();
          })
        : null;
    observer?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "style", "class"],
    });
    const mql =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-color-scheme: dark)")
        : null;
    const onMediaChange = () => {
      postTheme();
    };
    mql?.addEventListener("change", onMediaChange);
    return () => {
      observer?.disconnect();
      mql?.removeEventListener("change", onMediaChange);
    };
  }, [html, postTheme]);

  return { iframeRef, handleLoad: postRender };
}

function InlinePageFullscreen({
  title,
  filename,
  html,
  bytes,
  opener,
  onClose,
}: {
  title: string;
  filename: string;
  html: string;
  bytes: Uint8Array;
  opener: HTMLElement | null;
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const saveFile = useSaveFile();
  const [downloadError, setDownloadError] = useState<string>();
  const instanceId = useId();
  const sandboxSrc = resolveSandboxFrameSrc();

  useFullscreenDialogTrap({ rootRef, opener, onClose });

  const { iframeRef, handleLoad } = useSandboxedHtmlFrame({
    html,
    instanceId: `full:${instanceId}`,
    fullscreen: true,
    onEscape: onClose,
  });

  const handleDownload = () => {
    setDownloadError(undefined);
    triggerBytesDownload({
      filename,
      mimeType: "text/html;charset=utf-8",
      bytes,
      saveFile,
      onError: setDownloadError,
    });
  };

  return (
    <div
      ref={rootRef}
      className="inline-page-fullscreen"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
      onClick={(event) => {
        if (event.target === rootRef.current) {
          onClose();
        }
      }}
    >
      <div ref={sheetRef} className="inline-page-sheet">
        <iframe
          ref={iframeRef}
          className="inline-page-frame"
          sandbox="allow-scripts"
          src={sandboxSrc}
          title={title}
          onLoad={handleLoad}
        />
        <div className="inline-page-full-tools">
          <IconButton
            className="inline-page-btn"
            aria-label="下载"
            title={downloadError ?? "下载"}
            onClick={handleDownload}
          >
            <Icon name="download_2" size={ICON_LG} />
          </IconButton>
          <IconButton className="inline-page-btn" aria-label="关闭" title="关闭" onClick={onClose}>
            <Icon name="close" size={ICON_LG} />
          </IconButton>
        </div>
      </div>
    </div>
  );
}

export interface InlinePageProps {
  file: FileAttachment;
  session: Pick<RpcSession, "readAttachment"> | undefined;
  renderFallback: (errorMessage?: string) => ReactNode;
  onCollapseAboveViewport?: ((container: HTMLElement) => void) | undefined;
  searchHit?: boolean | undefined;
  sessionSeq?: number | undefined;
  completedSeq?: number | undefined;
}

export function InlinePage({
  file,
  session,
  renderFallback,
  onCollapseAboveViewport,
  searchHit = false,
  sessionSeq,
  completedSeq,
}: InlinePageProps) {
  const title = file.inline?.title ?? file.label;
  const instanceId = useId();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fullBtnRef = useRef<HTMLButtonElement | null>(null);
  const [loaded, setLoaded] = useState<{ html: string; bytes: Uint8Array } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  const prevDisplayedHeightRef = useRef<number>(INLINE_PAGE_INITIAL_HEIGHT);

  const overlay = useCustomOverlay();
  const sandboxSrc = resolveSandboxFrameSrc();

  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    setFailed(null);
    setContentHeight(null);
    setExpanded(false);
    if (!session) {
      setFailed("");
      return;
    }
    session.readAttachment(file.file).then(
      (res) => {
        if (cancelled) return;
        const html = new TextDecoder("utf-8").decode(res.data);
        setLoaded({ html, bytes: res.data });
      },
      (err: unknown) => {
        if (cancelled) return;
        setFailed(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [file.file, file.sha256, session]);

  const { iframeRef, handleLoad } = useSandboxedHtmlFrame({
    html: loaded?.html,
    instanceId: `inline:${instanceId}`,
    fullscreen: false,
    onResize: setContentHeight,
  });

  const collapsible = contentHeight !== null && contentHeight > INLINE_PAGE_COLLAPSE_HEIGHT;
  const displayedHeight =
    collapsible && !expanded
      ? INLINE_PAGE_COLLAPSE_HEIGHT
      : (contentHeight ?? INLINE_PAGE_INITIAL_HEIGHT);

  // 当页面位于视口上方且高度被动变化时补偿滚动容器，防止阅读位置跳动
  useLayoutEffect(() => {
    const prev = prevDisplayedHeightRef.current;
    prevDisplayedHeightRef.current = displayedHeight;
    const delta = displayedHeight - prev;
    if (delta === 0) return;
    const box = containerRef.current;
    const scroller = box?.closest<HTMLElement>(".conversation-scroll");
    if (!box || !scroller) return;
    const isAtBottom = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 4;
    if (isAtBottom) return;
    const boxRect = box.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    if (boxRect.bottom <= scrollerRect.top) {
      scroller.scrollTop += delta;
    }
  }, [displayedHeight]);

  if (failed !== null) {
    return <>{renderFallback(failed)}</>;
  }

  const openFullscreen = () => {
    if (!loaded) return;
    const opener = fullBtnRef.current;
    overlay.open(
      (onClose) => (
        <InlinePageFullscreen
          title={title}
          filename={file.label}
          html={loaded.html}
          bytes={loaded.bytes}
          opener={opener}
          onClose={onClose}
        />
      ),
      opener,
    );
  };

  const toggleExpanded = () => {
    if (expanded) {
      setExpanded(false);
      if (containerRef.current) {
        onCollapseAboveViewport?.(containerRef.current);
      }
    } else {
      setExpanded(true);
    }
  };

  return (
    <div
      ref={containerRef}
      className={`inline-page${collapsible && !expanded ? " is-collapsed" : ""}${collapsible && expanded ? " is-expanded" : ""}${searchHit ? " search-hit" : ""}`}
      data-session-seq={sessionSeq}
      data-completed-seq={completedSeq}
    >
      <div className="inline-page-body" style={{ height: `${displayedHeight}px` }}>
        {loaded !== null && (
          <iframe
            ref={iframeRef}
            className="inline-page-frame"
            style={{ height: `${contentHeight ?? INLINE_PAGE_INITIAL_HEIGHT}px` }}
            sandbox="allow-scripts"
            src={sandboxSrc}
            title={title}
            onLoad={handleLoad}
          />
        )}
      </div>
      {collapsible && !expanded && <div className="inline-page-fade" aria-hidden="true" />}
      {loaded !== null && (
        <div className="inline-page-tools">
          <IconButton
            ref={fullBtnRef}
            className="inline-page-tool-btn"
            aria-label="全屏"
            title="全屏"
            onClick={openFullscreen}
          >
            <Icon name="fullscreen" size={ICON_MD} />
          </IconButton>
        </div>
      )}
      {collapsible && (
        <div className="inline-page-more-wrap">
          <IconButton
            className="inline-page-more"
            aria-label={expanded ? "收起" : "展开"}
            title={expanded ? "收起" : "展开"}
            aria-expanded={expanded}
            onClick={toggleExpanded}
          >
            <Icon name="down_small" size={ICON_MD} className="inline-page-chevron" />
          </IconButton>
        </div>
      )}
    </div>
  );
}
