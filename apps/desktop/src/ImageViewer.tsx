import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import { ICON_LG, Icon, IconButton } from "./ui";
import "./image-viewer.css";

const MAX_ZOOM = 8;

export interface ViewerImageItem {
  src: string;
  filename: string;
  alt?: string | undefined;
  blob?: Blob | undefined;
}

export interface ImageViewerCapabilities {
  copy?: boolean | undefined;
  download?: boolean | undefined;
}

export type OpenImageViewer = (
  items: readonly ViewerImageItem[],
  initialIndex: number,
  opener?: HTMLElement | null,
) => void;

interface ActiveViewerState {
  items: readonly ViewerImageItem[];
  initialIndex: number;
  opener: HTMLElement | null;
}

const ImageViewerContext = createContext<OpenImageViewer | null>(null);

export interface ImageViewerControl {
  readonly isOpen: boolean;
  close: () => void;
}

export function ImageViewerProvider({
  children,
  capabilities,
  controlRef,
  onOpenChange,
}: {
  children: ReactNode;
  capabilities?: ImageViewerCapabilities | undefined;
  controlRef?: RefObject<ImageViewerControl | null> | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
}) {
  const [active, setActive] = useState<ActiveViewerState | null>(null);
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;

  const close = useCallback(() => {
    setActive((prev) => {
      if (prev === null) return null;
      return null;
    });
  }, []);

  const open = useCallback<OpenImageViewer>((items, initialIndex, opener) => {
    if (items.length === 0) return;
    const clamped = Math.max(0, Math.min(items.length - 1, initialIndex));
    const fallbackOpener =
      opener !== undefined
        ? opener
        : document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    setActive({ items, initialIndex: clamped, opener: fallbackOpener });
  }, []);

  const isOpen = active !== null;
  useEffect(() => {
    if (controlRef !== undefined) {
      controlRef.current = { isOpen, close };
    }
    return () => {
      if (controlRef !== undefined) {
        controlRef.current = null;
      }
    };
  }, [close, controlRef, isOpen]);

  const prevOpen = useRef(false);
  useEffect(() => {
    if (prevOpen.current !== isOpen) {
      prevOpen.current = isOpen;
      onOpenChangeRef.current?.(isOpen);
    }
  }, [isOpen]);

  return (
    <ImageViewerContext.Provider value={open}>
      {children}
      {active !== null &&
        createPortal(
          <ImageViewer
            items={active.items}
            initialIndex={active.initialIndex}
            opener={active.opener}
            capabilities={capabilities}
            onClose={close}
          />,
          document.body,
        )}
    </ImageViewerContext.Provider>
  );
}

export function ImageViewerBoundary({
  children,
  capabilities,
}: {
  children: ReactNode;
  capabilities?: ImageViewerCapabilities | undefined;
}) {
  const existing = useContext(ImageViewerContext);
  if (existing !== null) return <>{children}</>;
  return <ImageViewerProvider capabilities={capabilities}>{children}</ImageViewerProvider>;
}

export function useImageViewer(): OpenImageViewer {
  const open = useContext(ImageViewerContext);
  const noop = useMemo<OpenImageViewer>(() => () => undefined, []);
  return open ?? noop;
}

function clipboardSupported(): boolean {
  if (typeof navigator === "undefined" || typeof ClipboardItem === "undefined") return false;
  const clip = (navigator as { clipboard?: { write?: unknown } }).clipboard;
  return typeof clip?.write === "function";
}

function pos(n: number | undefined | null): number | undefined {
  return n !== undefined && n !== null && n > 0 ? n : undefined;
}

async function encodeToPng(src: string, imgEl: HTMLImageElement | null): Promise<Blob> {
  let source: HTMLImageElement;
  if (imgEl !== null && imgEl.src === src && imgEl.complete && imgEl.naturalWidth > 0) {
    source = imgEl;
  } else {
    source = await new Promise<HTMLImageElement>((resolve, reject) => {
      const im = new Image();
      im.onload = () => {
        resolve(im);
      };
      im.onerror = () => {
        reject(new Error("Failed to decode image"));
      };
      im.src = src;
    });
  }
  const width = source.naturalWidth || source.width;
  const height = source.naturalHeight || source.height;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    throw new Error("Canvas 2D context unavailable");
  }
  ctx.drawImage(source, 0, 0, width, height);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob !== null) resolve(blob);
      else reject(new Error("Failed to encode PNG"));
    }, "image/png");
  });
}

