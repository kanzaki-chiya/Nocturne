/**
 * 服务商配置向导的客户端外壳（provider-setup.md 第 6 节）：
 * 按 Core 的 describeProviderSetup 描述依次收集字段与凭据，交给 prepareProvider / commitProvider。
 * 步骤顺序、提问文案、结果行都来自 Core 的描述与返回值；这里不判断预设差异。
 * CLI 逐行向导与 TUI 服务商页共用本流程，各自实现 SetupPrompts 与 SetupFlowHooks。
 */
import {
  prepareProvider,
  commitProvider,
  discardProvider,
  credentialBackendLabel,
  describeProviderSetup,
  listProviderPresets,
  setupCredentialNotice,
  setupCredentialStep,
  setupFieldStep,
  type AddProviderOptions,
  type AddProviderResult,
  type DraftLoginTarget,
  type ProviderCredentialInput,
  type RuntimeConfig,
} from "@nocturne/core";

import { SetupAbort, type SetupPrompts } from "./provider-prompts.js";

export interface SetupFlowHooks {
  /** 浏览器登录：客户端显示授权并等待完成，返回交给 prepareProvider 的 loginId */
  login(target: DraftLoginTarget): Promise<string>;
  /** 保存前的确认页（TUI 弹层最后一步）；缺省直接提交 */
  confirm?: (() => Promise<void>) | undefined;
  /** 每次提交前取一个新的取消信号（TUI 在获取模型列表期间 Esc 取消） */
  newSignal?: (() => AbortSignal) | undefined;
  /**
   * 提交失败的处理：返回 true 表示已向用户显示原因、回到确认页重试；
   * 缺省则错误向上抛出（行式 CLI）。
   */
  onSubmitError?: ((error: Error) => boolean) | undefined;
  /** 提交期间（获取模型列表与保存）的开关，TUI 用来屏蔽取消按键 */
  submitting?: ((on: boolean) => void) | undefined;
  /** 注入 prepareProvider 的选项（测试注入离线 fetchModels 与 env） */
  addOptions?: AddProviderOptions | undefined;
}

export interface SetupFlowOptions {
  presetId?: string | undefined;
}

const isAbort = (e: unknown): boolean => e instanceof SetupAbort;

