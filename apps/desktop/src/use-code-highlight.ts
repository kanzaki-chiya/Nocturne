import { useEffect, useRef } from "react";
import { highlightCode } from "./code-highlight-client";
import type { CodeRequest } from "./code-lines";

export function useCodeHighlight<T extends HTMLElement>(
  path: string | undefined,
  text: string,
  kind: CodeRequest["kind"],
) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const root = ref.current;
    if (path === undefined || path === "" || text === "" || root === null) return;
    const controller = new AbortController();
    highlightCode(root, { path, text, kind }, controller.signal);
    return () => {
      controller.abort();
    };
  }, [path, text, kind]);
  return ref;
}
