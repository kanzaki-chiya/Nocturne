/**
 * TUI 根组件（tui.md §2）：
 * - 有会话：欢迎框 + 启动通知块 + 回放区共用同一条 <Static> 流（Ink 单
 *   static 节点约束，见 StaticRow），只画一次 → 活动区 +
 *   权限对话框 + 弹层 + 输入行（上下横线）+ 分段状态栏；
 * - 无会话（首次配置，ADR-0019 第 4 条）：服务商页 → 模型页两步流程，
 *   完成后经注入的 openSession 回调创建会话再进入主界面。
 * 键位路由：Ctrl+C 忙时中断、空闲退出，Esc 忙时中断、空闲无动作；弹层优先自闭。
 * /resume：注入的 switchSession 回调执行切换；旧回放冻结进 Static，
 * 新会话重建 SessionView 重放（tui.md §4）。
 */
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  listProviderPresets,
  type PermissionReply,
  type ProviderOverview,
  type Runtime,
  type RuntimeSession,
  type SessionSummary,
  type WizardPreset,
} from "@nocturne/core";
import type { SessionView, ViewEntry } from "@nocturne/core/protocol";

import {
  contextLines,
  errText,
  helpLines,
  runSlash,
  sessionNotes,
  type OverlayName,
  type ProviderBridge,
  type ProviderWizardStart,
} from "./commands.js";
import { inputWindow } from "./cursor.js";
import { createPasteStore } from "./paste.js";
import { frameBudget } from "./frame.js";
import { isAltM, noteBareEscape, shouldSwallowAfterEscape } from "./keys.js";
import { NEW_CONTENT_HINT, SCROLLED_HINT, transcriptBlocks } from "./lines.js";
import { applyClamp, scrollFollow, scrollPage, scrollToBottom, scrollToTop } from "./scroll.js";
import { completeSlash, PRESET_NAMES, type Candidate } from "./slash-catalog.js";
import { countLaidLines, selectVisible, type LaidLine } from "./viewport.js";
import { welcomeLines } from "./welcome.js";
import { APP_VERSION } from "./version.js";
import { Composer } from "./components/composer.js";
import { ConfirmBox } from "./components/confirm-box.js";
import { InputCursor } from "./components/input-cursor.js";
import { ModelPicker, type PickerScope } from "./components/model-picker.js";
import { Panel } from "./components/panel.js";
import { PermissionDialog } from "./components/permission-dialog.js";
import { PickList, type PickItem } from "./components/pick-list.js";
import { ProviderPage, type ProviderOp } from "./components/provider-page.js";
import { StatusBar, type EffortSegment, type StatusHighlight } from "./components/status-bar.js";
import { type TranscriptItem } from "./components/transcript.js";
import { WizardView } from "./components/wizard-view.js";
import { TuiEnvContext, glyphs, type TuiEnv } from "./env.js";
import { useSessionView } from "./session-view.js";
import { theme } from "./theme.js";
import type { SwitchSessionFn } from "./types.js";
import { useProviderWizard } from "./wizard-io.js";

/** 完结前缀切分：测试仍覆盖这条切分；全屏视口不再依赖 <Static> 不可改写。 */
export function splitCompletedPrefix(entries: readonly ViewEntry[]): {
  prefix: ViewEntry[];
  tail: ViewEntry[];
} {
  const cut = entries.findIndex(
    (e) => e.kind === "tool" && (e.status === "awaiting_permission" || e.status === "running"),
  );
  if (cut < 0) return { prefix: [...entries], tail: [] };
  return { prefix: entries.slice(0, cut), tail: entries.slice(cut) };
}

export interface SetupFlowSpec {
  /** 起始页：1=服务商页；2=跳过第 1 步直接进模型选择页（已有服务商但无默认模型） */
  step?: 1 | 2 | undefined;
  /**
   * 流程完成后打开会话（nctrn 首次运行）：缺省时为 nctrn setup
   * 独立命令形态——流程结束即退出（code 0）。
   */
  openSession?: ((model: string) => Promise<RuntimeSession>) | undefined;
}

/** SetupFlow 的收尾：交给外层 App——新会话挂载主界面，或带退出码结束 */
export type SetupDone =
  | { kind: "session"; session: RuntimeSession }
  | { kind: "exit"; code: number; message?: string | undefined };

export interface AppProps {
  /** 已打开的会话；undefined = 首次配置流程形态（setup 必给） */
  session?: RuntimeSession | undefined;
  runtime: Runtime;
  env: TuiEnv;
  switchSession?: SwitchSessionFn | undefined;
  /** /provider 与全屏页的配置桥（cli 注入）；缺省时相关命令提示不可用 */
  provider?: ProviderBridge | undefined;
  /** 首次配置流程（session 为 undefined 时生效） */
  setup?: SetupFlowSpec | undefined;
  /** 结束回调：让 runTui 带出退出码与 stderr 提示（默认退出码 0） */
  onExitResult?: ((code: number, message?: string) => void) | undefined;
  /** 当前会话 id 变化时通知 runTui，退出提示要用切换后的 id */
  onSessionId?: ((id: string) => void) | undefined;
}

/**
 * 服务商页/模型页共享的数据与操作（SessionApp 与 SetupFlow 两处使用）：
 * describeProviders 数据、内嵌向导、四个操作（key/refresh/thinking/remove）、
 * 只读提示与结果行。业务逻辑全部走 Core 公开 API（provider-setup.md 第 6 节）。
 */
