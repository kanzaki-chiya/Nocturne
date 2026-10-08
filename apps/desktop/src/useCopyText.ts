import { useEffect, useRef, useState } from "react";

export function useCopyText(onError?: (message: string) => void) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
    },
    [],
  );
  const copy = async (text: string) => {
    setError(undefined);
    const fail = (message: string) => {
      setError(message);
      onError?.(message);
    };
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (clipboard === undefined) {
      fail("剪贴板不可用");
      return;
    }
    try {
      await clipboard.writeText(text);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        setCopied(false);
      }, 1500);
    } catch {
      fail("复制失败");
    }
  };
  return { copy, copied, error };
}
