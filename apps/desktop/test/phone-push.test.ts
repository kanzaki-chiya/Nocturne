import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import type { DeviceRelay } from "@nocturne/remote";
import { PhonePush, pushAvailable } from "../src/web/push";

function fixture() {
  let current: PushSubscription | null = null;
  const subscription = {
    toJSON: () => ({
      endpoint: "https://push.example/test",
      keys: { p256dh: "key", auth: "auth" },
    }),
    unsubscribe: vi.fn(() => {
      current = null;
      return Promise.resolve(true);
    }),
  } as unknown as PushSubscription;
  const manager = {
    getSubscription: vi.fn(() => Promise.resolve(current)),
    subscribe: vi.fn(() => {
      current = subscription;
      return Promise.resolve(subscription);
    }),
  } as unknown as PushManager;
  const request = vi.fn(() => Promise.resolve<NotificationPermission>("granted"));
  const push = new PhonePush({
    registration: () => Promise.resolve({ pushManager: manager }),
    permission: () => "default",
    requestPermission: request,
    info: () => Promise.resolve({ vapidPublicKey: "AQID" }),
    changed: vi.fn(),
  });
  const relay = () =>
    ({
      subscribePush: vi.fn(() => Promise.resolve()),
      unsubscribePush: vi.fn(() => Promise.resolve()),
    }) as unknown as DeviceRelay;
  return { push, request, manager, subscription, relay };
}
it("只有点击入口请求权限、同步所有当前电脑、离线电脑下次补发、关闭取消订阅", async () => {
  const f = fixture();
  const first = f.relay(),
    second = f.relay(),
    offline = f.relay();
  await f.push.refresh();
  await f.push.attach("one", first);
  await f.push.attach("two", second);
  expect(f.request).not.toHaveBeenCalled();
  expect(f.manager.subscribe).not.toHaveBeenCalled();
  await f.push.enable();
  expect(f.request).toHaveBeenCalledTimes(1);
  expect(f.manager.subscribe).toHaveBeenCalledWith({
    userVisibleOnly: true,
    applicationServerKey: Uint8Array.from([1, 2, 3]),
  });
  for (const relay of [first, second])
    expect(relay.subscribePush).toHaveBeenCalledWith({
      endpoint: "https://push.example/test",
      p256dh: "key",
      auth: "auth",
    });
  expect(offline.subscribePush).not.toHaveBeenCalled();
  await f.push.attach("three", offline);
  expect(offline.subscribePush).toHaveBeenCalledOnce();
  await f.push.disable();
  expect(f.subscription.unsubscribe).toHaveBeenCalledOnce();
  expect(f.push.state).toBe("disabled");
  for (const relay of [first, second, offline]) expect(relay.unsubscribePush).toHaveBeenCalled();
  const later = f.relay();
  await f.push.attach("four", later);
  expect(later.unsubscribePush).toHaveBeenCalledOnce();
});
it("通知拒绝不订阅；iOS 非 standalone 隐藏按钮", async () => {
  const f = fixture();
  f.request.mockResolvedValue("denied");
  await f.push.enable();
  expect(f.push.state).toBe("denied");
  expect(f.manager.subscribe).not.toHaveBeenCalled();
  expect(pushAvailable(true, false)).toBe(false);
  expect(pushAvailable(true, true)).toBe(true);
  expect(pushAvailable(false, false)).toBe(true);
});
it.each([true, false])(
  "service worker 固定无载荷文案与 notificationclick（已有窗口 %s）",
  async (existing) => {
    const handlers = new Map<
      string,
      (event: {
        waitUntil: (promise: Promise<unknown>) => void;
        notification: { close: () => void };
      }) => void
    >();
    const focus = vi.fn(() => Promise.resolve());
    const openWindow = vi.fn(() => Promise.resolve());
    const showNotification = vi.fn(() => Promise.resolve());
    const source = await readFile("public-web/sw.js", "utf8");
    runInNewContext(source, {
      URL,
      self: {
        location: { origin: "https://relay.example" },
        addEventListener: (
          name: string,
          fn: (event: {
            waitUntil: (promise: Promise<unknown>) => void;
            notification: { close: () => void };
          }) => void,
        ) => {
          handlers.set(name, fn);
        },
        registration: { showNotification },
        clients: {
          matchAll: () =>
            Promise.resolve(existing ? [{ url: "https://relay.example/", focus }] : []),
          openWindow,
        },
      },
    });
    expect([...handlers.keys()]).toEqual(["push", "notificationclick"]);
    expect(source).not.toContain('addEventListener("fetch"');
    const close = vi.fn();
    let work = Promise.resolve<unknown>(undefined);
    const event = {
      waitUntil: (p: Promise<unknown>) => {
        work = p;
      },
      notification: { close },
    };
    handlers.get("push")?.(event);
    await work;
    expect(showNotification).toHaveBeenCalledWith("Nocturne：有会话需要你处理", {
      tag: "nocturne-attention",
      renotify: true,
      icon: "/icons/icon-192.png",
    });
    handlers.get("notificationclick")?.(event);
    await work;
    expect(close).toHaveBeenCalledOnce();
    if (existing) {
      expect(focus).toHaveBeenCalledOnce();
      expect(openWindow).not.toHaveBeenCalled();
    } else expect(openWindow).toHaveBeenCalledWith("/");
  },
);
it("manifest 字段和所有 PNG 尺寸正确，SW 固定文件存在", async () => {
  const manifest = JSON.parse(await readFile("public-web/manifest.webmanifest", "utf8")) as {
    icons: { src: string; sizes: string }[];
  };
  expect(manifest).toMatchObject({
    name: "Nocturne",
    display: "standalone",
    start_url: "/",
    scope: "/",
  });
  for (const icon of [
    ...manifest.icons,
    { src: "/icons/apple-touch-icon.png", sizes: "180x180" },
  ]) {
    const image = await readFile(`public-web${icon.src}`);
    expect(image.subarray(1, 4).toString()).toBe("PNG");
    expect(`${image.readUInt32BE(16)}x${image.readUInt32BE(20)}`).toBe(icon.sizes);
  }
});