function useProviderOps(provider: ProviderBridge | undefined): {
  entries: readonly ProviderOverview[];
  presets: readonly WizardPreset[];
  wizard: ReturnType<typeof useProviderWizard>;
  notice: string | undefined;
  busyText: string | undefined;
  reload: () => Promise<void>;
  startWizard: (presetId: string) => void;
  runOp: (providerId: string, op: ProviderOp) => void;
  confirmRemove: (providerId: string) => void;
  readonlyHint: (entry: ProviderOverview) => string;
} {
  const [entries, setEntries] = useState<readonly ProviderOverview[]>([]);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [busyText, setBusyText] = useState<string | undefined>(undefined);
  const wizard = useProviderWizard(provider?.config);
  const presets = useMemo(() => listProviderPresets(), []);

  const reload = useCallback(async () => {
    if (provider === undefined) return;
    setEntries(await provider.config.describeProviders(provider.workspaceRoot));
  }, [provider]);

  const afterWizard = useCallback(
    (outcome: {
      kind: string;
      providerId?: string;
      modelCount?: number;
      message?: string;
    }): void => {
      void (async () => {
        if (provider !== undefined) {
          provider.updateProviders(await provider.reloadConfig());
          await reload();
        }
        if (outcome.kind === "added") {
          setNotice(
            `已保存 ${outcome.providerId}${(outcome.modelCount ?? 0) > 0 ? `，${outcome.modelCount} 个模型` : ""}`,
          );
        } else if (outcome.kind === "key-updated") {
          setNotice(`已更新 ${outcome.providerId} 的密钥`);
        } else if (outcome.kind === "thinking-updated") {
          setNotice(`已更新 ${outcome.providerId} 的思考档位`);
        } else if (outcome.kind === "error") {
          setNotice(`! ${outcome.message ?? ""}`);
        }
      })();
    },
    [provider, reload],
  );

  const startWizard = useCallback(
    (presetId: string): void => {
      wizard.start({ kind: "add", presetId }, afterWizard);
    },
    [wizard, afterWizard],
  );

  const runOp = useCallback(
    (providerId: string, op: ProviderOp): void => {
      if (provider === undefined) return;
      if (op === "key") {
        wizard.start({ kind: "key", providerId }, afterWizard);
        return;
      }
      if (op === "thinking") {
        wizard.start({ kind: "thinking", providerId }, afterWizard);
        return;
      }
      // refresh：同步执行（页面 busyText 显示进行中）
      void (async () => {
        setBusyText(`正在获取 ${providerId} 的模型列表…`);
        try {
          await provider.config.refreshUpstreamLimits(providerId);
          provider.updateProviders(await provider.reloadConfig());
          await reload();
          setNotice(`已刷新 ${providerId} 的上游模型列表`);
        } catch (e) {
          setNotice(`! ${errText(e)}`);
        } finally {
          setBusyText(undefined);
        }
      })();
    },
    [provider, wizard, afterWizard, reload],
  );

  const confirmRemove = useCallback(
    (providerId: string): void => {
      if (provider === undefined) return;
      void (async () => {
        try {
          await provider.config.removeSetupProvider(providerId);
          provider.updateProviders(await provider.reloadConfig());
          await reload();
          setNotice(`已删除 ${providerId}`);
        } catch (e) {
          setNotice(`! ${errText(e)}`);
        }
      })();
    },
    [provider, reload],
  );

  const readonlyHint = useCallback(
    (entry: ProviderOverview): string => {
      switch (entry.origin) {
        case "user":
          return `"${entry.id}" 手写在 ${provider?.config.nocturneHome ?? "~/.nocturne"}/config.json；页面内只读，请编辑该文件`;
        case "project":
          return `"${entry.id}" 手写在项目配置 .nocturne/config.json；页面内只读，请编辑该文件`;
        case "env":
        case "cli":
          return `"${entry.id}" 来自环境变量/命令行参数；页面内只读`;
        default:
          return `"${entry.id}" 为只读条目`;
      }
    },
    [provider],
  );

  return {
    entries,
    presets,
    wizard,
    notice,
    busyText,
    reload,
    startWizard,
    runOp,
    confirmRemove,
    readonlyHint,
  };
}

/** 首次配置流程（无会话形态）：服务商页 →（无默认模型时）模型页，同一全屏内切换 */
function SetupFlow({
  runtime,
  provider,
  setup,
  onDone,
}: {
  runtime: Runtime;
  provider: ProviderBridge;
  setup: SetupFlowSpec;
  onDone: (d: SetupDone) => void;
}): React.JSX.Element | null {
  const { stdout } = useStdout();
  const [width, setWidth] = useState(stdout.columns || 80);
  const [rows, setRows] = useState(stdout.rows || 24);
  useEffect(() => {
    const on = (): void => {
      setWidth(stdout.columns || 80);
      setRows(stdout.rows || 24);
    };
    stdout.on("resize", on);
    return () => {
      stdout.off("resize", on);
    };
  }, [stdout]);
  const frame = frameBudget(rows, 0);

  const ops = useProviderOps(provider);
  const [page, setPage] = useState<"provider" | "model">(setup.step === 2 ? "model" : "provider");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void ops.reload().finally(() => {
      setReady(true);
    });
  }, [ops]);

  const finish = useCallback(
    (d: SetupDone): void => {
      onDone(d);
    },
    [onDone],
  );

  /** 第 1 步 Esc：无默认模型 → 第 2 步模型页；否则收尾（openSession 时用默认模型开新会话） */
  const finishStep1 = useCallback((): void => {
    const def = runtime.defaultModel();
    if (def !== undefined) {
      if (setup.openSession !== undefined) {
        void (async () => {
          try {
            const session = await (setup.openSession as (model: string) => Promise<RuntimeSession>)(
              `${def.provider}/${def.model}`,
            );
            finish({ kind: "session", session });
          } catch (e) {
            finish({ kind: "exit", code: 1, message: errText(e) });
          }
        })();
      } else {
        finish({ kind: "exit", code: 0 });
      }
      return;
    }
    setPage("model");
  }, [runtime, setup, finish]);

  /** 选中模型：setDefault 写 providers.json，再交给 openSession 或退出 */
  const pick = useCallback(
    (ref: string, setDefault: boolean): void => {
      void (async () => {
        try {
          if (setDefault) {
            await provider.config.setDefaultModel(ref);
            provider.updateProviders(await provider.reloadConfig());
          }
          if (setup.openSession !== undefined) {
            const session = await setup.openSession(ref);
            finish({ kind: "session", session });
          } else {
            finish({ kind: "exit", code: 0 });
          }
        } catch (e) {
          finish({ kind: "exit", code: 1, message: errText(e) });
        }
      })();
    },
    [provider, setup, finish],
  );

  // Ctrl+C：先回主屏再退出，不把终端留在备用屏（ADR-0017/0019）
  useInput((ch, key) => {
    if (key.ctrl && ch === "c") {
      ops.wizard.cancel();
      finish({ kind: "exit", code: 0 });
    }
  });

  if (!ready) {
    return <Box flexDirection="column" width={width} height={frame.frameHeight} />;
  }

  if (page === "provider") {
    return (
      <ProviderPage
        presets={ops.presets}
        entries={ops.entries}
        wizard={ops.wizard.state.running ? ops.wizard : undefined}
        onStartWizard={(presetId) => {
          ops.startWizard(presetId);
        }}
        onOp={(id, op) => {
          ops.runOp(id, op);
        }}
        onReadonlyHint={ops.readonlyHint}
        onConfirmRemove={(id) => {
          ops.confirmRemove(id);
        }}
        onClose={finishStep1}
        notice={ops.notice}
        busyText={ops.busyText}
        stepLabel="第 1 步，共 2 步"
        width={width}
        height={frame.frameHeight}
        termRows={rows}
        active
      />
    );
  }

  const entries = ops.entries;
  const configured = new Set(entries.map((p) => p.id));
  return (
    <Box flexDirection="column" width={width} height={frame.frameHeight}>
      <Text color={theme.info}>第 2 步，共 2 步 — 选择模型并设为默认</Text>
      <ModelPicker
        models={runtime.listModels()}
        recents={runtime.listRecentModels()}
        providers={entries}
        presets={ops.presets.filter((p) => !configured.has(p.id))}
        current={undefined}
        defaultModel={runtime.defaultModel()}
        wizard={ops.wizard.state.running ? ops.wizard : undefined}
        onStartWizard={(presetId) => {
          ops.startWizard(presetId);
        }}
        onPick={pick}
        onClose={() => {
          finish(
            setup.openSession !== undefined
              ? { kind: "exit", code: 2, message: "未选择模型；可运行 nctrn setup 或 --model 指定" }
              : { kind: "exit", code: 0 },
          );
        }}
        width={width}
        height={Math.max(1, frame.frameHeight - 1)}
        active
      />
    </Box>
  );
}

