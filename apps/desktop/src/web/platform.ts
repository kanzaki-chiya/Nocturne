import type { ReactNode } from "react";
import type { ConnectionState } from "./connection";
import type { PairedHost } from "./storage";

/**
 * 手机界面的平台扩展点。网页入口不传（等同 `{ relay: "page" }`）；安卓 App 入口
 * （apps/android）经它接入后台服务状态与探针，网页的依赖图因此不含任何 App 代码。
 */
export interface PhoneObserver {
  /** 已配对的电脑列表变化 */
  hosts?(hosts: readonly PairedHost[]): void;
  /** 当前电脑的连接状态变化；host 为 undefined 表示没有打开任何电脑 */
  state?(host: PairedHost | undefined, state: ConnectionState, message: string): void;
  /** 一次断线与原因 */
  disconnected?(host: PairedHost, reason: string): void;
  /** 收到一条会话事件：只有类型、序号和是否为重连后的回放，不含内容 */
  event?(sessionId: string, type: string, seq: number | undefined, live: boolean): void;
}
export interface PhoneExtensionApi {
  /** 打开 `pages` 里登记的页面 */
  open(page: string): void;
  /** 已配对并已打开的电脑；设置页没有选中电脑时为 undefined */
  host: PairedHost | undefined;
  connected: boolean;
  /** 平台状态变了（例如设置页的开关），让页面按新值重新判定 */
  refresh(): void;
}
export interface PhonePlatform {
  /**
   * 中继地址从哪里来：网页是当前页面源（页面由中继下发）；App 的页面源是固定的 App 源，
   * 中继地址只能从配对链接取得并随电脑保存。
   */
  relay: "page" | "link";
  /** 页面不可见（App 在后台）时是否继续保持连接 */
  keepConnected?: boolean;
  observer?: PhoneObserver;
  /** 取代网页版信任边界说明（网页由中继下发，App 的页面随安装包）；不传用网页版文字 */
  trustText?: string;
  /** 配对说明里描述「怎么拿到配对链接」的一句话 */
  pairHint?: string;
  /** 设置页放在「已配对的电脑」之后、取代网页推送区块的位置 */
  background?(api: PhoneExtensionApi): ReactNode;
  /** 设置页「连接诊断」末尾追加 */
  diagnostics?(api: PhoneExtensionApi): ReactNode;
  pages?: Record<string, { title: string; render(api: PhoneExtensionApi): ReactNode }>;
}
export const webPlatform: PhonePlatform = { relay: "page" };
