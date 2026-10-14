export const ERROR_CODES = [
  "protocol_error",
  "version_mismatch",
  "unknown_device",
  "bad_mac",
  "bad_signature",
  "fingerprint_mismatch",
  "decrypt_failed",
  "replay",
  "frame_too_large",
  "timeout",
  "closed",
] as const;

export type RemoteChannelErrorCode = (typeof ERROR_CODES)[number];

const messages: Record<RemoteChannelErrorCode, string> = {
  protocol_error: "远程通道协议格式错误",
  version_mismatch: "远程通道协议版本不兼容",
  unknown_device: "远程设备未知或已吊销",
  bad_mac: "配对认证码校验失败",
  bad_signature: "远程身份签名校验失败",
  fingerprint_mismatch: "电脑公钥指纹与邀请不符",
  decrypt_failed: "远程数据解密失败",
  replay: "远程数据计数器不符",
  frame_too_large: "远程帧或消息超过大小上限",
  timeout: "远程通道握手超时",
  closed: "远程通道已关闭",
};

export class RemoteChannelError extends Error {
  constructor(readonly code: RemoteChannelErrorCode) {
    super(messages[code]);
    this.name = "RemoteChannelError";
  }
}

export function fail(code: RemoteChannelErrorCode = "protocol_error"): never {
  throw new RemoteChannelError(code);
}

export function asChannelError(error: unknown): RemoteChannelError {
  return error instanceof RemoteChannelError ? error : new RemoteChannelError("protocol_error");
}
