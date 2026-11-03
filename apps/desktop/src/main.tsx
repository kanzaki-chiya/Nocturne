import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { applyStoredAppearance } from "./appearance";
import { installInlineStyleShim } from "./inline-style-shim";
import { installKeyDiag } from "./key-diag";
import { installMotion } from "./motion";
import { createTauriHost } from "./tauri-host";
import { WindowFrame } from "./WindowFrame";
import "./styles.css";

// RPC 连接持有外部进程与会话锁，不能随 React Fast Refresh 丢弃所有权。
// 开发更新统一转为整页重载，由 Rust 的页面代际钩子收束旧后台。
import.meta.hot?.on("vite:beforeUpdate", () => {
  window.location.reload();
});

// CodeMirror、xterm 运行时插的 <style> 在正式包 CSP 下会被拦，见 inline-style-shim.ts
installInlineStyleShim();
installMotion();

// 主题与字体在首次渲染前就位，不闪默认外观；之后由 App 随设置更新
applyStoredAppearance(document.documentElement);

const root = document.getElementById("root");
const host = createTauriHost();
installKeyDiag((lines) => host.invoke("key_diag_push", { lines }));
if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <WindowFrame host={host}>
        <App host={host} />
      </WindowFrame>
    </StrictMode>,
  );
}
