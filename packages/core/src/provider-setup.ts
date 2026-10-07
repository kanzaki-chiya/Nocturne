/**
 * 服务商配置的数据接口（ADR-0044 第 6 节，provider-setup.md 第 6 节）：
 * `describeProviderSetup` 描述某个预设需要填写什么，`prepareProvider` 准备草稿，`commitProvider` 确认后保存。
 * 预设之间的差异（哪些问名称与地址、哪些走登录、无凭据后端怎么办、模型列表失败怎么提示）
 * 全部在这里判断；界面只负责按描述收集输入并显示结果，不回调、不自己判断。
 * 不发送模型请求（不消耗 token）：密钥与地址的有效性由会话中的首次真实请求检验。
 * 日志与诊断里永远不要出现 input（密钥明文）。
 */
import { randomUUID } from "node:crypto";
import { ConfigError } from "./config/errors.js";
import type {
  CredentialBackend,
  ModelOverrideShape,
  ProviderEntryConfig,
  RuntimeConfig,
  UpstreamModelEntry,
} from "./config/index.js";
import {
  listProviderPresets,
  type FetchModelsRequest,
  type ProviderPreset,
} from "./provider/index.js";
import { fetchProviderModels } from "./provider-oauth.js";
import { dropPendingLogin, findPendingLogin } from "./provider-login/pending.js";

/** 表单字段名；校验失败的错误带它，客户端据此标到对应输入框 */
export type ProviderSetupFieldName =
  | "preset"
  | "name"
  | "baseURL"
  | "sessionHeader"
  | "credential"
  | "modelId"
  | "draftId"
  | "providerId"
  | "type"
  | "headers"
  | "displayName";

export class ProviderSetupError extends Error {
  constructor(
    readonly field: ProviderSetupFieldName,
    message: string,
  ) {
    super(message);
    this.name = "ProviderSetupError";
  }
}

export interface ProviderSetupField {
  key: "name" | "baseURL" | "sessionHeader";
  /** 输入框的提问行 */
  prompt: string;
  /** 提问下方的灰色说明 */
  hint: string;
  required: boolean;
  /** 预设写死的值：不询问，直接用 */
  fixed?: string | undefined;
}

export type CredentialMethodKind = "apiKey" | "env" | "login" | "external-file";

export type ProviderCredentialMethod =
  | {
      kind: "apiKey";
      label: string;
      /** 凭据后端不可用时为 false：不询问密钥，直接走环境变量 */
      available: boolean;
      prompt: string;
      hint: string;
    }
  | {
      kind: "env";
      label: string;
      prompt: string;
      hint: string;
      /** 留空时使用的变量名 */
      defaultName: string;
    }
  | { kind: "login"; label: string; account: boolean }
  | { kind: "external-file"; label: string; renewHint: string };

export interface AccountStorageOption {
  value: "plaintext" | "memory";
  label: string;
}

/** 无系统凭据后端时账号凭据必须由用户显式选择保存位置（没有默认值，更没有默认明文） */
export interface AccountStorageSetup {
  /** 选择前显示的风险说明（一行文字） */
  notice: string;
  prompt: string;
  hint: string;
  options: AccountStorageOption[];
  /** 没有选满一项时的提示 */
  retry: string;
}

export interface ProviderCredentialSetup {
  backend: { kind: CredentialBackend; available: boolean; label: string };
  /**
   * 凭据方式，按首选顺序。apiKey 留空回落到下一个 env；
   * 存在 choose 时先让用户在其中选一项（OpenRouter：浏览器登录 / 粘贴密钥），
   * 选 apiKey 才进入 apiKey → env 的顺序，选 login 直接走登录。
   */
  methods: ProviderCredentialMethod[];
  choose?: { prompt: string; options: { method: "login" | "apiKey"; label: string }[] } | undefined;
  /** 仅账号型登录且无系统后端时给出 */
  accountStorage?: AccountStorageSetup | undefined;
}

export interface ProviderSetupDescription {
  presetId: string;
  label: string;
  type: "openai-compatible" | "anthropic";
  fields: ProviderSetupField[];
  credential: ProviderCredentialSetup;
  /** 准备时会不会向上游获取模型列表（决定界面显示获取列表还是准备） */
  fetchableModels: boolean;
  /** 上游没给出模型列表时（如外部登录文件的服务）需要手填模型 ID */
  manualModel?: { prompt: string; hint: string } | undefined;
}

export type ProviderCredentialInput =
  | { kind: "apiKey"; key: string }
  | { kind: "env"; name: string }
  | { kind: "login"; loginId: string }
  | { kind: "external-file" };

