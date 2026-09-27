/**
 * TUI 斜杠命令 /shell（ADR-0022 第 4 节）：无参打开选择页 overlay，
 * 带种类名直接切换；被 env/config 覆盖时给出提示；未切换时兜底消息。
 */
import { describe, expect, it } from "vitest";

import type { RuntimeSession, SessionShellInfo } from "@nocturne/core";

import { runSlash } from "../src/commands.js";

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
