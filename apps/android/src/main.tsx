import { createRoot } from "react-dom/client";
import { PhoneApp } from "../../desktop/src/web/App";
import { indexedStorage } from "../../desktop/src/web/storage";
import type { WebHost } from "../../desktop/src/web/host";
import "../../desktop/src/styles.css";
import "../../desktop/src/web/phone.css";
import "./app.css";
import { tauriHost } from "./host";
import { appPlatform } from "./platform";

// WebView 不允许导航到页面以外的地址（Rust 侧 on_navigation 强制），所以外链在 App 里不打开
const host: WebHost = {
  openUrl: () => undefined,
  note: (message) => {
    console.warn(message);
  },
};
const platform = appPlatform(tauriHost);
platform.probe.start();
// 页面被系统收走（App 被杀或渲染进程重建）前尽量落盘
const flush = () => {
  platform.probe.flush();
};
addEventListener("pagehide", flush);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flush();
});
const root = document.getElementById("root");
if (root)
  createRoot(root).render(<PhoneApp storage={indexedStorage()} host={host} platform={platform} />);