export interface AddProviderInput {
  presetId: string;
  /** 预设询问名称时必填 */
  name?: string | undefined;
  baseURL?: string | undefined;
  sessionHeader?: string | undefined;
  credential: ProviderCredentialInput;
  /** 外部登录文件且上游无模型列表时的手填模型 ID */
  modelId?: string | undefined;
}

/** 提交结果里的一条提示：step 是折叠进步骤摘要的一行，print 是独立的说明行 */
export interface ProviderSetupNotice {
  code: "models_fetched" | "models_unauthorized" | "models_failed" | "models_dev";
  kind: "step" | "print";
  text: string;
}

export interface AddProviderResult {
  providerId: string;
  /** 已登记到条目 models 的上游模型数 */
  modelCount: number;
  notices: ProviderSetupNotice[];
  /** 结果行：已保存 xxx，N 个模型 */
  message: string;
}

export interface AddProviderOptions {
  /** 模型列表获取（测试注入离线实现）；缺省走 provider 层的 GET /models */
  fetchModels?:
    | ((
        request: FetchModelsRequest & { apiKeyEnv?: string | undefined },
        key: string | undefined,
        signal: AbortSignal | undefined,
      ) => Promise<UpstreamModelEntry[]>)
    | undefined;
  /** 读取环境变量（决定 env 方式下能否带密钥获取模型列表）；缺省读进程环境 */
  env?: ((name: string) => string | undefined) | undefined;
  signal?: AbortSignal | undefined;
  /** 名称冲突检查时参与的项目层（与 describeProviders 同口径）；缺省只查全局各层 */
  workspaceRoot?: string | undefined;
}

/** 准备结果里的一条模型摘要（供表单展示；上游没给的字段省略） */
export interface PreparedModelSummary {
  id: string;
  displayName?: string | undefined;
  reasoning?: "none" | "hidden" | "visible" | undefined;
  imageInput?: boolean | undefined;
  contextWindow?: number | undefined;
  maxOutputTokens?: number | undefined;
}

export interface PrepareProviderResult {
  draftId: string;
  modelCount: number;
  /** 获取到的上游模型（与 modelCount 同序同数） */
  models: PreparedModelSummary[];
  notices: ProviderSetupNotice[];
  needsManualModel: boolean;
  steps: string[];
}

interface ProviderDraft {
  commit(manualModelId?: string): Promise<AddProviderResult>;
  timer: ReturnType<typeof setTimeout>;
  expiresAt: number;
  committing: boolean;
}

const drafts = new WeakMap<RuntimeConfig, Map<string, ProviderDraft>>();
const DRAFT_TTL = 15 * 60_000;

/** 放弃或过期只释放内存；不会消费登录或写入凭据。 */
export function discardProvider(config: RuntimeConfig, draftId: string): void {
  const table = drafts.get(config);
  const draft = table?.get(draftId);
  if (draft === undefined) return;
  clearTimeout(draft.timer);
  table?.delete(draftId);
}

export async function commitProvider(
  config: RuntimeConfig,
  draftId: string,
  options: { manualModelId?: string | undefined } = {},
): Promise<AddProviderResult> {
  const draft = drafts.get(config)?.get(draftId);
  if (draft === undefined || draft.expiresAt <= Date.now()) {
    discardProvider(config, draftId);
    throw new ProviderSetupError("draftId", "配置草稿不存在或已过期，请重新开始");
  }
  if (draft.committing) throw new ProviderSetupError("draftId", "配置草稿正在保存");
  draft.committing = true;
  try {
    const result = await draft.commit(options.manualModelId);
    discardProvider(config, draftId);
    return result;
  } finally {
    draft.committing = false;
  }
}

const ACCOUNT_STORAGE_RISK =
  "明文保存在 credentials.json。文件被备份、同步或拷走时凭据随之泄漏；refresh token 在被撤销前可以持续使用。不会默认选择明文。";

export function credentialBackendLabel(backend: string): string {
  switch (backend) {
    case "dpapi":
      return "Windows DPAPI";
    case "keychain":
      return "macOS 钥匙串";
    case "libsecret":
      return "Secret Service";
    default:
      return backend;
  }
}

function isAccountPreset(preset: Pick<ProviderPreset, "auth">): boolean {
  return preset.auth?.kind === "openai-siwc" || preset.auth?.kind === "xai-oauth2";
}

/**
 * 账号型登录在无系统后端时需要用户选择保存位置；其余情况返回 undefined。
 * 已保存服务商重新登录（/provider login）与表单里的草稿登录共用。
 */
