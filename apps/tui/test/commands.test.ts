/**
 * TUI 斜杠命令 /shell（ADR-0022 第 4 节）：无参打开选择页 overlay，
 * 带种类名直接切换；被 env/config 覆盖时给出提示；未切换时兜底消息。
 */
import { describe, expect, it, vi } from "vitest";

import {
  RuntimeCommandError,
  type Runtime,
  type RuntimeConfig,
  type RuntimeSession,
  type SessionShellInfo,
} from "@nocturne/core";
import { BUILTIN_SLASH_COMMANDS } from "@nocturne/core/protocol";

import { contextLines, modelErrorText, runSlash, type ProviderBridge } from "../src/commands.js";
import { SLASH_COMMANDS } from "../src/slash-catalog.js";

it("TUI /agents 为只读列表，保留来源、停用和重名警告", async () => {
  const result = await runSlash(
    "/agents",
    fakeSession({
      describeSkills: () => ({
        skills: [],
        warnings: [],
        budget: {
          usedTokens: 0,
          limitTokens: 8000,
          fullCount: 0,
          nameCount: 0,
          disabledCount: 0,
          basis: "fallback",
        },
        scannedDirs: [],
        homeDir: "",
      }),
      describeExternalAgents: async () => ({
        agents: [
          {
            name: "Model",
            command: "fake",
            args: [],
            enabled: true,
            origin: "user",
            editable: false,
          },
          {
            name: "codex",
            command: "fake",
            args: [],
            enabled: false,
            origin: "app",
            editable: true,
          },
        ],
        warnings: ["配置警告"],
      }),
    }),
  );
  expect(result.kind).toBe("message");
  if (result.kind === "message") {
    expect(result.text).toContain("config.json");
    expect(result.text).toContain("程序管理");
    expect(result.text).toContain("已停用");
    expect(result.text).toContain("与内置命令重名");
    expect(result.text).toContain("配置警告");
    expect(result.text).toContain("费用与额度");
    expect(result.text).toContain("fake");
  }
});

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
      text: "用法：/provider model <服务商> [<模型>] [on|off]",
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

describe("TUI /provider 启停（ADR-0054 §5）", () => {
  const provider = {
    config: {} as unknown as RuntimeConfig,
    reloadConfig: async () => ({}) as unknown as RuntimeConfig,
    updateProviders: () => undefined,
  } satisfies ProviderBridge;

  const runtime = (): Runtime =>
    ({
      setProviderEnabled: vi.fn(async () => undefined),
      setModelsEnabled: vi.fn(async () => undefined),
    }) as unknown as Runtime;

  it("/provider disable <名称> 写停用；enable 写启用", async () => {
    const rt = runtime();
    const off = await runSlash("/provider disable corp", fakeSession(), provider, { runtime: rt });
    expect(rt.setProviderEnabled).toHaveBeenCalledWith({ provider: "corp", enabled: false });
    expect(off).toEqual({ kind: "message", text: "已停用 corp" });

    const on = await runSlash("/provider enable corp", fakeSession(), provider, { runtime: rt });
    expect(rt.setProviderEnabled).toHaveBeenLastCalledWith({ provider: "corp", enabled: true });
    expect(on).toEqual({ kind: "message", text: "已启用 corp" });
  });

  it("/provider model <名称> <模型> on|off 启停单个模型", async () => {
    const rt = runtime();
    const off = await runSlash("/provider model corp m1 off", fakeSession(), provider, {
      runtime: rt,
    });
    expect(rt.setModelsEnabled).toHaveBeenCalledWith({
      provider: "corp",
      models: ["m1"],
      enabled: false,
    });
    expect(off).toEqual({ kind: "message", text: "已停用 corp/m1" });

    const on = await runSlash("/provider model corp m1 on", fakeSession(), provider, {
      runtime: rt,
    });
    expect(rt.setModelsEnabled).toHaveBeenLastCalledWith({
      provider: "corp",
      models: ["m1"],
      enabled: true,
    });
    expect(on).toEqual({ kind: "message", text: "已启用 corp/m1" });
  });

  it("不带 on|off 仍直达编辑页；第三参数非法 → 用法提示", async () => {
    const direct = await runSlash("/provider model corp m1", fakeSession(), provider, {
      runtime: runtime(),
    });
    expect(direct).toEqual({
      kind: "provider-page",
      modelTarget: { providerId: "corp", modelId: "m1" },
    });

    const bad = await runSlash("/provider model corp m1 bogus", fakeSession(), provider, {
      runtime: runtime(),
    });
    expect(bad).toEqual({ kind: "message", text: "用法：/provider model <服务商> <模型> on|off" });
  });

  it("缺名称 → 用法提示", async () => {
    const r = await runSlash("/provider disable", fakeSession(), provider, { runtime: runtime() });
    expect(r).toEqual({ kind: "message", text: "用法：/provider disable <名称>" });
  });
});

describe("modelErrorText（ADR-0054 §3/§5）", () => {
  it("停用型 invalid_model 追加换模型/重新启用；其余原样", () => {
    const disabled = new RuntimeCommandError("invalid_model", "模型 m1 已停用", {
      disabled: "model",
      model: { provider: "corp", model: "m1" },
    });
    expect(modelErrorText(disabled)).toContain("模型 m1 已停用");
    expect(modelErrorText(disabled)).toContain("/model 换模型");
    expect(modelErrorText(disabled)).toContain("/provider model corp m1 on");
    expect(
      modelErrorText(
        new RuntimeCommandError("invalid_model", "服务商已停用", {
          disabled: "provider",
          model: { provider: "corp", model: "m1" },
        }),
      ),
    ).toContain("/provider enable corp");

    expect(modelErrorText(new RuntimeCommandError("invalid_model", "未知模型 x"))).toBe(
      "未知模型 x",
    );
    expect(modelErrorText(new Error("boom"))).toBe("boom");
  });

  it("双重停用同时给出模型与服务商两条重新启用命令", () => {
    const text = modelErrorText(
      new RuntimeCommandError("invalid_model", "模型 corp/m1 已停用", {
        disabled: "model",
        model: { provider: "corp", model: "m1" },
        providerDisabled: true,
      }),
    );
    expect(text).toContain("/provider model corp m1 on");
    expect(text).toContain("/provider enable corp");
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
