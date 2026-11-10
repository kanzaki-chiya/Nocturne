import { useEffect, useState } from "react";
import { Icon } from "../../desktop/src/ui";
import { RESUME_EVENT, type AppHost } from "./host";
import type { AndroidUpdate } from "./update";

function useUpdate(update: AndroidUpdate) {
  const [, render] = useState(0);
  useEffect(
    () =>
      update.subscribe(() => {
        render((n) => n + 1);
      }),
    [update],
  );
}

export function UpdateLifecycle({ update }: { update: AndroidUpdate }) {
  useEffect(() => {
    const check = () => {
      void update.check();
    };
    check();
    window.addEventListener(RESUME_EVENT, check);
    return () => {
      window.removeEventListener(RESUME_EVENT, check);
    };
  }, [update]);
  return null;
}

export function UpdateAbout({
  update,
  host,
  version,
}: {
  update: AndroidUpdate;
  host: AppHost;
  version: string;
}) {
  useUpdate(update);
  const next = update.version;
  return (
    <div className="phone-update-version">
      <span>版本 {version}</span>
      {update.state === "checking" ? (
        <button className="phone-update-link" disabled>
          检查中
        </button>
      ) : next ? (
        <button
          className="phone-update-link"
          onClick={() => {
            void host.downloadApk(update.url(next)).catch(() => undefined);
          }}
        >
          下载 {next}
        </button>
      ) : update.state === "latest" ? (
        <span className="muted-value">已是最新</span>
      ) : (
        <button
          className="phone-update-link"
          onClick={() => {
            void update.check(true);
          }}
        >
          {update.state === "error" ? "检查失败，重试" : "检查更新"}
        </button>
      )}
    </div>
  );
}

export function UpdateNotice({
  update,
  host,
  incompatible = false,
}: {
  update: AndroidUpdate;
  host: AppHost;
  incompatible?: boolean;
}) {
  useUpdate(update);
  const version = incompatible ? update.version : update.notice;
  if (!incompatible && !version) return null;
  const content = (
    <>
      <span>{incompatible ? "App 版本过旧" : `新版本 ${version ?? ""}`}</span>
      <span className="phone-update-actions">
        {version && (
          <button
            className="phone-update-link"
            onClick={() => {
              void host.downloadApk(update.url(version)).catch(() => undefined);
            }}
          >
            下载{incompatible ? ` ${version}` : ""}
          </button>
        )}
        {!incompatible && (
          <button
            className="phone-icon-button"
            aria-label="关闭"
            onClick={() => {
              update.dismiss();
            }}
          >
            <Icon name="close" size={16} />
          </button>
        )}
      </span>
    </>
  );
  return incompatible ? (
    content
  ) : (
    <aside className="phone-status phone-update-content" role="status">
      {content}
    </aside>
  );
}
