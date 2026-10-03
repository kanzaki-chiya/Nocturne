/**
 * 服务商配置流程（provider-setup-flow）的 TUI 适配：
 * 线性 ask()/askSecret()/print() 流程 → 弹层状态机。每次 ask 挂起为一个
 * 输入框状态，用户 Enter 后 resolve，Esc 后 reject(SetupAbort)。
 * print() 追加到日志区。密钥经 askSecret 回显为 *（WizardView 渲染）。
 */
import { appendFileSync } from "node:fs";
import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";

import {
  ProviderLoginError,
  type AddProviderOptions,
  type DraftLoginTarget,
  type ProviderEntryConfig,
  type RuntimeConfig,
} from "@nocturne/core";

import { runProviderLogin, type LoginPrompts } from "./provider-login.js";
import { SetupAbort } from "./provider-prompts.js";
import {
  runProviderKeyFlow,
  runProviderSetupFlow,
  type SetupFlowHooks,
} from "./provider-setup-flow.js";

export interface WizardPrompt {
  text: string;
  secret: boolean;
  /** TUI 保存前确认，不添加 Core 步骤。 */
  confirmation?: boolean;
  /** 提示下方的说明小字（omp 风格表单：强调色问题 + 灰色说明） */
  hint?: string | undefined;
  /** 多选模式（ADR-0018/0019 思考档位勾选）：渲染 checkbox 列表 */
  multi?: { options: string[]; exclusiveIndex?: number | undefined } | undefined;
}

export interface WizardState {
  mode?: "add" | "key" | "login";
  login?: { authorizeUrl: string; browserOpened: boolean; userCode?: string } | undefined;
  /** 临时显示；函数不进入 JSON 调试记录，确认后闭包释放密钥。 */
  secretDisplay?: (() => { key: string; envName: string } | undefined) | undefined;
  error?: string | undefined;
  /** 向导是否运行中 */
  running: boolean;
  /** print() 累积的日志行（失败原因等独立行） */
  logs: readonly string[];
  /** 已完成步骤的一行摘要（渲染为 "a · b · c" 折叠行） */
  steps: readonly string[];
  /** 瞬时进度行（"正在获取模型列表…"），被下一次 step/print 覆盖 */
  busyText?: string | undefined;
  /** 当前挂起的输入提示（undefined = 流程在异步步骤中，如拉取模型列表） */
  prompt?: WizardPrompt | undefined;
  /** 流程已结束（done/cancel/error 之一，供视图显示收尾） */
  done?: "done" | "cancel" | "error" | undefined;
  /** 结束时的说明行 */
  doneText?: string | undefined;
}

type Pending =
  | { kind: "text"; resolve: (v: string) => void; reject: (e: unknown) => void }
  | { kind: "multi"; resolve: (v: number[]) => void; reject: (e: unknown) => void };

export type WizardOutcome =
  | { kind: "added"; providerId: string; modelCount: number }
  | { kind: "key-updated"; providerId: string }
  | { kind: "logged-in"; providerId: string }
  | { kind: "cancel" }
  | { kind: "error"; message: string };

export type WizardStart =
  { kind: "add"; presetId?: string | undefined } | { kind: "key" | "login"; providerId: string };

export interface ProviderWizard {
  state: WizardState;
  /** 输入框提交（Enter） */
  submit(value: string): void;
  /** 多选确认（checkbox 模式 Enter）：提交选中下标 */
  submitMulti(indices: number[]): void;
  /** 取消（Esc / Ctrl+C 由调用方路由） */
  cancel(): void;
  /** 启动向导；onDone 在收尾时回调（重载配置/刷新列表由调用方做） */
  start(s: WizardStart, onDone: (o: WizardOutcome) => void): void;
}

