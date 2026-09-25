/**
 * TUI 根组件（tui.md §2）：
 * - 有会话：欢迎框 + 启动通知块 + 回放区共用同一条 <Static> 流（Ink 单
 *   static 节点约束，见 StaticRow），只画一次 → 活动区 +
 *   权限对话框 + 弹层 + 输入行（上下横线）+ 分段状态栏；
 * - 无会话（首次配置，ADR-0019 第 4 条）：服务商页 → 模型页两步流程，
 *   完成后经注入的 openSession 回调创建会话再进入主界面。
 * 键位路由：Ctrl+C 中断/退出，Ctrl+D 退出，Esc 由弹层组件自闭。
 * /resume：注入的 switchSession 回调执行切换；旧回放冻结进 Static，
 * 新会话重建 SessionView 重放（tui.md §4）。
 */
import { Box, Static, Text, useApp, useInput, useStdout } from "ink";
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

import { useAltScreen, waitCommit } from "./alt-screen.js";
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
import { Activity } from "./components/activity.js";
import { Composer } from "./components/composer.js";
import { ConfirmBox } from "./components/confirm-box.js";
import { ModelPicker, type PickerScope } from "./components/model-picker.js";
import { NoticeBlock, type NoticeLevel } from "./components/notice-block.js";
import { Panel } from "./components/panel.js";
import { PermissionDialog } from "./components/permission-dialog.js";
import { PickList, type PickItem } from "./components/pick-list.js";
import { ProviderPage, type ProviderOp } from "./components/provider-page.js";
import { StatusBar, type EffortSegment } from "./components/status-bar.js";
import { EntryRow, type TranscriptItem } from "./components/transcript.js";
import { WelcomeBox } from "./components/welcome-box.js";
import { WizardView } from "./components/wizard-view.js";
import { TuiEnvContext, type TuiEnv } from "./env.js";
import { useSessionView } from "./session-view.js";
import { theme } from "./theme.js";
import type { SwitchSessionFn } from "./types.js";
import { useProviderWizard } from "./wizard-io.js";

/**
 * 主屏静态流条目（ADR-0019）：Ink 只跟踪一棵 <Static> 子树，
 * 欢迎框/启动通知与回放区必须并进同一条 items 流，否则后挂载的
 * Static 会顶掉先挂载的，前者输出整段丢失。
 */
type StaticRow =
  { kind: "boot-welcome"; key: string } | { kind: "boot-notices"; key: string } | TranscriptItem;

/** 完结前缀切分：第一个未完结工具条目及其后条目留给活动区（tui.md §4） */
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

/** 首次配置流程（无会话形态）：服务商页 →（无默认模型时）模型页，都在备用屏内 */
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
  const [height, setHeight] = useState(stdout.rows || 24);
  useEffect(() => {
    const on = (): void => {
      setWidth(stdout.columns || 80);
      setHeight(stdout.rows || 24);
    };
    stdout.on("resize", on);
    return () => {
      stdout.off("resize", on);
    };
  }, [stdout]);

  const alt = useAltScreen();
  const ops = useProviderOps(provider);
  const [page, setPage] = useState<"provider" | "model">(setup.step === 2 ? "model" : "provider");
  const [ready, setReady] = useState(false);
  const committed = useRef(false);
  useEffect(() => {
    committed.current = ready;
  }, [ready]);

  // 挂载即进备用屏（ADR-0017 序列）：先提交页面状态再 ?1049h
  useEffect(() => {
    void (async () => {
      await ops.reload().catch(() => undefined);
      await alt.enter(async () => {
        setReady(true);
        await waitCommit(committed, true);
      });
    })();
    // 只跑一次的挂载序列：reload/alt 都是稳定引用
  }, []);

  const closePage = useCallback(async (): Promise<void> => {
    await alt.leave(async () => {
      setReady(false);
      await waitCommit(committed, false);
    });
  }, [alt]);

  const finish = useCallback(
    (d: SetupDone): void => {
      void closePage().finally(() => {
        onDone(d);
      });
    },
    [closePage, onDone],
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
    return <Box flexDirection="column" width={width} height={height} />;
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
        height={height}
        active
      />
    );
  }

  const entries = ops.entries;
  const configured = new Set(entries.map((p) => p.id));
  return (
    <Box flexDirection="column" width={width} height={height}>
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
        height={height - 1}
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
}: AppProps): React.JSX.Element | null {
  const { exit } = useApp();
  const [session, setSession] = useState<RuntimeSession | undefined>(initialSession);

  const onSetupDone = useCallback(
    (d: SetupDone): void => {
      if (d.kind === "session") {
        setSession(d.session);
        return;
      }
      onExitResult?.(d.code, d.message);
      exit();
    },
    [exit, onExitResult],
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
    />
  );
}

