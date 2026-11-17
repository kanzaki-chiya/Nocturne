// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { BrandIcon } from "../src/BrandIcon";
import { modelIcon, modelIconKey, providerIcon, resolveIconKey } from "../src/brand-icons";

afterEach(cleanup);

describe("providerIcon", () => {
  it.each([
    ["chatgpt", "openai"],
    ["openai", "openai"],
    ["anthropic", "anthropic"],
    ["grok", "grok"],
    ["grok-cli", "grok"],
    ["xai", "grok"],
    ["deepseek", "deepseek"],
    ["openrouter", "openrouter"],
    ["opencode-zen", "opencode"],
    ["opencode-go", "opencode"],
    ["opencode", "opencode"],
    ["ollama", "ollama"],
    ["lmstudio", "lmstudio"],
    ["siliconcloud", "siliconcloud"],
    ["volcengine", "volcengine"],
    ["bailian", "bailian"],
    ["moonshot", "moonshot"],
    ["zhipu", "zai"],
    ["zai", "zai"],
    ["bigmodel", "zai"],
    ["minimax", "minimax"],
    ["kiro", "kiro"],
    ["antigravity", "antigravity"],
    ["groq", "groq"],
    ["cerebras", "cerebras"],
    ["github", "github"],
    ["githubcopilot", "githubcopilot"],
    ["vercel", "vercel"],
    ["google", "gemini-color"],
    ["baidu-qianfan-api", "baiducloud"],
    ["tencent-cloud-intl", "tencentcloud"],
    ["huaweicloud-plan", "huaweicloud"],
    ["nous", "nousresearch"],
    ["gmicloud", "gmicloud"],
    ["clinepass", "cline"],
    ["kilo", "kilocode"],
    ["commandcode", "commandcode"],
    ["together", "together"],
    ["fireworks", "fireworks"],
    ["nvidia", "nvidia"],
    ["modelscope", "modelscope"],
    ["aihubmix", "aihubmix"],
    ["302ai", "ai302"],
    ["qwencloud-cn-beijing", "qwen-color"],
    ["stepfun-cn-plan", "stepfun-color"],
    ["xiaomi-plan-sgp", "xiaomimimo"],
    ["OpenRouter", "openrouter"],
  ])("映射服务商 %s → %s", (id, expected) => {
    const res = providerIcon(id);
    expect(res.kind).toBe("brand");
    expect(res.name).toBe(expected);
    if (res.kind === "brand") {
      expect(res.svg).toContain("<svg");
      expect(res.svg).toContain("viewBox=");
      expect(res.svg).not.toMatch(/<title>/);
      expect(res.svg).not.toMatch(/<svg[^>]*\s(?:width|height|style)=/);
    }
  });

  it("自定义服务商和未知 ID 回退到通用服务商图标 cloud", () => {
    for (const id of [
      "custom-openai",
      "custom-anthropic",
      "unknown-gw",
      "group",
      "pipellm",
      "cherryin",
      "yylx-auto",
      "aigocode",
      "omlx",
      "mlx-serve",
    ]) {
      expect(providerIcon(id)).toEqual({ kind: "fallback", name: "cloud" });
    }
  });
});

