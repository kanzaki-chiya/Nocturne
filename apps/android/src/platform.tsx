import { useEffect, useState } from "react";
import type { PhoneExtensionApi, PhonePlatform } from "../../desktop/src/web/platform";
import { Background } from "./background";
import { RESUME_EVENT, type AppHost, type BackgroundStatus } from "./host";
import { parseNativeLog, ProbeLog, summarize } from "./probe";

/** 信任边界：页面随安装包，不再由中继下发（ADR-0059 第 5 节） */
export const APP_TRUST_TEXT =
  "中继只转发密文，看不到会话内容。App 的页面代码随安装包签名，中继无法替换；你需要信任的是安装包来自维护者的 Release。远程访问相当于在手机上执行代码，请妥善保管手机并及时在电脑上移除丢失的设备。";

export const APP_PAIR_HINT =
  "在电脑的「设置 › 远程」选择「配对新手机」，复制配对链接，粘贴到下面。链接里带着中继地址，同一个 App 可以连任何中继。";

export const APP_VERSION = "0.10.0";

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
  return {
    relay: "link",
    get keepConnected() {
      return controller.enabled;
    },
    observer: controller.observer,
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
    background: (api) => <BackgroundSection host={host} background={controller} api={api} />,
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
