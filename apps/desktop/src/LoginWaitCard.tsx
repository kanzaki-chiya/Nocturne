/**
 * 登录等待卡（desktop-v3.html C 屏）：授权地址 + 复制 / 重新打开 / 粘贴回调 / 取消 + 倒计时。
 * LoginStarted 不含截止时间：倒计时按登录类型的服务端超时估算（仅展示用，
 * 真正的超时以 login.completed 的 error 为准）。
 */
import { useEffect, useState } from "react";
import type { LoginStarted } from "@nocturne/rpc/client";

function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function LoginWaitCard({
  login,
  warn = false,
  onOpenAuthorize,
  onCancel,
  onSubmitManual,
}: {
  /** 倒计时以服务端给的 login.expiresAt（Unix 毫秒）为准 */
  login: LoginStarted;
  /** 凭据失效后的重新登录：卡片用警告色描边 */
  warn?: boolean;
  onOpenAuthorize: () => void;
  onCancel: () => Promise<void>;
  /** 粘贴回调地址或授权码；失败抛错，错误显示在卡片里 */
  onSubmitManual: (text: string) => Promise<void>;
}) {
  const deadline = login.expiresAt;
  const [left, setLeft] = useState(() => Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
  const [cancelling, setCancelling] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualText, setManualText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setLeft(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [deadline]);

  const submitManual = async () => {
    const text = manualText.trim();
    if (text === "" || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmitManual(text);
      setManualText("");
      setSubmitted(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const manualLabel =
    login.manualInput === "callback-url"
      ? "粘贴回调地址"
      : login.manualInput === "code"
        ? "粘贴授权码"
        : null;

  return (
    <div className={`wait${warn ? " warnb" : ""}`} data-testid="login-wait">
      <div className="l1">
        <span className="spin" aria-hidden="true" />
        <span>{submitted ? "正在完成登录…" : "等待浏览器授权…"}</span>
      </div>
      {login.userCode !== undefined && (
        <div className="code">
          在浏览器里核对确认码 <b className="mono">{login.userCode}</b>
        </div>
      )}
      <div className="url" title={login.authorizeUrl}>
        {login.authorizeUrl}
      </div>
      <div className="row">
        <button
          className="btn"
          onClick={() => {
            navigator.clipboard
              .writeText(login.authorizeUrl)
              .then(() => {
                setCopied(true);
                window.setTimeout(() => {
                  setCopied(false);
                }, 2000);
              })
              .catch(() => undefined); // 剪贴板不可用时地址仍完整显示，可手动复制
          }}
        >
          {copied ? "已复制" : "复制链接"}
        </button>
        <button className="btn" onClick={onOpenAuthorize}>
          重新打开浏览器
        </button>
        {manualLabel !== null && (
          <button
            className="btn ghost"
            aria-expanded={manualOpen}
            onClick={() => {
              setManualOpen((open) => !open);
            }}
          >
            {manualLabel}…
          </button>
        )}
        <button
          className="btn ghost"
          disabled={cancelling}
          onClick={() => {
            setCancelling(true);
            void onCancel().finally(() => {
              setCancelling(false);
            });
          }}
        >
          {cancelling ? "取消中…" : "取消"}
        </button>
        <span className="cd" title="授权超时倒计时">
          {left > 0 ? clock(left) : "已超时"}
        </span>
      </div>
      {manualLabel !== null && manualOpen && (
        <div className="manual">
          <input
            className="input mono"
            type="text"
            spellCheck={false}
            autoFocus
            placeholder={
              login.manualInput === "callback-url"
                ? "回调失败或远程使用时，把浏览器地址栏的完整地址粘贴到这里"
                : "把浏览器显示的授权码粘贴到这里"
            }
            aria-label={manualLabel}
            value={manualText}
            disabled={submitting}
            onChange={(e) => {
              setManualText(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitManual();
            }}
          />
          <button
            className="btn primary"
            disabled={submitting || manualText.trim() === ""}
            onClick={() => void submitManual()}
          >
            {submitting ? "提交中…" : "提交"}
          </button>
        </div>
      )}
      {error !== null && <div className="errt">{error}</div>}
    </div>
  );
}
