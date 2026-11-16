/// <reference types="vite/client" />
import anthropicSvg from "./brand-icons/anthropic.svg?raw";
import antigravitySvg from "./brand-icons/antigravity.svg?raw";
import bailianSvg from "./brand-icons/bailian.svg?raw";
import cerebrasSvg from "./brand-icons/cerebras.svg?raw";
import claudeColorSvg from "./brand-icons/claude-color.svg?raw";
import deepseekColorSvg from "./brand-icons/deepseek-color.svg?raw";
import deepseekSvg from "./brand-icons/deepseek.svg?raw";
import doubaoColorSvg from "./brand-icons/doubao-color.svg?raw";
import geminiColorSvg from "./brand-icons/gemini-color.svg?raw";
import gemmaColorSvg from "./brand-icons/gemma-color.svg?raw";
import githubSvg from "./brand-icons/github.svg?raw";
import githubcopilotSvg from "./brand-icons/githubcopilot.svg?raw";
import grokSvg from "./brand-icons/grok.svg?raw";
import groqSvg from "./brand-icons/groq.svg?raw";
import hunyuanColorSvg from "./brand-icons/hunyuan-color.svg?raw";
import kimiSvg from "./brand-icons/kimi.svg?raw";
import kiroSvg from "./brand-icons/kiro.svg?raw";
import lmstudioSvg from "./brand-icons/lmstudio.svg?raw";
import longcatSvg from "./brand-icons/longcat.svg?raw";
import metaColorSvg from "./brand-icons/meta-color.svg?raw";
import minimaxColorSvg from "./brand-icons/minimax-color.svg?raw";
import minimaxSvg from "./brand-icons/minimax.svg?raw";
import mistralColorSvg from "./brand-icons/mistral-color.svg?raw";
import moonshotSvg from "./brand-icons/moonshot.svg?raw";
import ollamaSvg from "./brand-icons/ollama.svg?raw";
import openaiSvg from "./brand-icons/openai.svg?raw";
import opencodeSvg from "./brand-icons/opencode.svg?raw";
import openrouterSvg from "./brand-icons/openrouter.svg?raw";
import qwenColorSvg from "./brand-icons/qwen-color.svg?raw";
import siliconcloudSvg from "./brand-icons/siliconcloud.svg?raw";
import stepfunColorSvg from "./brand-icons/stepfun-color.svg?raw";
import vercelSvg from "./brand-icons/vercel.svg?raw";
import volcengineSvg from "./brand-icons/volcengine.svg?raw";
import wenxinColorSvg from "./brand-icons/wenxin-color.svg?raw";
import xiaomimimoSvg from "./brand-icons/xiaomimimo.svg?raw";
import zaiSvg from "./brand-icons/zai.svg?raw";

const BRAND_ICON_SVGS = {
  anthropic: anthropicSvg,
  antigravity: antigravitySvg,
  bailian: bailianSvg,
  cerebras: cerebrasSvg,
  "claude-color": claudeColorSvg,
  deepseek: deepseekSvg,
  "deepseek-color": deepseekColorSvg,
  "doubao-color": doubaoColorSvg,
  "gemini-color": geminiColorSvg,
  "gemma-color": gemmaColorSvg,
  github: githubSvg,
  githubcopilot: githubcopilotSvg,
  grok: grokSvg,
  groq: groqSvg,
  "hunyuan-color": hunyuanColorSvg,
  kimi: kimiSvg,
  kiro: kiroSvg,
  lmstudio: lmstudioSvg,
  longcat: longcatSvg,
  "meta-color": metaColorSvg,
  minimax: minimaxSvg,
  "minimax-color": minimaxColorSvg,
  "mistral-color": mistralColorSvg,
  moonshot: moonshotSvg,
  ollama: ollamaSvg,
  openai: openaiSvg,
  opencode: opencodeSvg,
  openrouter: openrouterSvg,
  "qwen-color": qwenColorSvg,
  siliconcloud: siliconcloudSvg,
  "stepfun-color": stepfunColorSvg,
  vercel: vercelSvg,
  volcengine: volcengineSvg,
  "wenxin-color": wenxinColorSvg,
  xiaomimimo: xiaomimimoSvg,
  zai: zaiSvg,
} as const satisfies Record<string, string>;

export type BrandIconName = keyof typeof BRAND_ICON_SVGS;
export type FallbackIconName = "box_3" | "cloud";
export type BrandIconKey = BrandIconName | FallbackIconName;

