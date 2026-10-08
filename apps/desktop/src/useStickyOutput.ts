import { useLayoutEffect, useRef } from "react";

/** Remember the pre-update scroll position, rather than measuring after content grows. */
export function useStickyOutput(text: string) {
  const output = useRef<HTMLPreElement>(null);
  const following = useRef(true);
  useLayoutEffect(() => {
    const element = output.current;
    if (element === null) return;
    const scrolled = () => {
      following.current = element.scrollHeight - element.clientHeight - element.scrollTop <= 24;
    };
    const expanded = () => {
      if (element.closest("details")?.open) {
        following.current = true;
        element.scrollTop = element.scrollHeight;
      }
    };
    element.addEventListener("scroll", scrolled);
    const details = element.closest("details");
    details?.addEventListener("toggle", expanded);
    return () => {
      element.removeEventListener("scroll", scrolled);
      details?.removeEventListener("toggle", expanded);
    };
  }, []);
  useLayoutEffect(() => {
    if (following.current && output.current !== null) {
      output.current.scrollTop = output.current.scrollHeight;
    }
  }, [text]);
  return output;
}
