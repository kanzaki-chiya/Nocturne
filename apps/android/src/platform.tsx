import { useEffect, useState } from "react";
import type { PhonePlatform } from "../../desktop/src/web/platform";
import type { AppHost, BackgroundStatus } from "./host";

/** 信任边界：页面随安装包，不再由中继下发（ADR-0059 第 5 节） */
export const APP_TRUST_TEXT =
  "中继只转发密文，看不到会话内容。App 的页面代码随安装包签名，中继无法替换；你需要信任的是安装包来自维护者的 Release。远程访问相当于在手机上执行代码，请妥善保管手机并及时在电脑上移除丢失的设备。";

export const APP_PAIR_HINT =
  "在电脑的「设置 › 远程」选择「配对新手机」，复制配对链接，粘贴到下面。链接里带着中继地址，同一个 App 可以连任何中继。";

function BackgroundSection({ host }: { host: AppHost }) {
  const [status, setStatus] = useState<BackgroundStatus>();
  useEffect(() => {
    let active = true;
    void host
      .backgroundStatus()
      .then((value) => {
        if (active) setStatus(value);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [host]);
  return (
    <section className="phone-section" aria-label="后台服务">
      <h3>后台服务</h3>
      <p>
        {status === undefined
          ? "正在读取…"
          : !status.supported
            ? "此版本没有后台服务，切到后台后连接会和网页一样被系统挂起。"
            : status.running
              ? "后台服务运行中。"
              : "后台服务未运行。"}
      </p>
    </section>
  );
}

export function appPlatform(host: AppHost): PhonePlatform {
  return {
    relay: "link",
    pairHint: APP_PAIR_HINT,
    trustText: APP_TRUST_TEXT,
    background: () => <BackgroundSection host={host} />,
  };
}
