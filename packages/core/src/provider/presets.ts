/**
 * 服务商预设（provider-setup.md 第 5 节）：向导默认值用的纯数据。
 * 写进 providers.json 的是完整条目；预设更新不会改变已写入的条目。
 * 新增预设门槛：服务地址与协议兼容性有官方文档可查，并实测过连接。
 */
import type { AuthResolver, ProviderAuth, UpstreamModelInfo } from "./types.js";
import { createAuthResolver } from "./auth.js";
import { ProviderAuthError } from "./errors.js";
import { hasStaticHeader, nocturneUserAgent } from "./http.js";
import { GROK_PROXY_HEADERS } from "./grok-proxy.js";

export type ProviderPresetGroup = "vendor" | "relay" | "local" | "custom";

export interface ProviderPreset {
  /** 预设标识（向导内部使用；"custom-*" 表示手动填写地址的预设） */
  id: string;
  /** 显示名（向导左侧栏 ○ 列表的标签） */
  label: string;
  /** 选择页分组 */
  group: ProviderPresetGroup;
  type: "openai-compatible" | "anthropic";
  /** 建议的服务商 id（用户可改） */
  defaultName: string;
  /** 建议的 baseURL；undefined = 适配器内置端点（Anthropic）或用户必填 */
  baseURL?: string | undefined;
  /** 建议的环境变量名（凭据走环境变量时的默认值；用户可改） */
  defaultKeyEnv?: string | undefined;
  /** 本地等免密钥服务：向导允许不填 API Key 完成添加 */
  keyOptional?: boolean | undefined;
  auth?: ProviderAuth | undefined;
  headers?: Record<string, string> | undefined;
  modelHeader?: string | undefined;
  login?: "openrouter" | "openai-siwc" | "xai-oauth2" | undefined;
  /** 模型列表能否经 GET /models 自动获取 */
  fetchableModels: boolean;
  /**
   * 该服务商的思考参数格式（ADR-0018）：写入条目的 thinking.format。
   * "openrouter" → reasoning: { effort }；缺省 → openai（reasoning_effort）。
   */
  thinkingFormat?: "openai" | "openrouter" | undefined;
  /** 密钥获取入口（控制台 URL）：向导密钥步骤的说明小字提示来源 */
  keyHint?: string | undefined;
  /**
   * 会话标识请求头名（ADR-0031 §5）：预设写死的服务商要求
   * （如 OpenCode 的 x-opencode-session），原样写入条目。
   */
  sessionHeader?: string | undefined;
  /**
   * models.dev 服务商键（ADR-0031 §5）：预设写死，原样写入条目；
   * 启用 models.dev 服务商层的逐模型接口声明参与合并。
   */
  modelsDevProvider?: string | undefined;
  modelsDevPricing?: string | undefined;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  // ── vendor（现有预设在前，其余按 magpie 原顺序） ──
  {
    id: "chatgpt",
    label: "ChatGPT",
    group: "vendor",
    type: "openai-compatible",
    defaultName: "chatgpt",
    baseURL: "https://api.openai.com/v1",
    auth: { kind: "openai-siwc" },
    login: "openai-siwc",
    modelsDevProvider: "openai",
    modelsDevPricing: "openai",
    fetchableModels: true,
  },
  {
    id: "grok",
    label: "Grok",
    group: "vendor",
    type: "openai-compatible",
    defaultName: "grok",
    baseURL: "https://cli-chat-proxy.grok.com/v1",
    headers: { ...GROK_PROXY_HEADERS },
    modelHeader: "x-grok-model-override",
    auth: { kind: "xai-oauth2" },
    login: "xai-oauth2",
    modelsDevPricing: "xai",
    fetchableModels: true,
  },
  {
    id: "grok-cli",
    label: "Grok CLI",
    group: "vendor",
    type: "openai-compatible",
    defaultName: "grok-cli",
    modelsDevPricing: "xai",
    baseURL: "https://cli-chat-proxy.grok.com/v1",
    headers: { ...GROK_PROXY_HEADERS },
    modelHeader: "x-grok-model-override",
    auth: {
      kind: "external-file",
      path: "~/.grok/auth.json",
      keyPath: ["https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828", "key"],
      renewHint: "grok login",
    },
    fetchableModels: true,
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    group: "vendor",
    type: "openai-compatible",
    defaultName: "deepseek",
    modelsDevPricing: "deepseek",
    baseURL: "https://api.deepseek.com/v1",
    defaultKeyEnv: "DEEPSEEK_API_KEY",
    fetchableModels: true,
    keyHint: "https://platform.deepseek.com/api_keys",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    group: "vendor",
    type: "anthropic",
    defaultName: "anthropic",
    modelsDevPricing: "anthropic",
    defaultKeyEnv: "ANTHROPIC_API_KEY",
    fetchableModels: true,
    keyHint: "https://console.anthropic.com/settings/keys",
  },
  {
    id: "openai",
    label: "OpenAI",
    group: "vendor",
    type: "openai-compatible",
    defaultName: "openai",
    baseURL: "https://api.openai.com/v1",
    defaultKeyEnv: "OPENAI_API_KEY",
    modelsDevPricing: "openai",
    fetchableModels: true,
    keyHint: "https://platform.openai.com/api-keys",
  },
  {
    id: "google",
    label: "Google Gemini",
    group: "vendor",
    type: "openai-compatible",
    defaultName: "google",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultKeyEnv: "GEMINI_API_KEY",
    modelsDevPricing: "google",
    fetchableModels: true,
    keyHint: "https://aistudio.google.com/apikey",
  },
  {
    id: "xai",
    label: "xAI",
    group: "vendor",
    type: "openai-compatible",
    defaultName: "xai",
    baseURL: "https://api.x.ai/v1",
    defaultKeyEnv: "XAI_API_KEY",
    modelsDevPricing: "xai",
    fetchableModels: true,
    keyHint: "https://console.x.ai",
  },
  {
    id: "moonshot",
    label: "Kimi",
    group: "vendor",
    type: "openai-compatible",
    defaultName: "moonshot",
    baseURL: "https://api.moonshot.ai/v1",
    defaultKeyEnv: "MOONSHOT_API_KEY",
    modelsDevPricing: "moonshotai",
    fetchableModels: true,
    keyHint: "https://platform.kimi.ai/console/api-keys",
  },
  {
    id: "moonshot-cn",
    label: "Kimi · 国内",
    group: "vendor",
    type: "openai-compatible",
    defaultName: "moonshot-cn",
    baseURL: "https://api.moonshot.cn/v1",
    defaultKeyEnv: "MOONSHOT_API_KEY",
    modelsDevPricing: "moonshotai",
    fetchableModels: true,
    keyHint: "https://platform.kimi.com/console/api-keys",
  },
  {
    id: "kimi-code",
    label: "Kimi Code",
    group: "vendor",
    type: "openai-compatible",
    defaultName: "kimi-code",
    baseURL: "https://api.kimi.ai/coding/v1",
    defaultKeyEnv: "KIMI_CODE_API_KEY",
    modelsDevPricing: "kimi-code-plan-global",
    fetchableModels: true,
    keyHint: "https://www.kimi.ai/code/console",
  },
  {
    id: "kimi-code-cn",
    label: "Kimi Code · 国内",
    group: "vendor",
    type: "openai-compatible",
    defaultName: "kimi-code-cn",
    baseURL: "https://api.kimi.com/coding/v1",
    defaultKeyEnv: "KIMI_CODE_API_KEY",
    modelsDevPricing: "kimi-code-plan-cn",
    fetchableModels: true,
    keyHint: "https://www.kimi.com/code/console",
  },
  {
    id: "zhipu-api",
    label: "智谱 GLM · 按量计费",
    group: "vendor",
    type: "openai-compatible",
    defaultName: "zhipu-api",
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
    defaultKeyEnv: "ZHIPU_API_KEY",
    modelsDevPricing: "zhipuai",
    fetchableModels: true,
    keyHint: "https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys",
  },
  {
    id: "zhipu-coding",
    label: "智谱 GLM · 编码套餐",
    group: "vendor",
    type: "openai-compatible",
    defaultName: "zhipu-coding",
    baseURL: "https://open.bigmodel.cn/api/coding/paas/v4",
    defaultKeyEnv: "ZHIPU_API_KEY",
    modelsDevPricing: "zhipuai",
    fetchableModels: true,
    keyHint: "https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys",
  },
  {
    id: "zai-api",
    label: "Z.ai · 按量计费",
    group: "vendor",
    type: "openai-compatible",
    defaultName: "zai-api",
    baseURL: "https://api.z.ai/api/paas/v4",
    defaultKeyEnv: "ZAI_API_KEY",
    modelsDevPricing: "zhipuai",
    fetchableModels: true,
    keyHint: "https://z.ai/manage-apikey/apikey-list",
  },
  {
    id: "zai-coding",
    label: "Z.ai · 编码套餐",
    group: "vendor",
    type: "openai-compatible",
    defaultName: "zai-coding",
    baseURL: "https://api.z.ai/api/coding/paas/v4",
    defaultKeyEnv: "ZAI_API_KEY",
    modelsDevPricing: "zhipuai",
    fetchableModels: true,
    keyHint: "https://z.ai/manage-apikey/apikey-list",
  },
  {
    id: "minimax",
    label: "MiniMax",
    group: "vendor",
    type: "openai-compatible",
    defaultName: "minimax",
    baseURL: "https://api.minimax.io/v1",
    defaultKeyEnv: "MINIMAX_API_KEY",
    modelsDevPricing: "minimax",
    fetchableModels: true,
    keyHint: "https://platform.minimax.io/user-center/basic-information/interface-key",
  },
  {
    id: "minimax-cn",
    label: "MiniMax · 国内",
    group: "vendor",
    type: "openai-compatible",
    defaultName: "minimax-cn",
    baseURL: "https://api.minimaxi.com/v1",
    defaultKeyEnv: "MINIMAX_API_KEY",
    modelsDevPricing: "minimax",
    fetchableModels: true,
    keyHint: "https://platform.minimaxi.com/user-center/basic-information/interface-key",
  },
  {
    id: "stepfun-plan",
    label: "StepFun · Step Plan",
    group: "vendor",
    type: "openai-compatible",
    defaultName: "stepfun-plan",
    baseURL: "https://api.stepfun.ai/step_plan/v1",
    defaultKeyEnv: "STEPFUN_API_KEY",
    modelsDevPricing: "stepfun-ai-step-plan",
    fetchableModels: true,
    keyHint: "https://platform.stepfun.ai/interface-key",
  },
  {
    id: "stepfun-api",
    label: "StepFun · 按量计费",
    group: "vendor",
    type: "openai-compatible",
    defaultName: "stepfun-api",
    baseURL: "https://api.stepfun.ai/v1",
    defaultKeyEnv: "STEPFUN_API_KEY",
    modelsDevPricing: "stepfun-ai-step-plan",
    fetchableModels: true,
    keyHint: "https://platform.stepfun.ai/interface-key",
  },
  {
    id: "stepfun-cn-plan",
    label: "StepFun · 国内 · Step Plan",
    group: "vendor",
    type: "openai-compatible",
    defaultName: "stepfun-cn-plan",
    baseURL: "https://api.stepfun.com/step_plan/v1",
    defaultKeyEnv: "STEPFUN_API_KEY",
    modelsDevPricing: "stepfun-step-plan",
    fetchableModels: true,
    keyHint: "https://platform.stepfun.com/interface-key",
  },
  {
    id: "stepfun-cn-api",
    label: "StepFun · 国内 · 按量计费",
    group: "vendor",
    type: "openai-compatible",
    defaultName: "stepfun-cn-api",
    baseURL: "https://api.stepfun.com/v1",
    defaultKeyEnv: "STEPFUN_API_KEY",
    modelsDevPricing: "stepfun-step-plan",
    fetchableModels: true,
    keyHint: "https://platform.stepfun.com/interface-key",
  },
  {
    id: "xiaomi-plan-cn",
    label: "Xiaomi MiMo · 套餐 · 国内",
    group: "vendor",
    type: "openai-compatible",
    defaultName: "xiaomi-plan-cn",
    baseURL: "https://token-plan-cn.xiaomimimo.com/v1",
    defaultKeyEnv: "XIAOMI_API_KEY",
    modelsDevPricing: "xiaomi-token-plan-cn",
    fetchableModels: true,
    keyHint: "https://platform.xiaomimimo.com/token-plan",
  },
  {
    id: "xiaomi-plan-sgp",
    label: "Xiaomi MiMo · 套餐 · 新加坡",
    group: "vendor",
    type: "openai-compatible",
    defaultName: "xiaomi-plan-sgp",
    baseURL: "https://token-plan-sgp.xiaomimimo.com/v1",
    defaultKeyEnv: "XIAOMI_API_KEY",
    modelsDevPricing: "xiaomi-token-plan-sgp",
    fetchableModels: true,
    keyHint: "https://platform.xiaomimimo.com/token-plan",
  },
  {
    id: "xiaomi-plan-ams",
    label: "Xiaomi MiMo · 套餐 · 欧洲",
    group: "vendor",
    type: "openai-compatible",
    defaultName: "xiaomi-plan-ams",
    baseURL: "https://token-plan-ams.xiaomimimo.com/v1",
    defaultKeyEnv: "XIAOMI_API_KEY",
    modelsDevPricing: "xiaomi-token-plan-ams",
    fetchableModels: true,
    keyHint: "https://platform.xiaomimimo.com/token-plan",
  },
  {
    id: "xiaomi-api",
    label: "Xiaomi MiMo · 按量计费",
    group: "vendor",
    type: "openai-compatible",
    defaultName: "xiaomi-api",
    baseURL: "https://api.xiaomimimo.com/v1",
    defaultKeyEnv: "XIAOMI_API_KEY",
    modelsDevPricing: "xiaomi",
    fetchableModels: true,
    keyHint: "https://platform.xiaomimimo.com/token-plan",
  },
  {
    id: "longcat",
    label: "LongCat",
    group: "vendor",
    type: "openai-compatible",
    defaultName: "longcat",
    baseURL: "https://api.longcat.chat/openai/v1",
    defaultKeyEnv: "LONGCAT_API_KEY",
    modelsDevPricing: "longcat",
    fetchableModels: true,
    keyHint: "https://longcat.chat/platform/api_keys",
  },
  {
    id: "baidu-qianfan-api",
    label: "Baidu Qianfan · 按量计费",
    group: "vendor",
    type: "openai-compatible",
    defaultName: "baidu-qianfan-api",
    baseURL: "https://qianfan.baidubce.com/v2",
    defaultKeyEnv: "BAIDU_QIANFAN_API_KEY",
    fetchableModels: true,
    keyHint: "https://console.bce.baidu.com/iam/#/iam/apikey/list",
  },
  {
    id: "tencent-cloud-plan",
    label: "Tencent Cloud · 套餐 · 国内",
    group: "vendor",
    type: "openai-compatible",
    defaultName: "tencent-cloud-plan",
    baseURL: "https://tokenhub.tencentmaas.com/plan/v3",
    defaultKeyEnv: "TENCENT_CLOUD_API_KEY",
    fetchableModels: true,
    keyHint: "https://console.cloud.tencent.com/tokenhub/tokenplan",
  },
  {
    id: "tencent-cloud-cn",
    label: "Tencent Cloud · 按量计费 · 国内",
    group: "vendor",
    type: "openai-compatible",
    defaultName: "tencent-cloud-cn",
    baseURL: "https://tokenhub.tencentmaas.com/v1",
    defaultKeyEnv: "TENCENT_CLOUD_API_KEY",
    modelsDevPricing: "tencent-tokenhub",
    fetchableModels: true,
    keyHint: "https://console.cloud.tencent.com/tokenhub/apikey",
  },
  {
    id: "tencent-cloud-intl",
    label: "Tencent Cloud · 按量计费 · 国际",
    group: "vendor",
    type: "openai-compatible",
    defaultName: "tencent-cloud-intl",
    baseURL: "https://tokenhub-intl.tencentmaas.com/v1",
    defaultKeyEnv: "TENCENT_CLOUD_API_KEY",
    modelsDevPricing: "tencent-tokenhub",
    fetchableModels: true,
    keyHint: "https://console.tencentcloud.com/tokenhub/apikey",
  },
  {
    id: "tencent-cloud-enterprise-intl",
    label: "Tencent Cloud · 企业套餐 · 国际",
    group: "vendor",
    type: "openai-compatible",
    defaultName: "tencent-cloud-enterprise-intl",
    baseURL: "https://tokenhub-intl.tencentmaas.com/plan/v3",
    defaultKeyEnv: "TENCENT_CLOUD_API_KEY",
    fetchableModels: true,
    keyHint: "https://console.tencentcloud.com/tokenhub/tokenplan",
  },
  {
    id: "huaweicloud-plan",
    label: "Huawei Cloud MaaS · Token Plan",
    group: "vendor",
    type: "openai-compatible",
    defaultName: "huaweicloud-plan",
    baseURL: "https://api.modelarts-maas.com/plan/v2",
    defaultKeyEnv: "HUAWEICLOUD_API_KEY",
    fetchableModels: true,
    keyHint: "https://console.huaweicloud.com/modelarts/?#/model-studio/authmanage",
  },
  {
    id: "huaweicloud-api",
    label: "Huawei Cloud MaaS · 按量计费",
    group: "vendor",
    type: "openai-compatible",
    defaultName: "huaweicloud-api",
    baseURL: "https://api.modelarts-maas.com/openai/v1",
    defaultKeyEnv: "HUAWEICLOUD_API_KEY",
    fetchableModels: true,
    keyHint: "https://console.huaweicloud.com/modelarts/?#/model-studio/authmanage",
  },
  {
    id: "volcengine-api",
    label: "Volcengine Ark · 按量计费",
    group: "vendor",
    type: "openai-compatible",
    defaultName: "volcengine-api",
    baseURL: "https://ark.cn-beijing.volces.com/api/v3",
    defaultKeyEnv: "VOLCENGINE_API_KEY",
    fetchableModels: true,
    keyHint: "https://ark.volcengine.com/region:cn-beijing/apikey",
  },
  {
    id: "qwen",
    label: "Qwen",
    group: "vendor",
    type: "openai-compatible",
    defaultName: "qwen",
    baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    defaultKeyEnv: "QWEN_API_KEY",
    modelsDevPricing: "alibaba",
    fetchableModels: true,
    keyHint: "https://modelstudio.console.alibabacloud.com/?tab=playground#/api-key",
  },
  {
    id: "qwen-cn",
    label: "Qwen · 国内",
    group: "vendor",
    type: "openai-compatible",
    defaultName: "qwen-cn",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultKeyEnv: "QWEN_API_KEY",
    modelsDevPricing: "alibaba",
    fetchableModels: true,
    keyHint: "https://bailian.console.aliyun.com/?tab=model#/api-key",
  },
  {
    id: "qwen-token-plan",
    label: "Qwen Token Plan",
    group: "vendor",
    type: "openai-compatible",
    defaultName: "qwen-token-plan",
    baseURL: "https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1",
    defaultKeyEnv: "QWEN_API_KEY",
    fetchableModels: true,
    keyHint: "https://platform.qianwenai.com/home/analytics/token-plan/individual",
  },
  {
    id: "bailian-token-plan",
    label: "Bailian Token Plan",
    group: "vendor",
    type: "openai-compatible",
    defaultName: "bailian-token-plan",
    baseURL: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    defaultKeyEnv: "BAILIAN_API_KEY",
    fetchableModels: true,
    keyHint: "https://bailian.console.aliyun.com/cn-beijing/subscription/token-plan/personal",
  },
  {
    id: "alibaba-token-plan",
    label: "Alibaba Cloud Token Plan",
    group: "vendor",
    type: "openai-compatible",
    defaultName: "alibaba-token-plan",
    baseURL: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    defaultKeyEnv: "ALIBABA_API_KEY",
    fetchableModels: true,
    keyHint:
      "https://modelstudio.console.alibabacloud.com/ap-southeast-1/?tab=globalset#/efm/token_plan",
  },
  {
    id: "qwencloud-token-plan",
    label: "Qwen Cloud Token Plan",
    group: "vendor",
    type: "openai-compatible",
    defaultName: "qwencloud-token-plan",
    baseURL: "https://token-plan.maas.qwencloudapi.com/compatible-mode/v1",
    defaultKeyEnv: "QWENCLOUD_API_KEY",
    fetchableModels: true,
    keyHint: "https://home.qwencloud.com/analytics/token-plan/individual",
  },
  {
    id: "qwencloud-ap-southeast-1",
    label: "Qwen Cloud · 新加坡",
    group: "vendor",
    type: "openai-compatible",
    defaultName: "qwencloud-ap-southeast-1",
    baseURL: "https://ap-southeast-1.maas.qwencloudapi.com/compatible-mode/v1",
    defaultKeyEnv: "QWENCLOUD_API_KEY",
    modelsDevPricing: "alibaba",
    fetchableModels: true,
    keyHint: "https://home.qwencloud.com/api-keys",
  },
  {
    id: "qwencloud-us-east-1",
    label: "Qwen Cloud · 美东",
    group: "vendor",
    type: "openai-compatible",
    defaultName: "qwencloud-us-east-1",
    baseURL: "https://us-east-1.maas.qwencloudapi.com/compatible-mode/v1",
    defaultKeyEnv: "QWENCLOUD_API_KEY",
    modelsDevPricing: "alibaba",
    fetchableModels: true,
    keyHint: "https://home.qwencloud.com/api-keys",
  },
  {
    id: "qwencloud-eu-central-1",
    label: "Qwen Cloud · 欧洲",
    group: "vendor",
    type: "openai-compatible",
    defaultName: "qwencloud-eu-central-1",
    baseURL: "https://eu-central-1.maas.qwencloudapi.com/compatible-mode/v1",
    defaultKeyEnv: "QWENCLOUD_API_KEY",
    modelsDevPricing: "alibaba",
    fetchableModels: true,
    keyHint: "https://home.qwencloud.com/api-keys",
  },
  {
    id: "qwencloud-ap-northeast-1",
    label: "Qwen Cloud · 日本",
    group: "vendor",
    type: "openai-compatible",
    defaultName: "qwencloud-ap-northeast-1",
    baseURL: "https://ap-northeast-1.maas.qwencloudapi.com/compatible-mode/v1",
    defaultKeyEnv: "QWENCLOUD_API_KEY",
    modelsDevPricing: "alibaba",
    fetchableModels: true,
    keyHint: "https://home.qwencloud.com/api-keys",
  },
  {
    id: "qwencloud-cn-hongkong",
    label: "Qwen Cloud · 香港",
    group: "vendor",
    type: "openai-compatible",
    defaultName: "qwencloud-cn-hongkong",
    baseURL: "https://cn-hongkong.maas.qwencloudapi.com/compatible-mode/v1",
    defaultKeyEnv: "QWENCLOUD_API_KEY",
    modelsDevPricing: "alibaba",
    fetchableModels: true,
    keyHint: "https://home.qwencloud.com/api-keys",
  },
  {
    id: "qwencloud-cn-beijing",
    label: "Qwen Cloud · 北京",
    group: "vendor",
    type: "openai-compatible",
    defaultName: "qwencloud-cn-beijing",
    baseURL: "https://cn-beijing.maas.qwencloudapi.com/compatible-mode/v1",
    defaultKeyEnv: "QWENCLOUD_API_KEY",
    modelsDevPricing: "alibaba",
    fetchableModels: true,
    keyHint: "https://home.qwencloud.com/api-keys",
  },
  {
    id: "mistral",
    label: "Mistral",
    group: "vendor",
    type: "openai-compatible",
    defaultName: "mistral",
    baseURL: "https://api.mistral.ai/v1",
    defaultKeyEnv: "MISTRAL_API_KEY",
    modelsDevPricing: "mistral",
    fetchableModels: true,
    keyHint: "https://console.mistral.ai/api-keys",
  },
  {
    id: "groq",
    label: "Groq",
    group: "vendor",
    type: "openai-compatible",
    defaultName: "groq",
    baseURL: "https://api.groq.com/openai/v1",
    defaultKeyEnv: "GROQ_API_KEY",
    modelsDevPricing: "groq",
    fetchableModels: true,
    keyHint: "https://console.groq.com/keys",
  },
  {
    id: "ollama-cloud",
    label: "Ollama Cloud",
    group: "vendor",
    type: "openai-compatible",
    defaultName: "ollama-cloud",
    baseURL: "https://ollama.com/v1",
    defaultKeyEnv: "OLLAMA_API_KEY",
    modelsDevPricing: "ollama-cloud",
    fetchableModels: true,
    keyHint: "https://ollama.com/settings/keys",
  },
  {
    id: "nous",
    label: "Nous Portal",
    group: "vendor",
    type: "openai-compatible",
    defaultName: "nous",
    baseURL: "https://inference-api.nousresearch.com/v1",
    defaultKeyEnv: "NOUS_API_KEY",
    fetchableModels: true,
    keyHint: "https://portal.nousresearch.com",
  },