export function describeAccountStorage(
  config: RuntimeConfig,
  entry: { auth?: { kind: string } | undefined },
): AccountStorageSetup | undefined {
  if (config.credentials.backend() !== "none") return undefined;
  if (entry.auth?.kind !== "openai-siwc" && entry.auth?.kind !== "xai-oauth2") return undefined;
  return {
    notice: `系统凭据后端不可用。${ACCOUNT_STORAGE_RISK}`,
    prompt: "账号凭据保存方式（必须选择一项）：",
    hint: ACCOUNT_STORAGE_RISK,
    options: [
      { value: "plaintext", label: "保存到 credentials.json（明文，仅你可读）" },
      { value: "memory", label: "仅本次运行（退出后丢失，下次启动重新登录）" },
    ],
    retry: "请只选择一项，不能留空。",
  };
}

function findPreset(presetId: string): ProviderPreset {
  const preset = listProviderPresets().find((p) => p.id === presetId);
  if (preset === undefined) throw new ProviderSetupError("preset", `未知预设：${presetId}`);
  return preset;
}

function describeFields(preset: ProviderPreset): ProviderSetupField[] {
  const fields: ProviderSetupField[] = [];
  fields.push(
    preset.defaultName !== ""
      ? { key: "name", prompt: "名称：", hint: "", required: true, fixed: preset.defaultName }
      : {
          key: "name",
          prompt: "名称：",
          hint: "该服务商在 providers.json、/model 与状态栏中的标识",
          required: true,
        },
  );
  if (preset.baseURL !== undefined) {
    fields.push({
      key: "baseURL",
      prompt: "服务地址：",
      hint: "",
      required: true,
      fixed: preset.baseURL,
    });
  } else if (preset.type === "openai-compatible") {
    fields.push({
      key: "baseURL",
      prompt: "服务地址：",
      hint: "OpenAI 兼容端点，通常以 /v1 结尾（如 https://api.example.com/v1）",
      required: true,
    });
  } else {
    fields.push({
      key: "baseURL",
      prompt: "服务地址：",
      hint: "留空使用官方端点",
      required: false,
    });
  }
  // 会话标识请求头（ADR-0031 §3）：仅自定义预设询问，可选；内置预设由预设值写死
  if (preset.id.startsWith("custom-")) {
    fields.push({
      key: "sessionHeader",
      prompt: "会话标识请求头（可选，回车跳过）：",
      hint: "部分网关要求每个对话带固定的会话 ID，填请求头名称，例如 x-opencode-session；留空不发送",
      required: false,
    });
  }
  return fields;
}

function describeCredential(
  config: RuntimeConfig,
  preset: ProviderPreset,
): ProviderCredentialSetup {
  const kind = config.credentials.backend();
  const available = kind !== "none";
  const backend = { kind, available, label: credentialBackendLabel(kind) };
  const defaultEnv = preset.defaultKeyEnv ?? "NOCTURNE_API_KEY";
  const apiKey: ProviderCredentialMethod = {
    kind: "apiKey",
    label: "粘贴密钥",
    available,
    prompt: "API Key：",
    hint:
      (preset.keyHint !== undefined ? `从 ${preset.keyHint} 获取；` : "") +
      "输入不回显；直接回车改用环境变量",
  };
  const env: ProviderCredentialMethod = {
    kind: "env",
    label: "环境变量",
    prompt: `凭据环境变量名 [${defaultEnv}]：`,
    hint: "该变量的值会作为请求凭据发送",
    defaultName: defaultEnv,
  };
  if (isAccountPreset(preset)) {
    return {
      backend,
      methods: [{ kind: "login", label: "浏览器登录", account: true }],
      accountStorage: describeAccountStorage(config, preset),
    };
  }
  if (preset.auth?.kind === "external-file") {
    return {
      backend,
      methods: [{ kind: "external-file", label: "外部登录文件", renewHint: preset.auth.renewHint }],
    };
  }
  if (preset.login === "openrouter") {
    return {
      backend,
      methods: [{ kind: "login", label: "浏览器登录", account: false }, apiKey, env],
      choose: {
        prompt: "密钥获取方式（选择一项）：",
        options: [
          { method: "login", label: "浏览器登录" },
          { method: "apiKey", label: "粘贴密钥" },
        ],
      },
    };
  }
  return { backend, methods: [apiKey, env] };
}

/** 描述一个预设的配置表单；客户端据此画表单，不自己判断预设差异 */
export function describeProviderSetup(
  config: RuntimeConfig,
  presetId: string,
): ProviderSetupDescription {
  const preset = findPreset(presetId);
  return {
    presetId: preset.id,
    label: preset.label,
    type: preset.type,
    fields: describeFields(preset),
    credential: describeCredential(config, preset),
    fetchableModels: preset.fetchableModels,
    ...(preset.auth?.kind === "external-file"
      ? {
          manualModel: {
            prompt: "模型 ID：",
            hint: "服务不提供模型列表时手动填写",
          },
        }
      : {}),
  };
}

