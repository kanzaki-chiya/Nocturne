/**
 * TUI 斜杠命令 /shell（ADR-0022 第 4 节）：无参打开选择页 overlay，
 * 带种类名直接切换；被 env/config 覆盖时给出提示；未切换时兜底消息。
 */
import { describe, expect, it } from "vitest";

import type { RuntimeConfig, RuntimeSession, SessionShellInfo } from "@nocturne/core";
import { BUILTIN_SLASH_COMMANDS } from "@nocturne/core/protocol";

import { contextLines, runSlash, type ProviderBridge } from "../src/commands.js";
import { SLASH_COMMANDS } from "../src/slash-catalog.js";

function fakeSession(overrides: Partial<RuntimeSession> = {}): RuntimeSession {
  return {
    id: "s1",
    state: () =>
      ({
        config: { model: { provider: "p", model: "m1" }, permissionPreset: "default" },
      }) as ReturnType<RuntimeSession["state"]>,
    shellInfo: () => ({
      selected: "auto",
      source: "auto",
      effective: { kind: "cmd", name: "cmd.exe", path: "C:\\Windows\\System32\\cmd.exe" },
    }),
    listShells: () => [],
    setShell: () => Promise.resolve(),
    ...overrides,
  } as unknown as RuntimeSession;
}

describe("TUI /shell", () => {
  it("无参数 → shell overlay", async () => {
    const r = await runSlash("/shell", fakeSession());
    expect(r).toEqual({ kind: "overlay", name: "shell" });
  });

  it("/shell <种类> 调 setShell；实际切换后确认行交给 config_changed 事件（返回 none）", async () => {
    const calls: string[] = [];
    let effective: SessionShellInfo["effective"] = {
      kind: "cmd",
      name: "cmd.exe",
      path: "C:\\cmd.exe",
    };
    const session = fakeSession({
      shellInfo: () => ({
        selected: calls.at(-1) ?? "auto",
        source: "settings",
        ...(effective !== undefined ? { effective } : {}),
      }),
      setShell: async (k) => {
        calls.push(k);
        effective = { kind: k, name: k, path: `C:\\x\\${k}.exe` };
      },
    });
    const r = await runSlash("/shell pwsh", session);
    expect(calls).toEqual(["pwsh"]);
    expect(r).toEqual({ kind: "none" });
  });

  it("setShell 后生效未变（同种类）→ 兜底消息", async () => {
    const session = fakeSession({
      shellInfo: () => ({
        selected: "cmd",
        source: "settings",
        effective: { kind: "cmd", name: "cmd.exe", path: "C:\\cmd.exe" },
      }),
      setShell: () => Promise.resolve(),
    });
    const r = await runSlash("/shell cmd", session);
    expect(r).toEqual({ kind: "message", text: "shell 已是 cmd" });
  });

  it("被上层覆盖 → 提示已写入但不生效；未安装 → 显示错误", async () => {
    const overridden = fakeSession({
      shellInfo: () => ({
        selected: "bash",
        source: "env",
        effective: { kind: "cmd", name: "cmd.exe", path: "C:\\cmd.exe" },
        overriddenBy: "env",
      }),
      setShell: () => Promise.resolve(),
    });
    const r = await runSlash("/shell bash", overridden);
    expect(r.kind).toBe("message");
    if (r.kind === "message") {
      expect(r.text).toContain("settings.json");
      expect(r.text).toContain("NOCTURNE_SHELL");
    }

    // 未安装的种类：setShell 在写盘前以 invalid_command 拒绝（ADR-0022）
    const missing = fakeSession({
      setShell: () =>
        Promise.reject(
          new Error("invalid_command: 指定的 shell sh 未安装；可用 shell：pwsh | bash | cmd"),
        ),
    });
    const r2 = await runSlash("/shell sh", missing);
    expect(r2.kind).toBe("message");
    if (r2.kind === "message") expect(r2.text).toContain("sh 未安装");
  });

  it("未知种类 → setShell 抛错显示为消息", async () => {
    const session = fakeSession({
      setShell: () => Promise.reject(new Error("未知 shell：fish")),
    });
    const r = await runSlash("/shell fish", session);
    expect(r.kind).toBe("message");
    if (r.kind === "message") expect(r.text).toContain("未知 shell");
  });
});

