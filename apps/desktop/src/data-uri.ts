import { useEffect, useState } from "react";

/**
 * 桌面端 CSP 为 `img-src 'self' blob:`，在支持 ObjectURL 的环境将 base64 data URI
 * 转为 blob URL 渲染；非 base64 data URI 或解码失败时原样返回。
 */
export function dataUriToBlobUrl(uri: string): string {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(uri);
  if (!match) return uri;
  const [, mime, payload] = match;
  if (!mime || !payload) return uri;
  try {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return URL.createObjectURL(new Blob([bytes], { type: mime }));
  } catch {
    return uri;
  }
}

/**
 * 将 data URI 转为受 CSP `img-src 'self' blob:` 允许的 blob URL，并在切换或卸载时释放。
 * 无 `URL.createObjectURL` 的测试环境退回原 URI。
 */
export function useDataUriBlobUrl(uri: string | undefined): string | undefined {
  const canBlobUrl = typeof URL.createObjectURL === "function";
  const [resolved, setResolved] = useState<{ uri: string; url: string }>();

  useEffect(() => {
    if (!uri || !canBlobUrl) {
      setResolved(undefined);
      return;
    }
    const url = dataUriToBlobUrl(uri);
    setResolved({ uri, url });
    return () => {
      if (url.startsWith("blob:") && typeof URL.revokeObjectURL === "function") {
        URL.revokeObjectURL(url);
      }
    };
  }, [uri, canBlobUrl]);

  if (!uri) return undefined;
  return canBlobUrl ? (resolved?.uri === uri ? resolved.url : undefined) : uri;
}
