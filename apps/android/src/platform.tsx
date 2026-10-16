import { useEffect, useState } from "react";
import type { PhoneExtensionApi, PhonePlatform } from "../../desktop/src/web/platform";
import { Background } from "./background";
import { RESUME_EVENT, type AppHost, type BackgroundStatus } from "./host";
import { BACK_EVENT, PAUSE_EVENT, TARGET_EVENT } from "./host";
import { LocalNotifications, DONE_THRESHOLD_CHOICES, saveNotifyPrefs } from "./notifications";
import { parseNativeLog, ProbeLog, summarize } from "./probe";
import { version } from "../package.json";

/** 信任边界：页面随安装包，不再由中继下发（ADR-0059 第 5 节） */
export const APP_TRUST_TEXT =
  "中继只转发密文，看不到会话内容。App 的页面代码随安装包签名，中继无法替换；你需要信任的是安装包来自维护者的 Release。远程访问相当于在手机上执行代码，请妥善保管手机并及时在电脑上移除丢失的设备。";

export const APP_PAIR_HINT =
  "在电脑的「设置 › 远程」选择「配对新手机」，复制配对链接，粘贴到下面。链接里带着中继地址，同一个 App 可以连任何中继。";

export const APP_VERSION = version;

function BackgroundSection({
  host,
  background,
  api,
}: {
  host: AppHost;
  background: Background;
  api: PhoneExtensionApi;
}) {
  const [status, setStatus] = useState<BackgroundStatus>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const read = () => {
      void host
        .backgroundStatus()
        .then((value) => {
          if (active) setStatus(value);
        })
        .catch(() => undefined);
    };
    read();
    const timer = setInterval(read, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [host]);
  const open = (target: "battery" | "autostart") => {
    setError("");
    host.openSettings(target).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "无法打开系统设置");
    });
  };
  return (
    <section className="phone-section" aria-label="后台保持连接">
      <h3>后台保持连接</h3>
      <label className="phone-switch">
        <span>
          切到后台后继续保持连接
          <small>回到 App 时内容已是最新；会在通知栏显示常驻通知</small>
        </span>
        <input
          type="checkbox"
          role="switch"
          aria-label="后台保持连接"
          checked={background.enabled}
          onChange={(event) => {
            background.enabled = event.target.checked;
            api.refresh();
          }}
        />
      </label>
      <p role="status">
        {status === undefined
          ? "正在读取…"
          : !status.supported
            ? "此版本没有后台服务，切到后台后连接会和网页一样被系统挂起。"
            : status.running
              ? "后台服务运行中，通知栏有常驻通知。"
              : background.enabled
                ? "后台服务未运行（没有已配对的电脑时不会启动）。"
                : "已关闭，行为与网页版一致。"}
      </p>
      {status?.supported && (
        <>
          <p>
            {status.ignoringBatteryOptimizations
              ? "系统已不限制本应用的电池优化。"
              : "系统的电池优化可能在息屏后冻结网络，建议放行；小米手机还需要开启自启动。"}
          </p>
          <div className="phone-actions">
            <button
              className="phone-list-action"
              onClick={() => {
                open("battery");
              }}
            >
              电池优化设置
            </button>
            <button
              className="phone-list-action"
              onClick={() => {
                open("autostart");
              }}
            >
              自启动设置
            </button>
          </div>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

function NotificationSection({
  host,
  notifications,
}: {
  host: AppHost;
  notifications: LocalNotifications;
}) {
  const [prefs, setPrefs] = useState(() => notifications.prefs);
  const [enabled, setEnabled] = useState(true);
  useEffect(() => {
    let active = true;
    const read = () => {
      void host
        .notificationStatus()
        .then((status) => {
          if (active) setEnabled(status.enabled);
        })
        .catch(() => {
          if (active) setEnabled(false);
        });
    };
    read();
    window.addEventListener(RESUME_EVENT, read);
    return () => {
      active = false;
      window.removeEventListener(RESUME_EVENT, read);
    };
  }, [host]);
  const update = (patch: Partial<typeof prefs>) => {
    const next = { ...prefs, ...patch };
    notifications.prefs = next;
    saveNotifyPrefs(next);
    setPrefs(next);
  };
  return (
    <section className="phone-section" aria-label="会话提醒">
      <h3>会话提醒</h3>
      <label className="phone-switch">
        <span>提醒我需要处理的会话</span>
        <input
          type="checkbox"
          role="switch"
          aria-label="会话提醒"
          checked={prefs.enabled}
          onChange={(e) => {
            update({ enabled: e.target.checked });
          }}
        />
      </label>
      {(
        [
          ["attention", "需要确认"],
          ["error", "出错停止"],
          ["done", "长任务完成"],
        ] as const
      ).map(([key, label]) => (
        <label className="phone-switch" key={key}>
          <span>{label}</span>
          <input
            type="checkbox"
            aria-label={label}
            disabled={!prefs.enabled}
            checked={prefs[key]}
            onChange={(e) => {
              update({ [key]: e.target.checked });
            }}
          />
        </label>
      ))}
      <label>
        完成阈值{" "}
        <select
          aria-label="完成阈值"
          disabled={!prefs.enabled || !prefs.done}
          value={prefs.doneAfterSeconds}
          onChange={(e) => {
            update({ doneAfterSeconds: Number(e.target.value) });
          }}
        >
          {!DONE_THRESHOLD_CHOICES.some((choice) => choice.seconds === prefs.doneAfterSeconds) && (
            <option value={prefs.doneAfterSeconds}>{prefs.doneAfterSeconds} 秒</option>
          )}
          {DONE_THRESHOLD_CHOICES.map((choice) => (
            <option key={choice.seconds} value={choice.seconds}>
              {choice.label}
            </option>
          ))}
        </select>
      </label>
      {!enabled && <p role="status">系统通知已关闭，请到系统 › 应用 › Nocturne › 通知中开启。</p>}
      <button
        className="phone-list-action"
        onClick={() => {
          void host.openSettings("app").catch(() => undefined);
        }}
      >
        打开系统应用设置
      </button>
    </section>
  );
}

function useRefreshEvery2s() {
  const [, render] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      render((n) => n + 1);
    }, 2000);
    return () => {
      clearInterval(timer);
    };
  }, []);
}

