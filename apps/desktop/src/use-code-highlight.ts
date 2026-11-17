import { useEffect, useRef } from "react";
import { highlightCode } from "./code-highlight-client";
import type { CodeRequest } from "./code-lines";

const PLAIN_TEXT_LANGUAGES = new Set([
  "text",
  "plaintext",
  "txt",
  "plain",
  "console",
  "output",
  "raw",
  "log",
  "none",
  "nohighlight",
]);

function normalizeLanguageToken(language: string | undefined): string {
  if (language === undefined) return "";
  return language.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}

export function useCodeHighlight<T extends HTMLElement>(
  path: string | undefined,
  text: string,
  kind: CodeRequest["kind"],
  options?: { language?: string | undefined; enabled?: boolean | undefined },
) {
  const ref = useRef<T>(null);
  const language = options?.language;
  const enabled = options?.enabled ?? true;
  useEffect(() => {
    const root = ref.current;
    if (!enabled || text === "" || root === null) return;
    const request: CodeRequest | undefined =
      language !== undefined
        ? (() => {
            const token = normalizeLanguageToken(language);
            return token === "" || PLAIN_TEXT_LANGUAGES.has(token)
              ? undefined
              : { language, text, kind };
          })()
        : path !== undefined && path !== ""
          ? { path, text, kind }
          : undefined;
    if (request === undefined) return;
    const controller = new AbortController();
    highlightCode(root, request, controller.signal);
    return () => {
      controller.abort();
    };
  }, [path, text, kind, language, enabled]);
  return ref;
}
