/**
 * 面板「浏览器」标签（ADR-0060 第 5 节、desktop.md 5.10）：工具栏（后退、前进、刷新/停止、
 * 地址栏、在系统浏览器打开、开发者工具）加一块占位区，外壳子 webview 按占位区的位置叠在
 * 上面。主界面浮层伸进占位区时换成截图占位（browser-occlusion.ts）。
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import {
  CAPTURE_TIMEOUT_MS,
  coverStep,
  HOLD_ATTRIBUTE,
  overlaysOver,
  type CoverEvent,
  type CoverState,
} from "./browser-occlusion";
import type { BrowserPool, BrowserStatus } from "./browser-pool";
import { parseAddress, type BrowserTab } from "./side-panel";

const FALLBACK: BrowserStatus = {
  url: "",
  loading: false,
  back: false,
  forward: false,
  live: false,
};

/** 订阅一个浏览器标签的状态（标签栏图标和浏览器面板共用） */
export function useBrowserStatus(pool: BrowserPool, tab: BrowserTab): BrowserStatus {
  const status = useSyncExternalStore(
    (listener) => pool.subscribe(tab.id, listener),
    () => pool.status(tab.id),
  );
  return status ?? { ...FALLBACK, url: tab.url };
}

/** 标签栏上的图标：加载中转圈，有网站图标用图标，否则地球 */
export function BrowserTabIcon({
  pool,
  tab,
  globe,
}: {
  pool: BrowserPool;
  tab: BrowserTab;
  globe: ReactNode;
}) {
  const status = useBrowserStatus(pool, tab);
  if (status.loading) {
    return <span className="sp-glyph sp-spinner" role="img" aria-label="正在加载" />;
  }
  if (status.favicon !== undefined) {
    return <img className="sp-glyph sp-favicon" src={status.favicon} alt="" aria-hidden="true" />;
  }
  return <>{globe}</>;
}

function ToolGlyph({
  kind,
}: {
  kind: "back" | "forward" | "reload" | "stop" | "external" | "dev";
}) {
  const paths: Record<typeof kind, ReactNode> = {
    back: <path d="M10 3.5 5.5 8l4.5 4.5" />,
    forward: <path d="m6 3.5 4.5 4.5L6 12.5" />,
    reload: <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3" />,
    stop: <path d="m4.5 4.5 7 7m0-7-7 7" />,
    external: (
      <path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" />
    ),
    dev: <path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5M9 3 7 13" />,
  };
  return (
    <svg className="sp-glyph" viewBox="0 0 16 16" aria-hidden="true">
      {paths[kind]}
    </svg>
  );
}

export interface BrowserPaneProps {
  tab: BrowserTab;
  pool: BrowserPool;
  /** 标签可见（面板开着、是当前会话的选中标签）：可见时显示 webview */
  visible: boolean;
  /** 地址栏相对 HTML 路径按它拼 */
  workspace: string | undefined;
  /** 「在系统浏览器打开」 */
  openExternal: (url: string) => Promise<void>;
}

