import { describe, expect, it } from "vitest";

import { parseArgs, resolveUiMode, UsageError } from "../src/args.js";

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

  it("恢复与列表参数", () => {
    expect(parseArgs(["--continue"]).continueSession).toBe(true);
    expect(parseArgs(["-c"]).continueSession).toBe(true);
    const r = parseArgs(["--resume", "sess-9", "--model", "m2", "--force-unlock"]);
    expect(r.resume).toBe("sess-9");
    expect(r.model).toBe("m2");
    expect(r.forceUnlock).toBe(true);
    expect(parseArgs(["--sessions"]).sessions).toBe(true);
    expect(parseArgs(["--preset", "read-only"]).preset).toBe("read-only");
  });

  it("--tui：默认 false；可与 -c / --resume / --model 组合", () => {
    expect(parseArgs([]).tui).toBe(false);
    expect(parseArgs(["--tui"]).tui).toBe(true);
    const r = parseArgs(["--tui", "--resume", "sess-9", "--model", "m2"]);
    expect(r.tui).toBe(true);
    expect(r.resume).toBe("sess-9");
  });

  it("--cli：默认 false；可与 -c / --resume / setup 组合（cli.md 第 2 节）", () => {
    expect(parseArgs([]).cli).toBe(false);
    expect(parseArgs(["--cli"]).cli).toBe(true);
    expect(parseArgs(["--cli", "-c"]).cli).toBe(true);
    expect(parseArgs(["--cli", "--resume", "sess-9"]).cli).toBe(true);
    const s = parseArgs(["setup", "--cli"]);
    expect(s.command).toBe("setup");
    expect(s.cli).toBe(true);
  });

  it("--cli 互斥（cli.md 第 2 节）", () => {
    expect(() => parseArgs(["--cli", "--tui"])).toThrow(UsageError);
    expect(() => parseArgs(["--cli", "-p", "hi"])).toThrow(UsageError);
    expect(() => parseArgs(["--cli", "--sessions"])).toThrow(UsageError);
    expect(() => parseArgs(["trust", "--cli"])).toThrow(UsageError);
  });

  it("--inline：默认 false；可与 -c / --resume 组合；互斥项与 --tui 相同", () => {
    expect(parseArgs([]).inline).toBe(false);
    expect(parseArgs(["--inline"]).inline).toBe(true);
    const r = parseArgs(["--inline", "--resume", "sess-9"]);
    expect(r.inline).toBe(true);
    expect(r.resume).toBe("sess-9");
    expect(() => parseArgs(["--inline", "--cli"])).toThrow(UsageError);
    expect(() => parseArgs(["--inline", "-p", "hi"])).toThrow(UsageError);
    expect(() => parseArgs(["--inline", "--sessions"])).toThrow(UsageError);
    expect(() => parseArgs(["trust", "--inline"])).toThrow(UsageError);
  });

  it("trust / untrust 子命令", () => {
    expect(parseArgs(["trust"]).command).toBe("trust");
    expect(parseArgs(["untrust"]).command).toBe("untrust");
  });

  it("非法组合 → UsageError", () => {
    expect(() => parseArgs(["-c", "--resume", "x"])).toThrow(UsageError);
    expect(() => parseArgs(["--force-unlock"])).toThrow(UsageError);
    expect(() => parseArgs(["--preset", "default", "--resume", "x"])).toThrow(UsageError);
    expect(() => parseArgs(["--sessions", "-p", "hi"])).toThrow(UsageError);
    expect(() => parseArgs(["trust", "--resume", "x"])).toThrow(UsageError);
    // --tui 互斥项（cli.md 第 2 节）
    expect(() => parseArgs(["--tui", "-p", "hi"])).toThrow(UsageError);
    expect(() => parseArgs(["--tui", "--print"])).toThrow(UsageError);
    expect(() => parseArgs(["--tui", "--sessions"])).toThrow(UsageError);
    expect(() => parseArgs(["--tui", "trust"])).toThrow(UsageError);
  });
});

describe("界面模式选择（cli.md 第 2 节：TTY 默认 TUI，非 TTY 自动行式）", () => {
  const noFlags = { cli: false, tui: false, inline: false };
  it("TTY 默认 TUI；--cli 选行式；--tui / --inline 显式 TUI", () => {
    expect(resolveUiMode(noFlags, true)).toBe("tui");
    expect(resolveUiMode({ cli: true, tui: false, inline: false }, true)).toBe("repl");
    expect(resolveUiMode({ cli: false, tui: true, inline: false }, true)).toBe("tui");
    expect(resolveUiMode({ cli: false, tui: false, inline: true }, true)).toBe("tui");
  });
  it("非 TTY 自动行式（无参与 --cli 相同）；显式 --tui/--inline 报用法错", () => {
    expect(resolveUiMode(noFlags, false)).toBe("repl");
    expect(resolveUiMode({ cli: true, tui: false, inline: false }, false)).toBe("repl");
    const r = resolveUiMode({ cli: false, tui: true, inline: false }, false);
    expect(typeof r).toBe("object");
    const r2 = resolveUiMode({ cli: false, tui: false, inline: true }, false);
    expect(typeof r2).toBe("object");
  });
});