/** 已回答字段的一行步骤摘要（"名称 x"、"地址 y"、"会话头 z"）；value 为空表示留空 */
export function setupFieldStep(key: ProviderSetupField["key"], value: string | undefined): string {
  const v = value === undefined || value === "" ? undefined : value;
  switch (key) {
    case "name":
      return `名称 ${v ?? ""}`;
    case "baseURL":
      return `地址 ${v ?? "官方端点"}`;
    case "sessionHeader":
      return `会话头 ${v ?? "不发送"}`;
  }
}

/** 凭据步骤的一行摘要；login 不含登录等待，仅表示已完成 */
export function setupCredentialStep(
  description: ProviderSetupDescription,
  credential: ProviderCredentialInput,
): string {
  switch (credential.kind) {
    case "apiKey":
      return "密钥已保存（凭据存储）";
    case "env":
      return `密钥来源：环境变量 ${credential.name}`;
    case "login":
      return "登录已完成";
    case "external-file": {
      const method = description.credential.methods.find((m) => m.kind === "external-file");
      return `凭据来源：外部登录文件；续期运行 ${method?.kind === "external-file" ? method.renewHint : ""}`;
    }
  }
}

/** 提交凭据后的独立说明行（无则 undefined） */
export function setupCredentialNotice(
  description: ProviderSetupDescription,
  credential: ProviderCredentialInput,
): string | undefined {
  const { backend } = description.credential;
  if (credential.kind === "apiKey") return `密钥已交给 ${backend.label} 加密保存`;
  if (credential.kind === "env" && !backend.available)
    return "系统凭据后端不可用，使用环境变量方式";
  return undefined;
}

/** 注入的 fetchModels 抛错约定：可携带数字 status（ProviderUpstreamError） */
function upstreamStatus(e: unknown): number | undefined {
  const s = (e as { status?: unknown } | null | undefined)?.status;
  return typeof s === "number" ? s : undefined;
}

function resolveField(field: ProviderSetupField, value: string | undefined): string | undefined {
  if (field.fixed !== undefined) return field.fixed;
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") {
    if (field.required) {
      throw new ProviderSetupError(field.key, `${field.prompt.replace(/[：:]$/, "")}不能为空`);
    }
    return undefined;
  }
  return trimmed;
}

/**
 * 准备表单：校验与获取模型列表；凭据和条目只在 commitProvider 写入。
 * 获取模型列表失败不阻止保存，只产生 notices；校验失败抛带字段名的 ProviderSetupError。
 * v0.3 起不再询问模型与"设为默认"——模型选择走 /model（ADR-0019 第 3 条）。
 */
