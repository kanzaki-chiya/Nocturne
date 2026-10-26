import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createKeyDiagBatch,
  describeElement,
  installKeyDiag,
  keyRecord,
  panelKeyReason,
} from "../src/key-diag";

afterEach(() => vi.useRealTimers());
const state = { settingsOpen: false, hasPanel: true, quickOpen: false };

describe("按键诊断", () => {
  it("普通字母、数字和符号不记录；Ctrl+B 包含完整字段", () => {
    for (const key of ["a", "1", ";"])
      expect(
        keyRecord(new KeyboardEvent("keydown", { key }), "input", "input", true),
      ).toBeUndefined();
    const line = keyRecord(
      new KeyboardEvent("keydown", {
        key: "b",
        code: "KeyB",
        keyCode: 66,
        ctrlKey: true,
        repeat: true,
      }),
      "input#draft.a.b",
      "input#draft.a.b",
      true,
    );
    expect(line).toBeDefined();
    expect(JSON.parse((line ?? "").slice(8))).toEqual({
      key: "b",
      code: "KeyB",
      keyCode: 66,
      ctrl: true,
      shift: false,
      alt: false,
      meta: false,
      isComposing: false,
      defaultPrevented: false,
      repeat: true,
      target: "input#draft.a.b",
      active: "input#draft.a.b",
      hasFocus: true,
    });
  });
  it("组字与 Process 都记录，忽略原因正确", () => {
    const composing = new KeyboardEvent("keydown", { key: "b", ctrlKey: true, isComposing: true });
    const process = new KeyboardEvent("keydown", { key: "Process", keyCode: 229 });
    expect(keyRecord(composing, "input", "input", true)).toContain('"isComposing":true');
    expect(panelKeyReason(composing, state)).toBe("passed");
    expect(
      panelKeyReason(new KeyboardEvent("keydown", { key: "Escape", isComposing: true }), state),
    ).toBe("ignored: composing");
    expect(keyRecord(process, "input", "input", true)).toContain('"keyCode":229');
    expect(panelKeyReason(process, state)).toBe("ignored: Process key");
    expect(panelKeyReason(new KeyboardEvent("keydown"), { ...state, settingsOpen: true })).toBe(
      "ignored: settings open",
    );
    expect(panelKeyReason(new KeyboardEvent("keydown"), { ...state, hasPanel: false })).toBe(
      "ignored: no panel",
    );
  });
  it("普通组字 Process 不记录物理 code，修饰键组合保留 code", () => {
    for (const code of ["KeyN", "KeyI", "KeyH"]) {
      const line = keyRecord(
        new KeyboardEvent("keydown", { key: "Process", code, keyCode: 229, isComposing: true }),
        "textarea",
        "textarea",
        true,
      );
      expect(JSON.parse((line ?? "").slice(8))).toEqual({
        key: "Process",
        keyCode: 229,
        isComposing: true,
        repeat: false,
        target: "textarea",
        active: "textarea",
        hasFocus: true,
      });
      expect(line).not.toContain("code");
      expect(line).not.toContain(code);
    }
    expect(
      keyRecord(
        new KeyboardEvent("keydown", {
          key: "Process",
          code: "KeyP",
          ctrlKey: true,
          isComposing: true,
        }),
        "textarea",
        "textarea",
        true,
      ),
    ).toContain('"code":"KeyP"');
  });
  it("元素只记标签、id 和前两个 class，不记输入内容", () => {
    const input = document.createElement("input");
    input.id = "draft";
    input.className = "one two three";
    input.value = "private text";
    expect(describeElement(input)).toBe("input#draft.one.two");
  });
  it("100ms 合并多条发送，组字事件没有内容", async () => {
    vi.useFakeTimers();
    const send = vi.fn(async (_lines: string[]) => undefined);
    const dispose = installKeyDiag(send);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    window.dispatchEvent(new CompositionEvent("compositionstart", { data: "private text" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", code: "KeyB", ctrlKey: true }));
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toHaveLength(2);
    expect(JSON.stringify(send.mock.calls)).not.toContain("private text");
    dispose();
  });
  it("卸载发送最后一批", () => {
    const send = vi.fn(async (_lines: string[]) => undefined);
    const batch = createKeyDiagBatch(send);
    batch.push("focus");
    batch.push("blur");
    batch.dispose();
    expect(send).toHaveBeenCalledWith(["focus", "blur"]);
  });
});
