/**
 * App 专属的宿主能力，与网页的 `WebHost` 并列（apps/desktop/src/web/host.ts）。
 * 网页入口不感知它；App 入口把它接入 `PhonePlatform`（platform.tsx）。
 */

/** 系统设置页：电池优化、自启动（厂商系统）、本应用的系统详情页 */
export type SettingsTarget = "battery" | "autostart" | "app";

export interface BackgroundStatus {
  /** 这个构建带有前台服务 */
  supported: boolean;
  /** 前台服务正在运行 */
  running: boolean;
}

export interface AppHost {
  backgroundStatus(): Promise<BackgroundStatus>;
  openSettings(target: SettingsTarget): Promise<void>;
}

/** 没有原生插件时的宿主（测试与第 1 轮外壳）：没有后台服务，不能打开系统设置 */
export const shellHost: AppHost = {
  backgroundStatus: () => Promise.resolve({ supported: false, running: false }),
  openSettings: () => Promise.reject(new Error("此版本不能打开系统设置")),
};
