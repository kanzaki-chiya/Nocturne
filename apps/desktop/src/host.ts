import type { PickedImage } from "./picked-images";
import type { BackendMessage } from "./types";

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
}
