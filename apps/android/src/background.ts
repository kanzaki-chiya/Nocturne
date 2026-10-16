import type { ConnectionState } from "../../desktop/src/web/connection";
import type { PairedHost } from "../../desktop/src/web/storage";
import type { PhoneObserver } from "../../desktop/src/web/platform";
import type { AppHost } from "./host";
import type { ProbeLog } from "./probe";

const KEY = "nocturne.android.keepConnected";

export function connectedText(host: PairedHost | undefined, state: ConnectionState): string {
  return state === "online" && host
    ? `Nocturne 远程：已连接 ${host.name}`
    : "Nocturne 远程：正在连接…";
}

/**
 * 「后台保持连接」：已配对电脑且开关打开时让前台服务运行，常驻通知跟随连接状态；关闭则停止服务，
 * 页面隐藏时的行为与网页版一致（不主动断开、不重连，回前台再连）。
 */
export class Background {
  private hostCount = 0;
  private text = connectedText(undefined, "offline");
  private started = false;
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly host: AppHost,
    private readonly probe: ProbeLog,
    private readonly changed: () => void = () => undefined,
  ) {}

  get enabled(): boolean {
    try {
      return localStorage.getItem(KEY) !== "off";
    } catch {
      return true;
    }
  }

  set enabled(value: boolean) {
    try {
      localStorage.setItem(KEY, value ? "on" : "off");
    } catch {
      // 存不下则本次运行有效
    }
    this.probe.add("service", `keepConnected=${value ? "on" : "off"}`);
    this.sync();
    this.changed();
  }

  readonly observer: PhoneObserver = {
    hosts: (hosts) => {
      this.hostCount = hosts.length;
      this.sync();
    },
    state: (host, state, message) => {
      this.probe.add("state", `${state}${message ? ` ${message}` : ""}`);
      if (state === "online") this.probe.add("connect", host?.name ?? "-");
      this.text = connectedText(host, state);
      this.sync();
    },
    disconnected: (host, reason) => {
      this.probe.add("disconnect", `${host.name} ${reason}`);
    },
    event: (sessionId, type, seq, live, eventTime) => {
      this.probe.event(sessionId, type, seq, live, eventTime);
    },
  };

  private sync(): void {
    const wanted = this.enabled && this.hostCount > 0;
    this.pending = this.pending
      .then(async () => {
        if (wanted && !this.started) {
          this.started = true;
          this.probe.add("service", "start requested");
          await this.host.startService(this.text);
        } else if (wanted) {
          await this.host.updateService(this.text);
        } else if (this.started) {
          this.started = false;
          this.probe.add("service", "stop requested");
          await this.host.stopService();
        }
      })
      .catch((error: unknown) => {
        this.started = false;
        this.probe.add(
          "service",
          `error ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }
}