  // ── relay（现有预设在前，其余按 magpie 原顺序） ──
  {
    id: "openrouter",
    login: "openrouter",
    label: "OpenRouter",
    group: "relay",
    type: "openai-compatible",
    defaultName: "openrouter",
    modelsDevPricing: "openrouter",
    baseURL: "https://openrouter.ai/api/v1",
    defaultKeyEnv: "OPENROUTER_API_KEY",
    fetchableModels: true,
    thinkingFormat: "openrouter",
    keyHint: "https://openrouter.ai/keys",
  },
  {
    // ADR-0031 §5：OpenCode Zen；会话头与 models.dev 服务商键写死。
    // 官方文档的密钥入口是 opencode.ai/auth（登录后复制 API key）。
    id: "opencode-zen",
    label: "OpenCode Zen",
    group: "relay",
    type: "openai-compatible",
    defaultName: "opencode-zen",
    baseURL: "https://opencode.ai/zen/v1",
    defaultKeyEnv: "OPENCODE_API_KEY",
    fetchableModels: true,
    sessionHeader: "x-opencode-session",
    modelsDevProvider: "opencode",
    modelsDevPricing: "opencode",
    keyHint: "https://opencode.ai/auth",
  },
  {
    // ADR-0031 §5 / ADR-0061：OpenCode Go（Console 文档 Base URLs 已迁至 /inference/go/openai/v1）
    id: "opencode-go",
    label: "OpenCode Go",
    group: "relay",
    type: "openai-compatible",
    defaultName: "opencode-go",
    baseURL: "https://opencode.ai/inference/go/openai/v1",
    defaultKeyEnv: "OPENCODE_API_KEY",
    fetchableModels: true,
    sessionHeader: "x-opencode-session",
    modelsDevProvider: "opencode-go",
    modelsDevPricing: "opencode-go",
    keyHint: "https://opencode.ai/auth",
  },
  {
    id: "vercel",
    label: "Vercel AI Gateway",
    group: "relay",
    type: "openai-compatible",
    defaultName: "vercel",
    baseURL: "https://ai-gateway.vercel.sh/v1",
    defaultKeyEnv: "VERCEL_API_KEY",
    modelsDevPricing: "vercel",
    fetchableModels: true,
    keyHint: "https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai-gateway%2Fapi-keys",
  },
  {
    id: "gmicloud",
    label: "GMI Cloud",
    group: "relay",
    type: "openai-compatible",
    defaultName: "gmicloud",
    baseURL: "https://api.gmi-serving.com/v1",
    defaultKeyEnv: "GMICLOUD_API_KEY",
    fetchableModels: true,
    keyHint: "https://console.gmicloud.ai",
  },
  {
    id: "clinepass",
    label: "ClinePass",
    group: "relay",
    type: "openai-compatible",
    defaultName: "clinepass",
    baseURL: "https://api.cline.bot/api/v1",
    defaultKeyEnv: "CLINEPASS_API_KEY",
    fetchableModels: true,
    keyHint: "https://app.cline.bot",
  },
  {
    id: "kilo",
    label: "Kilo Gateway",
    group: "relay",
    type: "openai-compatible",
    defaultName: "kilo",
    baseURL: "https://api.kilo.ai/api/openrouter",
    defaultKeyEnv: "KILO_API_KEY",
    fetchableModels: true,
    keyHint: "https://app.kilo.ai",
  },
  {
    id: "commandcode",
    label: "Command Code",
    group: "relay",
    type: "openai-compatible",
    defaultName: "commandcode",
    baseURL: "https://api.commandcode.ai/provider/v1",
    defaultKeyEnv: "COMMANDCODE_API_KEY",
    fetchableModels: true,
    keyHint: "https://commandcode.ai/settings/keys",
  },
  {
    id: "together",
    label: "Together AI",
    group: "relay",
    type: "openai-compatible",
    defaultName: "together",
    baseURL: "https://api.together.xyz/v1",
    defaultKeyEnv: "TOGETHER_API_KEY",
    modelsDevPricing: "togetherai",
    fetchableModels: true,
    keyHint: "https://api.together.ai/settings/api-keys",
  },
  {
    id: "fireworks",
    label: "Fireworks",
    group: "relay",
    type: "openai-compatible",
    defaultName: "fireworks",
    baseURL: "https://api.fireworks.ai/inference/v1",
    defaultKeyEnv: "FIREWORKS_API_KEY",
    modelsDevPricing: "fireworks-ai",
    fetchableModels: true,
    keyHint: "https://app.fireworks.ai/settings/users/api-keys",
  },
  {
    id: "siliconflow-cn",
    label: "SiliconFlow · 国内",
    group: "relay",
    type: "openai-compatible",
    defaultName: "siliconflow-cn",
    baseURL: "https://api.siliconflow.cn/v1",
    defaultKeyEnv: "SILICONFLOW_API_KEY",
    modelsDevPricing: "siliconflow",
    fetchableModels: true,
    keyHint: "https://cloud.siliconflow.cn/account/ak",
  },
  {
    id: "siliconflow-intl",
    label: "SiliconFlow · 国际",
    group: "relay",
    type: "openai-compatible",
    defaultName: "siliconflow-intl",
    baseURL: "https://api.siliconflow.com/v1",
    defaultKeyEnv: "SILICONFLOW_API_KEY",
    modelsDevPricing: "siliconflow",
    fetchableModels: true,
    keyHint: "https://cloud.siliconflow.com/account/ak",
  },
  {
    id: "nvidia",
    label: "NVIDIA NIM",
    group: "relay",
    type: "openai-compatible",
    defaultName: "nvidia",
    baseURL: "https://integrate.api.nvidia.com/v1",
    defaultKeyEnv: "NVIDIA_API_KEY",
    modelsDevPricing: "nvidia",
    fetchableModels: true,
    keyHint: "https://build.nvidia.com/settings/api-keys",
  },
  {
    id: "modelscope",
    label: "ModelScope",
    group: "relay",
    type: "openai-compatible",
    defaultName: "modelscope",
    baseURL: "https://api-inference.modelscope.cn/v1",
    defaultKeyEnv: "MODELSCOPE_API_KEY",
    modelsDevPricing: "modelscope",
    fetchableModels: true,
    keyHint: "https://modelscope.cn/my/myaccesstoken",
  },
  {
    id: "aihubmix",
    label: "AiHubMix",
    group: "relay",
    type: "openai-compatible",
    defaultName: "aihubmix",
    baseURL: "https://aihubmix.com/v1",
    defaultKeyEnv: "AIHUBMIX_API_KEY",
    fetchableModels: true,
    keyHint: "https://console.aihubmix.com/token",
  },
  {
    id: "pipellm",
    label: "PipeLLM",
    group: "relay",
    type: "openai-compatible",
    defaultName: "pipellm",
    baseURL: "https://api.pipellm.ai/openai/v1",
    defaultKeyEnv: "PIPELLM_API_KEY",
    fetchableModels: true,
    keyHint: "https://console.pipellm.ai",
  },
  {
    id: "302ai",
    label: "302.AI",
    group: "relay",
    type: "openai-compatible",
    defaultName: "302ai",
    baseURL: "https://api.302.ai/v1",
    defaultKeyEnv: "AI302_API_KEY",
    fetchableModels: true,
    keyHint: "https://302.ai/api-keys/list",
  },
  {
    id: "cherryin",
    label: "CherryIN",
    group: "relay",
    type: "openai-compatible",
    defaultName: "cherryin",
    baseURL: "https://open.cherryin.ai/v1",
    defaultKeyEnv: "CHERRYIN_API_KEY",
    fetchableModels: true,
    keyHint: "https://open.cherryin.ai/console/token",
  },
  {
    id: "yylx-auto",
    label: "鱼鱼连线 · 自动",
    group: "relay",
    type: "openai-compatible",
    defaultName: "yylx-auto",
    baseURL: "https://app.yylx.io/v1",
    defaultKeyEnv: "YYLX_API_KEY",
    fetchableModels: true,
    keyHint: "https://app.yylx.io/keys",
  },
  {
    id: "yylx-global",
    label: "鱼鱼连线 · 国际",
    group: "relay",
    type: "openai-compatible",
    defaultName: "yylx-global",
    baseURL: "https://global.yylx.io/v1",
    defaultKeyEnv: "YYLX_API_KEY",
    fetchableModels: true,
    keyHint: "https://app.yylx.io/keys",
  },
  {
    id: "yylx-cn",
    label: "鱼鱼连线 · 国内",
    group: "relay",
    type: "openai-compatible",
    defaultName: "yylx-cn",
    baseURL: "https://cn.yylx.io/v1",
    defaultKeyEnv: "YYLX_API_KEY",
    fetchableModels: true,
    keyHint: "https://app.yylx.io/keys",
  },
  {
    id: "aigocode",
    label: "AIGoCode",
    group: "relay",
    type: "openai-compatible",
    defaultName: "aigocode",
    baseURL: "https://api.aigocode.dev/v1",
    defaultKeyEnv: "AIGOCODE_API_KEY",
    fetchableModels: true,
    keyHint: "https://www.aigocode.net/dashboard/keys",
  },

