import type { DeviceRelay } from "@nocturne/remote";
import { decode } from "./storage";

export type PushState = "disabled" | "enabled" | "denied" | "working" | "unsupported" | "error";
export function pushAvailable(ios: boolean, standalone: boolean): boolean {
  return !ios || standalone;
}
export class PhonePush {
  state: PushState = "disabled";
  message = "";
  private readonly connected = new Map<string, DeviceRelay>();
  constructor(
    private readonly options: {
      registration: () => Promise<Pick<ServiceWorkerRegistration, "pushManager">>;
      permission: () => NotificationPermission;
      requestPermission: () => Promise<NotificationPermission>;
      info: () => Promise<{ vapidPublicKey: string }>;
      changed: () => void;
    },
  ) {}
  async refresh(): Promise<void> {
    try {
      const subscription = await (await this.options.registration()).pushManager.getSubscription();
      this.state =
        this.options.permission() === "denied" ? "denied" : subscription ? "enabled" : "disabled";
      this.options.changed();
    } catch {
      this.state = "unsupported";
      this.options.changed();
    }
  }
  async attach(hostId: string, relay: DeviceRelay): Promise<void> {
    this.connected.set(hostId, relay);
    const subscription = await (await this.options.registration()).pushManager.getSubscription();
    await this.sync(relay, subscription);
  }
  detach(hostId: string): void {
    this.connected.delete(hostId);
  }
  private async sync(relay: DeviceRelay, subscription: PushSubscription | null): Promise<void> {
    if (subscription) {
      const json = subscription.toJSON();
      const p256dh = json.keys?.p256dh,
        auth = json.keys?.auth;
      if (!json.endpoint || !p256dh || !auth) throw new Error("浏览器返回的推送订阅无效");
      await relay.subscribePush({ endpoint: json.endpoint, p256dh, auth });
    } else await relay.unsubscribePush();
  }
  async enable(): Promise<void> {
    this.message = "";
    const requested =
      this.options.permission() === "granted"
        ? Promise.resolve<NotificationPermission>("granted")
        : this.options.requestPermission();
    this.state = "working";
    this.options.changed();
    try {
      const permission = await requested;
      if (permission !== "granted") {
        this.state = permission === "denied" ? "denied" : "disabled";
        return;
      }
      const info = await this.options.info();
      const registration = await this.options.registration();
      const subscription =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: decode(info.vapidPublicKey),
        }));
      await Promise.all(
        [...this.connected.values()].map((relay) => this.sync(relay, subscription)),
      );
      this.state = "enabled";
    } catch (error) {
      this.state = "error";
      this.message = error instanceof Error ? error.message : "推送订阅失败，请稍后重试";
    } finally {
      this.options.changed();
    }
  }
  async disable(): Promise<void> {
    this.state = "working";
    this.message = "";
    this.options.changed();
    try {
      const subscription = await (await this.options.registration()).pushManager.getSubscription();
      if (subscription && !(await subscription.unsubscribe()))
        throw new Error("浏览器未取消推送订阅，请重试");
      await Promise.all([...this.connected.values()].map((relay) => relay.unsubscribePush()));
      this.state = "disabled";
    } catch (error) {
      this.state = "error";
      this.message = error instanceof Error ? error.message : "取消推送失败，请重试";
    } finally {
      this.options.changed();
    }
  }
}
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
