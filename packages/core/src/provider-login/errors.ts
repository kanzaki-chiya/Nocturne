import type { ProviderEntryConfig } from "../config/index.js";

export interface ProviderLoginOptions {
  /** 向导尚未保存的条目；id 必须与登录目标一致。 */
  entry?: ProviderEntryConfig | undefined;
  remote?: boolean | undefined;
  /** 唯一允许向人展示未保存密钥的通道，不进入 completion。 */
  onUnstoredKey?: ((key: string, envName: string) => void | Promise<void>) | undefined;
}

const messages = {
  unsupported: "该服务商不支持浏览器登录。",
  missing: "服务商配置不存在或与登录目标不符。",
  cancelled: "服务商登录已取消。",
  timeout: "服务商登录已超时，请重新登录。",
  input: "授权输入无效，请重新粘贴。",
  callback: "无法启动本地登录回调，请使用远程登录模式。",
  exchange: "授权交换失败，请重新登录。",
  network: "无法连接授权服务，请重新登录。",
  storage: "无法保存登录凭据。",
  unstored: "系统凭据后端不可用，需要由客户端一次性显示密钥。",
} as const;

export type ProviderLoginErrorCode = keyof typeof messages;

/** 固定文案；禁止附加上游响应、异常 cause 或授权输入。 */
export class ProviderLoginError extends Error {
  constructor(readonly code: ProviderLoginErrorCode) {
    super(messages[code]);
    this.name = "ProviderLoginError";
  }
}
