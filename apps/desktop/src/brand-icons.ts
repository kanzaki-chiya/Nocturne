/// <reference types="vite/client" />
import ai302Svg from "./brand-icons/ai302.svg?raw";
import aihubmixSvg from "./brand-icons/aihubmix.svg?raw";
import anthropicSvg from "./brand-icons/anthropic.svg?raw";
import antigravitySvg from "./brand-icons/antigravity.svg?raw";
import baiducloudSvg from "./brand-icons/baiducloud.svg?raw";
import bailianSvg from "./brand-icons/bailian.svg?raw";
import cerebrasSvg from "./brand-icons/cerebras.svg?raw";
import claudeColorSvg from "./brand-icons/claude-color.svg?raw";
import clineSvg from "./brand-icons/cline.svg?raw";
import commandcodeSvg from "./brand-icons/commandcode.svg?raw";
import deepseekColorSvg from "./brand-icons/deepseek-color.svg?raw";
import deepseekSvg from "./brand-icons/deepseek.svg?raw";
import doubaoColorSvg from "./brand-icons/doubao-color.svg?raw";
import fireworksSvg from "./brand-icons/fireworks.svg?raw";
import geminiColorSvg from "./brand-icons/gemini-color.svg?raw";
import gemmaColorSvg from "./brand-icons/gemma-color.svg?raw";
import githubSvg from "./brand-icons/github.svg?raw";
import githubcopilotSvg from "./brand-icons/githubcopilot.svg?raw";
import gmicloudSvg from "./brand-icons/gmicloud.svg?raw";
import grokSvg from "./brand-icons/grok.svg?raw";
import groqSvg from "./brand-icons/groq.svg?raw";
import huaweicloudSvg from "./brand-icons/huaweicloud.svg?raw";
import hunyuanColorSvg from "./brand-icons/hunyuan-color.svg?raw";
import kilocodeSvg from "./brand-icons/kilocode.svg?raw";
import kimiSvg from "./brand-icons/kimi.svg?raw";
import kiroSvg from "./brand-icons/kiro.svg?raw";
import lmstudioSvg from "./brand-icons/lmstudio.svg?raw";
import longcatSvg from "./brand-icons/longcat.svg?raw";
import metaColorSvg from "./brand-icons/meta-color.svg?raw";
import minimaxColorSvg from "./brand-icons/minimax-color.svg?raw";
import minimaxSvg from "./brand-icons/minimax.svg?raw";
import mistralColorSvg from "./brand-icons/mistral-color.svg?raw";
import modelscopeSvg from "./brand-icons/modelscope.svg?raw";
import moonshotSvg from "./brand-icons/moonshot.svg?raw";
import nousresearchSvg from "./brand-icons/nousresearch.svg?raw";
import nvidiaSvg from "./brand-icons/nvidia.svg?raw";
import ollamaSvg from "./brand-icons/ollama.svg?raw";
import openaiSvg from "./brand-icons/openai.svg?raw";
import opencodeSvg from "./brand-icons/opencode.svg?raw";
import openrouterSvg from "./brand-icons/openrouter.svg?raw";
import qwenColorSvg from "./brand-icons/qwen-color.svg?raw";
import siliconcloudSvg from "./brand-icons/siliconcloud.svg?raw";
import stepfunColorSvg from "./brand-icons/stepfun-color.svg?raw";
import tencentcloudSvg from "./brand-icons/tencentcloud.svg?raw";
import togetherSvg from "./brand-icons/together.svg?raw";
import vercelSvg from "./brand-icons/vercel.svg?raw";
import volcengineSvg from "./brand-icons/volcengine.svg?raw";
import wenxinColorSvg from "./brand-icons/wenxin-color.svg?raw";
import xiaomimimoSvg from "./brand-icons/xiaomimimo.svg?raw";
import zaiSvg from "./brand-icons/zai.svg?raw";