function SessionApp({
  session: initialSession,
  runtime,
  env,
  switchSession,
  provider,
}: {
  session: RuntimeSession;
  runtime: Runtime;
  env: TuiEnv;
  switchSession?: SwitchSessionFn | undefined;
  provider?: ProviderBridge | undefined;
}): React.JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [width, setWidth] = useState(stdout.columns || 80);
  const [height, setHeight] = useState(stdout.rows || 24);

  // resize 跟随：Ink 不因终端 resize 自动重渲染（ADR-0017 实测约束）
  useEffect(() => {
    const on = (): void => {
      setWidth(stdout.columns || 80);
      setHeight(stdout.rows || 24);
    };
    stdout.on("resize", on);
    return () => {
      stdout.off("resize", on);
    };
  }, [stdout]);

  // /resume 切换：session 变为新会话（useSessionView 自动重放新日志）
  const [session, setSession] = useState(initialSession);
  const view = useSessionView(session);
  const [input, setInput] = useState("");
  const [overlay, setOverlay] = useState<OverlayName | undefined>(undefined);
  const [clientLines, setClientLines] = useState<string[]>([]);
  const [exiting, setExiting] = useState(false);
  /** 已冻结进滚动区的回放（旧会话的完结前缀 + 切换分隔线） */
  const [frozen, setFrozen] = useState<TranscriptItem[]>([]);
  /** /resume 弹层的会话清单（打开弹层时拉取） */
  const [resumeList, setResumeList] = useState<readonly SessionSummary[] | undefined>(undefined);
  /** /resume 跨目录确认（foreign → 用户确认后带 allowForeign 重试） */
  const [foreign, setForeign] = useState<{ id: string; root: string } | undefined>(undefined);
  /** 欢迎框"最近会话"数据（挂载时拉取一次，<Static> 只写一次） */
  const [boot, setBoot] = useState<{ recents: SessionSummary[] } | undefined>(undefined);

  // 全屏模型选择页（tui.md §7 / ADR-0017）：备用屏进出由 alt 驱动
  const alt = useAltScreen();
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
  /** React commit 观察点（挂起期间靠它确认页面状态已提交） */
  const pickerCommitted = useRef(false);
  useEffect(() => {
    pickerCommitted.current = pickerOpen;
  }, [pickerOpen]);

  // 全屏服务商页（tui.md §8 / ADR-0019）：与模型选择页共用 alt 序列
  const [providerPageOpen, setProviderPageOpen] = useState(false);
  const providerPageCommitted = useRef(false);
  useEffect(() => {
    providerPageCommitted.current = providerPageOpen;
  }, [providerPageOpen]);

  // 服务商页数据与操作（与 SetupFlow 共用一套编排）
  const ops = useProviderOps(provider);

  // /provider 向导（add/key）：主屏弹层 + 全屏页内嵌共用一份状态机
  const wizard = useProviderWizard(provider?.config);
  const [wizardOverlay, setWizardOverlay] = useState<ProviderWizardStart | undefined>(undefined);
  /** /provider remove 确认 */
  const [providerRemove, setProviderRemove] = useState<string | undefined>(undefined);

  const busy = view.status !== "idle";
  const pending = view.pendingPermission;

  const { prefix, tail } = splitCompletedPrefix(view.entries);
  const prefixRef = useRef(prefix);
  prefixRef.current = prefix;
  const transcriptItems = useMemo(() => [...frozen, ...prefix], [frozen, prefix]);
  /** 主屏唯一 <Static> 的 items 流：欢迎框与启动通知打头，其后是回放区（append-only） */
  const staticRows = useMemo<StaticRow[]>(
    () => [
      { kind: "boot-welcome", key: "boot:welcome" },
      { kind: "boot-notices", key: "boot:notices" },
      ...transcriptItems,
    ],
    [transcriptItems],
  );

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
  }, []);

  // 启动数据（欢迎框"最近会话"）：拿到后才渲染 <Static>——Static 只写一次
  useEffect(() => {
    runtime
      .listSessions()
      .then((rows) => {
        setBoot({ recents: [...rows].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 3) });
      })
      .catch(() => {
        setBoot({ recents: [] });
      });
  }, [runtime]);

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

  /** 思考强度循环（Shift+Tab）：仅在输入框受理时由全局键路由调用 */
  const cycleEffort = useCallback(() => {
    const info = session.reasoningEffortInfo();
    if (info.available.length === 0) {
      pushLine("! 该模型未声明可用思考档位（可用 /provider thinking 或配置文件声明）");
      return;
    }
    const cycle = ["off", ...info.available];
    const next = cycle[(cycle.indexOf(info.current) + 1) % cycle.length] ?? "off";
    session.setReasoningEffort(next).catch((e: unknown) => {
      pushLine(`! ${errText(e)}`);
    });
  }, [session, pushLine]);

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

  /** 打开模型选择页：ADR-0017 序列——挂起 → 提交页面 → ?1049h → 恢复全量重绘 */
  const openPicker = useCallback(
    async (focus: "left" | "right"): Promise<void> => {
      if (busy || pending !== undefined) {
        pushLine("! 会话忙，模型选择页仅在空闲时可打开");
        return;
      }
      if (provider === undefined) {
        pushLine("! 当前环境不支持模型选择页");
        return;
      }
      const data = await loadPickerData().catch((e: unknown) => {
        pushLine(`! ${errText(e)}`);
        return undefined;
      });
      if (data === undefined) return;
      setPickerData(data);
      await alt.enter(async () => {
        setPicker({ focus });
        await waitCommit(pickerCommitted, true);
      });
    },
    [busy, pending, provider, loadPickerData, alt, pushLine],
  );

  /** 关闭模型选择页：ADR-0017 序列——挂起 → 备用屏内恢复 → ?1049l → 提交关闭 */
  const closePicker = useCallback(async (): Promise<void> => {
    await alt.leave(async () => {
      setPicker(undefined);
      // 提交必须落地后才算关完：否则紧随的 exit() 在 unmount 终帧里
      // 把仍未卸载的页面帧画进主屏 scrollback（Ctrl+C 路径实测）
      await waitCommit(pickerCommitted, false);
    });
  }, [alt]);

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

  /** 打开服务商页：与模型选择页同一个 alt 序列（ADR-0019 扩展 ADR-0017 页面范围） */
  const openProviderPage = useCallback(
    async (presetId?: string): Promise<void> => {
      if (busy || pending !== undefined) {
        pushLine("! 会话忙，服务商页仅在空闲时可打开");
        return;
      }
      if (provider === undefined) {
        pushLine("! 当前环境不支持服务商页");
        return;
      }
      await ops.reload().catch((e: unknown) => {
        pushLine(`! ${errText(e)}`);
      });
      await alt.enter(async () => {
        setProviderPageOpen(true);
        await waitCommit(providerPageCommitted, true);
      });
      if (presetId !== undefined) ops.startWizard(presetId);
    },
    [busy, pending, provider, ops, alt, pushLine],
  );

  const closeProviderPage = useCallback(async (): Promise<void> => {
    await alt.leave(async () => {
      setProviderPageOpen(false);
      await waitCommit(providerPageCommitted, false);
    });
  }, [alt]);

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

  // 全局键：Ctrl+C / Ctrl+D / Shift+Tab（弹层内的 Esc/Enter/Tab 由各弹层组件处理）
  useInput((ch, key) => {
    // Shift+Tab（\x1B[Z → tab+shift）：输入框受理时循环思考档位；
    // 弹层/权限框打开时放行给各自组件（权限框用 Shift+Tab 反向移动焦点）
    if (key.tab && key.shift) {
      if (pickerOpen || providerPageOpen || dialogOpen || pending !== undefined) return;
      cycleEffort();
      return;
    }
    if (key.ctrl && ch === "c") {
      if (pickerOpen) {
        // 先走正常关闭路径回主屏再退出——否则 unmount 把页面帧写进 scrollback（ADR-0017）
        wizard.cancel();
        void closePicker()
          .then(() => {
            exit();
          })
          .catch(() => {
            exit();
          });
        return;
      }
      if (providerPageOpen) {
        ops.wizard.cancel();
        void closeProviderPage()
          .then(() => {
            exit();
          })
          .catch(() => {
            exit();
          });
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
        // 权限待决/运行中：中断（权限请求结算为 cancelled）
        session.interrupt();
        return;
      }
      exit();
      return;
    }
    if (key.ctrl && ch === "d") {
      if (pickerOpen) {
        wizard.cancel();
        void closePicker().then(() => {
          requestExit();
        });
        return;
      }
      if (providerPageOpen) {
        ops.wizard.cancel();
        void closeProviderPage().then(() => {
          requestExit();
        });
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

  const onSubmit = useCallback(
    (line: string) => {
      setInput("");
      const text = line.trim();
      if (text === "") return;
      if (text.startsWith("/")) {
        void runSlash(text, session, provider)
          .then((r) => {
            if (r.kind === "exit") requestExit();
            else if (r.kind === "overlay") setOverlay(r.name);
            else if (r.kind === "picker") void openPicker(r.focus);
            else if (r.kind === "provider-page") void openProviderPage(r.presetId);
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
      session.submit({ text }).catch((e: unknown) => {
        pushLine(`! ${errText(e)}`);
      });
    },
    [
      session,
      pushLine,
      requestExit,
      doSwitch,
      openPicker,
      openProviderPage,
      openProviderWizard,
      provider,
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

  // 模型选择页：整页替换主界面（帧渲染进备用屏；ADR-0017）
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
            void (async () => {
              await closePicker();
              try {
                if (setDefault && provider !== undefined) {
                  // providers.json 的 model 字段 + 重载让 runtime.defaultModel() 生效
                  await provider.config.setDefaultModel(ref);
                  provider.updateProviders(await provider.reloadConfig());
                }
                await session.setModel(ref);
              } catch (e) {
                pushLine(`! ${errText(e)}`);
              }
            })();
          }}
          onClose={() => {
            void closePicker();
          }}
          width={width}
          height={height}
          active={wizardOverlay === undefined}
        />
      </TuiEnvContext.Provider>
    );
  }

  // 服务商页：整页替换主界面（帧渲染进备用屏；ADR-0019）
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
          onClose={() => {
            void closeProviderPage();
          }}
          notice={ops.notice}
          busyText={ops.busyText}
          width={width}
          height={height}
          active
        />
      </TuiEnvContext.Provider>
    );
  }

  const bootNotes = (() => {
    const notes: { level: NoticeLevel; text: string }[] = [];
    const r = session.recovery;
    if (r !== undefined) {
      const parts: string[] = [];
      if (r.truncatedTail !== undefined) parts.push(`损坏尾部已截断（另存 ${r.truncatedTail}）`);
      if (r.interruptedCalls > 0)
        parts.push(`${r.interruptedCalls} 个未完成调用标记为 interrupted`);
      if (r.recoveredTurns > 0)
        parts.push(`${r.recoveredTurns} 个未完成 Turn 已按 process_exited 收束`);
      if (parts.length > 0)
        notes.push({ level: "info", text: `会话恢复时已修复：${parts.join("；")}` });
    }
    for (const w of session.warnings) notes.push({ level: "warning", text: w });
    return notes;
  })();

  // 等待"最近会话"数据，保证欢迎框只画一次（<Static> 不可改）
  if (boot === undefined) {
    return <TuiEnvContext.Provider value={env} />;
  }

  const modelText =
    view.config.model !== undefined
      ? `${view.config.model.provider}/${view.config.model.model}`
      : "?";

  return (
    <TuiEnvContext.Provider value={env}>
      <Box flexDirection="column">
        <Static items={staticRows}>
          {(item) => {
            if (item.kind === "boot-welcome") {
              return (
                <WelcomeBox
                  key={item.key}
                  model={modelText}
                  sessionId={session.id}
                  mcp={session.mcpServers()}
                  recents={boot.recents}
                  width={width}
                />
              );
            }
            if (item.kind === "boot-notices") {
              return <NoticeBlock key={item.key} notes={bootNotes} width={width} />;
            }
            return <EntryRow key={item.key} entry={item} width={width} />;
          }}
        </Static>
        <Activity view={view} pendingEntries={tail} clientLines={clientLines} width={width} />
        {pending !== undefined ? (
          <PermissionDialog
            pending={pending}
            active={!dialogOpen}
            onReply={replyPermission}
            width={width}
          />
        ) : null}
        {overlay === "context" ? (
          <Panel
            title="/context"
            lines={contextLines(session)}
            active
            onClose={() => {
              setOverlay(undefined);
            }}
            width={width}
          />
        ) : null}
        {overlay === "help" ? (
          <Panel
            title="/help"
            lines={helpLines()}
            active
            onClose={() => {
              setOverlay(undefined);
            }}
            width={width}
          />
        ) : null}
        {overlay === "resume" ? (
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
        ) : null}
        {wizardOverlay !== undefined ? (
          <WizardView
            title={
              wizardOverlay.kind === "add"
                ? "添加服务商"
                : wizardOverlay.kind === "key"
                  ? `更新密钥 ${wizardOverlay.providerId}`
                  : `思考档位 ${wizardOverlay.providerId}`
            }
            state={wizard.state}
            active={overlay === undefined && providerRemove === undefined}
            width={width}
            maxRows={Math.max(6, height - 8)}
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
        ) : null}
        {providerRemove !== undefined ? (
          <ConfirmBox
            title={`删除服务商 ${providerRemove}`}
            detail="同时删除其凭据（providers.json 条目与凭据索引）"
            confirmLabel="删除"
            active={overlay === undefined}
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
        ) : null}
        {foreign !== undefined ? (
          <ConfirmBox
            title={`会话绑定到 ${foreign.root}`}
            detail="与当前目录不同"
            active={overlay === undefined}
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
        ) : null}
        <Composer
          value={input}
          onChange={setInput}
          onSubmit={onSubmit}
          active={!dialogOpen && pending === undefined}
          disabledReason={composerDisabled}
          width={width}
        />
        <StatusBar
          view={view}
          width={width}
          effort={effort}
          context={{ used: contextReport.estimatedTokens, limit: contextWindow }}
        />
      </Box>
    </TuiEnvContext.Provider>
  );
}

export type { SessionView };