function copyText(text: string): Promise<boolean> {
  // 剪贴板不可用时由页面下方的日志框兜底：长按选择文字即可复制
  return navigator.clipboard.writeText(text).then(
    () => true,
    () => false,
  );
}

function ProbePage({ host, probe }: { host: AppHost; probe: ProbeLog }) {
  useRefreshEvery2s();
  const [native, setNative] = useState("");
  const [note, setNote] = useState("");
  useEffect(() => {
    let active = true;
    const read = () => {
      void host
        .nativeLog()
        .then((text) => {
          if (active) setNative(text);
        })
        .catch(() => undefined);
    };
    read();
    const timer = setInterval(read, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [host]);
  const nativeEvents = parseNativeLog(native);
  const summary = summarize(probe.all(), nativeEvents);
  const info = { version: APP_VERSION, agent: navigator.userAgent };
  return (
    <>
      <p>
        前台事件 {summary.events.fg}，后台事件 {summary.events.bg}，重连回放 {summary.events.replay}
        ；断线 {summary.disconnects} 次；渲染进程重建 {summary.native.rendererGone} 次。
      </p>
      <p>
        最大事件间隔：前台 {summary.maxGap.fg}ms，后台 {summary.maxGap.bg}ms；成批涌入{" "}
        {summary.batches} 批；后台计时器最大延迟 {summary.maxTimerLag}ms。
      </p>
      <p>
        后台到达延迟：{summary.backgroundLatency.count} 条，中位数{" "}
        {summary.backgroundLatency.median}ms，最大 {summary.backgroundLatency.max}ms。
      </p>
      <p>
        前台服务启 {summary.native.serviceStarts} 次、停 {summary.native.serviceStops} 次。
      </p>
      <div className="phone-actions">
        <button
          className="phone-list-action"
          onClick={() => {
            void copyText(probe.text(nativeEvents, info)).then((ok) => {
              setNote(ok ? "已复制探针记录" : "复制失败，请长按下面的记录选择文字");
            });
          }}
        >
          复制探针记录
        </button>
        <button
          className="phone-list-action"
          onClick={() => {
            probe.clear();
            void host.clearNativeLog().then(() => {
              setNative("");
              setNote("已清除");
            });
          }}
        >
          清除记录
        </button>
      </div>
      {note && <p role="status">{note}</p>}
      <small>只记事件类型、会话 id 和时间，不含会话内容；只存在这台手机上。</small>
      <pre className="phone-probe-log">
        {probe.text(nativeEvents, info).split("\n").slice(-40).join("\n")}
      </pre>
    </>
  );
}

export interface AppPlatform extends PhonePlatform {
  background: NonNullable<PhonePlatform["background"]>;
  probe: ProbeLog;
  controller: Background;
}

export function appPlatform(
  host: AppHost,
  probe: ProbeLog = new ProbeLog(),
  changed: () => void = () => undefined,
): AppPlatform {
  const controller = new Background(host, probe, changed);
  const notifications = new LocalNotifications(host);
  let foreground = false;
  let lifecycleRevision = 0;
  void host
    .activityForeground()
    .then((value) => {
      if (lifecycleRevision === 0) foreground = value;
    })
    .catch(() => undefined);
  window.addEventListener(RESUME_EVENT, () => {
    lifecycleRevision++;
    foreground = true;
  });
  window.addEventListener(PAUSE_EVENT, () => {
    lifecycleRevision++;
    foreground = false;
    probe.flush();
  });
  probe.setVisible(() => foreground);
  const target = async () => {
    const value = await host.consumeNotificationTarget();
    return value?.hostId && value.sessionId ? value : null;
  };
  return {
    relay: "link",
    get keepConnected() {
      return controller.enabled;
    },
    observer: {
      ...controller.observer,
      sessionEvent: (hostId, sessionId, event, live, session, watching, turnStartedAt) => {
        notifications.event(hostId, sessionId, event, live, session, watching, turnStartedAt);
      },
    },
    isForeground: () => foreground,
    notificationTarget: target,
    onNotificationTarget: (listener) => {
      const handler = () => {
        void target().then((value) => {
          if (value) listener(value);
        });
      };
      window.addEventListener(TARGET_EVENT, handler);
      return () => {
        window.removeEventListener(TARGET_EVENT, handler);
      };
    },
    onAndroidBack: (listener) => {
      window.addEventListener(BACK_EVENT, listener);
      return () => {
        window.removeEventListener(BACK_EVENT, listener);
      };
    },
    moveTaskToBack: () => {
      void host.moveTaskToBack();
    },
    dismissNotification: (hostId: string, sessionId: string) => {
      notifications.dismiss(hostId, sessionId);
    },
    onForeground: (listener) => {
      window.addEventListener(RESUME_EVENT, listener);
      return () => {
        window.removeEventListener(RESUME_EVENT, listener);
      };
    },
    pairHint: APP_PAIR_HINT,
    trustText: APP_TRUST_TEXT,
    probe,
    controller,
    background: (api) => (
      <>
        <BackgroundSection host={host} background={controller} api={api} />
        <NotificationSection host={host} notifications={notifications} />
      </>
    ),
    diagnostics: (api) => (
      <button
        className="phone-list-action"
        onClick={() => {
          api.open("probe");
        }}
      >
        后台探针 ›
      </button>
    ),
    pages: {
      probe: { title: "后台探针", render: () => <ProbePage host={host} probe={probe} /> },
    },
  };
}
