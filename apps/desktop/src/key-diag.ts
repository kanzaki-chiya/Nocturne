type DiagKey = Pick<
  KeyboardEvent,
  | "key"
  | "code"
  | "keyCode"
  | "ctrlKey"
  | "altKey"
  | "metaKey"
  | "shiftKey"
  | "isComposing"
  | "defaultPrevented"
  | "repeat"
>;

export function shouldRecordKey(event: DiagKey): boolean {
  return (
    event.ctrlKey ||
    event.altKey ||
    event.metaKey ||
    event.key === "Escape" ||
    event.key === "Process"
  );
}

export function describeElement(target: EventTarget | null): string {
  if (!(target instanceof Element)) return "none";
  return `${target.tagName.toLowerCase()}${target.id ? `#${target.id}` : ""}${[...target.classList]
    .slice(0, 2)
    .map((name) => `.${name}`)
    .join("")}`;
}

export function keyRecord(
  event: DiagKey,
  target: string,
  active: string,
  hasFocus: boolean,
): string | undefined {
  if (!shouldRecordKey(event)) return undefined;
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- VK_PROCESSKEY/229 is essential diagnostic evidence.
  const keyCode = event.keyCode;
  if (event.key === "Process" && !event.ctrlKey && !event.altKey && !event.metaKey) {
    return `keydown ${JSON.stringify({ key: event.key, keyCode, isComposing: event.isComposing, repeat: event.repeat, target, active, hasFocus })}`;
  }
  return `keydown ${JSON.stringify({ key: event.key, code: event.code, keyCode, isComposing: event.isComposing, defaultPrevented: event.defaultPrevented, repeat: event.repeat, ctrl: event.ctrlKey, shift: event.shiftKey, alt: event.altKey, meta: event.metaKey, target, active, hasFocus })}`;
}

export function panelKeyReason(
  event: DiagKey,
  state: { settingsOpen: boolean; hasPanel: boolean; quickOpen: boolean },
): string {
  if (event.key === "Process") return "ignored: Process key";
  if (event.key === "Escape" && event.isComposing) return "ignored: composing";
  if (state.settingsOpen) return "ignored: settings open";
  if (!state.hasPanel) return "ignored: no panel";
  if (event.key === "Escape" && event.defaultPrevented) return "ignored: defaultPrevented";
  if (event.key === "Escape" && state.quickOpen) return "ignored: quick open";
  // 通过了前置检查；是否匹配面板快捷键见随后的「PanelHost matched=…」
  return "passed";
}

export function createKeyDiagBatch(send: (lines: string[]) => Promise<unknown>, delay = 100) {
  let pending: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
    const lines = pending;
    pending = [];
    if (lines.length > 0) void send(lines).catch(() => undefined);
  };
  return {
    push(line: string) {
      pending.push(line);
      if (pending.length > 500) pending.shift();
      timer ??= setTimeout(flush, delay);
    },
    dispose() {
      clearTimeout(timer);
      flush();
    },
  };
}

let record: ((line: string) => void) | undefined;
export function keyDiag(line: string): void {
  record?.(line);
}

/** Only main.tsx installs this sender; the phone entry does not import this module. */
export function installKeyDiag(send: (lines: string[]) => Promise<unknown>): () => void {
  const batch = createKeyDiagBatch(send);
  record = (line) => {
    batch.push(line);
  };
  const focus = () => {
    keyDiag("window focus");
  };
  const blur = () => {
    keyDiag("window blur");
  };
  const visibility = () => {
    keyDiag(`visibilitychange ${document.visibilityState}`);
  };
  const start = () => {
    keyDiag("compositionstart");
  };
  const end = () => {
    keyDiag("compositionend");
  };
  const keydown = (event: KeyboardEvent) => {
    const line = keyRecord(
      event,
      describeElement(event.target),
      describeElement(document.activeElement),
      document.hasFocus(),
    );
    if (line !== undefined) keyDiag(line);
  };
  window.addEventListener("focus", focus);
  window.addEventListener("blur", blur);
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("compositionstart", start, true);
  window.addEventListener("compositionend", end, true);
  window.addEventListener("keydown", keydown, true);
  return () => {
    window.removeEventListener("focus", focus);
    window.removeEventListener("blur", blur);
    document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener("compositionstart", start, true);
    window.removeEventListener("compositionend", end, true);
    window.removeEventListener("keydown", keydown, true);
    record = undefined;
    batch.dispose();
  };
}
