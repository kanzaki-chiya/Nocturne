import { render } from "ink-testing-library";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { Composer } from "../src/components/composer.js";
import { TuiEnvContext } from "../src/env.js";
import { createPasteStore } from "../src/paste.js";
import { createFileStore } from "../src/files.js";

const env = { ascii: false, animated: false };
describe("Composer 多行编辑", () => {
  it("文件占位整体左右移动及退格删除", async () => {
    const files = createFileStore();
    const token = files.add({
      data: Buffer.from("abc"),
      mimeType: "text/plain",
      label: "a.log",
      source: "upload",
    });
    let value = token;
    let caret = token.length;
    function Harness() {
      const [text, setText] = useState(token);
      const [cursor, setCursor] = useState(token.length);
      value = text;
      caret = cursor;
      return (
        <TuiEnvContext.Provider value={env}>
          <Composer
            value={text}
            cursor={cursor}
            onChange={(next, pos) => {
              setText(next);
              setCursor(pos);
            }}
            onCursor={setCursor}
            onSubmit={() => {
              throw new Error("不应提交");
            }}
            active
            width={80}
          />
        </TuiEnvContext.Provider>
      );
    }
    const screen = render(<Harness />);
    screen.stdin.write("\x1b[D");
    await vi.waitFor(() => expect(caret).toBe(0));
    screen.stdin.write("\x1b[C");
    await vi.waitFor(() => expect(caret).toBe(token.length));
    screen.stdin.write("\x7f");
    await vi.waitFor(() => expect(value).toBe(""));
    screen.unmount();
  });
  it("Ctrl+J 换行，方向键跨行移动，反斜杠回车换行，Enter 提交", async () => {
    const submitted: string[] = [];
    let current = "";
    let caret = 0;
    function Harness() {
      const [value, setValue] = useState("");
      const [cursor, setCursor] = useState(0);
      current = value;
      caret = cursor;
      return (
        <TuiEnvContext.Provider value={env}>
          <Composer
            value={value}
            cursor={cursor}
            onChange={(next, pos) => {
              setValue(next);
              setCursor(pos);
            }}
            onCursor={setCursor}
            onSubmit={(text) => submitted.push(text)}
            active
            width={40}
            height={5}
          />
        </TuiEnvContext.Provider>
      );
    }
    const { stdin, lastFrame, unmount } = render(<Harness />);
    await vi.waitFor(() => expect(lastFrame()).toBeTruthy());
    stdin.write("甲");
    await vi.waitFor(() => expect(current).toBe("甲"));
    stdin.write("\n"); // Windows Terminal 的 Ctrl+J
    await vi.waitFor(() => expect(current).toBe("甲\n"));
    stdin.write("乙\\");
    await vi.waitFor(() => expect(current).toBe("甲\n乙\\"));
    stdin.write("\r");
    await vi.waitFor(() => expect(current).toBe("甲\n乙\n"));
    expect(lastFrame()).toContain("甲");
    expect(lastFrame()).toContain("乙");
    stdin.write("\x1b[A");
    await vi.waitFor(() => expect(caret).toBe(2));
    stdin.write("\x1b[B");
    await vi.waitFor(() => expect(caret).toBe(4));
    stdin.write("丙");
    await vi.waitFor(() => expect(current).toBe("甲\n乙\n丙"));
    stdin.write("\r");
    await vi.waitFor(() => expect(submitted).toEqual(["甲\n乙\n丙"]));
    unmount();
  });

  it("占位按整体移动和删除，Ctrl+W 删前词", async () => {
    const store = createPasteStore();
    const token = store.add("第一行\n第二行") ?? "";
    let current = "";
    let caret = 0;
    function Harness() {
      const [value, setValue] = useState(token + " alpha beta");
      const [cursor, setCursor] = useState(value.length);
      current = value;
      caret = cursor;
      return (
        <TuiEnvContext.Provider value={env}>
          <Composer
            value={value}
            cursor={cursor}
            onChange={(next, pos) => {
              setValue(next);
              setCursor(pos);
            }}
            onCursor={setCursor}
            onSubmit={() => {
              throw new Error("不应提交");
            }}
            active
            width={80}
            pastes={store}
          />
        </TuiEnvContext.Provider>
      );
    }
    const { stdin, unmount } = render(<Harness />);
    await vi.waitFor(() => expect(current).toBe(token + " alpha beta"));
    stdin.write("\x17"); // Ctrl+W
    await vi.waitFor(() => expect(current).toBe(token + " alpha"));
    stdin.write("\x01"); // Ctrl+A
    await vi.waitFor(() => expect(caret).toBe(0));
    stdin.write("\x1b[C"); // 占位整块右移
    await vi.waitFor(() => expect(caret).toBe(token.length));
    stdin.write("\x7f");
    await vi.waitFor(() => expect(current).toBe(" alpha"));
    unmount();
  });
});

describe("Composer 待发输入（ADR-0070）", () => {
  it("运行中 Enter 提交、Tab 走排队回调，补全列表打开时 Tab 归列表", async () => {
    const submitted: string[] = [];
    const queued: string[] = [];
    function Harness({ suspendNav }: { suspendNav: boolean }) {
      const [value, setValue] = useState("继续一句");
      const [cursor, setCursor] = useState(value.length);
      return (
        <TuiEnvContext.Provider value={env}>
          <Composer
            value={value}
            cursor={cursor}
            onChange={(next, pos) => {
              setValue(next);
              setCursor(pos);
            }}
            onCursor={setCursor}
            onSubmit={(text) => submitted.push(text)}
            onQueue={(text) => queued.push(text)}
            active
            width={40}
            suspendNav={suspendNav}
          />
        </TuiEnvContext.Provider>
      );
    }
    const first = render(<Harness suspendNav={false} />);
    await vi.waitFor(() => expect(first.lastFrame()).toContain("继续一句"));
    first.stdin.write("\t");
    await vi.waitFor(() => expect(queued).toEqual(["继续一句"]));
    expect(submitted).toEqual([]);
    first.unmount();

    // 补全列表打开时 Tab 不排队（交给列表）
    const second = render(<Harness suspendNav />);
    await vi.waitFor(() => expect(second.lastFrame()).toContain("继续一句"));
    second.stdin.write("\t");
    await new Promise((done) => setTimeout(done, 20));
    expect(queued).toEqual(["继续一句"]);
    // 补全列表打开时 Tab 与 Enter 都归列表
    second.stdin.write("\r");
    await new Promise((done) => setTimeout(done, 20));
    expect(queued).toEqual(["继续一句"]);
    expect(submitted).toEqual([]);
    second.unmount();
  });
});
