import { describe, expect, it } from "vitest";

import { parseArgs, UsageError } from "../src/args.js";

describe("参数解析（cli.md 第 2 节）", () => {
  it("无参数 → 交互模式", () => {
    const a = parseArgs([]);
    expect(a.print).toBe(false);
    expect(a.yes).toBe(false);
  });

  it("-p 带内联 prompt", () => {
    const a = parseArgs(["-p", "修复这个 bug"]);
    expect(a.print).toBe(true);
    expect(a.prompt).toBe("修复这个 bug");
  });

  it("--print 无值 → prompt 为 undefined（stdin 模式）", () => {
    const a = parseArgs(["--print"]);
    expect(a.print).toBe(true);
    expect(a.prompt).toBeUndefined();
  });

  it("覆盖参数与 --yes", () => {
    const a = parseArgs([
      "--api-type",
      "anthropic",
      "--base-url",
      "https://x.test/v1",
      "--api-key-env",
      "MY_KEY",
      "--model",
      "claude-x",
      "-y",
      "-p",
      "hi",
    ]);
    expect(a.apiType).toBe("anthropic");
    expect(a.baseUrl).toBe("https://x.test/v1");
    expect(a.apiKeyEnv).toBe("MY_KEY");
    expect(a.model).toBe("claude-x");
    expect(a.yes).toBe(true);
  });

  it("位置参数不带 -p → UsageError", () => {
    expect(() => parseArgs(["hello"])).toThrow(UsageError);
  });

  it("未知参数 → UsageError", () => {
    expect(() => parseArgs(["--nope"])).toThrow(UsageError);
  });

  it("--help / --version", () => {
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(parseArgs(["--version"]).version).toBe(true);
  });
});