function visibleButtons(root: HTMLElement | null): HTMLButtonElement[] {
  if (root === null) return [];
  const all = Array.from(root.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
  return all.filter((btn) => {
    let cur: HTMLElement | null = btn;
    while (cur !== null && cur !== root) {
      if (window.getComputedStyle(cur).display === "none") return false;
      cur = cur.parentElement;
    }
    return true;
  });
}

export function ImageViewer({
  items,
  initialIndex = 0,
  opener = null,
  capabilities,
  onClose,
}: {
  items: readonly ViewerImageItem[];
  initialIndex?: number | undefined;
  opener?: HTMLElement | null | undefined;
  capabilities?: ImageViewerCapabilities | undefined;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(() => Math.max(0, Math.min(items.length - 1, initialIndex)));
  const [zoomed, setZoomed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [copyError, setCopyError] = useState<string>();

  const rootRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const suppressClickRef = useRef(false);

  const viewState = useRef({ fit: 1, s: 1, tx: 0, ty: 0 });
  const indexRef = useRef(index);
  indexRef.current = index;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const current = items[index] ?? items[0];
  const many = items.length > 1;
  const canCopy = (capabilities?.copy ?? true) && clipboardSupported();
  const canDownload = capabilities?.download ?? true;

  const measure = useCallback(() => {
    const stage = stageRef.current;
    const img = imgRef.current;
    const stageW = pos(stage?.clientWidth) ?? pos(window.innerWidth) ?? 800;
    const stageH = pos(stage?.clientHeight) ?? pos(window.innerHeight) ?? 600;
    const natW =
      pos(img?.naturalWidth) ??
      pos(Number(img?.getAttribute("data-natural-width"))) ??
      pos(img?.width) ??
      400;
    const natH =
      pos(img?.naturalHeight) ??
      pos(Number(img?.getAttribute("data-natural-height"))) ??
      pos(img?.height) ??
      300;
    const narrow = (pos(window.innerWidth) ?? stageW) <= 600;
    return { stageW, stageH, natW, natH, narrow };
  }, []);

  const applyTransform = useCallback(() => {
    const img = imgRef.current;
    if (img === null) return;
    const { stageW, stageH, natW, natH } = measure();
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      img.width = img.naturalWidth;
      img.height = img.naturalHeight;
    }
    const st = viewState.current;
    const maxX = natW * st.s > stageW ? (natW * st.s - stageW) / 2 + 24 : 0;
    const maxY = natH * st.s > stageH ? (natH * st.s - stageH) / 2 + 24 : 0;
    st.tx = Math.max(-maxX, Math.min(maxX, st.tx));
    st.ty = Math.max(-maxY, Math.min(maxY, st.ty));
    img.style.transform = `translate(-50%, -50%) translate(${st.tx}px, ${st.ty}px) scale(${st.s})`;
    setZoomed(st.s > st.fit * 1.01);
  }, [measure]);

  const resetToFit = useCallback(() => {
    const { stageW, stageH, natW, natH, narrow } = measure();
    const availW = Math.max(1, stageW - (narrow ? 0 : 96));
    const availH = Math.max(1, stageH - (narrow ? 0 : 48));
    const fit = Math.min(1, availW / natW, availH / natH);
    viewState.current = { fit, s: fit, tx: 0, ty: 0 };
    applyTransform();
  }, [applyTransform, measure]);

  const zoomAt = useCallback(
    (nextRaw: number, clientX: number, clientY: number) => {
      const stage = stageRef.current;
      if (stage === null) return;
      const { stageW, stageH } = measure();
      const st = viewState.current;
      const next = Math.max(st.fit, Math.min(MAX_ZOOM, nextRaw));
      const rect = stage.getBoundingClientRect();
      const px = clientX - rect.left - stageW / 2;
      const py = clientY - rect.top - stageH / 2;
      const prev = st.s || 1;
      st.tx = px - ((px - st.tx) * next) / prev;
      st.ty = py - ((py - st.ty) * next) / prev;
      st.s = next;
      if (st.s <= st.fit * 1.01) {
        if (st.s <= st.fit * 1.001) st.s = st.fit;
        st.tx = 0;
        st.ty = 0;
      }
      applyTransform();
    },
    [applyTransform, measure],
  );

  const showIndex = useCallback((nextIndex: number) => {
    const len = itemsRef.current.length;
    if (len <= 1) return;
    setCopyError(undefined);
    setIndex(((nextIndex % len) + len) % len);
  }, []);

  useLayoutEffect(() => {
    resetToFit();
  }, [index, current?.src, resetToFit]);

  useLayoutEffect(() => {
    const saved =
      opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    rootRef.current?.focus();
    const onFocusIn = (event: FocusEvent) => {
      const root = rootRef.current;
      if (root === null) return;
      if (event.target instanceof Node && !root.contains(event.target)) {
        root.focus();
      }
    };
    document.addEventListener("focusin", onFocusIn, true);
    return () => {
      document.removeEventListener("focusin", onFocusIn, true);
      if (saved?.isConnected === true) {
        saved.focus();
      }
    };
  }, [opener]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onCloseRef.current();
        return;
      }
      if (
        event.key === "ArrowLeft" &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        itemsRef.current.length > 1
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        showIndex(indexRef.current - 1);
        return;
      }
      if (
        event.key === "ArrowRight" &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        itemsRef.current.length > 1
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        showIndex(indexRef.current + 1);
        return;
      }
      if (event.key === "Tab") {
        const root = rootRef.current;
        const btns = visibleButtons(root);
        if (btns.length === 0) {
          event.preventDefault();
          root?.focus();
          return;
        }
        const active = document.activeElement;
        const at = active instanceof HTMLButtonElement ? btns.indexOf(active) : -1;
        if (event.shiftKey) {
          if (at <= 0) {
            event.preventDefault();
            event.stopImmediatePropagation();
            btns[btns.length - 1]?.focus();
          }
        } else if (at === -1 || at === btns.length - 1) {
          event.preventDefault();
          event.stopImmediatePropagation();
          btns[0]?.focus();
        }
      }
    };
    const onResize = () => {
      resetToFit();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      window.removeEventListener("resize", onResize);
    };
  }, [resetToFit, showIndex]);

  useEffect(() => {
    const stage = stageRef.current;
    if (stage === null) return;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const dy = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      zoomAt(viewState.current.s * Math.exp(-dy * 0.0016), event.clientX, event.clientY);
    };

    const pts = new Map<number, { clientX: number; clientY: number }>();
    let moved = 0;
    let start: {
      x: number;
      y: number;
      tx: number;
      ty: number;
      onImg: boolean;
    } | null = null;
    let pinch: { d: number; s: number } | null = null;
    let lastTap: { time: number; x: number; y: number } | null = null;

    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      if ("setPointerCapture" in stage && typeof stage.setPointerCapture === "function") {
        stage.setPointerCapture(event.pointerId);
      }
      pts.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
      moved = 0;
      if (pts.size === 1) {
        start = {
          x: event.clientX,
          y: event.clientY,
          tx: viewState.current.tx,
          ty: viewState.current.ty,
          onImg: event.target === imgRef.current,
        };
      } else if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        if (a !== undefined && b !== undefined) {
          const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
          pinch = { d: Math.max(1, d), s: viewState.current.s };
        }
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!pts.has(event.pointerId)) return;
      pts.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
      if (pts.size === 2 && pinch !== null) {
        const [a, b] = [...pts.values()];
        if (a !== undefined && b !== undefined) {
          const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
          zoomAt((pinch.s * d) / pinch.d, (a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
          moved = 99;
        }
        return;
      }
      if (start === null) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      moved = Math.max(moved, Math.hypot(dx, dy));
      if (viewState.current.s > viewState.current.fit * 1.01 && moved >= 2) {
        viewState.current.tx = start.tx + dx;
        viewState.current.ty = start.ty + dy;
        setDragging(true);
        applyTransform();
      }
    };

    const finishPointer = (event: PointerEvent, cancelled: boolean) => {
      if (!pts.has(event.pointerId)) return;
      const wasSingle = pts.size === 1;
      pts.delete(event.pointerId);
      setDragging(false);
      if (!wasSingle) {
        pinch = null;
        moved = 99;
        suppressClickRef.current = true;
        return;
      }
      if (cancelled || start === null) {
        start = null;
        return;
      }
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      const st = viewState.current;
      if (
        st.s <= st.fit * 1.01 &&
        event.pointerType !== "mouse" &&
        Math.abs(dx) > 56 &&
        Math.abs(dx) > Math.abs(dy) &&
        itemsRef.current.length > 1
      ) {
        suppressClickRef.current = true;
        showIndex(indexRef.current + (dx < 0 ? 1 : -1));
        start = null;
        return;
      }
      if (moved >= 5) {
        suppressClickRef.current = true;
        start = null;
        return;
      }
      if (event.pointerType !== "mouse" && start.onImg) {
        const now = performance.now();
        if (
          lastTap !== null &&
          now - lastTap.time < 280 &&
          Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) < 36
        ) {
          const target =
            st.s > st.fit * 1.01 ? st.fit : Math.min(MAX_ZOOM, Math.max(1, st.fit * 2.5));
          zoomAt(target, event.clientX, event.clientY);
          lastTap = null;
          suppressClickRef.current = true;
          start = null;
          return;
        }
        lastTap = { time: now, x: event.clientX, y: event.clientY };
      }
      start = null;
    };

    const onPointerUp = (event: PointerEvent) => {
      finishPointer(event, false);
    };
    const onPointerCancel = (event: PointerEvent) => {
      finishPointer(event, true);
    };

    stage.addEventListener("wheel", onWheel, { passive: false });
    stage.addEventListener("pointerdown", onPointerDown);
    stage.addEventListener("pointermove", onPointerMove);
    stage.addEventListener("pointerup", onPointerUp);
    stage.addEventListener("pointercancel", onPointerCancel);
    return () => {
      stage.removeEventListener("wheel", onWheel);
      stage.removeEventListener("pointerdown", onPointerDown);
      stage.removeEventListener("pointermove", onPointerMove);
      stage.removeEventListener("pointerup", onPointerUp);
      stage.removeEventListener("pointercancel", onPointerCancel);
    };
  }, [applyTransform, showIndex, zoomAt]);

  if (current === undefined) return null;

  const handleCopy = async () => {
    setCopyError(undefined);
    try {
      const data: Blob | Promise<Blob> =
        current.blob?.type === "image/png"
          ? current.blob
          : encodeToPng(current.src, imgRef.current);
      await navigator.clipboard.write([new ClipboardItem({ "image/png": data })]);
    } catch (reason: unknown) {
      setCopyError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const handleDownload = () => {
    let href = current.src;
    let revoke = false;
    if (!href.startsWith("blob:") && current.blob !== undefined) {
      href = URL.createObjectURL(current.blob);
      revoke = true;
    }
    const link = document.createElement("a");
    link.href = href;
    link.download = current.filename;
    link.click();
    if (revoke) {
      setTimeout(() => {
        URL.revokeObjectURL(href);
      }, 1000);
    }
  };

  return (
    <div
      ref={rootRef}
      className="image-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={current.alt && current.alt !== "" ? current.alt : undefined}
      tabIndex={-1}
    >
      <div
        ref={stageRef}
        className={`iv-stage${zoomed ? " zoomed" : ""}${dragging ? " dragging" : ""}`}
        onClick={(event) => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
          }
          if (event.target === stageRef.current) {
            onClose();
          }
        }}
        onDoubleClick={(event) => {
          const st = viewState.current;
          const target = st.s > st.fit * 1.01 ? st.fit : st.fit < 0.99 ? 1 : 2;
          zoomAt(target, event.clientX, event.clientY);
        }}
      >
        <img
          ref={imgRef}
          src={current.src}
          alt={current.alt ?? ""}
          draggable={false}
          onLoad={() => {
            resetToFit();
          }}
        />
      </div>
      {many && (
        <>
          <span className="iv-nav prev">
            <IconButton
              className="iv-btn"
              aria-label="上一张"
              title="上一张"
              onClick={() => {
                showIndex(index - 1);
              }}
            >
              <Icon name="left" size={ICON_LG} />
            </IconButton>
          </span>
          <span className="iv-nav next">
            <IconButton
              className="iv-btn"
              aria-label="下一张"
              title="下一张"
              onClick={() => {
                showIndex(index + 1);
              }}
            >
              <Icon name="right" size={ICON_LG} />
            </IconButton>
          </span>
        </>
      )}
      <div className="iv-top">
        {canCopy && (
          <IconButton
            className="iv-btn"
            aria-label="复制"
            title={copyError ?? "复制"}
            onClick={() => {
              void handleCopy();
            }}
          >
            <Icon name="copy_2" size={ICON_LG} />
          </IconButton>
        )}
        {canDownload && (
          <IconButton className="iv-btn" aria-label="下载" title="下载" onClick={handleDownload}>
            <Icon name="download_2" size={ICON_LG} />
          </IconButton>
        )}
        <IconButton className="iv-btn iv-close" aria-label="关闭" title="关闭" onClick={onClose}>
          <Icon name="close" size={ICON_LG} />
        </IconButton>
      </div>
      {many && <div className="iv-count">{`${index + 1} / ${items.length}`}</div>}
    </div>
  );
}