export async function prepareProvider(
  config: RuntimeConfig,
  input: AddProviderInput,
  options: AddProviderOptions = {},
): Promise<PrepareProviderResult> {
  const preset = findPreset(input.presetId);
  const description = describeProviderSetup(config, preset.id);
  const values: Record<ProviderSetupField["key"], string | undefined> = {
    name: undefined,
    baseURL: undefined,
    sessionHeader: undefined,
  };
  const given: Record<ProviderSetupField["key"], string | undefined> = {
    name: input.name,
    baseURL: input.baseURL,
    sessionHeader: input.sessionHeader,
  };
  for (const field of description.fields) values[field.key] = resolveField(field, given[field.key]);
  const providerId = values.name ?? "";
  const baseURL = values.baseURL;
  const sessionHeader = values.sessionHeader ?? preset.sessionHeader;
  await assertNameFree(config, providerId, options.workspaceRoot);

  // ── 凭据 ──
  const backendAvailable = config.credentials.backend() !== "none";
  const account = isAccountPreset(preset);
  const credential = input.credential;
  let key: string | undefined;
  let apiKeyEnv: string | undefined;
  let loginId: string | undefined;
  let stagedAccount: { value: string; storage: "plaintext" | "memory" | undefined } | undefined;
  switch (credential.kind) {
    case "apiKey": {
      if (account || preset.auth?.kind === "external-file") {
        throw new ProviderSetupError("credential", `${preset.label} 不使用 API Key`);
      }
      if (!backendAvailable) {
        throw new ProviderSetupError(
          "credential",
          "系统凭据后端不可用，无法保存密钥；请改用环境变量方式",
        );
      }
      if (credential.key === "") throw new ProviderSetupError("credential", "API Key 不能为空");
      key = credential.key;
      break;
    }
    case "env": {
      if (account || preset.auth?.kind === "external-file") {
        throw new ProviderSetupError("credential", `${preset.label} 不使用环境变量`);
      }
      const name = credential.name.trim();
      apiKeyEnv = name !== "" ? name : (preset.defaultKeyEnv ?? "NOCTURNE_API_KEY");
      break;
    }
    case "external-file": {
      if (preset.auth?.kind !== "external-file") {
        throw new ProviderSetupError("credential", `${preset.label} 不使用外部登录文件`);
      }
      break;
    }
    case "login": {
      if (preset.login === undefined) {
        throw new ProviderSetupError("credential", `${preset.label} 不支持浏览器登录`);
      }
      const pending = findPendingLogin(config, credential.loginId);
      if (pending === undefined) {
        throw new ProviderSetupError("credential", "登录会话不存在或已结束，请重新登录");
      }
      if (
        pending.presetId !== preset.id ||
        pending.providerId !== providerId ||
        pending.baseURL !== baseURL
      ) {
        throw new ProviderSetupError("credential", "登录与表单内容不一致，请重新登录");
      }
      if (!pending.settled) throw new ProviderSetupError("credential", "登录尚未完成");
      loginId = credential.loginId;
      if (pending.account) {
        if (pending.staged !== undefined) {
          stagedAccount = {
            value: pending.staged.value,
            storage: pending.staged.kind === "account" ? pending.staged.storage : undefined,
          };
        }
      } else if (pending.staged?.kind === "secret") {
        key = pending.staged.value;
      } else if (!backendAvailable) {
        // 无后端的 OpenRouter 登录：密钥已由客户端一次性展示，条目改读环境变量
        apiKeyEnv = preset.defaultKeyEnv ?? "NOCTURNE_API_KEY";
      }
      break;
    }
  }

  // 账号令牌解析与刷新仅使用草稿内存；不写凭据、锁文件或官方 CLI 文件。
  const fetchConfig = !account
    ? config
    : {
        ...config,
        credentials: {
          backend: () => config.credentials.backend(),
          has: () => stagedAccount !== undefined,
          get: () => Promise.resolve(stagedAccount?.value),
          set: (_id: string, value: string) => {
            if (stagedAccount !== undefined) stagedAccount.value = value;
            return Promise.resolve();
          },
          setAccount: (_id: string, value: string) => {
            if (stagedAccount !== undefined) stagedAccount.value = value;
            return Promise.resolve();
          },
          delete: () => {
            stagedAccount = undefined;
            return Promise.resolve();
          },
          storage: () => "memory" as const,
        },
      };

  // ── 模型列表 ──
  const env = options.env ?? ((name: string) => process.env[name]);
  const effectiveKey = key ?? (apiKeyEnv !== undefined ? env(apiKeyEnv) : undefined);
  const request: FetchModelsRequest & { apiKeyEnv?: string | undefined } = {
    id: providerId,
    auth: preset.auth,
    headers: preset.headers,
    type: preset.type,
    ...(baseURL !== undefined ? { baseURL } : {}),
  };
  const notices: ProviderSetupNotice[] = [];
  let upstreamModels: UpstreamModelEntry[] = [];
  // 同名检查是异步的：期间已取消就不再发请求
  options.signal?.throwIfAborted();
  if (preset.fetchableModels) {
    const fetchKey = effectiveKey !== undefined && effectiveKey !== "" ? effectiveKey : undefined;
    try {
      upstreamModels = options.fetchModels
        ? await options.fetchModels(request, fetchKey, options.signal)
        : await fetchProviderModels(fetchConfig, request, fetchKey, options.signal);
      notices.push({
        code: "models_fetched",
        kind: "step",
        text: `已获取 ${upstreamModels.length} 个模型`,
      });
    } catch (e) {
      options.signal?.throwIfAborted();
      const status = upstreamStatus(e);
      if (status === 401 || status === 403) {
        notices.push({
          code: "models_unauthorized",
          kind: "step",
          text: `! 获取模型列表失败（HTTP ${status}）：密钥可能无效`,
        });
        notices.push({
          code: "models_unauthorized",
          kind: "print",
          text: "保存后可用 /provider key 更新密钥，再 /provider refresh 重试",
        });
      } else {
        const reason =
          status !== undefined ? `HTTP ${status}` : e instanceof Error ? e.message : String(e);
        const secrets = [effectiveKey, stagedAccount?.value].filter(
          (value): value is string => !!value,
        );
        const why = secrets.reduce((text, secret) => text.split(secret).join("[redacted]"), reason);
        notices.push({
          code: "models_failed",
          kind: "step",
          text: `! 获取模型列表失败（${why}）：模型将手动填写`,
        });
        notices.push({
          code: "models_failed",
          kind: "print",
          text: "保存后可用 /provider refresh 重试",
        });
      }
    }
  }
  options.signal?.throwIfAborted();
  const needsManualModel = upstreamModels.length === 0 && preset.auth?.kind === "external-file";
  const draftId = randomUUID();
  let table = drafts.get(config);
  if (table === undefined) {
    table = new Map();
    drafts.set(config, table);
  }
  const timer = setTimeout(() => {
    discardProvider(config, draftId);
  }, DRAFT_TTL);
  timer.unref();
  table.set(draftId, {
    timer,
    expiresAt: Date.now() + DRAFT_TTL,
    committing: false,
    commit: async (manualModelId) => {
      const id = manualModelId?.trim() ?? "";
      if (needsManualModel && id === "")
        throw new ProviderSetupError("modelId", "模型 ID 不能为空");
      if (loginId !== undefined && findPendingLogin(config, loginId) === undefined) {
        throw new ProviderSetupError("credential", "登录会话不存在或已结束，请重新登录");
      }
      const modelsToSave = needsManualModel ? [{ id }] : upstreamModels;
      // 写入前再查一次：准备之后可能有别的配置对象或进程保存了同名条目。
      await assertNameFree(config, providerId, options.workspaceRoot);
      // 同 id 的孤立凭据（条目已手工删掉而凭据残留）先清掉，新条目不继承旧密钥或旧账号。
      if (config.credentials.has(providerId)) {
        try {
          await config.credentials.delete(providerId);
        } catch {
          throw new ProviderSetupError("credential", "无法清理同名服务商残留的凭据");
        }
      }
      let wroteAccount = false;
      if (stagedAccount !== undefined) {
        try {
          if (config.credentials.backend() === "none") {
            if (config.credentials.setAccount === undefined) throw new Error("storage");
            await config.credentials.setAccount(
              providerId,
              stagedAccount.value,
              stagedAccount.storage,
            );
          } else await config.credentials.set(providerId, stagedAccount.value);
          wroteAccount = true;
        } catch {
          throw new ProviderSetupError("credential", "无法保存登录凭据");
        }
      }
      // models 字段写入上游声明的能力/价格/限额/接口（provider-setup.md 第 7 节）
      const models: Record<string, ModelOverrideShape> = {};
      for (const m of modelsToSave) {
        models[m.id] = {
          ...(preset.auth?.kind === "openai-siwc" ? { protocol: "openai-responses" as const } : {}),
          ...(m.displayName !== undefined ? { displayName: m.displayName } : {}),
          ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
          ...(m.maxOutputTokens !== undefined ? { maxOutputTokens: m.maxOutputTokens } : {}),
          ...(m.pricing !== undefined ? { pricing: m.pricing } : {}),
          ...(m.capabilities !== undefined ? { capabilities: m.capabilities } : {}),
          // ADR-0026 第 2 节：上游 supported_endpoints 原文随条目保存
          ...(m.endpoints !== undefined ? { endpoints: m.endpoints } : {}),
        };
      }

      // thinking.format 是协议格式开关；能力和档位只按模型声明。
      const thinking: ProviderEntryConfig["thinking"] = {
        ...(preset.thinkingFormat !== undefined ? { format: preset.thinkingFormat } : {}),
      };
      const modelCount = modelsToSave.length;
      try {
        await config.saveSetupProvider(
          {
            id: providerId,
            ...(preset.auth !== undefined ? { auth: preset.auth } : {}),
            ...(preset.headers !== undefined ? { headers: preset.headers } : {}),
            ...(preset.modelHeader !== undefined ? { modelHeader: preset.modelHeader } : {}),
            type: preset.type,
            ...(baseURL !== undefined ? { baseURL } : {}),
            ...(apiKeyEnv !== undefined ? { apiKeyEnv } : {}),
            ...(sessionHeader !== undefined ? { sessionHeader } : {}),
            ...(preset.modelsDevProvider !== undefined
              ? { modelsDevProvider: preset.modelsDevProvider }
              : {}),
            models,
            ...(Object.keys(thinking).length > 0 ? { thinking } : {}),
            ...(modelCount > 0
              ? { source: "upstream" as const, fetchedAt: new Date().toISOString() }
              : {}),
          },
          { ...(key !== undefined ? { key } : {}), mode: "create" },
        );
      } catch (e) {
        if (!(e instanceof ConfigError) || e.code !== "provider_exists") throw e;
        // 两次检查之间被抢先写入：撤回刚写的账号凭据，不留孤立记录。
        if (wroteAccount) await config.credentials.delete(providerId).catch(() => undefined);
        throw new ProviderSetupError("name", e.message);
      }
      if (loginId !== undefined) dropPendingLogin(config, loginId);

      const commitNotices: ProviderSetupNotice[] = [];
      const modelsDevWarning = await config.refreshModelsDev();
      if (modelsDevWarning !== undefined) {
        commitNotices.push({ code: "models_dev", kind: "print", text: `! ${modelsDevWarning}` });
      }
      return {
        providerId,
        modelCount,
        notices: commitNotices,
        message: `已保存 ${providerId}${modelCount > 0 ? `，${modelCount} 个模型` : ""}`,
      };
    },
  });
  return {
    draftId,
    modelCount: upstreamModels.length,
    models: upstreamModels.map(summarizeModel),
    notices,
    needsManualModel,
    steps: [
      ...description.fields.map((field) => setupFieldStep(field.key, values[field.key])),
      setupCredentialStep(description, credential),
      ...notices.filter((notice) => notice.kind === "step").map((notice) => notice.text),
    ],
  };
}