export function useProviderWizard(
  config: RuntimeConfig | undefined,
  addOptions?: AddProviderOptions,
): ProviderWizard {
  const [state, updateState] = useState<WizardState>({ running: false, logs: [], steps: [] });
  const setState = useCallback((update: SetStateAction<WizardState>) => {
    updateState((previous) => {
      const next = typeof update === "function" ? update(previous) : update;
      if (process.env.NOCTURNE_DEBUG_STATE !== undefined) {
        try {
          appendFileSync(process.env.NOCTURNE_DEBUG_STATE, JSON.stringify(next) + "\n");
        } catch {
          /* 调试用途，失败忽略；state 不包含输入的密钥。 */
        }
      }
      return next;
    });
  }, []);
  const pendingRef = useRef<Pending | undefined>(undefined);
  const configRef = useRef(config);
  configRef.current = config;
  const generation = useRef(0);
  const cancelRef = useRef<() => void>(() => undefined);
  useEffect(
    () => () => {
      cancelRef.current();
      generation.current++;
    },
    [],
  );

  const submit = useCallback((value: string) => {
    const pending = pendingRef.current;
    if (pending?.kind !== "text") return;
    pendingRef.current = undefined;
    setState((st) => ({ ...st, prompt: undefined, error: undefined }));
    pending.resolve(value);
  }, []);
  const submitMulti = useCallback((indices: number[]) => {
    const pending = pendingRef.current;
    if (pending?.kind !== "multi") return;
    pendingRef.current = undefined;
    setState((st) => ({ ...st, prompt: undefined, error: undefined }));
    pending.resolve(indices);
  }, []);
  const cancel = useCallback(() => {
    cancelRef.current();
  }, []);

  const start = useCallback(
    (request: WizardStart, onDone: (o: WizardOutcome) => void): void => {
      const config = configRef.current;
      if (config === undefined) {
        onDone({ kind: "error", message: "当前环境不支持 /provider 配置" });
        return;
      }
      const current = ++generation.current;
      const controller = new AbortController();
      let submitting = false;
      let loggingIn = false;
      let submitController: AbortController | undefined;
      let displayedKey: { key: string; envName: string } | undefined;
      const guard = () => {
        if (generation.current !== current || controller.signal.aborted) throw new SetupAbort();
      };
      setState({ running: true, logs: [], steps: [], mode: request.kind });
      const ask = (prompt: WizardPrompt): Promise<string | number[]> => {
        guard();
        setState((st) => ({ ...st, prompt, busyText: undefined }));
        return new Promise<string | number[]>((resolve, reject) => {
          pendingRef.current = prompt.multi
            ? { kind: "multi", resolve, reject }
            : { kind: "text", resolve, reject };
        });
      };
      const io: LoginPrompts = {
        cancelPending: () => {
          const pending = pendingRef.current;
          pendingRef.current = undefined;
          pending?.reject(new SetupAbort());
          if (generation.current === current) setState((st) => ({ ...st, prompt: undefined }));
        },
        ask: (text, opts) => ask({ text, secret: false, hint: opts?.hint }) as Promise<string>,
        askSecret: (text, opts) => ask({ text, secret: true, hint: opts?.hint }) as Promise<string>,
        chooseMulti: (text, options, opts) =>
          ask({
            text,
            secret: false,
            hint: opts?.hint,
            multi: { options: [...options], exclusiveIndex: opts?.exclusiveIndex },
          }) as Promise<number[]>,
        busy: (busyText) => {
          guard();
          setState((st) => ({ ...st, busyText }));
        },
        step: (text) => {
          guard();
          setState((st) => ({ ...st, steps: [...st.steps, text], busyText: undefined }));
        },
        print: (text) => {
          guard();
          setState((st) => ({
            ...st,
            logs: [...st.logs, ...text.split("\n")],
            busyText: undefined,
          }));
        },
      };
      const showError = (error: Error): boolean => {
        setState((st) => ({ ...st, error: error.message }));
        return true;
      };
      const login = async (
        target: string | DraftLoginTarget,
        entry?: ProviderEntryConfig,
      ): Promise<string | undefined> => {
        guard();
        loggingIn = true;
        try {
          const result = await runProviderLogin(config, target, io, {
            ...(entry !== undefined ? { entry } : {}),
            signal: controller.signal,
            onWaiting: (authorizeUrl, browserOpened, userCode) => {
              guard();
              setState((st) => ({
                ...st,
                login: {
                  authorizeUrl,
                  browserOpened,
                  ...(userCode !== undefined ? { userCode } : {}),
                },
              }));
            },
            showUnstoredKey: async (key, envName) => {
              guard();
              io.cancelPending?.();
              displayedKey = { key, envName };
              setState((st) => ({ ...st, secretDisplay: () => displayedKey }));
              try {
                await ask({
                  text: "密钥仅显示一次，请保存环境变量命令",
                  secret: false,
                  confirmation: true,
                });
              } finally {
                displayedKey = undefined;
                if (generation.current === current)
                  setState((st) => ({ ...st, secretDisplay: undefined }));
              }
            },
          });
          return result.loginId;
        } finally {
          loggingIn = false;
          if (generation.current === current) setState((st) => ({ ...st, login: undefined }));
        }
      };
      cancelRef.current = () => {
        if (loggingIn) {
          controller.abort();
          displayedKey = undefined;
          io.cancelPending?.();
          return;
        }
        if (submitting) {
          // 获取模型列表期间取消：中止请求并回到确认页；已进入保存则放行到完成
          submitController?.abort();
          return;
        }
        if (pendingRef.current) {
          const pending = pendingRef.current;
          pendingRef.current = undefined;
          pending.reject(new SetupAbort());
        }
      };
      const hooks: SetupFlowHooks = {
        login: async (target) => {
          const loginId = await login(target);
          if (loginId === undefined) throw new ProviderLoginError("missing");
          return loginId;
        },
        confirm: async () => {
          await ask({ text: "保存配置", secret: false, confirmation: true });
          guard();
        },
        newSignal: () => {
          submitController = new AbortController();
          return submitController.signal;
        },
        onSubmitError: showError,
        submitting: (on) => {
          submitting = on;
        },
        addOptions,
      };
      const promise: Promise<WizardOutcome> =
        request.kind === "add"
          ? runProviderSetupFlow(io, config, hooks, { presetId: request.presetId }).then(
              (result): WizardOutcome => ({
                kind: "added",
                providerId: result.providerId,
                modelCount: result.modelCount,
              }),
            )
          : request.kind === "login"
            ? (async (): Promise<WizardOutcome> => {
                const entry = config.base.providers.find((item) => item.id === request.providerId);
                if (!entry) throw new ProviderLoginError("missing");
                await login(request.providerId, entry);
                return { kind: "logged-in", providerId: request.providerId };
              })()
            : runProviderKeyFlow(io, config, request.providerId, {
                onSaveError: showError,
                submitting: (on) => {
                  submitting = on;
                  if (on) setState((st) => ({ ...st, busyText: "正在保存…" }));
                },
              }).then((): WizardOutcome => ({
                kind: "key-updated",
                providerId: request.providerId,
              }));
      void promise
        .then((outcome) => {
          if (generation.current !== current) return;
          setState((st) => ({
            ...st,
            running: false,
            prompt: undefined,
            busyText: undefined,
            login: undefined,
            secretDisplay: undefined,
            done: "done",
            doneText:
              outcome.kind === "added"
                ? `已保存 ${outcome.providerId}${outcome.modelCount > 0 ? `，${outcome.modelCount} 个模型` : ""}`
                : outcome.kind === "key-updated"
                  ? `已更新 ${outcome.providerId} 的密钥`
                  : outcome.kind === "logged-in"
                    ? `已登录 ${outcome.providerId}`
                    : "",
          }));
          onDone(outcome);
        })
        .catch((error: unknown) => {
          if (generation.current !== current) return;
          const outcome: WizardOutcome =
            error instanceof SetupAbort
              ? { kind: "cancel" }
              : {
                  kind: "error",
                  message: error instanceof Error ? error.message : String(error),
                };
          setState((st) => ({
            ...st,
            running: false,
            prompt: undefined,
            busyText: undefined,
            login: undefined,
            secretDisplay: undefined,
            done: outcome.kind === "cancel" ? "cancel" : "error",
            doneText: outcome.kind === "cancel" ? "已取消" : outcome.message,
          }));
          onDone(outcome);
        });
    },
    [addOptions],
  );
  return { state, submit, submitMulti, cancel, start };
}
