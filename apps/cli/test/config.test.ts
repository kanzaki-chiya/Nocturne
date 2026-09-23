import { describe, expect, it } from "vitest";

import type { CliArgs } from "../src/args.js";
import { collectConfig } from "../src/config.js";

const base: CliArgs = {
  print: true,
  yes: false,
  help: false,
  version: false,
};

const envOf = (map: Record<string, string>) => (n: string) => map[n];

describe("Provider 配置收集（cli.md 第 7 节）", () => {
  it("openai-compatible：env 齐全 → 组装配置", () => {
    const r = collectConfig(
      base,
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
    expect(r.config.providerConfig).toMatchObject({
      id: "openai-compatible",
      baseURL: "https://api.test/v1",
      apiKeyEnv: "NOCTURNE_API_KEY",
      models: { m1: {} },
    });
  });

  it("参数优先于环境变量", () => {
    const r = collectConfig(
      { ...base, baseUrl: "https://flag.test", model: "m2", apiKeyEnv: "K" },
      envOf({ NOCTURNE_BASE_URL: "https://env.test", NOCTURNE_MODEL: "m1", K: "sk" }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.providerConfig).toMatchObject({
      baseURL: "https://flag.test",
      apiKeyEnv: "K",
      models: { m2: {} },
    });
    expect(r.config.model).toBe("openai-compatible/m2");
  });

  it("缺 baseURL / 凭据 / 模型 → 列出全部缺失项", () => {
    const r = collectConfig(base, () => undefined);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems.join("\n")).toContain("NOCTURNE_BASE_URL");
    expect(r.problems.join("\n")).toContain("NOCTURNE_API_KEY");
    expect(r.problems.join("\n")).toContain("NOCTURNE_MODEL");
  });

  it("anthropic：baseURL 可省略；默认凭据变量 ANTHROPIC_API_KEY", () => {
    const r = collectConfig(
      { ...base, apiType: "anthropic", model: "claude-x" },
      envOf({ ANTHROPIC_API_KEY: "sk-a" }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.providerConfig).toMatchObject({
      type: "anthropic",
      apiKeyEnv: "ANTHROPIC_API_KEY",
    });
    expect("baseURL" in r.config.providerConfig).toBe(false);
    expect(r.config.model).toBe("anthropic/claude-x");
  });

  it("--model provider/model 与当前 Provider 不一致 → 拒绝", () => {
    const r = collectConfig(
      { ...base, model: "other/m" },
      envOf({ NOCTURNE_BASE_URL: "https://x", NOCTURNE_API_KEY: "k" }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems[0]).toContain("不一致");
  });

  it("--api-type 无效值 → 拒绝", () => {
    const r = collectConfig(
      { ...base, apiType: "gemini" },
      envOf({ NOCTURNE_API_KEY: "k", NOCTURNE_MODEL: "m", NOCTURNE_BASE_URL: "u" }),
    );
    expect(r.ok).toBe(false);
  });

  it("凭据只回显变量名：配置里不出现密钥值", () => {
    const r = collectConfig(
      base,
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
});