async function assertNameFree(
  config: RuntimeConfig,
  providerId: string,
  workspaceRoot: string | undefined,
): Promise<void> {
  if (providerId.includes("/")) throw new ProviderSetupError("name", "服务商名称不能包含 / 字符");
  const conflict = await config.findProviderConflict(providerId, workspaceRoot);
  if (conflict !== undefined) {
    throw new ProviderSetupError("name", `已有同名服务商 ${conflict.id}（${conflict.layer}）`);
  }
}

function summarizeModel(m: UpstreamModelEntry): PreparedModelSummary {
  return {
    id: m.id,
    ...(m.displayName !== undefined ? { displayName: m.displayName } : {}),
    ...(m.capabilities?.reasoning !== undefined ? { reasoning: m.capabilities.reasoning } : {}),
    ...(m.capabilities?.imageInput !== undefined ? { imageInput: m.capabilities.imageInput } : {}),
    ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
    ...(m.maxOutputTokens !== undefined ? { maxOutputTokens: m.maxOutputTokens } : {}),
  };
}

/* ---------------- 编辑自定义服务商（ADR-0046 修订，U-07） ---------------- */

/**
 * 编辑对话框的可改字段。服务商 id 锁定（会话、最近模型、默认模型都按它
 * 引用）；密钥不在这里修改（仍走 setCredential）。未提供的字段保留原值。
 */