  // ── local（免密钥） ──
  {
    id: "ollama",
    label: "Ollama",
    group: "local",
    type: "openai-compatible",
    defaultName: "ollama",
    baseURL: "http://localhost:11434/v1",
    defaultKeyEnv: "OLLAMA_API_KEY",
    keyOptional: true,
    fetchableModels: true,
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    group: "local",
    type: "openai-compatible",
    defaultName: "lmstudio",
    baseURL: "http://localhost:1234/v1",
    defaultKeyEnv: "LMSTUDIO_API_KEY",
    keyOptional: true,
    fetchableModels: true,
  },
  {
    id: "omlx",
    label: "oMLX",
    group: "local",
    type: "openai-compatible",
    defaultName: "omlx",
    baseURL: "http://localhost:8000/v1",
    defaultKeyEnv: "OMLX_API_KEY",
    keyOptional: true,
    fetchableModels: true,
  },
  {
    id: "mlx-serve",
    label: "MLX-Serve",
    group: "local",
    type: "openai-compatible",
    defaultName: "mlx-serve",
    baseURL: "http://localhost:11234/v1",
    defaultKeyEnv: "MLX_SERVE_API_KEY",
    keyOptional: true,
    fetchableModels: true,
  },

  // ── custom ──
  {
    id: "custom-openai",
    label: "其他 OpenAI 兼容服务",
    group: "custom",
    type: "openai-compatible",
    defaultName: "",
    fetchableModels: true,
  },
  {
    id: "custom-anthropic",
    label: "其他 Anthropic 兼容服务",
    group: "custom",
    type: "anthropic",
    defaultName: "",
    fetchableModels: true,
  },
];

