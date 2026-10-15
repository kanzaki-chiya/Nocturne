self.addEventListener("push", (event) => {
  event.waitUntil(
    self.registration.showNotification("Nocturne：有会话需要你处理", {
      tag: "nocturne-attention",
      renotify: true,
      icon: "/icons/icon-192.png",
    }),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = windows.find(
        (client) => new URL(client.url).origin === self.location.origin,
      );
      // 推送无载荷，由网页连上电脑后自己找要处理的会话
      if (existing) {
        existing.postMessage({ t: "nocturne.attention" });
        await existing.focus();
      } else await self.clients.openWindow("/?attention");
    })(),
  );
});
