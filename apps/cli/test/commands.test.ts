import { describe, expect, it } from "vitest";

import type { Runtime, RuntimeSession } from "@nocturne/core";
import { RuntimeCommandError } from "@nocturne/core";

import { runSlashCommand } from "../src/commands.js";

function fakeSession(overrides: Partial<RuntimeSession> = {}): RuntimeSession {
  return {
    id: "s1",
    state: () =>
      ({
        config: { model: { provider: "p", model: "m1" }, permissionPreset: "default" },
      }) as ReturnType<RuntimeSession["state"]>,
    setModel: () => Promise.resolve(),
    compact: () => Promise.resolve(),
    describeContext: () =>
      ({
        report: {
          sections: [
            { name: "system", source: "v1", chars: 100, estimatedTokens: 25 },
            { name: "history", source: "3 条", chars: 400, estimatedTokens: 100 },
          ],
          totalChars: 500,
          estimatedTokens: 125,
          budgetTokens: 100_000,
        },
        overBudget: false,
      }) as ReturnType<RuntimeSession["describeContext"]>,
    ...overrides,
  } as unknown as RuntimeSession;
}

const fakeRuntime = {
  listModels: () => [
    {
      ref: { provider: "p", model: "m1" },
      contextWindow: 128_000,
      pricing: { input: 0.27, output: 1.1 },
      capabilities: {
        reasoning: "visible",
        imageInput: true,
        promptCache: false,
        toolCalls: true,
        parallelToolCalls: false,
      },
    },
    {
      ref: { provider: "p", model: "m2" },
      capabilities: {
        reasoning: "none",
        imageInput: false,
        promptCache: false,
        toolCalls: true,
        parallelToolCalls: false,
      },
    },
    {
      ref: { provider: "other", model: "big" },
      contextWindow: 1_000_000,
      capabilities: {
        reasoning: "none",
        imageInput: false,
        promptCache: false,
        toolCalls: true,
        parallelToolCalls: false,
      },
    },
  ],
  defaultModel: () => ({ provider: "p", model: "m2" }),
  listRecentModels: () => [],
  updateProviders: () => undefined,
} as unknown as Runtime;

function capture() {
  const lines: string[] = [];
  return { lines, io: { print: (t: string) => lines.push(t) } };
}

