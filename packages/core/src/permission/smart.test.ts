import { describe, expect, it } from "vitest";
import { createRulePolicy, PERMISSION_PRESET_NAMES, presetRules } from "./index.js";
import type { PermissionSubject } from "../protocol/index.js";

const ctx = { workspaceRoot: "C:/ws", caseSensitive: false, nocturneHome: "C:/home" };
const edit = (path: string): PermissionSubject => ({ kind: "edit", target: path, resolved: path });
const shell = (target: string): PermissionSubject => ({ kind: "shell", target });

describe("ADR-0036 预设", () => {
  it.each(PERMISSION_PRESET_NAMES)("%s 普通主体矩阵", (preset) => {
    const p = createRulePolicy({ ...ctx, preset, presetContext: ctx });
    const broad = ["guarded", "smart", "bypass"].includes(preset);
    expect(
      p.evaluate([{ kind: "read", target: "C:/ws/a", resolved: "C:/ws/a" }]).decision.action,
    ).toBe("allow");
    expect(p.evaluate([edit("C:/ws/a")]).decision.action).toBe(
      preset === "read-only" ? "deny" : preset === "default" ? "ask" : "allow",
    );
    expect(p.evaluate([edit("C:/outside/a")]).decision.action).toBe(
      preset === "read-only" ? "deny" : preset === "bypass" ? "allow" : "ask",
    );
    for (const subject of [
      shell("git status"),
      { kind: "network", target: "https://example.test" } as const,
      { kind: "mcp", target: "s/t" } as const,
    ])
      expect(p.evaluate([subject]).decision.action).toBe(broad ? "allow" : "ask");
  });
  it("smart 与 guarded 规则序列一致", () => {
    expect(presetRules("smart", ctx)).toEqual(presetRules("guarded", ctx));
  });
  it("bypass 撤销四类降级，保留授权数据、凭据与显式规则", () => {
    const p = createRulePolicy({
      ...ctx,
      preset: "bypass",
      presetContext: ctx,
      protectedPaths: { lexical: ["C:/home/credentials.json"] },
      rules: [
        { origin: "user", rule: { kind: "shell", pattern: "ask *", action: "ask" } },
        { origin: "cli", rule: { kind: "shell", pattern: "deny *", action: "deny" } },
      ],
    });
    for (const subject of [
      edit("C:/outside/a"),
      edit("C:/ws/.git/config"),
      shell("rm -rf build"),
      shell("pwsh -EncodedCommand abc"),
    ])
      expect(p.evaluate([subject]).decision.action).toBe("allow");
    for (const path of [
      "C:/ws/.nocturne/config.json",
      "C:/home/config.json",
      "C:/home/settings.json",
      "C:/home/trust.json",
      "C:/home/providers.json",
      "C:/home/grants/x",
    ])
      expect(p.evaluate([edit(path)]).decision.action).toBe("ask");
    expect(p.evaluate([edit("C:/home/credentials.json")]).decision.action).toBe("deny");
    expect(p.evaluate([shell("cat credentials.json")]).decision.action).toBe("ask");
    expect(p.evaluate([shell("ask something")]).decision.action).toBe("ask");
    expect(p.evaluate([shell("deny something")]).decision.action).toBe("deny");
  });
});