export interface UpdateSetupProviderPatch {
  /** 显示名：undefined 保留，空串清除，其余写入条目 displayName */
  displayName?: string | undefined;
  /** undefined 保留，空串清除（仅 anthropic 允许，回落官方端点），其余替换 */
  baseURL?: string | undefined;
  /** 协议（适配器类型）；缺省保留 */
  type?: "openai-compatible" | "anthropic" | undefined;
  /** 自定义请求头：undefined 保留，空表清除，其余整表替换 */
  headers?: Record<string, string> | undefined;
  /** 会话标识请求头名：undefined 保留，空串清除 */
  sessionHeader?: string | undefined;
  /**
   * 编辑时以候选配置新获取的模型列表（probeSetupProviderModels 的结果）；
   * 提供时随条目更新 models/source/fetchedAt，缺省保留原清单。
   */
  models?: UpstreamModelEntry[] | undefined;
}

export interface UpdateSetupProviderResult {
  providerId: string;
  /** 保存后条目声明的模型数 */
  modelCount: number;
  message: string;
}

/**
 * 内置预设写出的条目（id 与 preset.defaultName 一致且地址仍是预设地址）：
 * 地址/协议由程序维护，编辑入口只对自定义条目开放。自定义服务商的名称由
 * 用户起、地址必填（custom-anthropic 可留官方端点），不会与内置条目同形。
 */
function isPresetMaintainedEntry(entry: ProviderEntryConfig): boolean {
  return listProviderPresets().some(
    (preset) =>
      preset.defaultName !== "" &&
      preset.defaultName === entry.id &&
      preset.baseURL === entry.baseURL,
  );
}

const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * 编辑自定义服务商（U-07）：只允许 providers.json 里的自定义条目；内置
 * 预设条目与高层只读条目拒绝。保存走 saveSetupProvider 的 replace 模式
 * （逐模型用户编辑由它自动保留）。
 */