export function BrowserPane({ tab, pool, visible, workspace, openExternal }: BrowserPaneProps) {
  const root = useRef<HTMLDivElement>(null);
  const slot = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState<string>();
  const [addressError, setAddressError] = useState<string>();
  const [cover, setCover] = useState<string>();
  const [noticeOpen, setNoticeOpen] = useState(true);
  const coverState = useRef<CoverState>("live");

  // 登记在布局与订阅之前（layout effect 先于普通 effect）；卸载（关闭标签、删除会话）时销毁 webview
  useLayoutEffect(() => {
    pool.register(tab.id, tab.url);
    return () => {
      pool.destroy(tab.id);
    };
    // 地址只在登记时用；之后由网页和地址栏驱动
  }, [pool, tab.id]);
  const status = useBrowserStatus(pool, tab);

  useEffect(() => {
    setNoticeOpen(true);
  }, [status.blocked, status.download]);

  // ── 位置：可见时跟着占位区走；用 layout effect，隐藏命令在这一帧绘制前发出 ──
  useLayoutEffect(() => {
    const node = slot.current;
    if (!visible || node === null) {
      pool.hide(tab.id);
      return;
    }
    const place = () => {
      if (coverState.current === "covered") return;
      const r = node.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) pool.hide(tab.id);
      else pool.show(tab.id, { x: r.left, y: r.top, width: r.width, height: r.height });
    };
    place();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(place);
    observer?.observe(node);
    window.addEventListener("resize", place);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", place);
      pool.hide(tab.id);
    };
  }, [visible, pool, tab.id]);

  // ── 遮挡：可见时盯着主界面浮层 ──
  useEffect(() => {
    const node = slot.current;
    if (!visible || node === null || typeof MutationObserver === "undefined") return;
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
      if (step.webview === "hide") pool.hide(tab.id);
      if (step.hold === false) {
        for (const el of held) el.removeAttribute(HOLD_ATTRIBUTE);
        held.clear();
      }
      if (step.webview === "show") {
        const r = node.getBoundingClientRect();
        pool.show(tab.id, { x: r.left, y: r.top, width: r.width, height: r.height });
      }
      if (step.clearPlaceholder === true) {
        // 先让 webview 盖回来，下一帧再撤截图，中间不露底
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
      if (step.capture === true) {
        timer = setTimeout(() => {
          timer = undefined;
          fire("timeout");
        }, CAPTURE_TIMEOUT_MS);
        void pool
          .capture(tab.id)
          .then(async (png) => {
            if (!capturing() || png === undefined) return;
            const url = URL.createObjectURL(new Blob([png as BlobPart], { type: "image/png" }));
            const image = new Image();
            image.src = url;
            await image.decode().catch(() => undefined);
            // 等解码期间浮层可能已经关了
            if (!capturing()) {
              URL.revokeObjectURL(url);
              return;
            }
            placeholder = url;
            setCover(url);
            // 截图画上去之后再藏 webview
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                if (alive) fire("captured");
              });
            });
          })
          // 截图失败：等超时，不换占位直接隐藏
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
  }, [visible, pool, tab.id]);

  const submit = () => {
    const text = editing ?? status.url;
    const target = parseAddress(text, workspace);
    if (target.kind === "invalid") {
      setAddressError(target.message);
      return;
    }
    setAddressError(undefined);
    setEditing(undefined);
    void pool.navigate(tab.id, target.url).then((message) => {
      if (message !== undefined) setAddressError(message);
    });
  };
  const notice =
    status.blocked !== undefined
      ? { text: status.blocked, alert: true }
      : status.download !== undefined
        ? {
            text:
              status.download.state === "started"
                ? `正在下载 ${status.download.name}`
                : status.download.state === "finished"
                  ? `已下载 ${status.download.name}`
                  : `下载失败：${status.download.name}`,
            alert: status.download.state === "failed",
          }
        : undefined;
  const address = editing ?? (status.url === "about:blank" ? "" : status.url);
  return (
    <div className="sp-browser" ref={root}>
      <header className="sp-browser-bar">
        <button
          type="button"
          className="sp-icon-btn"
          aria-label="后退"
          title="后退"
          disabled={!status.back}
          onClick={() => {
            pool.action(tab.id, "back");
          }}
        >
          <ToolGlyph kind="back" />
        </button>
        <button
          type="button"
          className="sp-icon-btn"
          aria-label="前进"
          title="前进"
          disabled={!status.forward}
          onClick={() => {
            pool.action(tab.id, "forward");
          }}
        >
          <ToolGlyph kind="forward" />
        </button>
        <button
          type="button"
          className="sp-icon-btn"
          aria-label={status.loading ? "停止" : "重新加载"}
          title={status.loading ? "停止" : "重新加载"}
          onClick={() => {
            pool.action(tab.id, status.loading ? "stop" : "reload");
          }}
        >
          <ToolGlyph kind={status.loading ? "stop" : "reload"} />
        </button>
        <form
          className="sp-browser-address"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <input
            value={address}
            aria-label="地址栏"
            placeholder="输入网址或 HTML 文件路径"
            spellCheck={false}
            onFocus={(event) => {
              event.currentTarget.select();
            }}
            onChange={(event) => {
              setEditing(event.target.value);
              setAddressError(undefined);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Escape" || editing === undefined) return;
              // 放弃编辑，回到当前地址；Esc 不再往下传（不开关概览浮层）
              event.preventDefault();
              setEditing(undefined);
              setAddressError(undefined);
            }}
            onBlur={() => {
              if (editing === status.url) setEditing(undefined);
            }}
          />
        </form>
        <button
          type="button"
          className="sp-icon-btn"
          aria-label="在系统浏览器打开"
          title="在系统浏览器打开"
          disabled={status.url === "" || status.url === "about:blank"}
          onClick={() => {
            void openExternal(status.url).catch((e: unknown) => {
              setAddressError(e instanceof Error ? e.message : String(e));
            });
          }}
        >
          <ToolGlyph kind="external" />
        </button>
        <button
          type="button"
          className="sp-icon-btn"
          aria-label="开发者工具"
          title="开发者工具"
          disabled={!status.live}
          onClick={() => {
            pool.action(tab.id, "devtools");
          }}
        >
          <ToolGlyph kind="dev" />
        </button>
      </header>
      {addressError !== undefined && (
        <p className="sp-browser-notice alert" role="alert">
          {addressError}
        </p>
      )}
      {notice !== undefined && noticeOpen && (
        <p className={`sp-browser-notice${notice.alert ? " alert" : ""}`} role="status">
          <span>{notice.text}</span>
          <button
            type="button"
            className="sp-icon-btn"
            aria-label="关闭提示"
            title="关闭"
            onClick={() => {
              setNoticeOpen(false);
            }}
          >
            <ToolGlyph kind="stop" />
          </button>
        </p>
      )}
      <div className="sp-browser-slot" ref={slot}>
        {cover !== undefined && <img className="sp-browser-cover" src={cover} alt="" />}
        {status.error !== undefined && (
          <div className="sp-empty sp-file-missing">
            <p>打不开这个网页：{status.error}</p>
            <div className="sp-file-actions">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  const r = slot.current?.getBoundingClientRect();
                  if (r !== undefined) {
                    pool.retry(tab.id, { x: r.left, y: r.top, width: r.width, height: r.height });
                  }
                }}
              >
                重试
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