export type BrandIconResult =
  | { kind: "brand"; name: BrandIconName; svg: string }
  | { kind: "fallback"; name: FallbackIconName };

const PROVIDER_ICON_MAP: Readonly<Record<string, BrandIconName>> = {
  chatgpt: "openai",
  openai: "openai",
  anthropic: "anthropic",
  grok: "grok",
  "grok-cli": "grok",
  xai: "grok",
  deepseek: "deepseek",
  openrouter: "openrouter",
  "opencode-zen": "opencode",
  "opencode-go": "opencode",
  opencode: "opencode",
  ollama: "ollama",
  lmstudio: "lmstudio",
  "lm-studio": "lmstudio",
  siliconcloud: "siliconcloud",
  siliconflow: "siliconcloud",
  volcengine: "volcengine",
  bailian: "bailian",
  dashscope: "bailian",
  moonshot: "moonshot",
  zhipu: "zai",
  zai: "zai",
  bigmodel: "zai",
  minimax: "minimax",
  kiro: "kiro",
  antigravity: "antigravity",
  "agy-cli": "antigravity",
  groq: "groq",
  cerebras: "cerebras",
  github: "github",
  githubcopilot: "githubcopilot",
  "github-copilot": "githubcopilot",
  vercel: "vercel",
};

const MODEL_ICON_RULES: readonly { readonly pattern: RegExp; readonly icon: BrandIconName }[] = [
  { pattern: /claude/, icon: "claude-color" },
  { pattern: /gemma/, icon: "gemma-color" },
  { pattern: /gemini/, icon: "gemini-color" },
  { pattern: /gpt|codex|^o\d/, icon: "openai" },
  { pattern: /grok/, icon: "grok" },
  { pattern: /deepseek/, icon: "deepseek-color" },
  { pattern: /qwen|qwq/, icon: "qwen-color" },
  { pattern: /kimi|moonshot/, icon: "kimi" },
  { pattern: /glm/, icon: "zai" },
  { pattern: /minimax/, icon: "minimax-color" },
  { pattern: /mimo/, icon: "xiaomimimo" },
  { pattern: /doubao/, icon: "doubao-color" },
  { pattern: /mistral|codestral|devstral/, icon: "mistral-color" },
  { pattern: /llama/, icon: "meta-color" },
  { pattern: /hunyuan/, icon: "hunyuan-color" },
  { pattern: /ernie/, icon: "wenxin-color" },
  { pattern: /step/, icon: "stepfun-color" },
  { pattern: /longcat/, icon: "longcat" },
];

function brandResult(name: BrandIconName): BrandIconResult {
  return { kind: "brand", name, svg: BRAND_ICON_SVGS[name].trim() };
}

/** 按服务商 ID 或预设 ID 解析品牌图标；无匹配时回退到通用服务商图标 cloud。 */
export function providerIcon(id: string): BrandIconResult {
  const key = id.trim().toLowerCase();
  const brand = PROVIDER_ICON_MAP[key];
  if (brand !== undefined) return brandResult(brand);
  return { kind: "fallback", name: "cloud" };
}

/** 按模型引用解析品牌图标：先按模型名最后一段有序匹配，未命中回退服务商图标，仍无回退 box_3。 */
export function modelIcon(ref: { provider: string; model: string }): BrandIconResult {
  const tail = (ref.model.split("/").pop() ?? ref.model).trim().toLowerCase();
  for (const rule of MODEL_ICON_RULES) {
    if (rule.pattern.test(tail)) return brandResult(rule.icon);
  }
  const byProvider = providerIcon(ref.provider);
  if (byProvider.kind === "brand") return byProvider;
  return { kind: "fallback", name: "box_3" };
}

/** 返回给 ChoiceOption / ChoiceControl 使用的纯字符串图标键。 */
export function modelIconKey(ref: { provider: string; model: string }): BrandIconKey {
  return modelIcon(ref).name;
}

/** 将 ChoiceOption / ChoiceControl 携带的字符串图标键还原为渲染结果。 */
export function resolveIconKey(key: string): BrandIconResult | undefined {
  if (key === "box_3" || key === "cloud") {
    return { kind: "fallback", name: key };
  }
  if (Object.hasOwn(BRAND_ICON_SVGS, key)) {
    return brandResult(key as BrandIconName);
  }
  return undefined;
}