export function listProviderPresets(): ProviderPreset[] {
  return [...PROVIDER_PRESETS];
}

/** fetchModels 的入参：与 ProviderEntryConfig 同形但松一档（向导半成品也能测） */
export interface FetchModelsRequest {
  id?: string | undefined;
  auth?: ProviderAuth | undefined;
  type: "openai-compatible" | "anthropic";
  baseURL?: string | undefined;
  headers?: Record<string, string> | undefined;
  /** 条目可能声明的会话头名；fetchModels 不属于会话，永不发送（ADR-0031 §3） */
  sessionHeader?: string | undefined;
}

const FETCH_TIMEOUT_MS = 15_000;

/** /v1/models 按未入文档的 client_version 过滤较新模型；发足够大的版本以列出全部（ADR-0042 修订） */
const SIWC_MODELS_CLIENT_VERSION = "99.0.0";

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

/**
 * anthropic 条目的请求基地址（ADR-0026 §3）：与消息请求共用同一 baseURL
 * 语义——省略 baseURL 时用官方 https://api.anthropic.com/v1。
 */
function anthropicBase(entry: FetchModelsRequest): string {
  return entry.baseURL ?? "https://api.anthropic.com/v1";
}

function authHeaders(entry: FetchModelsRequest, key: string | undefined): Record<string, string> {
  const out: Record<string, string> = { ...(entry.headers ?? {}) };
  if (key === undefined || key === "") return out;
  if (entry.type === "anthropic") {
    out["x-api-key"] = key;
    out["anthropic-version"] ??= "2023-06-01";
  } else {
    out.Authorization = `Bearer ${key}`;
  }
  return out;
}

