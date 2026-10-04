import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { createTauriHost } from "./tauri-host";
import { WindowFrame } from "./WindowFrame";
import "./styles.css";

// RPC 连接持有外部进程与会话锁，不能随 React Fast Refresh 丢弃所有权。
// 开发更新统一转为整页重载，由 Rust 的页面代际钩子收束旧后台。
import.meta.hot?.on("vite:beforeUpdate", () => {
  window.location.reload();
});

const root = document.getElementById("root");
const host = createTauriHost();
if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <WindowFrame host={host}>
        <App host={host} />
      </WindowFrame>
    </StrictMode>,
  );
}