export async function runProviderSetupFlow(
  prompts: SetupPrompts,
  config: RuntimeConfig,
  hooks: SetupFlowHooks,
  options: SetupFlowOptions = {},
): Promise<AddProviderResult> {
  let presetId = options.presetId;
  if (presetId === undefined) {
    const presets = listProviderPresets();
    const lines = presets.map((p, i) => `  ${i + 1}) ${p.label}`);
    prompts.print(`选择服务商：\n${lines.join("\n")}`);
    const pick = await prompts.ask("> ");
    const chosen = presets[Number.parseInt(pick, 10) - 1];
    if (chosen === undefined) throw new SetupAbort();
    presetId = chosen.id;
  }
  const description = describeProviderSetup(config, presetId);

  // 名称 / 地址 / 会话头：预设写死的直接用，其余询问
  const values: Record<string, string> = {};
  for (const field of description.fields) {
    let value = field.fixed;
    if (value === undefined) {
      value = await prompts.ask(field.prompt, { hint: field.hint });
      if (value === "" && field.required) throw new SetupAbort();
    }
    values[field.key] = value;
    prompts.step(setupFieldStep(field.key, value));
  }
  const name = values.name ?? "";
  const baseURL = values.baseURL === "" ? undefined : values.baseURL;

  // 凭据
  const { credential: setup } = description;
  let chosen: "login" | "apiKey" | undefined;
  if (setup.choose !== undefined) {
    const picks = await prompts.chooseMulti(
      setup.choose.prompt,
      setup.choose.options.map((o) => o.label),
    );
    const only = picks.length === 1 ? setup.choose.options[picks[0] ?? -1] : undefined;
    if (only === undefined) throw new SetupAbort();
    chosen = only.method;
  }
  let credential: ProviderCredentialInput | undefined;
  const first = setup.methods[0];
  if (chosen === "login" || (chosen === undefined && first?.kind === "login")) {
    const loginId = await hooks.login({ presetId: description.presetId, name, baseURL });
    credential = { kind: "login", loginId };
  } else if (first?.kind === "external-file") {
    credential = { kind: "external-file" };
  } else {
    const apiKey = setup.methods.find((m) => m.kind === "apiKey");
    if (apiKey?.kind === "apiKey" && apiKey.available) {
      const key = await prompts.askSecret(apiKey.prompt, { hint: apiKey.hint });
      if (key !== "") credential = { kind: "apiKey", key };
    }
    if (credential === undefined) {
      const env = setup.methods.find((m) => m.kind === "env");
      if (env?.kind !== "env") throw new SetupAbort();
      const input = await prompts.ask(env.prompt, { hint: env.hint });
      credential = { kind: "env", name: input !== "" ? input : env.defaultName };
    }
  }
  const finalCredential: ProviderCredentialInput = credential;
  prompts.step(setupCredentialStep(description, finalCredential));
  const notice = setupCredentialNotice(description, finalCredential);
  if (notice !== undefined) prompts.print(notice);

  let prepared;
  for (;;) {
    const signal = hooks.newSignal?.();
    hooks.submitting?.(true);
    prompts.busy(description.fetchableModels ? "正在获取模型列表…" : "正在准备…");
    try {
      prepared = await prepareProvider(
        config,
        {
          presetId: description.presetId,
          name,
          baseURL,
          sessionHeader: values.sessionHeader,
          credential: finalCredential,
        },
        { ...hooks.addOptions, ...(signal !== undefined ? { signal } : {}) },
      );
      break;
    } catch (e) {
      if (isAbort(e)) throw e;
      if (signal?.aborted !== true && !(e instanceof Error && hooks.onSubmitError?.(e) === true))
        throw e;
    } finally {
      hooks.submitting?.(false);
    }
    // 取消请求后保留输入，由用户决定是否重新准备。
    await hooks.confirm?.();
  }
  try {
    for (const n of prepared.notices) {
      if (n.kind === "step") prompts.step(n.text);
      else prompts.print(n.text);
    }
    let manualModelId: string | undefined;
    if (prepared.needsManualModel && description.manualModel) {
      manualModelId = (
        await prompts.ask(description.manualModel.prompt, { hint: description.manualModel.hint })
      ).trim();
      if (manualModelId === "") throw new SetupAbort();
    }
    for (;;) {
      await hooks.confirm?.();
      hooks.submitting?.(true);
      prompts.busy("正在保存…");
      try {
        const result = await commitProvider(config, prepared.draftId, { manualModelId });
        for (const n of result.notices) {
          if (n.kind === "step") prompts.step(n.text);
          else prompts.print(n.text);
        }
        prompts.print(result.message);
        return result;
      } catch (e) {
        if (isAbort(e) || !(e instanceof Error && hooks.onSubmitError?.(e) === true)) throw e;
      } finally {
        hooks.submitting?.(false);
      }
    }
  } finally {
    discardProvider(config, prepared.draftId);
  }
}

export interface KeyFlowHooks {
  /** 保存失败的处理：返回 true 表示已显示原因，重新询问密钥；缺省向上抛出 */
  onSaveError?: ((error: Error) => boolean) | undefined;
  /** 保存期间的开关，TUI 用来屏蔽取消按键 */
  submitting?: ((on: boolean) => void) | undefined;
}

/**
 * /provider key <name>：更新单个服务商的密钥（provider-setup.md 第 1 节）。
 * 新密钥经 config.setCredential 写入系统后端后即完成——不做连接测试，
 * 密钥有效性由下一次真实请求检验。
 */
export async function runProviderKeyFlow(
  prompts: SetupPrompts,
  config: RuntimeConfig,
  providerId: string,
  hooks: KeyFlowHooks = {},
): Promise<void> {
  const backend = config.credentials.backend();
  if (backend === "none") {
    prompts.print("! 系统凭据后端不可用，无法保存密钥；请改用 apiKeyEnv 环境变量方式");
    return;
  }
  const prompt = `新的 API Key（${providerId}）：`;
  let key = await prompts.askSecret(prompt, { hint: "输入不回显；直接回车 = 取消" });
  if (key === "") {
    prompts.print("已取消（未输入密钥）");
    return;
  }
  for (;;) {
    hooks.submitting?.(true);
    try {
      await config.setCredential(providerId, key);
      break;
    } catch (e) {
      if (isAbort(e)) throw e;
      if (!(e instanceof Error) || hooks.onSaveError?.(e) !== true) throw e;
    } finally {
      hooks.submitting?.(false);
    }
    key = await prompts.askSecret(prompt);
    if (key === "") throw new SetupAbort();
  }
  prompts.print(`密钥已交给 ${credentialBackendLabel(backend)} 加密保存`);
}
