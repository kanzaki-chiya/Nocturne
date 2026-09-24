/**
 * 配置层错误（config.md 第 2 节）。
 * 用户配置文件损坏属于快速失败：不带着半截配置启动。
 */
export type ConfigErrorCode =
  /** 文件不是合法 JSON 或不符合 schema */
  | "config_invalid"
  /** 读写配置/授权数据失败（权限、I/O） */
  | "config_unavailable"
  /** 配置试图内联凭据值（只允许 apiKeyEnv 指向环境变量名） */
  | "config_credential_rejected";

export class ConfigError extends Error {
  readonly code: ConfigErrorCode;
  /** 出错的文件路径（用于诊断信息） */
  readonly filePath: string | undefined;
  constructor(code: ConfigErrorCode, message: string, filePath?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConfigError";
    this.code = code;
    this.filePath = filePath;
  }
}