describe("modelIcon", () => {
  it.each([
    [{ provider: "any", model: "claude-sonnet-4-5" }, "claude-color"],
    [{ provider: "any", model: "gemma-3-27b" }, "gemma-color"],
    [{ provider: "any", model: "gemini-2.5-pro" }, "gemini-color"],
    [{ provider: "any", model: "gpt-5" }, "openai"],
    [{ provider: "any", model: "gpt-5.2-codex" }, "openai"],
    [{ provider: "any", model: "o3-mini" }, "openai"],
    [{ provider: "any", model: "openai/o4-mini" }, "openai"],
    [{ provider: "any", model: "grok-4" }, "grok"],
    [{ provider: "any", model: "deepseek-r1" }, "deepseek-color"],
    [{ provider: "any", model: "qwen3-coder" }, "qwen-color"],
    [{ provider: "any", model: "qwq-32b" }, "qwen-color"],
    [{ provider: "any", model: "kimi-k2" }, "kimi"],
    [{ provider: "any", model: "moonshot-v1-8k" }, "kimi"],
    [{ provider: "any", model: "glm-4.7" }, "zai"],
    [{ provider: "any", model: "minimax-m2" }, "minimax-color"],
    [{ provider: "any", model: "mimo-v2-flash" }, "xiaomimimo"],
    [{ provider: "any", model: "doubao-seed-1.6" }, "doubao-color"],
    [{ provider: "any", model: "mistral-large" }, "mistral-color"],
    [{ provider: "any", model: "codestral-2501" }, "mistral-color"],
    [{ provider: "any", model: "devstral-small" }, "mistral-color"],
    [{ provider: "any", model: "llama-4-scout" }, "meta-color"],
    [{ provider: "any", model: "hunyuan-turbo" }, "hunyuan-color"],
    [{ provider: "any", model: "ernie-4.5" }, "wenxin-color"],
    [{ provider: "any", model: "step-2-16k" }, "stepfun-color"],
    [{ provider: "any", model: "longcat-flash" }, "longcat"],
  ])("命中模型规则 %o → %s", (ref, expected) => {
    const res = modelIcon(ref);
    expect(res.kind).toBe("brand");
    expect(res.name).toBe(expected);
  });

  it("按模型 ID 最后一段匹配（忽略前面组织/路由前缀）", () => {
    expect(modelIcon({ provider: "openrouter", model: "anthropic/claude-opus-4" }).name).toBe(
      "claude-color",
    );
    expect(modelIcon({ provider: "openrouter", model: "openai/some-model" }).name).toBe(
      "openrouter",
    );
  });

  it("覆盖指定实际模型 ID", () => {
    expect(modelIcon({ provider: "kiro", model: "claude-opus-5.5" }).name).toBe("claude-color");
    expect(modelIcon({ provider: "agy-cli", model: "gemini-4-hydrogen" }).name).toBe(
      "gemini-color",
    );
    expect(modelIcon({ provider: "group", model: "never-stuck" })).toEqual({
      kind: "fallback",
      name: "box_3",
    });
    expect(modelIcon({ provider: "openrouter", model: "never-stuck" }).name).toBe("openrouter");
    expect(modelIcon({ provider: "deepseek", model: "deepseek-v4.1-flash" }).name).toBe(
      "deepseek-color",
    );
    expect(modelIcon({ provider: "openai", model: "gpt-6.1-sol" }).name).toBe("openai");
    expect(modelIcon({ provider: "bailian", model: "Qwen3.8-Flash" }).name).toBe("qwen-color");
  });

  it("modelIconKey 与 resolveIconKey 往返一致", () => {
    const k1 = modelIconKey({ provider: "kiro", model: "claude-opus-5.5" });
    const k2 = modelIconKey({ provider: "group", model: "never-stuck" });
    expect(k1).toBe("claude-color");
    expect(k2).toBe("box_3");
    expect(resolveIconKey(k1)?.kind).toBe("brand");
    expect(resolveIconKey(k2)).toEqual({ kind: "fallback", name: "box_3" });
    expect(resolveIconKey("cloud")).toEqual({ kind: "fallback", name: "cloud" });
    expect(resolveIconKey("not-exist")).toBeUndefined();
  });
});

describe("BrandIcon 组件", () => {
  it("内联渲染 SVG 并设 aria-hidden，无 title 且同页渐变 id 隔离", () => {
    const { container } = render(
      <>
        <BrandIcon iconKey="gemini-color" size="md" />
        <BrandIcon iconKey="gemini-color" size="sm" />
        <BrandIcon iconKey="box_3" size="sm" />
      </>,
    );
    const spans = container.querySelectorAll("span.brand-icon");
    expect(spans).toHaveLength(3);
    expect(spans[0]?.getAttribute("aria-hidden")).toBe("true");
    expect(spans[0]?.classList.contains("brand-icon-md")).toBe(true);
    expect(spans[1]?.classList.contains("brand-icon-sm")).toBe(true);
    expect(spans[2]?.classList.contains("is-fallback")).toBe(true);
    expect(container.querySelector("title")).toBeNull();
    expect(container.querySelector("[title]")).toBeNull();
    expect(container.textContent).toBe("");

    const grads = container.querySelectorAll("linearGradient");
    expect(grads.length).toBeGreaterThanOrEqual(2);
    const ids = Array.from(grads).map((g) => g.getAttribute("id"));
    expect(new Set(ids).size).toBe(ids.length);
  });
});
