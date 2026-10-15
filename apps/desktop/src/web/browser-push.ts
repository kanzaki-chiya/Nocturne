import { PhonePush } from "./push";

// 网页专属：service worker 与浏览器 Web Push。App 入口不得引用本文件（depcheck android-no-web-push）。
let registration: Promise<ServiceWorkerRegistration> | undefined;
export function registerWorker(): Promise<ServiceWorkerRegistration> {
  if (!("serviceWorker" in navigator)) return Promise.reject(new Error("此浏览器不支持主屏幕推送"));
  return (registration ??= navigator.serviceWorker
    .register("/sw.js", { scope: "/" })
    .then(() => navigator.serviceWorker.ready));
}
export function browserPush(changed: () => void): PhonePush {
  return new PhonePush({
    registration: registerWorker,
    changed,
    permission: () => ("Notification" in window ? Notification.permission : "denied"),
    requestPermission: () =>
      "Notification" in window ? Notification.requestPermission() : Promise.resolve("denied"),
    info: async () => {
      const response = await fetch("/v1/info");
      if (!response.ok) throw new Error("无法读取中继推送配置");
      return response.json() as Promise<{ vapidPublicKey: string }>;
    },
  });
}
