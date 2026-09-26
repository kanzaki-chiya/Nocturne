import { render } from "ink-testing-library";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { Composer } from "../src/components/composer.js";
import { TuiEnvContext } from "../src/env.js";
import { createPasteStore } from "../src/paste.js";

const env = { ascii: false, animated: false };
const pause = () => new Promise((resolve) => setTimeout(resolve, 30));

describe("Composer 多行编辑", () => {
  it("Ctrl+J 换行，方向键跨行移动，反斜杠回车换行，Enter 提交", async () => {
    const submitted: string[] = [];
    function Harness() {
      const [value, setValue] = useState("");
      const [cursor, setCursor] = useState(0);
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
    await pause();
    stdin.write("甲");
    await pause();
    stdin.write("\n"); // Windows Terminal 的 Ctrl+J
    await pause();
    stdin.write("乙\\");
    await pause();
    stdin.write("\r");
    await pause();
    expect(lastFrame()).toContain("甲");
    expect(lastFrame()).toContain("乙");
    stdin.write("\x1b[A");
    await pause();
    stdin.write("\x1b[B");
    await pause();
    stdin.write("丙");
    await pause();
    stdin.write("\r");
    await pause();
    expect(submitted).toEqual(["甲\n乙\n丙"]);
    unmount();
  });

  it("占位按整体移动和删除，Ctrl+W 删前词", async () => {
    const store = createPasteStore();
    const token = store.add("第一行\n第二行") ?? "";
    let current = "";
    function Harness() {
      const [value, setValue] = useState(token + " alpha beta");
      const [cursor, setCursor] = useState(value.length);
      current = value;
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
    await pause();
    stdin.write("\x17"); // Ctrl+W
    await pause();
    expect(current).toBe(token + " alpha");
    stdin.write("\x01"); // Ctrl+A
    await pause();
    stdin.write("\x1b[C"); // 占位整块右移
    await pause();
    stdin.write("\x7f");
    await pause();
    expect(current).toBe(" alpha");
    unmount();
  });
});