describe("TUI /provider model（ADR-0024 第 5 节）", () => {
  const provider = {
    config: {} as unknown as RuntimeConfig,
    reloadConfig: async () => ({}) as unknown as RuntimeConfig,
    updateProviders: () => undefined,
  } satisfies ProviderBridge;

  it("带模型 id 直达编辑页（provider-page + modelTarget）", async () => {
    const r = await runSlash("/provider model corp m1", fakeSession(), provider);
    expect(r).toEqual({
      kind: "provider-page",
      modelTarget: { providerId: "corp", modelId: "m1" },
    });
  });

  it("只给服务商名 → 打开模型列表", async () => {
    const r = await runSlash("/provider model corp", fakeSession(), provider);
    expect(r).toEqual({ kind: "provider-page", modelTarget: { providerId: "corp" } });
  });

  it("缺参数 → 用法提示", async () => {
    const r = await runSlash("/provider model", fakeSession(), provider);
    expect(r).toEqual({
      kind: "message",
      text: "用法：/provider model <服务商> [<模型>]",
    });
  });

  it("未知子命令提示列出 model", async () => {
    const r = await runSlash("/provider bogus", fakeSession(), provider);
    expect(r.kind).toBe("message");
    if (r.kind === "message") {
      expect(r.text).toContain("未知子命令 bogus");
      expect(r.text).toContain("model <名称>");
      expect(r.text).not.toContain("image");
    }
  });
});

describe("TUI /context 面板（ADR-0046 第 5 节）", () => {
  const contextSession = (breakdown?: object): RuntimeSession =>
    fakeSession({
      describeContext: () =>
        ({
          report: {
            sections: [
              { name: "system", source: "v1", chars: 100, estimatedTokens: 25 },
              {
                name: "history",
                source: "3 entries",
                chars: 400,
                estimatedTokens: 100,
                ...(breakdown !== undefined ? { breakdown } : {}),
              },
            ],
            totalChars: 500,
            estimatedTokens: 125,
            budgetTokens: 100_000,
          },
          overBudget: false,
        }) as ReturnType<RuntimeSession["describeContext"]>,
    });

  it("history 行下缩进列出细分，为 0 的项省略", () => {
    const text = contextLines(
      contextSession({
        user: { chars: 200, estimatedTokens: 50 },
        assistant: { chars: 0, estimatedTokens: 0 },
        tool: { chars: 150, estimatedTokens: 40 },
        summary: { chars: 50, estimatedTokens: 10 },
      }),
    ).join("\n");
    expect(text).toContain("history");
    expect(text).toContain("    user           200 chars  ~50 tok");
    expect(text).toContain("    tool           150 chars  ~40 tok");
    expect(text).toContain("    summary         50 chars  ~10 tok");
    expect(text).not.toContain("assistant");
  });

  it("无 breakdown（旧报告）时只渲染分区行", () => {
    const text = contextLines(contextSession()).join("\n");
    expect(text).toContain("history");
    expect(text).not.toContain("    user");
  });
});

describe("内置命令名单", () => {
  it("TUI 每个斜杠命令都在 Core 的 BUILTIN_SLASH_COMMANDS 里", () => {
    // 技能与命令重名时禁止斜杠调用（skills.md 第 6 节）；新增命令要同步名单
    const builtin = new Set(BUILTIN_SLASH_COMMANDS);
    for (const cmd of SLASH_COMMANDS) {
      expect(builtin.has(cmd.name.slice(1)), cmd.name).toBe(true);
    }
  });
});