describe("斜杠命令（cli.md 第 4 节）", () => {
  it("/help 列出命令", async () => {
    const { lines, io } = capture();
    expect(await runSlashCommand("/help", fakeSession(), fakeRuntime, io)).toBe("handled");
    expect(lines.join("")).toContain("/compact");
  });

  it("/model 无参数：编号表格含列信息与标注（cli.md 第 4 节）", async () => {
    const { lines, io } = capture();
    await runSlashCommand("/model", fakeSession(), fakeRuntime, io);
    const text = lines.join("");
    expect(text).toContain("p/m1");
    expect(text).toContain("p/m2");
    expect(text).toContain("128k");
    expect(text).toContain("1m");
    expect(text).toContain("$0.27/1.1");
    expect(text).toContain("当前会话");
    expect(text).toContain("默认模型");
  });

  it("/model <关键词> 未匹配 id 时过滤列表，不切换", async () => {
    let called = 0;
    const session = fakeSession({
      setModel: async () => {
        called += 1;
      },
    });
    const { lines, io } = capture();
    await runSlashCommand("/model big", session, fakeRuntime, io);
    expect(called).toBe(0);
    expect(lines.join("")).toContain("other/big");
    expect(lines.join("")).not.toContain("p/m1");

    const none = capture();
    await runSlashCommand("/model zzzz", session, fakeRuntime, none.io);
    expect(none.lines.join("")).toContain("没有匹配");
  });

  it("/model <id> 调 setModel；RuntimeCommandError 显示为提示", async () => {
    let called: unknown;
    const session = fakeSession({
      setModel: async (m) => {
        called = m;
      },
    });
    const { lines, io } = capture();
    await runSlashCommand("/model p/m2", session, fakeRuntime, io);
    expect(called).toBe("p/m2");

    const failing = fakeSession({
      setModel: async () => {
        throw new RuntimeCommandError("session_busy", "Turn 进行中");
      },
    });
    await runSlashCommand("/model p/m2", failing, fakeRuntime, io);
    expect(lines.join("")).toContain("session_busy");
  });

  it("/model <裸 id> 按当前 Provider 补齐；异 api-type 前缀报错不调 setModel", async () => {
    const calls: unknown[] = [];
    const session = fakeSession({
      setModel: async (m) => {
        calls.push(m);
      },
    });
    const { lines, io } = capture();
    await runSlashCommand("/model m2", session, fakeRuntime, io);
    expect(calls).toEqual(["p/m2"]);

    // 含斜杠但前缀不是 api-type：整体按模型 id 处理
    await runSlashCommand("/model deepseek/deepseek-v4.1-flash", session, fakeRuntime, io);
    expect(calls.at(-1)).toBe("p/deepseek/deepseek-v4.1-flash");

    await runSlashCommand("/model anthropic/claude-b", session, fakeRuntime, io);
    expect(calls).toHaveLength(2);
    expect(lines.join("")).toContain("anthropic");
    expect(lines.join("")).toContain("不一致");
  });

  it("/preset 无参数显示当前；/preset <name> 调 setPermissionPreset", async () => {
    let called: unknown;
    const session = fakeSession({
      setPermissionPreset: async (n) => {
        called = n;
      },
    });
    const { lines, io } = capture();
    await runSlashCommand("/preset", session, fakeRuntime, io);
    expect(lines.join("")).toContain("default");
    await runSlashCommand("/preset auto-edit", session, fakeRuntime, io);
    expect(called).toBe("auto-edit");

    const failing = fakeSession({
      setPermissionPreset: async () => {
        throw new RuntimeCommandError("invalid_command", "未知预设");
      },
    });
    await runSlashCommand("/preset bogus", failing, fakeRuntime, io);
    expect(lines.join("")).toContain("invalid_command");
  });

  it("/context 渲染分区与合计", async () => {
    const { lines, io } = capture();
    await runSlashCommand("/context", fakeSession(), fakeRuntime, io);
    const text = lines.join("");
    expect(text).toContain("system");
    expect(text).toContain("history");
    expect(text).toContain("125");
    expect(text).toContain("100000");
  });

  it("/context 有图片时渲染 images 行", async () => {
    const { lines, io } = capture();
    const session = fakeSession({
      describeContext: () =>
        ({
          report: {
            sections: [{ name: "history", source: "3 条", chars: 400, estimatedTokens: 100 }],
            totalChars: 400,
            estimatedTokens: 4900,
            budgetTokens: 100_000,
            images: { count: 3, estimatedTokens: 4800 },
          },
          overBudget: false,
        }) as ReturnType<RuntimeSession["describeContext"]>,
    });
    await runSlashCommand("/context", session, fakeRuntime, io);
    const text = lines.join("");
    expect(text).toContain("images");
    expect(text).toContain("3 张");
    expect(text).toContain("~4800");
  });

  it("/compact 调 compact；失败只显示不抛", async () => {
    let compacted = false;
    const session = fakeSession({
      compact: async () => {
        compacted = true;
      },
    });
    const { io } = capture();
    await runSlashCommand("/compact", session, fakeRuntime, io);
    expect(compacted).toBe(true);

    const failing = fakeSession({
      compact: async () => {
        throw new RuntimeCommandError("compaction_in_progress", "x");
      },
    });
    const c2 = capture();
    const outcome = await runSlashCommand("/compact", failing, fakeRuntime, c2.io);
    expect(outcome).toBe("handled");
    expect(c2.lines.join("")).toContain("compaction_in_progress");
  });

  it("/provider 列出服务商：密钥来源、来源层、当前会话标注，不含密钥", async () => {
    const { lines, io } = capture();
    const deps = {
      provider: {
        config: {
          providerSetupWarning: undefined,
          describeProviders: async () => [
            {
              id: "p",
              type: "openai-compatible",
              host: "api.corp.test",
              keySource: "credential" as const,
              origin: "setup" as const,
              overridden: false,
              modelCount: 2,
              managed: true,
            },
            {
              id: "q",
              type: "anthropic",
              host: undefined,
              keySource: "env" as const,
              keyEnvName: "ANTHROPIC_API_KEY",
              origin: "user" as const,
              overridden: false,
              modelCount: 0,
              managed: false,
            },
          ],
        } as never,
        reloadConfig: async () => ({}) as never,
        updateProviders: () => undefined,
      },
    };
    await runSlashCommand("/provider", fakeSession(), fakeRuntime, io, deps);
    const text = lines.join("");
    expect(text).toContain("api.corp.test");
    expect(text).toContain("凭据文件");
    expect(text).toContain("环境变量 ANTHROPIC_API_KEY");
    expect(text).toContain("向导");
    expect(text).toContain("config.json");
    expect(text).toContain("当前会话");
    expect(text).not.toContain("sk-");
  });

  it("/provider remove 当前会话使用的服务商拒绝；其他删除并刷新", async () => {
    const removed: string[] = [];
    const updated: unknown[] = [];
    const deps = {
      provider: {
        config: {
          removeSetupProvider: async (id: string) => {
            removed.push(id);
          },
        } as never,
        reloadConfig: async () => ({ tag: "rc" }) as never,
        updateProviders: (rc: unknown) => {
          updated.push(rc);
        },
      },
    };
    const { lines, io } = capture();
    await runSlashCommand("/provider remove p", fakeSession(), fakeRuntime, io, deps);
    expect(removed).toHaveLength(0);
    expect(lines.join("")).toContain("不能删除");

    await runSlashCommand("/provider remove q", fakeSession(), fakeRuntime, io, deps);
    expect(removed).toEqual(["q"]);
    expect(updated).toEqual([{ tag: "rc" }]);
  });

  it("/provider refresh 调 refreshUpstreamLimits 并 updateProviders", async () => {
    const refreshed: string[] = [];
    const updated: unknown[] = [];
    const deps = {
      provider: {
        config: {
          refreshUpstreamLimits: async (id: string) => {
            refreshed.push(id);
          },
        } as never,
        reloadConfig: async () => ({ tag: "rc" }) as never,
        updateProviders: (rc: unknown) => {
          updated.push(rc);
        },
      },
    };
    const { io } = capture();
    await runSlashCommand("/provider refresh p", fakeSession(), fakeRuntime, io, deps);
    expect(refreshed).toEqual(["p"]);
    expect(updated).toEqual([{ tag: "rc" }]);
  });

  it("/provider model 调 runModelWizard（参数顺序：服务商、模型）", async () => {
    const calls: [string, string][] = [];
    const deps = {
      provider: {
        config: {} as never,
        reloadConfig: async () => ({}) as never,
        updateProviders: () => undefined,
      },
      runModelWizard: async (p: string, m: string) => {
        calls.push([p, m]);
      },
    };
    await runSlashCommand(
      "/provider model corp m1",
      fakeSession(),
      fakeRuntime,
      capture().io,
      deps,
    );
    expect(calls).toEqual([["corp", "m1"]]);
  });

  it("/provider model 参数不全 → 用法；无向导桥 → 需要交互式终端；失败透传", async () => {
    const deps = {
      provider: {
        config: {} as never,
        reloadConfig: async () => ({}) as never,
        updateProviders: () => undefined,
      },
    };
    const { lines, io } = capture();
    for (const line of ["/provider model", "/provider model corp"]) {
      await runSlashCommand(line, fakeSession(), fakeRuntime, io, deps);
    }
    expect(lines.filter((l) => l.includes("用法：/provider model <服务商> <模型>"))).toHaveLength(
      2,
    );
    // 无 runModelWizard 桥 → 非交互提示
    await runSlashCommand("/provider model corp m1", fakeSession(), fakeRuntime, io, deps);
    expect(lines.at(-1)).toContain("需要交互式终端");
    // 向导错误透传
    const { lines: lines2, io: io2 } = capture();
    await runSlashCommand("/provider model corp m1", fakeSession(), fakeRuntime, io2, {
      ...deps,
      runModelWizard: async () => {
        throw new Error('模型 "m1" 不在清单中');
      },
    });
    expect(lines2.at(-1)).toContain("! ");
    expect(lines2.at(-1)).toContain("不在清单中");
  });

  it("/provider add 无向导桥时提示需要交互终端", async () => {
    const { lines, io } = capture();
    await runSlashCommand("/provider add", fakeSession(), fakeRuntime, io, {
      provider: {
        config: {} as never,
        reloadConfig: async () => ({}) as never,
        updateProviders: () => undefined,
      },
    });
    expect(lines.join("")).toContain("交互式终端");
  });

  it("/effort 无参数：显示当前档位与可用档位；无可用档位时只显示当前", async () => {
    const { lines, io } = capture();
    const session = fakeSession({
      reasoningEffortInfo: () => ({
        current: "high",
        effective: "high",
        available: ["low", "medium", "high", "xhigh"],
      }),
    });
    await runSlashCommand("/effort", session, fakeRuntime, io);
    const text = lines.join("");
    expect(text).toContain("high");
    expect(text).toContain("off | low | medium | high | xhigh");

    const c2 = capture();
    const plain = fakeSession({
      reasoningEffortInfo: () => ({ current: "off", effective: "off", available: [] }),
    });
    await runSlashCommand("/effort", plain, fakeRuntime, c2.io);
    expect(c2.lines.join("")).toContain("未声明可用档位");
  });

  it("/effort <档位> 调 setReasoningEffort；不可用档位报错为提示", async () => {
    let called: unknown;
    const session = fakeSession({
      reasoningEffortInfo: () => ({ current: "off", effective: "off", available: ["low", "high"] }),
      setReasoningEffort: async (level) => {
        called = level;
      },
    });
    const { lines, io } = capture();
    await runSlashCommand("/effort high", session, fakeRuntime, io);
    expect(called).toBe("high");

    const failing = fakeSession({
      reasoningEffortInfo: () => ({ current: "off", effective: "off", available: ["low", "high"] }),
      setReasoningEffort: async () => {
        throw new RuntimeCommandError("invalid_command", "该模型不可用档位 xhigh");
      },
    });
    await runSlashCommand("/effort xhigh", failing, fakeRuntime, io);
    expect(lines.join("")).toContain("invalid_command");
  });

  it("/provider thinking 已移除", async () => {
    const { io, lines } = capture();
    await runSlashCommand("/provider thinking p", fakeSession(), fakeRuntime, io, {
      provider: {
        config: {} as never,
        reloadConfig: async () => ({}) as never,
        updateProviders: () => undefined,
      },
    });
    expect(lines.join("")).toContain("未知 /provider 子命令 thinking");
  });

  it("/shell 无参数：编号列表含 auto 与全部种类、标注当前与来源；覆盖提示", async () => {
    const { lines, io } = capture();
    const session = fakeSession({
      shellInfo: () => ({
        selected: "cmd",
        source: "settings",
        effective: { kind: "cmd", name: "cmd.exe", path: "C:\\Windows\\System32\\cmd.exe" },
        overriddenBy: "env",
      }),
      listShells: () => [
        { kind: "pwsh", name: "PowerShell 7", executable: "C:\\ps\\pwsh.exe", available: true },
        { kind: "powershell", name: "Windows PowerShell 5.1", available: false },
        { kind: "bash", name: "Git Bash", executable: "C:\\Git\\bin\\bash.exe", available: true },
        {
          kind: "cmd",
          name: "cmd.exe",
          executable: "C:\\Windows\\System32\\cmd.exe",
          available: true,
        },
        { kind: "sh", name: "POSIX sh", available: false },
      ],
      setShell: () => Promise.resolve(),
    });
    await runSlashCommand("/shell", session, fakeRuntime, io);
    const text = lines.join("");
    expect(text).toContain("当前 shell：cmd");
    expect(text).toContain("settings.json");
    expect(text).toContain("auto");
    expect(text).toContain("pwsh");
    expect(text).toContain("（未安装）");
    expect(text).toContain("← 当前");
    expect(text).toContain("NOCTURNE_SHELL"); // overriddenBy 提示
  });

  it("/shell <种类|编号> 调 setShell；切换成功打印确认；无效值显示错误", async () => {
    const calls: string[] = [];
    let cur: { kind: string; name: string; path: string } | undefined = {
      kind: "cmd",
      name: "cmd.exe",
      path: "C:\\Windows\\System32\\cmd.exe",
    };
    const session = fakeSession({
      shellInfo: () => ({
        selected: calls.at(-1) ?? "auto",
        source: calls.length > 0 ? "settings" : "auto",
        ...(cur !== undefined ? { effective: cur } : {}),
      }),
      listShells: () => [
        { kind: "pwsh", name: "PowerShell 7", executable: "C:\\ps\\pwsh.exe", available: true },
        { kind: "powershell", name: "ps51", available: false },
        { kind: "bash", name: "Git Bash", executable: "C:\\Git\\bin\\bash.exe", available: true },
        {
          kind: "cmd",
          name: "cmd.exe",
          executable: "C:\\Windows\\System32\\cmd.exe",
          available: true,
        },
        { kind: "sh", name: "POSIX sh", available: false },
      ],
      setShell: async (k) => {
        calls.push(k);
        cur = { kind: k, name: k, path: `C:\\x\\${k}.exe` };
      },
    });
    const { lines, io } = capture();
    await runSlashCommand("/shell pwsh", session, fakeRuntime, io);
    expect(calls).toEqual(["pwsh"]);
    expect(lines.join("")).toContain("pwsh");

    // 编号选择：1=auto，其后按 SHELL_KINDS 顺序（2=pwsh, 3=powershell, 4=bash）
    await runSlashCommand("/shell 4", session, fakeRuntime, io);
    expect(calls.at(-1)).toBe("bash");
    await runSlashCommand("/shell 1", session, fakeRuntime, io);
    expect(calls.at(-1)).toBe("auto");

    const failing = fakeSession({
      shellInfo: () => ({ selected: "auto", source: "auto" as const }),
      listShells: () => [],
      setShell: async () => {
        throw new RuntimeCommandError("invalid_command", "未知 shell");
      },
    });
    await runSlashCommand("/shell fish", failing, fakeRuntime, io);
    expect(lines.join("")).toContain("未知 shell");
  });

  it("/shell 切换被覆盖时打印 settings 已写入但不生效的提示", async () => {
    const session = fakeSession({
      shellInfo: () => ({
        selected: "bash",
        source: "env",
        effective: { kind: "cmd", name: "cmd.exe", path: "C:\\Windows\\System32\\cmd.exe" },
        overriddenBy: "env" as const,
      }),
      listShells: () => [],
      setShell: () => Promise.resolve(),
    });
    const { lines, io } = capture();
    await runSlashCommand("/shell bash", session, fakeRuntime, io);
    expect(lines.join("")).toContain("settings.json");
    expect(lines.join("")).toContain("NOCTURNE_SHELL");
  });

  it("/exit → exit；未知命令 → unknown 且不报错退出", async () => {
    const { lines, io } = capture();
    expect(await runSlashCommand("/exit", fakeSession(), fakeRuntime, io)).toBe("exit");
    expect(await runSlashCommand("/nope", fakeSession(), fakeRuntime, io)).toBe("unknown");
    expect(lines.join("")).toContain("未知命令");
  });
});