export async function updateSetupProvider(
  config: RuntimeConfig,
  providerId: string,
  patch: UpdateSetupProviderPatch,
): Promise<UpdateSetupProviderResult> {
  const entry = await config.describeSetupProvider(providerId);
  if (entry === undefined) {
    throw new ProviderSetupError(
      "providerId",
      `服务商 "${providerId}" 不是向导写入的条目，不能在程序里编辑`,
    );
  }
  if (isPresetMaintainedEntry(entry)) {
    throw new ProviderSetupError(
      "preset",
      `${providerId} 是内置服务商，地址与协议由程序维护，不提供编辑`,
    );
  }

  const type = patch.type ?? entry.type ?? "openai-compatible";
  let baseURL: string | undefined;
  if (patch.baseURL !== undefined) {
    const trimmed = patch.baseURL.trim();
    baseURL = trimmed === "" ? undefined : trimmed;
  } else {
    baseURL = entry.baseURL;
  }
  if (type === "openai-compatible" && baseURL === undefined) {
    throw new ProviderSetupError("baseURL", "服务地址不能为空");
  }

  const trimToUndefined = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim() ?? "";
    return trimmed === "" ? undefined : trimmed;
  };
  const displayName =
    patch.displayName === undefined ? entry.displayName : trimToUndefined(patch.displayName);
  const sessionHeader =
    patch.sessionHeader === undefined ? entry.sessionHeader : trimToUndefined(patch.sessionHeader);
  let headers: Record<string, string> | undefined;
  if (patch.headers === undefined) {
    headers = entry.headers;
  } else {
    headers = {};
    for (const [name, value] of Object.entries(patch.headers)) {
      if (!HEADER_NAME_RE.test(name)) {
        throw new ProviderSetupError("headers", `请求头名称无效：${name}`);
      }
      const trimmed = value.trim();
      if (trimmed === "") {
        throw new ProviderSetupError("headers", `请求头 ${name} 的值不能为空`);
      }
      headers[name] = trimmed;
    }
    if (Object.keys(headers).length === 0) headers = undefined;
  }

  const updated: ProviderEntryConfig = {
    ...entry,
    type,
    baseURL,
    displayName,
    sessionHeader,
    headers,
  };
  let modelCount = Object.keys(entry.models ?? {}).length;
  if (patch.models !== undefined) {
    const models: Record<string, ModelOverrideShape> = {};
    for (const m of patch.models) {
      models[m.id] = {
        ...(m.displayName !== undefined ? { displayName: m.displayName } : {}),
        ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
        ...(m.maxOutputTokens !== undefined ? { maxOutputTokens: m.maxOutputTokens } : {}),
        ...(m.pricing !== undefined ? { pricing: m.pricing } : {}),
        ...(m.capabilities !== undefined ? { capabilities: m.capabilities } : {}),
        ...(m.endpoints !== undefined ? { endpoints: m.endpoints } : {}),
      };
    }
    updated.models = models;
    updated.source = "upstream";
    updated.fetchedAt = new Date().toISOString();
    modelCount = patch.models.length;
  }
  await config.saveSetupProvider(updated, { mode: "replace" });
  return {
    providerId,
    modelCount,
    message: `已更新 ${providerId}${patch.models !== undefined ? `，${modelCount} 个模型` : ""}`,
  };
}

export interface ProbeSetupProviderParams {
  providerId: string;
  /** 候选协议 */
  type: "openai-compatible" | "anthropic";
  /** 候选地址；anthropic 留空表示官方端点 */
  baseURL?: string | undefined;
  /** 候选自定义请求头；缺省用条目当前值 */
  headers?: Record<string, string> | undefined;
}

/**
 * 编辑前的模型列表探测（U-07）：用对话框里的候选配置向候候选地址发一次
 * GET /models；凭据按条目现有解析规则取（apiKeyEnv → 环境变量 → 凭据存储），
 * 不修改任何配置与凭据。失败原样抛给调用方，由界面决定「仍然保存」。
 */
export async function probeSetupProviderModels(
  config: RuntimeConfig,
  params: ProbeSetupProviderParams,
  options: AddProviderOptions = {},
): Promise<UpstreamModelEntry[]> {
  const entry = await config.describeSetupProvider(params.providerId);
  if (entry === undefined) {
    throw new ProviderSetupError("providerId", `服务商 "${params.providerId}" 不是向导写入的条目`);
  }
  // 凭据解析顺序与适配器/refreshUpstreamLimits 一致
  const env = options.env ?? ((name: string) => process.env[name]);
  const envKey = entry.apiKeyEnv !== undefined ? env(entry.apiKeyEnv) : undefined;
  const key =
    entry.auth !== undefined && entry.auth.kind !== "apiKey"
      ? undefined
      : envKey !== undefined && envKey !== ""
        ? envKey
        : await config.credentials.get(params.providerId);
  const request: FetchModelsRequest & { apiKeyEnv?: string | undefined } = {
    id: params.providerId,
    auth: entry.auth,
    headers: params.headers ?? entry.headers,
    type: params.type,
    ...(params.baseURL !== undefined && params.baseURL.trim() !== ""
      ? { baseURL: params.baseURL.trim() }
      : {}),
    apiKeyEnv: entry.apiKeyEnv,
  };
  options.signal?.throwIfAborted();
  return options.fetchModels !== undefined
    ? await options.fetchModels(request, key, options.signal)
    : await fetchProviderModels(config, request, key, options.signal);
}

/** 不需要中间确认的调用者可一次提交；客户端向导使用 prepare/commit。 */
export async function addProvider(
  config: RuntimeConfig,
  input: AddProviderInput,
  options: AddProviderOptions = {},
): Promise<AddProviderResult> {
  const prepared = await prepareProvider(config, input, options);
  try {
    const result = await commitProvider(config, prepared.draftId, { manualModelId: input.modelId });
    return { ...result, notices: [...prepared.notices, ...result.notices] };
  } finally {
    discardProvider(config, prepared.draftId);
  }
}