export function App({
  session: initialSession,
  runtime,
  env,
  switchSession,
  provider,
  setup,
  onExitResult,
  onSessionId,
}: AppProps): React.JSX.Element | null {
  const { exit } = useApp();
  const [session, setSession] = useState<RuntimeSession | undefined>(initialSession);

  const onSetupDone = useCallback(
    (d: SetupDone): void => {
      if (d.kind === "session") {
        onSessionId?.(d.session.id);
        setSession(d.session);
        return;
      }
      onExitResult?.(d.code, d.message);
      exit();
    },
    [exit, onExitResult, onSessionId],
  );

  if (session === undefined) {
    return (
      <TuiEnvContext.Provider value={env}>
        {provider !== undefined && setup !== undefined ? (
          <SetupFlow runtime={runtime} provider={provider} setup={setup} onDone={onSetupDone} />
        ) : null}
      </TuiEnvContext.Provider>
    );
  }

  return (
    <SessionApp
      session={session}
      runtime={runtime}
      env={env}
      switchSession={switchSession}
      provider={provider}
      onSessionId={onSessionId}
    />
  );
}

function SessionApp({
  session: initialSession,
  runtime,
  env,
  switchSession,
  provider,
  onSessionId,
}: {
  session: RuntimeSession;
  runtime: Runtime;
  env: TuiEnv;
  switchSession?: SwitchSessionFn | undefined;
  provider?: ProviderBridge | undefined;
  onSessionId?: ((id: string) => void) | undefined;
}): React.JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [width, setWidth] = useState(stdout.columns || 80);
  const [rows, setRows] = useState(stdout.rows || 24);

  // resize 跟随：Ink 不因终端 resize 自动重渲染
  useEffect(() => {
    const on = (): void => {
      setWidth(stdout.columns || 80);
      setRows(stdout.rows || 24);
    };
    stdout.on("resize", on);
    return () => {
      stdout.off("resize", on);
    };
  }, [stdout]);

  // /resume 切换：session 变为新会话（useSessionView 自动重放新日志）
  const [session, setSession] = useState(initialSession);
  const view = useSessionView(session);
  useEffect(() => {
    onSessionId?.(session.id);
  }, [session, onSessionId]);
  const [input, setInput] = useState("");
  const [cursor, setCursor] = useState(0);
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | undefined>(undefined);
  const [historyDraft, setHistoryDraft] = useState("");
  const [overlay, setOverlay] = useState<OverlayName | undefined>(undefined);
  const [clientLines, setClientLines] = useState<string[]>([]);
  const [exiting, setExiting] = useState(false);
  /** 已冻结进滚动区的回放（旧会话的完结前缀 + 切换分隔线） */
  const [frozen, setFrozen] = useState<TranscriptItem[]>([]);
  /** /resume 弹层的会话清单（打开弹层时拉取） */
  const [resumeList, setResumeList] = useState<readonly SessionSummary[] | undefined>(undefined);
  /** /resume 跨目录确认（foreign → 用户确认后带 allowForeign 重试） */
  const [foreign, setForeign] = useState<{ id: string; root: string } | undefined>(undefined);
  // 模型选择页 / 服务商页：同一全屏里的页面，不再进出备用屏。输入文字留在父状态。
  const [picker, setPicker] = useState<
    { focus: "left" | "right"; scope?: PickerScope | undefined } | undefined
  >(undefined);
  /** picker remount 计数：向导完成后重开并选中新服务商 */
  const [pickerKey, setPickerKey] = useState(0);
  /** 打开时快照的左栏数据（providers + 未配置预设） */
  const [pickerData, setPickerData] = useState<
    { providers: ProviderOverview[]; presets: WizardPreset[] } | undefined
  >(undefined);
  const pickerOpen = picker !== undefined;
  const [providerPageOpen, setProviderPageOpen] = useState(false);
  const [scroll, setScroll] = useState(scrollFollow);
  const [completionOn, setCompletionOn] = useState(true);
  const [completionIndex, setCompletionIndex] = useState(0);
  const [highlight, setHighlight] = useState<StatusHighlight | undefined>(undefined);
  const [providerIds, setProviderIds] = useState<readonly string[]>([]);
  const lineCache = useRef(new Map<string, LaidLine[]>());
  const laidTotal = useRef<number | undefined>(undefined);
  const hiddenNotices = useRef(new Set<string>());
  const suppressConfigNotice = useRef(false);
  const swallowUntil = useRef(0);
  const escapeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const swallowRef = useRef(false);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // 服务商页数据与操作（与 SetupFlow 共用一套编排）
  const ops = useProviderOps(provider);

  // /provider 向导（add/key）：主屏弹层 + 全屏页内嵌共用一份状态机
  const wizard = useProviderWizard(provider?.config);
  const [wizardOverlay, setWizardOverlay] = useState<ProviderWizardStart | undefined>(undefined);
  /** /provider remove 确认 */
  const [providerRemove, setProviderRemove] = useState<string | undefined>(undefined);

  const busy = view.status !== "idle";
  const pending = view.pendingPermission;
  const interruptible = useRef(false);
  interruptible.current = busy;
  useEffect(
    () => () => {
      if (escapeTimer.current !== undefined) clearTimeout(escapeTimer.current);
    },
    [],
  );

  const { prefix } = splitCompletedPrefix(view.entries);
  const prefixRef = useRef(prefix);
  prefixRef.current = prefix;

  // 思考档位段（ADR-0018/0019）：Turn 中切档显示 旧档→新档 并变色
  const effortInfo = session.reasoningEffortInfo();
  const effort: EffortSegment | undefined =
    effortInfo.available.length > 0
      ? {
          effective: effortInfo.effective,
          current: effortInfo.current,
          transition: busy && effortInfo.effective !== effortInfo.current,
        }
      : undefined;

  // 上下文占用（tui.md §2：已用/声明的上下文长度，ADR-0016）；
  // 只在条目/状态变化时重算，流式 delta 不触发 describeContext
  const contextReport = useMemo(
    () => session.describeContext().report,
    // 只在条目/状态变化时重算，流式 delta 不触发 describeContext
    [session, view.entries.length, view.status],
  );
  const contextWindow = useMemo(() => {
    const m = view.config.model;
    if (m === undefined) return undefined;
    return runtime
      .listModels()
      .find((x) => x.ref.provider === m.provider && x.ref.model === m.model)?.contextWindow;
  }, [runtime, view.config.model]);

  const pushLine = useCallback((text: string) => {
    if (text === "") return;
    setClientLines((prev) => [...prev.slice(-19), ...text.split("\n")]);
    setScroll((s) => (s.follow ? s : { ...s, follow: false, newContent: true }));
  }, []);

  const flash = useCallback((which: StatusHighlight) => {
    setHighlight(which);
    if (highlightTimer.current !== undefined) clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => {
      setHighlight(undefined);
    }, 1200);
  }, []);

  useEffect(
    () => () => {
      if (highlightTimer.current !== undefined) clearTimeout(highlightTimer.current);
    },
    [],
  );

  /** 退出：进行中先中断，等 Turn 收敛后再退（与 REPL close 路径同语义） */
  const requestExit = useCallback(() => {
    if (busy || pending !== undefined) {
      session.interrupt();
      setExiting(true);
      return;
    }
    exit();
  }, [busy, pending, session, exit]);

  useEffect(() => {
    if (exiting && !busy && pending === undefined) exit();
  }, [exiting, busy, pending, exit]);

  const replyPermission = useCallback(
    (reply: PermissionReply) => {
      if (pending === undefined) return;
      session.respondPermission(pending.requestId, reply).catch((e: unknown) => {
        pushLine(`! ${errText(e)}`);
      });
    },
    [pending, session, pushLine],
  );

  /** 思考强度循环（Shift+Tab）：只改档位并高亮状态栏，不插入对话条目 */
  const cycleEffort = useCallback(() => {
    const info = session.reasoningEffortInfo();
    if (info.available.length === 0) return;
    const cycle = ["off", ...info.available];
    const next = cycle[(cycle.indexOf(info.current) + 1) % cycle.length] ?? "off";
    suppressConfigNotice.current = true;
    session.setReasoningEffort(next).then(
      () => {
        flash("effort");
      },
      () => {
        suppressConfigNotice.current = false;
      },
    );
  }, [session, flash]);

  /** Alt+M：与 /preset 同一条 setPermissionPreset 路径，Turn 中同样拒绝 */
  const cyclePreset = useCallback(() => {
    if (busy || pending !== undefined) return;
    const current = session.state().config.permissionPreset;
    const at = PRESET_NAMES.indexOf(current as (typeof PRESET_NAMES)[number]);
    const next = PRESET_NAMES[(at + 1) % PRESET_NAMES.length] ?? "default";
    suppressConfigNotice.current = true;
    session.setPermissionPreset(next).then(
      () => {
        flash("preset");
      },
      () => {
        suppressConfigNotice.current = false;
      },
    );
  }, [busy, pending, session, flash]);

  /** 会话切换：冻结旧回放进 Static、换绑 session、新日志重放进 SessionView */
  const doSwitch = useCallback(
    async (id: string, allowForeign = false): Promise<void> => {
      if (switchSession === undefined) {
        pushLine("! 当前环境不支持会话切换");
        return;
      }
      const res = await switchSession(id, { allowForeign });
      if (res.kind === "ok") {
        const sep: TranscriptItem = {
          kind: "separator",
          key: `sw-${res.session.id}`,
          text: `已切换到会话 ${res.session.id}`,
        };
        // 切换只会发生在空闲时（busy 被拦截）：prefix 即旧会话全部条目
        setFrozen([...prefixRef.current, sep]);
        setSession(res.session);
        setOverlay(undefined);
        for (const n of sessionNotes(res.session)) pushLine(`! ${n}`);
        return;
      }
      if (res.kind === "foreign") {
        setForeign({ id, root: res.workspaceRoot });
        return;
      }
      pushLine(
        res.kind === "busy" ? "! 会话忙（Turn 进行中）；先 Ctrl+C 中断再切换" : `! ${res.message}`,
      );
    },
    [switchSession, pushLine],
  );

  /** 模型选择页左栏数据快照（打开时与向导完成后拉取） */
  const loadPickerData = useCallback(async () => {
    if (provider === undefined) return { providers: [], presets: [] };
    const providers = await provider.config.describeProviders(provider.workspaceRoot);
    const configured = new Set(providers.map((p) => p.id));
    const presets = listProviderPresets().filter((p) => !configured.has(p.id));
    return { providers, presets };
  }, [provider]);

  /** 打开模型选择页：同一全屏内换页，不切备用屏，不清除输入框文字 */
  const openPicker = useCallback(
    (focus: "left" | "right"): void => {
      if (busy || pending !== undefined) {
        pushLine("! 会话忙，模型选择页仅在空闲时可打开");
        return;
      }
      if (provider === undefined) {
        pushLine("! 当前环境不支持模型选择页");
        return;
      }
      void loadPickerData()
        .then((data) => {
          setPickerData(data);
          setPicker({ focus });
        })
        .catch((e: unknown) => {
          pushLine(`! ${errText(e)}`);
        });
    },
    [busy, pending, provider, loadPickerData, pushLine],
  );

  const closePicker = useCallback((): void => {
    setPicker(undefined);
  }, []);

  /** picker 内 ○ 预设 Enter → 向导内嵌；完成后回到本页并选中新服务商 */
  const startWizardInPicker = useCallback(
    (presetId: string): void => {
      if (provider === undefined) return;
      wizard.start({ kind: "add", presetId }, (outcome) => {
        if (outcome.kind === "added") {
          void (async () => {
            provider.updateProviders(await provider.reloadConfig());
            const data = await loadPickerData().catch(() => undefined);
            if (data !== undefined) setPickerData(data);
            // 回到本页并选中刚添加的服务商（tui.md §7）
            setPicker({ focus: "right", scope: { kind: "provider", id: outcome.providerId } });
            setPickerKey((k) => k + 1);
          })();
        }
      });
    },
    [provider, wizard, loadPickerData],
  );

  /** 打开服务商页：同一全屏内换页，输入框文字保留在父状态 */
  const openProviderPage = useCallback(
    (presetId?: string): void => {
      if (busy || pending !== undefined) {
        pushLine("! 会话忙，服务商页仅在空闲时可打开");
        return;
      }
      if (provider === undefined) {
        pushLine("! 当前环境不支持服务商页");
        return;
      }
      void ops.reload().catch((e: unknown) => {
        pushLine(`! ${errText(e)}`);
      });
      setProviderPageOpen(true);
      if (presetId !== undefined) ops.startWizard(presetId);
    },
    [busy, pending, provider, ops, pushLine],
  );

  const closeProviderPage = useCallback((): void => {
    setProviderPageOpen(false);
  }, []);

  /** 主屏 /provider key|thinking 弹层（add 已改为服务商页内嵌） */
  const openProviderWizard = useCallback(
    (start: ProviderWizardStart): void => {
      if (provider === undefined) {
        pushLine("! 当前环境不支持 /provider 管理");
        return;
      }
      setWizardOverlay(start);
      wizard.start(start, (outcome) => {
        void (async () => {
          if (outcome.kind === "added") {
            provider.updateProviders(await provider.reloadConfig());
            pushLine(`已保存 ${outcome.providerId}，${outcome.modelCount} 个模型`);
          } else if (outcome.kind === "key-updated") {
            provider.updateProviders(await provider.reloadConfig());
            pushLine(`已更新 ${outcome.providerId} 的密钥`);
          } else if (outcome.kind === "thinking-updated") {
            provider.updateProviders(await provider.reloadConfig());
            pushLine(`已更新 ${outcome.providerId} 的思考档位`);
          } else if (outcome.kind === "error") {
            pushLine(`! ${outcome.message}`);
          }
          setWizardOverlay(undefined);
        })();
      });
    },
    [provider, wizard, pushLine],
  );

  /** /provider remove 确认后执行 */
  const doRemoveProvider = useCallback(
    async (providerId: string): Promise<void> => {
      if (provider === undefined) return;
      try {
        await provider.config.removeSetupProvider(providerId);
        provider.updateProviders(await provider.reloadConfig());
        pushLine(`已删除 ${providerId}`);
      } catch (e) {
        pushLine(`! ${errText(e)}`);
      }
    },
    [provider, pushLine],
  );

  useEffect(() => {
    if (overlay === "resume") {
      setResumeList(undefined);
      runtime
        .listSessions()
        .then((rows) => {
          setResumeList([...rows].sort((a, b) => b.mtimeMs - a.mtimeMs));
        })
        .catch((e: unknown) => {
          pushLine(`! ${errText(e)}`);
          setOverlay(undefined);
        });
    }
  }, [overlay, runtime, pushLine]);

  const dialogOpen =
    overlay !== undefined ||
    foreign !== undefined ||
    wizardOverlay !== undefined ||
    providerRemove !== undefined;
  const pageOpen = pickerOpen || providerPageOpen;
  const inputIdle = !pageOpen && !dialogOpen && pending === undefined && !busy;

  const completionCtx = useMemo(
    () => ({
      effortLevels: session.reasoningEffortInfo().available,
      providerIds,
    }),
    [session, providerIds, view.revision],
  );
  const candidates = useMemo(
    () => (input.startsWith("/") ? completeSlash(input, completionCtx) : []),
    [input, completionCtx],
  );
  const completionOpen =
    inputIdle && completionOn && input.startsWith("/") && candidates.length > 0;
  const selected = candidates[Math.min(completionIndex, Math.max(0, candidates.length - 1))];

  useEffect(() => {
    setCompletionIndex(0);
    setCompletionOn(true);
  }, [input]);

  useEffect(() => {
    if (!input.startsWith("/provider") || provider === undefined) return;
    let cancelled = false;
    void provider.config.describeProviders(provider.workspaceRoot).then(
      (rows) => {
        if (!cancelled) setProviderIds(rows.map((row) => row.id));
      },
      () => {
        if (!cancelled) setProviderIds([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [input.startsWith("/provider"), provider]);

  const applyCandidate = useCallback((item: Candidate, execute: boolean) => {
    setInput(item.insert);
    setCursor(item.insert.length);
    if (execute) {
      setCompletionOn(false);
    }
  }, []);

  const recallHistory = (direction: -1 | 1): void => {
    if (inputHistory.length === 0) return;
    const next = Math.max(
      0,
      Math.min(inputHistory.length, (historyIndex ?? inputHistory.length) + direction),
    );
    if (historyIndex === undefined) setHistoryDraft(input);
    setHistoryIndex(next === inputHistory.length ? undefined : next);
    const value = next === inputHistory.length ? historyDraft : (inputHistory[next] ?? "");
    setInput(value);
    setCursor(value.length);
  };

  // 全局键：退出、翻页、Shift+Tab、Alt+M、补全列表。弹层内的键由各自组件处理。
  useInput((ch, key) => {
    const now = Date.now();
    if (shouldSwallowAfterEscape(ch, key, swallowUntil.current, now)) {
      if (escapeTimer.current !== undefined) clearTimeout(escapeTimer.current);
      escapeTimer.current = undefined;
      swallowUntil.current = 0;
      swallowRef.current = true;
      return;
    }
    if (key.escape && ch === "" && !key.meta && !key.ctrl) {
      if (escapeTimer.current !== undefined) clearTimeout(escapeTimer.current);
      escapeTimer.current = undefined;
      swallowUntil.current = noteBareEscape(now);
      if (!pageOpen && !dialogOpen && pending === undefined) {
        if (completionOpen) setCompletionOn(false);
        else {
          escapeTimer.current = setTimeout(() => {
            escapeTimer.current = undefined;
            if (interruptible.current) session.interrupt();
          }, 80);
        }
        return;
      }
    }
    if (key.tab && key.shift) {
      if (pageOpen || dialogOpen || pending !== undefined) return;
      cycleEffort();
      return;
    }
    if (isAltM(ch, key)) {
      if (pageOpen || dialogOpen || pending !== undefined) return;
      cyclePreset();
      return;
    }
    if (!pageOpen && !dialogOpen && pending === undefined) {
      const page = Math.max(1, frameBudget(rows, 0).conversation - 1);
      if (key.pageUp) {
        setScroll((s) => scrollPage(s, page));
        return;
      }
      if (key.pageDown) {
        setScroll((s) => scrollPage(s, -page));
        return;
      }
      if (key.ctrl && key.home) {
        setScroll(scrollToTop());
        return;
      }
      if (key.ctrl && key.end) {
        setScroll(scrollToBottom());
        return;
      }
    }
    if (completionOpen && selected !== undefined) {
      if (key.upArrow) {
        setCompletionIndex((i) => (i <= 0 ? candidates.length - 1 : i - 1));
        return;
      }
      if (key.downArrow) {
        setCompletionIndex((i) => (i + 1) % candidates.length);
        return;
      }
      if (key.tab && !key.shift) {
        applyCandidate(selected, false);
        return;
      }
      if (key.escape) {
        setCompletionOn(false);
        return;
      }
      if (key.return) {
        const text = selected.insert;
        setInput("");
        setCursor(0);
        setCompletionOn(true);
        setScroll(scrollToBottom());
        void runSlash(text, session, provider)
          .then((r) => {
            const opens = r.kind === "overlay" || r.kind === "picker" || r.kind === "provider-page";
            if (!opens) clearInput();
            if (r.kind === "exit") requestExit();
            else if (r.kind === "overlay") setOverlay(r.name);
            else if (r.kind === "picker") openPicker(r.focus);
            else if (r.kind === "provider-page") openProviderPage(r.presetId);
            else if (r.kind === "switch") void doSwitch(r.id);
            else if (r.kind === "provider-wizard") openProviderWizard(r.start);
            else if (r.kind === "provider-remove") setProviderRemove(r.providerId);
            else if (r.kind === "message") pushLine(r.text);
          })
          .catch((e: unknown) => {
            pushLine(`! ${errText(e)}`);
          });
        return;
      }
    }
    if (inputIdle && !completionOpen && key.upArrow) {
      recallHistory(-1);
      return;
    }
    if (inputIdle && !completionOpen && key.downArrow && historyIndex !== undefined) {
      recallHistory(1);
      return;
    }
    if (key.ctrl && ch === "c") {
      if (pickerOpen) {
        wizard.cancel();
        closePicker();
        exit();
        return;
      }
      if (providerPageOpen) {
        ops.wizard.cancel();
        closeProviderPage();
        exit();
        return;
      }
      if (foreign !== undefined) {
        setForeign(undefined);
        return;
      }
      if (wizardOverlay !== undefined) {
        wizard.cancel();
        return;
      }
      if (providerRemove !== undefined) {
        setProviderRemove(undefined);
        return;
      }
      if (overlay !== undefined) {
        setOverlay(undefined);
        return;
      }
      if (pending !== undefined || busy) {
        session.interrupt();
        return;
      }
      exit();
      return;
    }
    if (key.ctrl && ch === "d") {
      if (pickerOpen) {
        wizard.cancel();
        closePicker();
        requestExit();
        return;
      }
      if (providerPageOpen) {
        ops.wizard.cancel();
        closeProviderPage();
        requestExit();
        return;
      }
      if (foreign !== undefined) {
        setForeign(undefined);
        return;
      }
      if (wizardOverlay !== undefined) {
        wizard.cancel();
        setWizardOverlay(undefined);
        return;
      }
      if (providerRemove !== undefined) {
        setProviderRemove(undefined);
        return;
      }
      if (overlay !== undefined) {
        setOverlay(undefined);
        return;
      }
      requestExit();
    }
  });

  const clearInput = useCallback(() => {
    setInput("");
    setCursor(0);
  }, []);

  const pastes = useMemo(() => createPasteStore(), []);
  const onSubmit = useCallback(
    (line: string) => {
      const text = line.trim();
      if (text === "") return;
      setInputHistory((history) => [...history.slice(-99), text]);
      setHistoryIndex(undefined);
      if (text.startsWith("/")) {
        void runSlash(text, session, provider)
          .then((r) => {
            const opens = r.kind === "overlay" || r.kind === "picker" || r.kind === "provider-page";
            if (!opens) clearInput();
            if (r.kind === "exit") requestExit();
            else if (r.kind === "overlay") setOverlay(r.name);
            else if (r.kind === "picker") openPicker(r.focus);
            else if (r.kind === "provider-page") openProviderPage(r.presetId);
            else if (r.kind === "switch") void doSwitch(r.id);
            else if (r.kind === "provider-wizard") openProviderWizard(r.start);
            else if (r.kind === "provider-remove") setProviderRemove(r.providerId);
            else if (r.kind === "message") pushLine(r.text);
          })
          .catch((e: unknown) => {
            pushLine(`! ${errText(e)}`);
          });
        return;
      }
      clearInput();
      setScroll(scrollToBottom());
      // 历史里保留占位，发给模型的是展开后的原文
      session.submit({ text: pastes.expand(text) }).catch((e: unknown) => {
        pushLine(`! ${errText(e)}`);
      });
    },
    [
      session,
      pushLine,
      clearInput,
      requestExit,
      doSwitch,
      openPicker,
      openProviderPage,
      openProviderWizard,
      provider,
      pastes,
    ],
  );

  const composerDisabled =
    pending !== undefined
      ? "等待权限确认（a/s/p/d/x）"
      : busy
        ? "会话忙，Ctrl+C 可中断"
        : dialogOpen
          ? "弹层打开中，Esc 关闭"
          : undefined;

  const resumeItems: PickItem<string>[] = (resumeList ?? []).map((s) => ({
    label: `${s.id}  ${s.createdAt}  ${s.model.provider}/${s.model.model}  ${s.workspaceRoot}`,
    hint: `${s.locked === true ? "locked " : ""}${s.id === session.id ? "当前" : ""}`.trim(),
    value: s.id,
  }));

  const budget = frameBudget(rows, completionOpen ? Math.min(8, candidates.length) : 0);
  const g = glyphs(env);

  // 模型选择页：同一全屏里的一页，输入文字留在父状态
  if (pickerOpen) {
    return (
      <TuiEnvContext.Provider value={env}>
        <ModelPicker
          key={pickerKey}
          models={runtime.listModels()}
          recents={runtime.listRecentModels()}
          providers={pickerData?.providers ?? []}
          presets={pickerData?.presets ?? []}
          current={view.config.model}
          defaultModel={runtime.defaultModel()}
          initialScope={picker.scope}
          initialFocus={picker.focus}
          wizard={wizard.state.running ? wizard : undefined}
          onStartWizard={startWizardInPicker}
          onPick={(ref, setDefault) => {
            closePicker();
            void (async () => {
              try {
                if (setDefault && provider !== undefined) {
                  await provider.config.setDefaultModel(ref);
                  provider.updateProviders(await provider.reloadConfig());
                }
                await session.setModel(ref);
              } catch (e) {
                pushLine(`! ${errText(e)}`);
              }
            })();
          }}
          onClose={closePicker}
          width={width}
          height={budget.frameHeight}
          active={wizardOverlay === undefined}
        />
      </TuiEnvContext.Provider>
    );
  }

  if (providerPageOpen) {
    return (
      <TuiEnvContext.Provider value={env}>
        <ProviderPage
          presets={ops.presets}
          entries={ops.entries}
          currentProviderId={view.config.model?.provider}
          wizard={ops.wizard.state.running ? ops.wizard : undefined}
          onStartWizard={(presetId) => {
            ops.startWizard(presetId);
          }}
          onOp={(id, op) => {
            ops.runOp(id, op);
          }}
          onReadonlyHint={ops.readonlyHint}
          onConfirmRemove={(id) => {
            ops.confirmRemove(id);
          }}
          onClose={closeProviderPage}
          notice={ops.notice}
          busyText={ops.busyText}
          width={width}
          height={budget.frameHeight}
          termRows={rows}
          active
        />
      </TuiEnvContext.Provider>
    );
  }

  const bootNotes = (() => {
    const notes: string[] = [];
    const r = session.recovery;
    if (r !== undefined) {
      const parts: string[] = [];
      if (r.truncatedTail !== undefined) parts.push(`损坏尾部已截断（另存 ${r.truncatedTail}）`);
      if (r.interruptedCalls > 0)
        parts.push(`${r.interruptedCalls} 个未完成调用标记为 interrupted`);
      if (r.recoveredTurns > 0)
        parts.push(`${r.recoveredTurns} 个未完成 Turn 已按 process_exited 收束`);
      if (parts.length > 0) notes.push(`会话恢复时已修复：${parts.join("；")}`);
    }
    for (const w of session.warnings) notes.push(w);
    for (const server of session.mcpServers()) {
      if (server.state === "failed" || server.state === "crashed") {
        notes.push(
          `${server.name} 连接失败${server.error !== undefined ? `: ${server.error}` : ""}`,
        );
      }
    }
    return notes;
  })();

  const hideNotice = (entry: ViewEntry): boolean => {
    if (entry.kind !== "notice" || entry.subtype !== "config") return false;
    if (hiddenNotices.current.has(entry.key)) return true;
    if (suppressConfigNotice.current) {
      hiddenNotices.current.add(entry.key);
      suppressConfigNotice.current = false;
      return true;
    }
    return false;
  };

  const modelText = view.config.model !== undefined ? view.config.model.model : "?";
  const welcome = welcomeLines({
    version: APP_VERSION,
    model: modelText,
    effort: effort !== undefined ? effort.current : undefined,
    cwd: view.meta?.cwd ?? "",
    ascii: env.ascii,
    width,
  });
  const blocks = transcriptBlocks({
    welcome,
    notices: bootNotes,
    frozen,
    entries: view.entries,
    hide: hideNotice,
    live: view,
    clientLines,
    ascii: env.ascii,
  });
  const showBanner = !scroll.follow;
  const transcriptRows = Math.max(0, budget.conversation - (showBanner ? 1 : 0));
  const visible = selectVisible(
    blocks,
    width,
    transcriptRows,
    scroll.fromBottom,
    lineCache.current,
  );
  if (!scroll.follow) {
    const total = countLaidLines(blocks, width, lineCache.current);
    const prev = laidTotal.current;
    laidTotal.current = total;
    if (prev !== undefined && total > prev) {
      setScroll((s) =>
        s.follow ? s : { ...s, fromBottom: s.fromBottom + (total - prev), newContent: true },
      );
    } else if (visible.clampedFromBottom !== scroll.fromBottom) {
      setScroll(applyClamp(scroll, visible.clampedFromBottom));
    }
  } else {
    laidTotal.current = undefined;
  }
  const prompt = `${g.prompt} `;
  const inputY = budget.conversation + budget.inputRule;

  const shownCandidates = candidates.slice(0, budget.completion);
  const overlayBody =
    pending !== undefined ? (
      <PermissionDialog
        pending={pending}
        active={!dialogOpen}
        onReply={replyPermission}
        width={width}
      />
    ) : overlay === "context" ? (
      <Panel
        title="/context"
        lines={contextLines(session)}
        active
        onClose={() => {
          setOverlay(undefined);
        }}
        width={width}
      />
    ) : overlay === "help" ? (
      <Panel
        title="/help"
        lines={helpLines()}
        active
        onClose={() => {
          setOverlay(undefined);
        }}
        width={width}
      />
    ) : overlay === "resume" ? (
      <PickList
        title="切换到会话"
        items={resumeItems}
        active
        width={width}
        onPick={(id) => {
          setOverlay(undefined);
          void doSwitch(id);
        }}
        onCancel={() => {
          setOverlay(undefined);
        }}
      />
    ) : overlay === "preset" ? (
      <PickList
        title="选择权限预设"
        items={PRESET_NAMES.map((name) => ({ label: name, value: name }))}
        initialValue={view.config.permissionPreset}
        active
        width={width}
        onPick={(name) => {
          setOverlay(undefined);
          clearInput();
          void session.setPermissionPreset(name).catch((e: unknown) => {
            pushLine(`! ${errText(e)}`);
          });
        }}
        onCancel={() => {
          setOverlay(undefined);
        }}
      />
    ) : overlay === "effort" ? (
      <PickList
        title="选择思考强度"
        items={["off", ...session.reasoningEffortInfo().available].map((name) => ({
          label: name,
          value: name,
        }))}
        initialValue={session.reasoningEffortInfo().current}
        active
        width={width}
        onPick={(name) => {
          setOverlay(undefined);
          clearInput();
          void session.setReasoningEffort(name).catch((e: unknown) => {
            pushLine(`! ${errText(e)}`);
          });
        }}
        onCancel={() => {
          setOverlay(undefined);
        }}
      />
    ) : wizardOverlay !== undefined ? (
      <WizardView
        title={
          wizardOverlay.kind === "add"
            ? "添加服务商"
            : wizardOverlay.kind === "key"
              ? `更新密钥 ${wizardOverlay.providerId}`
              : `思考档位 ${wizardOverlay.providerId}`
        }
        state={wizard.state}
        active
        width={width}
        maxRows={Math.max(4, budget.conversation - 2)}
        onSubmit={(v) => {
          wizard.submit(v);
        }}
        onSubmitMulti={(indices) => {
          wizard.submitMulti(indices);
        }}
        onCancel={() => {
          wizard.cancel();
        }}
      />
    ) : providerRemove !== undefined ? (
      <ConfirmBox
        title={`删除服务商 ${providerRemove}`}
        detail="同时删除其凭据（providers.json 条目与凭据索引）"
        confirmLabel="删除"
        active
        width={width}
        onConfirm={() => {
          const id = providerRemove;
          setProviderRemove(undefined);
          void doRemoveProvider(id);
        }}
        onCancel={() => {
          setProviderRemove(undefined);
          pushLine("! 已取消删除");
        }}
      />
    ) : foreign !== undefined ? (
      <ConfirmBox
        title={`会话绑定到 ${foreign.root}`}
        detail="与当前目录不同"
        active
        width={width}
        onConfirm={() => {
          const f = foreign;
          setForeign(undefined);
          void doSwitch(f.id, true);
        }}
        onCancel={() => {
          setForeign(undefined);
          pushLine("! 已取消切换");
        }}
      />
    ) : null;

  return (
    <TuiEnvContext.Provider value={env}>
      <Box flexDirection="column" width={width} height={budget.frameHeight}>
        <Box flexDirection="column" height={budget.conversation} overflow="hidden">
          {overlayBody ??
            visible.lines.map((line) => (
              <Text
                key={line.key}
                wrap="truncate"
                {...(line.color !== undefined ? { color: line.color } : {})}
                dimColor={line.dim === true}
                bold={line.bold === true}
              >
                {line.segments !== undefined
                  ? line.segments.map((seg, i) => (
                      <Text
                        key={i}
                        {...(seg.color !== undefined ? { color: seg.color } : {})}
                        {...(seg.backgroundColor !== undefined
                          ? { backgroundColor: seg.backgroundColor }
                          : {})}
                        dimColor={seg.dim === true}
                        bold={seg.bold === true}
                      >
                        {seg.text}
                      </Text>
                    ))
                  : line.text === ""
                    ? " "
                    : line.text}
              </Text>
            ))}
          {showBanner && overlayBody === null ? (
            <Text color={theme.warning} wrap="truncate">
              {scroll.newContent ? NEW_CONTENT_HINT : SCROLLED_HINT}
            </Text>
          ) : null}
        </Box>
        <InputCursor
          active={budget.input > 0 && !pageOpen}
          prefix={prompt}
          text={inputWindow(prompt, input, cursor, width, g.newline).before}
          width={width}
          y={inputY}
        />
        <Composer
          pastes={pastes}
          value={input}
          cursor={cursor}
          onChange={(next, nextCursor) => {
            setInput(next);
            setCursor(nextCursor);
            setHistoryIndex(undefined);
          }}
          onCursor={setCursor}
          onSubmit={onSubmit}
          active={!dialogOpen && pending === undefined}
          disabledReason={composerDisabled}
          width={width}
          showRule={budget.inputRule > 0}
          suspendNav={completionOpen}
          swallowRef={swallowRef}
        />
        {budget.completion > 0
          ? shownCandidates.map((item, i) => (
              <Text key={item.insert} wrap="truncate" inverse={i === completionIndex}>
                {item.label}
              </Text>
            ))
          : null}
        {budget.status > 0 ? (
          <StatusBar
            view={view}
            width={width}
            effort={effort}
            context={{ used: contextReport.estimatedTokens, limit: contextWindow }}
            models={runtime.listModels()}
            highlight={highlight}
          />
        ) : null}
      </Box>
    </TuiEnvContext.Provider>
  );
}

export type { SessionView };
