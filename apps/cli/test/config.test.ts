import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPlatform } from "@nocturne/core";

import type { CliArgs } from "../src/args.js";
import { collectConfig, configProblemsReport, normalizeModelRef } from "../src/config.js";

const platform = createPlatform();

const base: CliArgs = {
  print: true,
  tui: false,
  inline: false,
  cli: false,
  yes: false,
  debug: false,
  help: false,
  version: false,
  continueSession: false,
  sessions: false,
  forceUnlock: false,
};

const envOf = (map: Record<string, string>) => (n: string) => map[n];

let home: string;
beforeEach(() => {
  // loadConfig 读 <NOCTURNE_HOME>/config.json 与 trust.json——隔离到临时目录
  home = mkdtempSync(path.join(tmpdir(), "nct-cli-cfg-"));
  vi.stubEnv("NOCTURNE_HOME", home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("Provider 配置收集（cli.md 第 8 节）", () => {
  it("openai-compatible：env 齐全 → 组装配置", async () => {
    const r = await collectConfig(
      base,
      platform,
      envOf({
        NOCTURNE_BASE_URL: "https://api.test/v1",
        NOCTURNE_API_KEY: "sk-x",
        NOCTURNE_MODEL: "m1",
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.providerId).toBe("openai-compatible");
    expect(r.config.model).toBe("openai-compatible/m1");
    const provider = r.config.runtime.base.providers.find((p) => p.id === "openai-compatible");
    expect(provider).toMatchObject({
      baseURL: "https://api.test/v1",
      apiKeyEnv: "NOCTURNE_API_KEY",
      models: { m1: {} },
    });
  });

  it("参数优先于环境变量", async () => {
    const r = await collectConfig(
      { ...base, baseUrl: "https://flag.test", model: "m2", apiKeyEnv: "K" },
      platform,
      envOf({ NOCTURNE_BASE_URL: "https://env.test", NOCTURNE_MODEL: "m1", K: "sk" }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const provider = r.config.runtime.base.providers.find((p) => p.id === "openai-compatible");
    expect(provider).toMatchObject({ baseURL: "https://flag.test", apiKeyEnv: "K" });
    expect(r.config.model).toBe("openai-compatible/m2");
  });

  it("缺 baseURL / 凭据 / 模型 → 列出全部缺失项", async () => {
    const r = await collectConfig(base, platform, () => undefined);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const text = r.problems.join("\n");
    expect(text).toContain("模型");
    // 没有合成出 Provider 条目 → 报 Provider 未配置
    expect(text).toContain("openai-compatible");
  });

  it("anthropic：baseURL 可省略；默认凭据变量 ANTHROPIC_API_KEY", async () => {
    const r = await collectConfig(
      { ...base, apiType: "anthropic", model: "claude-x" },
      platform,
      envOf({ ANTHROPIC_API_KEY: "sk-a" }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const provider = r.config.runtime.base.providers.find((p) => p.id === "anthropic");
    expect(provider).toMatchObject({ type: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY" });
    expect(provider?.baseURL).toBeUndefined();
    expect(r.config.model).toBe("anthropic/claude-x");
  });

  it("--model 前缀是另一种 api-type → 拒绝；模型命名空间原样保留", async () => {
    const bad = await collectConfig(
      { ...base, model: "anthropic/m" },
      platform,
      envOf({ NOCTURNE_BASE_URL: "https://x", NOCTURNE_API_KEY: "k" }),
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.problems[0]).toContain("不一致");

    // 非 api-type 前缀是模型命名空间（openrouter/deepseek 形态），原样使用
    const ns = await collectConfig(
      { ...base, model: "deepseek/deepseek-v4.1-flash" },
      platform,
      envOf({ NOCTURNE_BASE_URL: "https://x", NOCTURNE_API_KEY: "k" }),
    );
    expect(ns.ok).toBe(true);
    if (!ns.ok) return;
    expect(ns.config.model).toBe("openai-compatible/deepseek/deepseek-v4.1-flash");
  });

  it("--api-type 无效值 → 拒绝", async () => {
    const r = await collectConfig(
      { ...base, apiType: "gemini" },
      platform,
      envOf({ NOCTURNE_API_KEY: "k", NOCTURNE_MODEL: "m", NOCTURNE_BASE_URL: "u" }),
    );
    expect(r.ok).toBe(false);
  });

  it("凭据只回显变量名：配置里不出现密钥值", async () => {
    const r = await collectConfig(
      base,
      platform,
      envOf({
        NOCTURNE_BASE_URL: "https://x",
        NOCTURNE_API_KEY: "super-secret-value",
        NOCTURNE_MODEL: "m",
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(JSON.stringify(r.config)).not.toContain("super-secret-value");
    expect(JSON.stringify(r.config)).toContain("NOCTURNE_API_KEY");
  });

  it("配置不完整报告：交互终端提示 nctrn setup，非 TTY 不含（cli.md 第 2 节）", async () => {
    // 空 NOCTURNE_HOME + 无任何环境变量：无 providers.json 条目、无
    // config.json providers、无环境变量合成 → hasProviderSource=false
    const r = await collectConfig(base, platform, () => undefined);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.hasProviderSource).toBe(false);

    const ttyText = configProblemsReport(r.problems, {
      tty: true,
      hasProviderSource: r.hasProviderSource,
    });
    expect(ttyText).toContain("nctrn setup");
    // 全无服务商来源：setup 提示置首（在缺失项列表之前）
    expect(ttyText.indexOf("nctrn setup")).toBeLessThan(ttyText.indexOf("  - "));

    const piped = configProblemsReport(r.problems, {
      tty: false,
      hasProviderSource: r.hasProviderSource,
    });
    expect(piped).not.toContain("nctrn setup");
    expect(piped).toContain("配置不完整");

    // 有服务商来源（如缺凭据）时提示在缺失项之后
    const sourced = configProblemsReport(r.problems, { tty: true, hasProviderSource: true });
    expect(sourced.indexOf("nctrn setup")).toBeGreaterThan(sourced.indexOf("  - "));
  });

  it("requireModel=false（恢复路径）：无模型配置也可通过", async () => {
    const r = await collectConfig({ ...base, resume: "sess-1" }, platform, () => undefined, {
      requireModel: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.model).toBeUndefined();
  });
});

describe("normalizeModelRef（cli.md §2/§4）", () => {
  it("裸 id 归属当前 Provider；同前缀剥掉；异 api-type 拒绝；命名空间保留", () => {
    expect(normalizeModelRef("m1", "openai-compatible")).toEqual({
      ok: true,
      ref: "openai-compatible/m1",
    });
    expect(normalizeModelRef("openai-compatible/m1", "openai-compatible")).toEqual({
      ok: true,
      ref: "openai-compatible/m1",
    });
    expect(normalizeModelRef("anthropic/m", "openai-compatible").ok).toBe(false);
    expect(normalizeModelRef("deepseek/v4", "openai-compatible")).toEqual({
      ok: true,
      ref: "openai-compatible/deepseek/v4",
    });
  });
});
