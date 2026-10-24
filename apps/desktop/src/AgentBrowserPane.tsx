/**
 * 面板里的 agent 标签（desktop-browser.md 第 7 节）：外壳建立的只读受控 webview 叠在
 * 占位区上，这里只画工具栏（徽标、活动状态、接管/交回、关闭）、网页脚本对话框的横幅和
 * 占位区，并把占位区的位置报给外壳。agent 的截图走工具结果附件，不在这里显示。
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import type { AgentTabInfo, BrowserBounds } from "./host";

const STATE_TEXT: Record<AgentTabInfo["state"], string> = {
  agent: "agent 控制中",
  busy: "agent 正在操作",
  taken_over: "已被你接管",
  ended: "已关闭",
};

function AgentGlyph({ kind }: { kind: "agent" | "hand" | "back" | "close" }): ReactNode {
  const paths: Record<typeof kind, ReactNode> = {
    agent: (
      <>
        <rect x="3" y="5" width="10" height="7.5" rx="2" />
        <path d="M8 5V2.5M5.5 8h.01M10.5 8h.01M5.5 11h5" />
      </>
    ),
    hand: (
      <path d="M5 8.5V5a1 1 0 0 1 2 0v3-4a1 1 0 0 1 2 0v4-3a1 1 0 0 1 2 0v5.5l-1.5 3h-4L3.5 9.5a1 1 0 0 1 1.5-1Z" />
    ),
    back: <path d="M10 3 5 8l5 5M5 8h6" />,
    close: <path d="m4 4 8 8m0-8-8 8" />,
  };
  return (
    <svg className="sp-glyph" viewBox="0 0 16 16" aria-hidden="true">
      {paths[kind]}
    </svg>
  );
}

const DIALOG_KIND: Record<string, string> = {
  alert: "提示框",
  confirm: "确认框",
  prompt: "输入框",
  beforeunload: "离开确认",
};

function originOf(uri: string): string {
  try {
    return new URL(uri).host || uri;
  } catch {
    return uri;
  }
}

type AgentDialog = NonNullable<AgentTabInfo["dialog"]>;

/**
 * 网页的脚本对话框：外壳挂起它，网页脚本停在这里，agent 的动作返回 dialog_open，
 * 直到用户在这里点确定或取消（prompt 先填输入）。
 */
function DialogBanner({
  dialog,
  onAnswer,
}: {
  dialog: AgentDialog;
  onAnswer: (accept: boolean, text?: string) => void;
}) {
  const [text, setText] = useState(dialog.defaultText ?? "");
  const prompt = dialog.kind === "prompt";
  return (
    <form
      className="sp-agent-dialog"
      aria-label="网页对话框"
      onSubmit={(event) => {
        event.preventDefault();
        onAnswer(true, prompt ? text : undefined);
      }}
    >
      <p className="sp-agent-dialog-title" role="alert">
        {originOf(dialog.uri)} 的网页弹出了{DIALOG_KIND[dialog.kind] ?? "对话框"}，等你处理
        {dialog.message !== "" ? "：" : ""}
      </p>
      {dialog.message !== "" && <p className="sp-agent-dialog-message">{dialog.message}</p>}
      {prompt && (
        <input
          aria-label="对话框输入"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
          }}
        />
      )}
      <div className="sp-agent-dialog-actions">
        {dialog.kind !== "alert" && (
          <button
            type="button"
            className="btn"
            onClick={() => {
              onAnswer(false);
            }}
          >
            取消
          </button>
        )}
        <button type="submit" className="btn primary">
          确定
        </button>
      </div>
    </form>
  );
}

export interface AgentBrowserPaneProps {
  info: AgentTabInfo;
  /** 面板可见且是当前标签：可见时把 webview 放在占位区，否则由外壳移到可见区域外 */
  visible: boolean;
  onSlot: (tabId: string, bounds: BrowserBounds) => void;
  onControl: (tabId: string, action: "takeover" | "return") => void;
  onDialog: (tabId: string, accept: boolean, text?: string) => void;
  onClose: (tabId: string) => void;
}

export function AgentBrowserPane({
  info,
  visible,
  onSlot,
  onControl,
  onDialog,
  onClose,
}: AgentBrowserPaneProps) {
  const slot = useRef<HTMLDivElement>(null);

  // 占位区变化时报告一次；可见性交给 PanelHost 汇总成 UiState
  useLayoutEffect(() => {
    const node = slot.current;
    if (!visible || node === null) return;
    const place = () => {
      const rect = node.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      onSlot(info.tabId, {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      });
    };
    place();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(place);
    observer?.observe(node);
    window.addEventListener("resize", place);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [visible, info.tabId, onSlot]);

  const takenOver = info.state === "taken_over";
  const ended = info.state === "ended" || !info.live;
  return (
    <div className="sp-browser sp-agent-browser">
      <header className="sp-browser-bar">
        <span
          className={`sp-agent-badge${info.child ? " child" : ""}`}
          title="这个标签由 agent 打开"
        >
          <AgentGlyph kind="agent" />
          {info.child ? "子代理" : "agent"}
        </span>
        <span className={`sp-agent-state${info.state === "busy" ? " busy" : ""}`} role="status">
          {STATE_TEXT[info.state]}
          {info.operation !== undefined && <span className="muted-value">{info.operation}</span>}
        </span>
        <span className="sp-agent-url" title={info.url}>
          {info.title !== "" ? info.title : info.url}
        </span>
        <button
          type="button"
          className={`btn sp-agent-control${takenOver ? "" : " primary"}`}
          disabled={ended}
          onClick={() => {
            onControl(info.tabId, takenOver ? "return" : "takeover");
          }}
        >
          {takenOver ? "交给 agent" : "接管"}
        </button>
        <button
          type="button"
          className="sp-icon-btn"
          aria-label="关闭 agent 标签"
          title="关闭"
          onClick={() => {
            onClose(info.tabId);
          }}
        >
          <AgentGlyph kind="close" />
        </button>
      </header>
      {/* 横幅、提示和说明放在同一行网格里：占位区固定在第 4 行，不能被挤乱 */}
      <div className="sp-agent-info">
        {info.dialog !== undefined && !ended && (
          <DialogBanner
            key={`${info.dialog.kind}|${info.dialog.message}`}
            dialog={info.dialog}
            onAnswer={(accept, text) => {
              onDialog(info.tabId, accept, text);
            }}
          />
        )}
        {info.notice !== undefined && info.notice !== "" && (
          <p className="sp-browser-notice" role="status">
            {info.notice}
          </p>
        )}
        <div className="sp-agent-hint">
          {takenOver
            ? "你已接管：直接操作网页；点「交给 agent」把控制权交回。"
            : "这个标签由 agent 打开、内容不可信；点网页或「接管」会立即撤销 agent 的控制权。"}
        </div>
      </div>
      <div className="sp-browser-slot sp-agent-slot" ref={slot}>
        {ended && (
          <div className="sp-empty">
            <p>标签已关闭</p>
            <div className="sp-file-actions">
              <button
                type="button"
                className="btn"
                aria-label="移除已关闭的标签"
                onClick={() => {
                  onClose(info.tabId);
                }}
              >
                <AgentGlyph kind="back" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
