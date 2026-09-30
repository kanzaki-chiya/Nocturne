import { describe, expect, it } from "vitest";

import { captureConsole } from "../src/console-capture.js";

describe("全屏 console 接管", () => {
  it("订阅前的行先缓存，首行去重、截断，restore 恢复原方法", () => {
    const target = { ...console } as Console;
    const original = target.error;
    const cap = captureConsole(target);
    target.error("(node:1) SomeWarning: first\n(Use `node --trace-warnings ...`)");
    target.warn("same %s", "line");
    target.warn("same line");
    target.log("x".repeat(400));
    const got: string[] = [];
    const off = cap.lines.subscribe((text) => got.push(text));
    target.info("after subscribe");
    expect(got[0]).toBe("(node:1) SomeWarning: first");
    expect(got[1]).toBe("same line");
    expect(got[2]).toHaveLength(301);
    expect(got[3]).toBe("after subscribe");
    expect(got).toHaveLength(4);
    off();
    cap.restore();
    expect(target.error).toBe(original);
  });

  it("每次运行至多 20 条", () => {
    const target = { ...console } as Console;
    const cap = captureConsole(target);
    const got: string[] = [];
    cap.lines.subscribe((text) => got.push(text));
    for (let i = 0; i < 30; i += 1) target.error(`w${i}`);
    expect(got).toHaveLength(20);
    cap.restore();
  });
});
