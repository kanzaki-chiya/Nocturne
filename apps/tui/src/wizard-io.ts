/**
 * Core 向导编排（runProviderSetupWizard/runProviderKeyWizard）的 TUI 适配：
 * 线性 ask()/askSecret()/print() 流程 → 弹层状态机。每次 ask 挂起为一个
 * 输入框状态，用户 Enter 后 resolve，Esc 后 reject(WizardAbort)。
 * print() 追加到日志区。密钥经 askSecret 回显为 *（WizardView 渲染）。
 */
import { appendFileSync } from "node:fs";
import { useCallback, useRef, useState, type SetStateAction } from "react";

import {
  fetchModels,
  type UpstreamModelEntry,
  listProviderPresets,
  runProviderKeyWizard,
  runProviderSetupWizard,
  WizardAbort,
  type RuntimeConfig,
  type SetupWizardDeps,
  type WizardIo,
  type WizardResult,
} from "@nocturne/core";

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
  mode?: "add" | "key";
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
  | { kind: "cancel" }
  | { kind: "error"; message: string };

export type WizardStart =
  { kind: "add"; presetId?: string | undefined } | { kind: "key"; providerId: string };

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

/** TUI 侧依赖注入：provider 层能力 + 进程环境变量 */
export function tuiWizardDeps(
  env: (n: string) => string | undefined = (n) => process.env[n],
  signal?: AbortSignal,
): SetupWizardDeps {
  return {
    presets: () => listProviderPresets(),
    fetchModels: (req, key) => fetchModels(req, key, signal),
    env,
  };
}

export function useProviderWizard(
  config: RuntimeConfig | undefined,
  deps?: SetupWizardDeps,
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
      const run = (replay: readonly (string | number[])[] = []): void => {
        const current = ++generation.current;
        const controller = new AbortController();
        const answers: (string | number[])[] = [];
        let fetching = false;
        let saving = false;
        let lastPrompt: WizardPrompt | undefined;
        const guard = () => {
          if (generation.current !== current || controller.signal.aborted) throw new WizardAbort();
        };
        setState({ running: true, logs: [], steps: [], mode: request.kind });
        const ask = (prompt: WizardPrompt): Promise<string | number[]> => {
          guard();
          lastPrompt = prompt;
          const recorded = replay[answers.length];
          if (recorded !== undefined && !prompt.confirmation) {
            answers.push(recorded);
            return Promise.resolve(recorded);
          }
          setState((st) => ({ ...st, prompt, busyText: undefined }));
          return new Promise<string | number[]>((resolve, reject) => {
            const accept = (value: string | number[]) => {
              if (!prompt.confirmation) answers.push(value);
              resolve(value);
            };
            pendingRef.current = prompt.multi
              ? { kind: "multi", resolve: accept, reject }
              : { kind: "text", resolve: accept, reject };
          });
        };
        const io: WizardIo = {
          ask: (text, opts) => ask({ text, secret: false, hint: opts?.hint }) as Promise<string>,
          askSecret: (text, opts) =>
            ask({ text, secret: true, hint: opts?.hint }) as Promise<string>,
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
        // 只包装本次调用，重放收集步骤时不执行存储；Core 仍决定步骤顺序。
        const wrapped = Object.create(config) as RuntimeConfig;
        wrapped.saveSetupProvider = async (entry, opts) => {
          guard();
          for (;;) {
            await ask({ text: "保存配置", secret: false, confirmation: true });
            guard();
            saving = true;
            setState((st) => ({ ...st, busyText: "正在保存…" }));
            try {
              await config.saveSetupProvider(entry, opts);
              return;
            } catch (error) {
              setState((st) => ({
                ...st,
                error: error instanceof Error ? error.message : String(error),
              }));
            } finally {
              saving = false;
            }
          }
        };
        wrapped.setCredential = async (providerId, initialKey) => {
          let key = initialKey;
          for (;;) {
            guard();
            saving = true;
            setState((st) => ({ ...st, busyText: "正在保存…" }));
            try {
              await config.setCredential(providerId, key);
              return;
            } catch (error) {
              setState((st) => ({
                ...st,
                error: error instanceof Error ? error.message : String(error),
              }));
            } finally {
              saving = false;
            }
            key = (await ask(lastPrompt ?? { text: "API Key", secret: true })) as string;
            if (key === "") throw new WizardAbort();
          }
        };
        wrapped.refreshModelsDev = async () => {
          guard();
          return config.refreshModelsDev();
        };
        const source = deps ?? tuiWizardDeps(undefined, controller.signal);
        const wrappedDeps: SetupWizardDeps = {
          ...source,
          fetchModels: async (req, key) => {
            guard();
            fetching = true;
            try {
              // 注入测试依赖也受取消控制；真实 GET 将同一 signal 传到 fetch。
              return await new Promise<UpstreamModelEntry[]>((resolve, reject) => {
                const abort = () => {
                  reject(new WizardAbort());
                };
                controller.signal.addEventListener("abort", abort, { once: true });
                source
                  .fetchModels(req, key)
                  .then(resolve, reject)
                  .finally(() => {
                    controller.signal.removeEventListener("abort", abort);
                  });
              });
            } finally {
              fetching = false;
            }
          },
        };
        cancelRef.current = () => {
          if (saving) return;
          if (fetching) {
            controller.abort();
            run(answers.slice(0, -1));
            return;
          }
          if (pendingRef.current) {
            const pending = pendingRef.current;
            pendingRef.current = undefined;
            pending.reject(new WizardAbort());
          }
        };
        const promise =
          request.kind === "add"
            ? runProviderSetupWizard(io, wrapped, wrappedDeps, { presetId: request.presetId }).then(
                (result: WizardResult): WizardOutcome => ({
                  kind: "added",
                  providerId: result.providerId,
                  modelCount: result.modelCount,
                }),
              )
            : runProviderKeyWizard(io, wrapped, request.providerId).then((): WizardOutcome => ({
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
              done: "done",
              doneText:
                outcome.kind === "added"
                  ? `已保存 ${outcome.providerId}${outcome.modelCount > 0 ? `，${outcome.modelCount} 个模型` : ""}`
                  : outcome.kind === "key-updated"
                    ? `已更新 ${outcome.providerId} 的密钥`
                    : "",
            }));
            onDone(outcome);
          })
          .catch((error: unknown) => {
            if (generation.current !== current) return;
            const outcome: WizardOutcome =
              error instanceof WizardAbort
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
              done: outcome.kind === "cancel" ? "cancel" : "error",
              doneText: outcome.kind === "cancel" ? "已取消" : outcome.message,
            }));
            onDone(outcome);
          });
      };
      run();
    },
    [deps],
  );
  return { state, submit, submitMulti, cancel, start };
}
