import type { PickedImage } from "./picked-images";
import type { BackendMessage } from "./types";

/**
 * updater 插件发现的新版本（前端只拿展示数据与安装入口；
 * Windows 下 downloadAndInstall 期间进程被安装器接管退出，Promise 可能不返回）。
 */
export interface AvailableUpdate {
  version: string;
  /** 发布说明（latest.json 的 notes）；没有为 null */
  notes: string | null;
  downloadAndInstall: (
    onProgress?: (downloaded: number, total: number | undefined) => void,
  ) => Promise<void>;
}

/**
 * 宿主抽象：前端对 Tauri 的全部依赖都在这一个接口后面，
 * 测试用假宿主替换（docs/apps/desktop.md）。
 */
export interface DesktopHost {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  /** 建一个 Tauri Channel 等价物；返回值原样传进 invoke 参数 */
  createChannel: (onMessage: (m: BackendMessage) => void) => unknown;
  /** 用系统浏览器打开链接（实现里先过 isAllowedExternalUrl） */
  openUrl: (url: string) => Promise<void>;
  /** 系统文件夹选择对话框；取消返回 null */
  pickFolder: () => Promise<string | null>;
  /** 系统图片选择对话框；取消返回空列表 */
  pickImages: () => Promise<PickedImage[]>;
  /** 用户主目录（路径 ~ 缩写用）；取不到返回 null */
  homeDir: () => Promise<string | null>;
  /** 当前应用版本号 */
  appVersion: () => Promise<string>;
  /** updater 检查更新；null = 已是最新，失败抛错 */
  checkUpdate: () => Promise<AvailableUpdate | null>;
  /** 重启应用（非 Windows 平台装完更新需要手动重启） */
  relaunch: () => Promise<void>;
  /**
   * 往外壳日志写一行诊断（后台日志页「外壳」条目可见）。
   * 内部 fire-and-forget：写失败不抛错。
   */
  note: (line: string) => void;
}