function withTimeout(signal: AbortSignal | undefined): {
  signal: AbortSignal;
  cancel: () => void;
} {
  const ac = new AbortController();
  const timer = setTimeout(() => {
    ac.abort();
  }, FETCH_TIMEOUT_MS);
  const onAbort = () => {
    ac.abort();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: ac.signal,
    cancel: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

async function fetchJson(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const t = withTimeout(signal);
  try {
    const res = await fetch(url, { headers, signal: t.signal, redirect: "error" });
    if (!res.ok) {
      throw new ProviderUpstreamError(`上游返回 HTTP ${res.status}`, res.status);
    }
    const data: unknown = await res.json();
    return data;
  } finally {
    t.cancel();
  }
}

export class ProviderUpstreamError extends Error {
  readonly status?: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "ProviderUpstreamError";
    this.status = status;
  }
}

// ── 上游字段映射（provider-setup.md 第 7 节）───────────────

interface RawModel {
  id?: unknown;
  name?: unknown;
  display_name?: unknown;
  context_length?: unknown;
  top_provider?: unknown;
  pricing?: unknown;
  supported_parameters?: unknown;
  /** 上游声明的服务接口列表（ADR-0026 §2；OpenRouter 等聚合服务逐模型给出） */
  supported_endpoints?: unknown;
  architecture?: unknown;
  // Anthropic /v1/models 官方声明的限额字段
  max_input_tokens?: unknown;
  max_tokens?: unknown;
}

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const perTokenPrice = (v: unknown): number | undefined => {
  // OpenRouter pricing 是按 token 计价的 USD 字符串，换算为每百万 token
  const s = str(v);
  if (s === undefined) return undefined;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n * 1_000_000 : undefined;
};

/** 单个上游模型条目 → UpstreamModelInfo；只映射明确声明的字段 */
function mapUpstreamModel(raw: RawModel): UpstreamModelInfo | undefined {
  const id = str(raw.id);
  if (id === undefined) return undefined;
  const top =
    typeof raw.top_provider === "object" && raw.top_provider !== null
      ? (raw.top_provider as { context_length?: unknown; max_completion_tokens?: unknown })
      : undefined;
  const out: UpstreamModelInfo = { id };

  const displayName = str(raw.display_name) ?? str(raw.name);
  if (displayName !== undefined) out.displayName = displayName;

  // top_provider.context_length 优先于顶层 context_length（OpenRouter）
  const contextWindow =
    num(top?.context_length) ?? num(raw.context_length) ?? num(raw.max_input_tokens);
  if (contextWindow !== undefined) out.contextWindow = contextWindow;

  const maxOutput = num(top?.max_completion_tokens) ?? num(raw.max_tokens);
  if (maxOutput !== undefined) out.maxOutputTokens = maxOutput;

  const pricing =
    typeof raw.pricing === "object" && raw.pricing !== null
      ? (raw.pricing as {
          prompt?: unknown;
          completion?: unknown;
          input_cache_read?: unknown;
          input_cache_write?: unknown;
        })
      : undefined;
  const inputPrice = perTokenPrice(pricing?.prompt);
  const outputPrice = perTokenPrice(pricing?.completion);
  const cacheRead = perTokenPrice(pricing?.input_cache_read);
  const cacheWrite = perTokenPrice(pricing?.input_cache_write);
  if (
    inputPrice !== undefined ||
    outputPrice !== undefined ||
    cacheRead !== undefined ||
    cacheWrite !== undefined
  ) {
    out.pricing = {
      ...(inputPrice !== undefined ? { input: inputPrice } : {}),
      ...(outputPrice !== undefined ? { output: outputPrice } : {}),
      ...(cacheRead !== undefined ? { cacheRead } : {}),
      ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    };
  }

  // 能力位只在有声明时设置（清单字段覆盖范围各服务不统一，不反向断言）
  const params = Array.isArray(raw.supported_parameters) ? raw.supported_parameters : [];
  const modalities =
    typeof raw.architecture === "object" && raw.architecture !== null
      ? (raw.architecture as { input_modalities?: unknown }).input_modalities
      : undefined;
  const caps: { reasoning?: "visible"; imageInput?: boolean } = {};
  if (params.includes("reasoning") || params.includes("include_reasoning")) {
    caps.reasoning = "visible";
  }
  if (Array.isArray(modalities) && modalities.includes("image")) {
    caps.imageInput = true;
  }
  if (caps.reasoning !== undefined || caps.imageInput !== undefined) {
    out.capabilities = caps;
  }

  // ADR-0026 §2：supported_endpoints 原文保存（字符串数组、非空才记）；
  // 空数组按未声明处理——由调用方继续走条目 type 回落
  if (Array.isArray(raw.supported_endpoints)) {
    const eps = raw.supported_endpoints.filter(
      (e): e is string => typeof e === "string" && e !== "",
    );
    if (eps.length > 0) out.endpoints = eps;
  }
  return out;
}

/**
 * GET /models（provider-setup.md 第 7 节）：拉取上游模型列表并映射声明的
 * 限额/能力/价格字段。服务不提供列表接口或请求失败时返回 [] 由调用方
 * 降级为手动输入；HTTP 错误抛 ProviderUpstreamError。
 */
export async function fetchModels(
  entry: FetchModelsRequest,
  key: string | AuthResolver | undefined,
  signal?: AbortSignal,
): Promise<UpstreamModelInfo[]> {
  // ADR-0031 §2：模型列表请求同样以 nocturne/<version> 开头；
  // 条目 headers 里用户写的 UA 优先。fetchModels 不属于会话，不写会话头。
  const uaHeader = hasStaticHeader(entry.headers, "user-agent")
    ? {}
    : { "User-Agent": nocturneUserAgent() };
  // ADR-0026 §3：两种协议共用条目的 baseURL 语义（含 /v1）——
  // anthropic 条目为 <baseURL 或官方默认>/models（不再是额外的 /v1 段）
  const url =
    entry.type === "anthropic"
      ? joinUrl(anthropicBase(entry), "/models")
      : entry.baseURL !== undefined && entry.baseURL !== ""
        ? joinUrl(entry.baseURL, "/models")
        : (() => {
            throw new ProviderUpstreamError(
              "openai-compatible 服务商缺少 baseURL，无法获取模型列表",
            );
          })();
  const resolver: AuthResolver =
    typeof key === "object"
      ? key
      : entry.auth !== undefined && entry.auth.kind !== "apiKey"
        ? createAuthResolver({ id: entry.id ?? "provider", auth: entry.auth })
        : {
            token: () => Promise.resolve(key ?? ""),
            invalidate: () => Promise.resolve(),
          };
  // 仅 siwc 模型列表带 client_version；其他服务商地址不变。
  const modelsUrl =
    resolver.modelFormat === "siwc" ? `${url}?client_version=${SIWC_MODELS_CLIENT_VERSION}` : url;
  const requestSignal = signal ?? new AbortController().signal;
  let raw: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      raw = await fetchJson(
        modelsUrl,
        {
          ...uaHeader,
          Accept: "application/json",
          ...authHeaders(entry, await resolver.token(requestSignal)),
          ...resolver.requestHeaders,
        },
        signal,
      );
      break;
    } catch (error) {
      if (!(error instanceof ProviderUpstreamError) || error.status !== 401) throw error;
      if (attempt === 1)
        throw new ProviderAuthError(
          resolver.unauthorizedMessage ?? "服务商凭据已失效，请重新登录或更新密钥",
          401,
        );
      await resolver.invalidate();
    }
  }
  if (resolver.modelFormat === "siwc") {
    const models =
      typeof raw === "object" && raw !== null && "models" in raw && Array.isArray(raw.models)
        ? (raw.models as unknown[])
        : [];
    return models.flatMap((value): UpstreamModelInfo[] => {
      if (typeof value !== "object" || value === null) return [];
      const model = value as {
        visibility?: unknown;
        slug?: unknown;
        display_name?: unknown;
        context_window?: unknown;
        input_modalities?: unknown;
      };
      if (model.visibility !== "list" || typeof model.slug !== "string" || model.slug === "")
        return [];
      return [
        {
          id: model.slug,
          ...(typeof model.display_name === "string" && model.display_name !== ""
            ? { displayName: model.display_name }
            : {}),
          // 账号通道声明的上下文长度（如 272000）优先于 models.dev 的 API 数值（ADR-0016）
          ...(typeof model.context_window === "number" &&
          Number.isInteger(model.context_window) &&
          model.context_window > 0
            ? { contextWindow: model.context_window }
            : {}),
          ...(Array.isArray(model.input_modalities)
            ? { capabilities: { imageInput: model.input_modalities.includes("image") } }
            : {}),
        },
      ];
    });
  }
  const data =
    typeof raw === "object" && raw !== null && Array.isArray((raw as { data?: unknown }).data)
      ? ((raw as { data: unknown[] }).data as RawModel[])
      : [];
  return data.map(mapUpstreamModel).filter((m): m is UpstreamModelInfo => m !== undefined);
}
