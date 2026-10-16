import { invoke } from "@tauri-apps/api/core";

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
  /** 系统已把本应用从电池优化里排除 */
  ignoringBatteryOptimizations?: boolean;
}

export interface AppHost {
  backgroundStatus(): Promise<BackgroundStatus>;
  /** 启动前台服务，`text` 是常驻通知文案；已在运行时只更新文案 */
  startService(text: string): Promise<void>;
  updateService(text: string): Promise<void>;
  stopService(): Promise<void>;
  openSettings(target: SettingsTarget): Promise<void>;
  /** 原生一侧的探针记录（前台服务启停、Activity 前后台、渲染进程回收），每行 `毫秒时间戳\t事件` */
  nativeLog(): Promise<string>;
  clearNativeLog(): Promise<void>;
  notificationStatus(): Promise<{ enabled: boolean }>;
  showNotification(input: {
    hostId: string;
    sessionId: string;
    title: string;
    body: string;
    kind: string;
  }): Promise<void>;
  dismissNotification(hostId: string, sessionId: string): Promise<void>;
  consumeNotificationTarget(): Promise<{ hostId: string; sessionId: string } | null>;
  moveTaskToBack(): Promise<void>;
  activityForeground(): Promise<boolean>;
}

/**
 * Activity 恢复（回到前台）时 Kotlin 在页面的 window 上派发的事件（MainActivity.onResume）。
 * 「窗口保持可见」的变通让页面在后台也认为自己可见，visibilitychange 不可靠，只能用原生信号。
 */
export const RESUME_EVENT = "nocturne-android-resume";
export const PAUSE_EVENT = "nocturne-android-pause";
export const TARGET_EVENT = "nocturne-android-notification-target";
export const BACK_EVENT = "nocturne-android-back";

/** 没有原生插件时的宿主（测试）：没有后台服务，不能打开系统设置 */
export const shellHost: AppHost = {
  backgroundStatus: () => Promise.resolve({ supported: false, running: false }),
  startService: () => Promise.resolve(),
  updateService: () => Promise.resolve(),
  stopService: () => Promise.resolve(),
  openSettings: () => Promise.reject(new Error("此版本不能打开系统设置")),
  nativeLog: () => Promise.resolve(""),
  clearNativeLog: () => Promise.resolve(),
  notificationStatus: () => Promise.resolve({ enabled: false }),
  showNotification: () => Promise.resolve(),
  dismissNotification: () => Promise.resolve(),
  consumeNotificationTarget: () => Promise.resolve(null),
  moveTaskToBack: () => Promise.resolve(),
  activityForeground: () => Promise.resolve(true),
};

/** 经 Rust 侧 `background` 插件（只转发白名单命令）调用 Kotlin 的 BackgroundPlugin */
function call<T>(command: string, payload?: Record<string, unknown>): Promise<T> {
  return invoke<T>("plugin:background|call", { command, payload: payload ?? null });
}

export const tauriHost: AppHost = {
  backgroundStatus: async () => {
    const state = await call<{ running: boolean; ignoringBatteryOptimizations: boolean }>("status");
    return { supported: true, ...state };
  },
  startService: async (text) => {
    await call("start", { text });
  },
  updateService: async (text) => {
    await call("update", { text });
  },
  stopService: async () => {
    await call("stop");
  },
  openSettings: async (target) => {
    await call("open_settings", { target });
  },
  nativeLog: async () => (await call<{ text: string }>("log")).text,
  clearNativeLog: async () => {
    await call("clear_log");
  },
  notificationStatus: () => call("notification_status"),
  showNotification: async (payload) => {
    await call("notify_show", payload);
  },
  dismissNotification: async (hostId, sessionId) => {
    await call("notify_dismiss", { hostId, sessionId });
  },
  consumeNotificationTarget: () => call("notification_target"),
  moveTaskToBack: async () => {
    await call("move_to_back");
  },
  activityForeground: async () =>
    (await call<{ foreground: boolean }>("activity_state")).foreground,
};