const BRAND_ICON_SVGS = {
  ai302: ai302Svg,
  aihubmix: aihubmixSvg,
  anthropic: anthropicSvg,
  antigravity: antigravitySvg,
  baiducloud: baiducloudSvg,
  bailian: bailianSvg,
  cerebras: cerebrasSvg,
  "claude-color": claudeColorSvg,
  cline: clineSvg,
  commandcode: commandcodeSvg,
  deepseek: deepseekSvg,
  "deepseek-color": deepseekColorSvg,
  "doubao-color": doubaoColorSvg,
  fireworks: fireworksSvg,
  "gemini-color": geminiColorSvg,
  "gemma-color": gemmaColorSvg,
  github: githubSvg,
  githubcopilot: githubcopilotSvg,
  gmicloud: gmicloudSvg,
  grok: grokSvg,
  groq: groqSvg,
  huaweicloud: huaweicloudSvg,
  "hunyuan-color": hunyuanColorSvg,
  kilocode: kilocodeSvg,
  kimi: kimiSvg,
  kiro: kiroSvg,
  lmstudio: lmstudioSvg,
  longcat: longcatSvg,
  "meta-color": metaColorSvg,
  minimax: minimaxSvg,
  "minimax-color": minimaxColorSvg,
  "mistral-color": mistralColorSvg,
  modelscope: modelscopeSvg,
  moonshot: moonshotSvg,
  nousresearch: nousresearchSvg,
  nvidia: nvidiaSvg,
  ollama: ollamaSvg,
  openai: openaiSvg,
  opencode: opencodeSvg,
  openrouter: openrouterSvg,
  "qwen-color": qwenColorSvg,
  siliconcloud: siliconcloudSvg,
  "stepfun-color": stepfunColorSvg,
  tencentcloud: tencentcloudSvg,
  together: togetherSvg,
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
  google: "gemini-color",
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
  "ollama-cloud": "ollama",
  lmstudio: "lmstudio",
  "lm-studio": "lmstudio",
  siliconcloud: "siliconcloud",
  siliconflow: "siliconcloud",
  "siliconflow-cn": "siliconcloud",
  "siliconflow-intl": "siliconcloud",
  volcengine: "volcengine",
  "volcengine-api": "volcengine",
  bailian: "bailian",
  "bailian-token-plan": "bailian",
  "alibaba-token-plan": "bailian",
  dashscope: "bailian",
  qwen: "qwen-color",
  "qwen-cn": "qwen-color",
  "qwen-token-plan": "qwen-color",
  "qwencloud-token-plan": "qwen-color",
  "qwencloud-ap-southeast-1": "qwen-color",
  "qwencloud-us-east-1": "qwen-color",
  "qwencloud-eu-central-1": "qwen-color",
  "qwencloud-ap-northeast-1": "qwen-color",
  "qwencloud-cn-hongkong": "qwen-color",
  "qwencloud-cn-beijing": "qwen-color",
  moonshot: "moonshot",
  "moonshot-cn": "moonshot",
  "kimi-code": "kimi",
  "kimi-code-cn": "kimi",
  zhipu: "zai",
  "zhipu-api": "zai",
  "zhipu-coding": "zai",
  zai: "zai",
  "zai-api": "zai",
  "zai-coding": "zai",
  bigmodel: "zai",
  minimax: "minimax",
  "minimax-cn": "minimax",
  "stepfun-plan": "stepfun-color",
  "stepfun-api": "stepfun-color",
  "stepfun-cn-plan": "stepfun-color",
  "stepfun-cn-api": "stepfun-color",
  "xiaomi-plan-cn": "xiaomimimo",
  "xiaomi-plan-sgp": "xiaomimimo",
  "xiaomi-plan-ams": "xiaomimimo",
  "xiaomi-api": "xiaomimimo",
  longcat: "longcat",
  "baidu-qianfan-api": "baiducloud",
  "tencent-cloud-plan": "tencentcloud",
  "tencent-cloud-cn": "tencentcloud",
  "tencent-cloud-intl": "tencentcloud",
  "tencent-cloud-enterprise-intl": "tencentcloud",
  "huaweicloud-plan": "huaweicloud",
  "huaweicloud-api": "huaweicloud",
  mistral: "mistral-color",
  nous: "nousresearch",
  kiro: "kiro",
  antigravity: "antigravity",
  "agy-cli": "antigravity",
  groq: "groq",
  cerebras: "cerebras",
  github: "github",
  githubcopilot: "githubcopilot",
  "github-copilot": "githubcopilot",
  vercel: "vercel",
  gmicloud: "gmicloud",
  clinepass: "cline",
  kilo: "kilocode",
  commandcode: "commandcode",
  together: "together",
  fireworks: "fireworks",
  nvidia: "nvidia",
  modelscope: "modelscope",
  aihubmix: "aihubmix",
  "302ai": "ai302",
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
