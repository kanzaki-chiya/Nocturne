/**
 * Core 向导编排（runProviderSetupWizard/runProviderKeyWizard）的 TUI 适配：
 * 线性 ask()/askSecret()/print() 流程 → 弹层状态机。每次 ask 挂起为一个
 * 输入框状态，用户 Enter 后 resolve，Esc 后 reject(WizardAbort)。
 * print() 追加到日志区。密钥经 askSecret 回显为 *（WizardView 渲染）。
 */
import { useCallback, useRef, useState } from "react";

import {
  fetchModels,
  listProviderPresets,
  runProviderKeyWizard,
  runProviderSetupWizard,
  runProviderThinkingWizard,
  WizardAbort,
  type RuntimeConfig,
  type SetupWizardDeps,
  type WizardIo,
  type WizardResult,
} from "@nocturne/core";

export interface WizardPrompt {
  text: string;
  secret: boolean;
  /** 多选模式（ADR-0018 思考档位勾选）：渲染 checkbox 列表 */
  multi?: { options: string[] } | undefined;
}

export interface WizardState {
  /** 向导是否运行中 */
  running: boolean;
  /** print() 累积的日志行 */
  logs: readonly string[];
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
  | { kind: "added"; providerId: string; model?: string | undefined }
  | { kind: "key-updated"; providerId: string }
  | { kind: "thinking-updated"; providerId: string }
  | { kind: "cancel" }
  | { kind: "error"; message: string };

export type WizardStart =
  | { kind: "add"; presetId?: string | undefined }
  | { kind: "key"; providerId: string }
  | { kind: "thinking"; providerId: string };

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
): SetupWizardDeps {
  return {
    presets: () => listProviderPresets(),
    fetchModels: (req, key) => fetchModels(req, key),
    env,
  };
}

export function useProviderWizard(
  config: RuntimeConfig | undefined,
  deps?: SetupWizardDeps,
): ProviderWizard {
  const [state, setState] = useState<WizardState>({ running: false, logs: [] });
  const pendingRef = useRef<Pending | undefined>(undefined);
  const depsRef = useRef(deps ?? tuiWizardDeps());
  const configRef = useRef(config);
  configRef.current = config;

  const settle = useCallback((patch: Partial<WizardState>) => {
    setState((s) => ({ ...s, ...patch }));
  }, []);

  // io 只在 settle/pendingRef 上闭包，渲染间重建无妨；start 捕获当次实例即可
  const io: WizardIo = {
    ask: (prompt) =>
      new Promise<string>((resolve, reject) => {
        pendingRef.current = { kind: "text", resolve, reject };
        settle({ prompt: { text: prompt, secret: false } });
      }),
    askSecret: (prompt) =>
      new Promise<string>((resolve, reject) => {
        pendingRef.current = { kind: "text", resolve, reject };
        settle({ prompt: { text: prompt, secret: true } });
      }),
    chooseMulti: (prompt, options) =>
      new Promise<number[]>((resolve, reject) => {
        pendingRef.current = { kind: "multi", resolve, reject };
        settle({ prompt: { text: prompt, secret: false, multi: { options: [...options] } } });
      }),
    print: (text) => {
      setState((s) => ({ ...s, logs: [...s.logs, ...text.split("\n")] }));
    },
  };
  const ioRef = useRef(io);
  ioRef.current = io;

  const submit = useCallback(
    (value: string) => {
      const p = pendingRef.current;
      if (p?.kind !== "text") return;
      pendingRef.current = undefined;
      settle({ prompt: undefined });
      p.resolve(value);
    },
    [settle],
  );

  const submitMulti = useCallback(
    (indices: number[]) => {
      const p = pendingRef.current;
      if (p?.kind !== "multi") return;
      pendingRef.current = undefined;
      settle({ prompt: undefined });
      p.resolve(indices);
    },
    [settle],
  );

  const cancel = useCallback(() => {
    const p = pendingRef.current;
    pendingRef.current = undefined;
    if (p !== undefined) {
      settle({ prompt: undefined });
      p.reject(new WizardAbort());
    }
  }, [settle]);

  const start = useCallback(
    (s: WizardStart, onDone: (o: WizardOutcome) => void): void => {
      const cfg = configRef.current;
      if (cfg === undefined) {
        onDone({ kind: "error", message: "当前环境不支持 /provider 配置" });
        return;
      }
      setState({ running: true, logs: [] });
      const run =
        s.kind === "add"
          ? runProviderSetupWizard(io, cfg, depsRef.current, {
              presetId: s.presetId,
            }).then((r: WizardResult): WizardOutcome => ({
              kind: "added",
              providerId: r.providerId,
              model: r.model,
            }))
          : s.kind === "key"
            ? runProviderKeyWizard(io, cfg, s.providerId).then((): WizardOutcome => ({
                kind: "key-updated",
                providerId: s.providerId,
              }))
            : runProviderThinkingWizard(io, cfg, s.providerId).then((): WizardOutcome => ({
                kind: "thinking-updated",
                providerId: s.providerId,
              }));
      run
        .then((outcome) => {
          setState((st) => ({
            ...st,
            running: false,
            prompt: undefined,
            done: "done",
            doneText:
              outcome.kind === "added"
                ? `已保存 ${outcome.providerId}${outcome.model !== undefined ? `（默认 ${outcome.model}）` : ""}`
                : outcome.kind === "key-updated"
                  ? `已更新 ${outcome.providerId} 的密钥`
                  : outcome.kind === "thinking-updated"
                    ? `已更新 ${outcome.providerId} 的思考档位`
                    : "",
          }));
          onDone(outcome);
        })
        .catch((e: unknown) => {
          const aborted = e instanceof WizardAbort;
          const outcome: WizardOutcome = aborted
            ? { kind: "cancel" }
            : { kind: "error", message: e instanceof Error ? e.message : String(e) };
          setState((st) => ({
            ...st,
            running: false,
            prompt: undefined,
            done: aborted ? "cancel" : "error",
            doneText: aborted ? "已取消" : outcome.kind === "error" ? outcome.message : "",
          }));
          onDone(outcome);
        });
    },
    [io],
  );

  return { state, submit, submitMulti, cancel, start };
}
