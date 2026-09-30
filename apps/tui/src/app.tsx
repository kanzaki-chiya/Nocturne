/**
 * TUI 根组件（tui.md §2）：
 * - 有会话：欢迎区 + 启动通知块 + 回放区共用同一条 <Static> 流（Ink 单
 *   static 节点约束，见 StaticRow），只画一次 → 活动区 +
 *   权限对话框 + 弹层 + 输入行（上下横线）+ 分段状态栏；
 * - 无会话（首次配置，ADR-0019 第 4 条）：服务商页 → 模型页两步流程，
 *   完成后经注入的 openSession 回调创建会话再进入主界面。
 * 键位路由：Ctrl+C 忙时中断、空闲退出，Esc 忙时中断、空闲无动作；弹层优先自闭。
 * /resume：注入的 switchSession 回调执行切换；旧回放冻结进 Static，
 * 新会话重建 SessionView 重放（tui.md §4）。
 */
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  listProviderPresets,
  createPlatform,
  completeFileRefs,
  type FileIndexEntry,
  type Clipboard,
  type ModelSettingsPatch,
  type ModelSettingsView,
  type PermissionReply,
  type ProviderOverview,
  type QuestionReply,
  type Runtime,
  type RuntimeSession,
  type SessionSummary,
  type WizardPreset,
} from "@nocturne/core";
import type { spawn } from "node:child_process";

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
import { interleaveClient, type ClientLine } from "./client-lines.js";
import { copyText } from "./clipboard.js";
import { composerWindow } from "./cursor.js";
import { checkImage, createImageStore, droppedImage } from "./images.js";
import { renderMarkdown, splitMarkdownBlocks, takeMarkdownBlocks } from "./markdown.js";
import type { MouseSource } from "./mouse.js";
import { createClickTracker } from "./click.js";
import type { DialogMouseFrame } from "./components/dialog/mouse.js";
import { createPasteStore } from "./paste.js";
import { resumeLabel } from "./resume-label.js";
import { frameBudget } from "./frame.js";
import { isAltM, noteBareEscape, shouldSwallowAfterEscape } from "./keys.js";
import {
  layoutEntry,
  layoutLive,
  NEW_CONTENT_HINT,
  SCROLLED_HINT,
  transcriptBlocks,
} from "./lines.js";
import {
  applyClamp,
  scrollFollow,
  scrollPage,
  scrollToBottom,
  scrollToTop,
  type ScrollState,
} from "./scroll.js";
import {
  colFromDisplay,
  selCopyText,
  selIsEmpty,
  selRangeOnLine,
  selSegments,
  type Selection,
} from "./selection.js";
import { completeSlash, PRESET_NAMES, type Candidate } from "./slash-catalog.js";
import {
  countLaidLines,
  layoutCached,
  reanchorFromBottom,
  selectVisible,
  type LaidLine,
  type LineBlock,
  type VisibleWindow,
} from "./viewport.js";
import { welcomeLines } from "./welcome.js";
import { APP_VERSION } from "./version.js";
import { Composer } from "./components/composer.js";
import { ConfirmBox } from "./components/confirm-box.js";
import { InputCursor } from "./components/input-cursor.js";
import { ModelPicker, type PickerScope } from "./components/model-picker.js";
import { Panel } from "./components/panel.js";
import { PermissionDialog, permissionDialogRows } from "./components/permission-dialog.js";
import { PickList, type PickItem } from "./components/pick-list.js";
import { QuestionDialog, questionDialogRows } from "./components/question-dialog.js";
import { ProviderPage, type ProviderOp } from "./components/provider-page.js";
import { StatusBar, type EffortSegment, type StatusHighlight } from "./components/status-bar.js";
import { ThemePage } from "./components/theme-page.js";
import { TodoPanel, todoPanelRows } from "./components/todo-panel.js";
import { Transcript, type TranscriptItem } from "./components/transcript.js";
import { useAltScreen, waitCommit } from "./alt-screen.js";
import { WizardView } from "./components/wizard-view.js";
import { TuiEnvContext, glyphs, type TuiEnv } from "./env.js";
import { useSessionView } from "./session-view.js";
import { useReasoning } from "./reasoning.js";
import { useTheme, type ThemeId } from "./theme.js";
import type { NewSessionFn, SwitchSessionFn } from "./types.js";
import { useProviderWizard } from "./wizard-io.js";

const EMPTY_WINDOW: VisibleWindow = {
  lines: [],
  atTop: true,
  atBottom: true,
  clampedFromBottom: 0,
  collectedLength: 0,
  sliceStart: 0,
  exhausted: true,
};

/** 未完成工具及其后的条目留在活动区；前缀可写入 <Static>。 */
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

export const splitTextBlocks = splitMarkdownBlocks;

/**
 * 持久化助手条目 → 写入回滚区的块条目。流式期间已写入的前缀按字符位置
 * 记账（written），这里只切剩余部分；块键用绝对偏移，流式块晋升后不重发。
 */
function assistantBlocks(
  entry: Extract<ViewEntry, { kind: "assistant" }>,
  written: Map<string, number>,
): ViewEntry[] {
  const from = Math.min(written.get(entry.messageId) ?? 0, entry.text.length);
  const { blocks } = splitMarkdownBlocks(entry.text.slice(from), true);
  written.set(entry.messageId, entry.text.length);
  // 空消息补一行占位；流式已写满时仅中断消息还要补"（中断）"标记行
  if (blocks.length === 0 && (from === 0 || entry.finishReason === "aborted")) blocks.push("");
  let at = from;
  return blocks.map((text, i) => {
    const key = `${entry.key}:@${at}`;
    at += text.length;
    return {
      ...entry,
      key,
      text,
      reasoning: i === 0 ? entry.reasoning : "",
      finishReason: i === blocks.length - 1 ? entry.finishReason : "stop",
    };
  });
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
  onThemeChange?: ((id: ThemeId) => void) | undefined;
  env: TuiEnv;
  switchSession?: SwitchSessionFn | undefined;
  newSession?: NewSessionFn | undefined;
  /** /provider 与全屏页的配置桥（cli 注入）；缺省时相关命令提示不可用 */
  provider?: ProviderBridge | undefined;
  /** 首次配置流程（session 为 undefined 时生效） */
  setup?: SetupFlowSpec | undefined;
  /**
   * 普通屏幕（行内）模式：<Static> 回滚区 + 页面临时备用屏。
   * 缺省为全屏：视口滚动、鼠标选中复制、页面同屏（ADR-0021 第 1 条）。
   */
  inline?: boolean | undefined;
  /** 全屏模式的鼠标事件源（runTui 的 stdin 包装提供；测试可注入假源） */
  mouse?: MouseSource | undefined;
  /** Ink 帧外写出通道（OSC 52 序列经 cursor.ts 代理直落 stdout） */
  writeOob?: ((data: string) => boolean) | undefined;
  /** 全屏输出层取得当前视口边界与页面身份。 */
  onOutputLayout?: ((conversation: number, page: string) => void) | undefined;
  /** 复制用的 spawn（测试注入 mock；缺省 node:child_process.spawn） */
  copySpawn?: typeof spawn | undefined;
  clipboard?: Clipboard | undefined;
  clipboardPlatform?: NodeJS.Platform | undefined;
  /** 全屏退出前把对话铺成行写回主屏（runTui 注入容器，App 填实现） */
  transcriptOut?: { current?: (() => string[]) | undefined } | undefined;
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
  listModels: (providerId: string) => Promise<ModelSettingsView[]>;
  saveModel: (
    providerId: string,
    modelId: string,
    patch: ModelSettingsPatch,
  ) => Promise<string | undefined>;
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
      // refresh：同步执行（页面 busyText 显示进行中）
      void (async () => {
        setBusyText(`正在获取 ${providerId} 的模型列表…`);
        try {
          const warning = await provider.config.refreshUpstreamLimits(providerId);
          provider.updateProviders(await provider.reloadConfig());
          await reload();
          setNotice(
            `已刷新 ${providerId} 的上游模型列表${warning !== undefined ? `；${warning}` : ""}`,
          );
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

  const listModels = useCallback(
    async (providerId: string): Promise<ModelSettingsView[]> => {
      if (provider === undefined) return [];
      return await provider.config.listModelSettings(providerId, provider.workspaceRoot);
    },
    [provider],
  );

  const saveModel = useCallback(
    async (
      providerId: string,
      modelId: string,
      patch: ModelSettingsPatch,
    ): Promise<string | undefined> => {
      if (provider === undefined) return "当前环境不支持模型设置编辑";
      try {
        await provider.config.saveModelSettings(providerId, modelId, patch, provider.workspaceRoot);
        provider.updateProviders(await provider.reloadConfig());
        await reload();
        setNotice(`已保存 ${providerId}/${modelId}`);
        return undefined;
      } catch (e) {
        return errText(e);
      }
    },
    [provider, reload],
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
    listModels,
    saveModel,
  };
}

/** 首次配置流程（无会话形态）：服务商页 →（无默认模型时）模型页；inline 走临时备用屏 */
function SetupFlow({
  runtime,
  provider,
  setup,
  inline,
  onOutputLayout,
  onDone,
}: {
  runtime: Runtime;
  provider: ProviderBridge;
  setup: SetupFlowSpec;
  inline: boolean;
  onOutputLayout?: ((conversation: number, page: string) => void) | undefined;
  onDone: (d: SetupDone) => void;
}): React.JSX.Element | null {
  const theme = useTheme();
  const { stdout } = useStdout();
  const alt = useAltScreen(inline);
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
  const readyCommitted = useRef(false);
  useLayoutEffect(() => {
    readyCommitted.current = ready;
  }, [ready]);

  useEffect(() => {
    void ops.reload().finally(() => {
      void alt.enter(async () => {
        setReady(true);
        await waitCommit(readyCommitted, true);
      });
    });
  }, [ops.reload]);

  const finish = useCallback(
    (d: SetupDone): void => {
      void alt
        .leave(async () => {
          setReady(false);
          await waitCommit(readyCommitted, false);
        })
        .then(() => {
          onDone(d);
        });
    },
    [alt, onDone],
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
    return null;
  }
  onOutputLayout?.(0, `setup-${page}`);

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
        onListModels={ops.listModels}
        onSaveModel={ops.saveModel}
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
  onThemeChange,
  env,
  switchSession,
  newSession,
  provider,
  setup,
  inline,
  mouse,
  writeOob,
  onOutputLayout,
  copySpawn,
  clipboard,
  clipboardPlatform,
  transcriptOut,
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
          <SetupFlow
            runtime={runtime}
            provider={provider}
            setup={setup}
            inline={inline === true}
            onOutputLayout={onOutputLayout}
            onDone={onSetupDone}
          />
        ) : null}
      </TuiEnvContext.Provider>
    );
  }

  return (
    <SessionApp
      session={session}
      runtime={runtime}
      onThemeChange={onThemeChange}
      env={env}
      switchSession={switchSession}
      newSession={newSession}
      provider={provider}
      inline={inline === true}
      mouse={mouse}
      writeOob={writeOob}
      onOutputLayout={onOutputLayout}
      copySpawn={copySpawn}
      clipboard={clipboard}
      clipboardPlatform={clipboardPlatform}
      transcriptOut={transcriptOut}
      onSessionId={onSessionId}
    />
  );
}

function SessionApp({
  session: initialSession,
  runtime,
  onThemeChange,
  env,
  switchSession,
  newSession,
  provider,
  inline = false,
  mouse,
  writeOob,
  onOutputLayout,
  copySpawn,
  clipboard,
  clipboardPlatform,
  transcriptOut,
  onSessionId,
}: {
  session: RuntimeSession;
  runtime: Runtime;
  onThemeChange?: ((id: ThemeId) => void) | undefined;
  env: TuiEnv;
  switchSession?: SwitchSessionFn | undefined;
  newSession?: NewSessionFn | undefined;
  provider?: ProviderBridge | undefined;
  /** 普通屏幕（行内）模式；缺省 false = 全屏 */
  inline?: boolean | undefined;
  mouse?: MouseSource | undefined;
  writeOob?: ((data: string) => boolean) | undefined;
  onOutputLayout?: ((conversation: number, page: string) => void) | undefined;
  copySpawn?: typeof spawn | undefined;
  clipboard?: Clipboard | undefined;
  clipboardPlatform?: NodeJS.Platform | undefined;
  transcriptOut?: { current?: (() => string[]) | undefined } | undefined;
  onSessionId?: ((id: string) => void) | undefined;
}): React.JSX.Element {
  const theme = useTheme();
  const fullscreen = !inline;
  const { exit } = useApp();
  const { stdout } = useStdout();
  const alt = useAltScreen(!fullscreen);
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
  const { parts: reasoning, now: reasoningNow } = useReasoning(session);
  useEffect(() => {
    onSessionId?.(session.id);
  }, [session, onSessionId]);
  const [input, setInput] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef("");
  const cursorRef = useRef(0);
  const images = useMemo(() => createImageStore(), []);
  const pastes = useMemo(() => createPasteStore(), []);
  const imagePlatform = useMemo(() => createPlatform(), []);
  const updateInput = (value: string, at: number): void => {
    inputRef.current = value;
    cursorRef.current = at;
    images.prune(value);
    setInput(value);
    setCursor(at);
    setCompletionIndex(0);
    setCompletionOn(true);
  };
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | undefined>(undefined);
  const [historyDraft, setHistoryDraft] = useState("");
  const [overlay, setOverlay] = useState<OverlayName | undefined>(undefined);
  const [clientLines, setClientLines] = useState<ClientLine[]>([]);
  const clientLineId = useRef(0);
  const [exiting, setExiting] = useState(false);
  const submitting = useRef(false);
  const [submitPending, setSubmitPending] = useState(false);
  const switching = useRef(false);
  const [switchPending, setSwitchPending] = useState(false);
  useLayoutEffect(() => {
    if (switching.current) {
      switching.current = false;
      setSwitchPending(false);
    }
  }, [session]);
  /** 全屏模式：对话视口滚动状态（fromBottom=0 跟随最新） */
  const [scroll, setScroll] = useState<ScrollState>(scrollFollow);
  const [expanded, setExpanded] = useState(false);
  const [diffExpanded, setDiffExpanded] = useState<ReadonlySet<string>>(new Set());
  const [recordOpen, setRecordOpen] = useState(false);
  const [recordScroll, setRecordScroll] = useState<ScrollState>(scrollFollow);
  const recordTotal = useRef<number | undefined>(undefined);
  const recordCommitted = useRef(false);
  useLayoutEffect(() => {
    recordCommitted.current = recordOpen;
  }, [recordOpen]);
  /** 全屏模式：/resume 切换时冻结的旧会话条目（新会话内容在其后铺开） */
  const [frozen, setFrozen] = useState<TranscriptItem[]>([]);
  /** 全屏模式：拖动选区（内容行+列坐标；滚动不漂移，宽度变化清除） */
  const [sel, setSel] = useState<Selection | undefined>(undefined);
  /** 状态栏短暂提示（复制结果等），约 2 秒 */
  const [note, setNote] = useState<string | undefined>(undefined);
  /** Ink Static 只按数组下标追加；流式块晋升为持久条目时也不能重排或缩短。 */
  const staticQueue = useRef<TranscriptItem[]>([]);
  const staticKeys = useRef(new Set<string>());
  /** 每条助手消息已写入回滚区的前缀长度（字符数），会话内跨流式/持久化保持；切换会话清零。 */
  const staticWritten = useRef(new Map<string, number>());
  const sessionEpoch = useRef(0);
  /** /resume 弹层的会话清单（打开弹层时拉取） */
  const [resumeList, setResumeList] = useState<readonly SessionSummary[] | undefined>(undefined);
  /** /resume 跨目录确认（foreign → 用户确认后带 allowForeign 重试） */
  const [foreign, setForeign] = useState<{ id: string; root: string } | undefined>(undefined);
  // 模型选择页 / 服务商页临时进出备用屏；输入文字留在父状态。
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
  const dialogMouse = useRef<DialogMouseFrame | undefined>(undefined);
  const dialogClicks = useRef(createClickTracker());
  const reportDialogMouse = useCallback((frame: DialogMouseFrame | undefined): void => {
    if (frame?.layer !== dialogMouse.current?.layer) dialogClicks.current.reset();
    dialogMouse.current = frame;
  }, []);
  /** /provider model 直达目标（ADR-0024）；每次打开页自增 key 让页内状态重挂 */
  const [providerPageTarget, setProviderPageTarget] = useState<
    { providerId: string; modelId?: string | undefined } | undefined
  >(undefined);
  const [providerPageKey, setProviderPageKey] = useState(0);
  const pickerCommitted = useRef(false);
  const providerCommitted = useRef(false);
  useLayoutEffect(() => {
    pickerCommitted.current = pickerOpen;
    providerCommitted.current = providerPageOpen;
  }, [pickerOpen, providerPageOpen]);
  const [completionOn, setCompletionOn] = useState(true);
  const [completionIndex, setCompletionIndex] = useState(0);
  const [indexed, setIndexed] = useState<
    { session: RuntimeSession; turn: number; entries: readonly FileIndexEntry[] } | undefined
  >();
  const [highlight, setHighlight] = useState<StatusHighlight | undefined>(undefined);
  const [providerIds, setProviderIds] = useState<readonly string[]>([]);
  const hiddenNotices = useRef(new Set<string>());
  const suppressConfigNotice = useRef(false);
  const swallowUntil = useRef(0);
  const escapeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const swallowRef = useRef(false);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** 全屏视口的排版缓存与几何信息（鼠标处理器经 ref 读最新帧） */
  const lineCache = useRef(new Map<string, LaidLine[]>());
  const laidTotal = useRef<number | undefined>(undefined);
  const geomRef = useRef<{
    visible: VisibleWindow;
    transcriptRows: number;
    blocked: boolean;
  }>({ visible: EMPTY_WINDOW, transcriptRows: 0, blocked: true });
  const selRef = useRef<Selection | undefined>(undefined);
  selRef.current = sel;
  const diffExpandedRef = useRef(diffExpanded);
  diffExpandedRef.current = diffExpanded;
  const blocksRef = useRef<{ blocks: LineBlock[]; width: number }>({ blocks: [], width: 0 });
  const sourceRef = useRef<Parameters<typeof transcriptBlocks>[0] | undefined>(undefined);
  const exportBlocksRef = useRef<{ blocks: LineBlock[]; width: number }>({ blocks: [], width: 0 });
  /** 异步回调（doSwitch）读当前会话条目/本地行，冻结进视口前缀 */
  const entriesRef = useRef(view.entries);
  entriesRef.current = view.entries;
  const clientLinesRef = useRef(clientLines);
  clientLinesRef.current = clientLines;
  /** 拖动状态：视口内按下为真；越过边缘时记方向（-1 上 / +1 下）并持续滚动 */
  const dragRef = useRef<{
    dragging: boolean;
    edge: -1 | 0 | 1;
    timer: ReturnType<typeof setInterval> | undefined;
  }>({ dragging: false, edge: 0, timer: undefined });

  // 服务商页数据与操作（与 SetupFlow 共用一套编排）
  const ops = useProviderOps(provider);

  // /provider 向导（add/key）：主屏弹层 + 全屏页内嵌共用一份状态机
  const wizard = useProviderWizard(provider?.config);
  const [wizardOverlay, setWizardOverlay] = useState<ProviderWizardStart | undefined>(undefined);
  /** /provider remove 确认 */
  const [providerRemove, setProviderRemove] = useState<string | undefined>(undefined);

  const busy = view.status !== "idle" || submitPending;
  const pending = view.pendingPermission;
  // 待回答的提问与权限确认同级独占焦点。
  const pendingQ = view.pendingQuestion;
  // 面板页码按 requestId 记录并在渲染时派生：新提问自动回到第 1 题。
  // 不用挂载 effect 重置——它会在挂载后多触发一轮渲染，赶上 Ink 按键订阅的时机丢键
  const [questionPageState, setQuestionPage] = useState<{
    requestId: string | undefined;
    index: number;
    confirm: boolean;
  }>({ requestId: undefined, index: 0, confirm: false });
  const questionPage =
    pendingQ !== undefined && questionPageState.requestId === pendingQ.requestId
      ? questionPageState
      : { index: 0, confirm: false };
  const interruptible = useRef(false);
  interruptible.current = busy;
  useEffect(
    () => () => {
      if (escapeTimer.current !== undefined) clearTimeout(escapeTimer.current);
    },
    [],
  );

  const { prefix } = splitCompletedPrefix(view.entries);

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

  const pushLine = useCallback(
    (text: string) => {
      if (text === "") return;
      // 记下推入时的条目数，提示行随对话滚走而不是钉在末尾
      const after = entriesRef.current.length;
      const added = text
        .split("\n")
        .map((line) => ({ id: clientLineId.current++, text: line, after }));
      setClientLines((prev) => [...prev.slice(-199), ...added]);
      if (fullscreen) {
        // 翻阅中不拉回底部，标"有新内容"
        setScroll((s) => (s.follow ? s : { ...s, newContent: true }));
      }
    },
    [fullscreen],
  );

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
    if (busy || submitting.current || pending !== undefined) {
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

  // 回复只结算工具；对话摘要由持久工具事件显示。
  const replyQuestion = useCallback(
    (reply: QuestionReply) => {
      if (pendingQ === undefined) return;
      session.respondQuestion(pendingQ.requestId, reply).catch((e: unknown) => {
        pushLine(`! ${errText(e)}`);
      });
    },
    [pendingQ, session, pushLine],
  );

  /** 拖动越过视口边缘时的自动滚动停止 */
  const stopEdgeScroll = useCallback((): void => {
    if (dragRef.current.timer !== undefined) clearInterval(dragRef.current.timer);
    dragRef.current.timer = undefined;
    dragRef.current.edge = 0;
  }, []);

  /** 可见窗口 lines[i] 在完整行表中的绝对序号 = absStart + i */
  const absStartOf = useCallback((v: VisibleWindow): number => {
    if (v.exhausted) return v.sliceStart;
    const { blocks: bs, width: w } = blocksRef.current;
    return countLaidLines(bs, w, lineCache.current) - v.collectedLength + v.sliceStart;
  }, []);

  const allLaidLines = useCallback((): LaidLine[] => {
    const { blocks: bs, width: w } = blocksRef.current;
    return bs.flatMap((b) => layoutCached(b, w, lineCache.current));
  }, []);

  const flashNote = useCallback((text: string | undefined): void => {
    setNote(text);
    if (noteTimer.current !== undefined) clearTimeout(noteTimer.current);
    if (text !== undefined) {
      noteTimer.current = setTimeout(() => {
        noteTimer.current = undefined;
        setNote(undefined);
      }, 2000);
    }
  }, []);

  /**
   * 复制选区：渲染后的可见文字（折行续行拼回、行尾空白去掉），
   * 系统剪贴板与 OSC 52 并行，任一成功即算成功。
   */
  const copySelection = useCallback(
    (clear: boolean): void => {
      const s = selRef.current;
      if (s === undefined || selIsEmpty(s)) return;
      const text = selCopyText(allLaidLines(), s);
      if (clear) setSel(undefined);
      if (text === "") return;
      void copyText(text, { spawn: copySpawn, osc52: writeOob }).then((ok) => {
        flashNote(ok.length > 0 ? `已复制 ${Array.from(text).length} 个字符` : "! 复制失败");
      });
    },
    [allLaidLines, copySpawn, writeOob, flashNote],
  );

  const moveScroll = useCallback(
    (change: (s: ScrollState) => ScrollState) => {
      if (recordOpen) setRecordScroll(change);
      else setScroll(change);
    },
    [recordOpen],
  );

  // 鼠标（全屏）：滚轮翻阅视口；视口内左键按下/拖动扩展选区、越沿持续滚动、
  // 松开复制。页面/弹层/权限待决时忽略。
  useEffect(() => {
    if (!fullscreen || mouse === undefined) return;
    const off = mouse.subscribe((ev) => {
      const dialog = dialogMouse.current;
      if (dialog) {
        if (ev.type === "wheel") dialog.wheel(ev);
        else {
          const id = dialogClicks.current.feed(ev, dialog.boxes);
          if (id !== undefined) dialog.click(id, ev);
        }
        return;
      }
      const g = geomRef.current;
      if (g.blocked) return;
      if (ev.type === "wheel") {
        moveScroll((s) => scrollPage(s, ev.dir === "up" ? 3 : -3));
        return;
      }
      const base = absStartOf(g.visible);
      const row = ev.y - 1;
      const lineAt = (r: number): LaidLine | undefined =>
        r >= 0 && r < g.visible.lines.length ? g.visible.lines[r] : undefined;
      if (ev.type === "press") {
        const line = lineAt(row);
        if (ev.button !== 0 || line === undefined) return;
        dragRef.current.dragging = true;
        dragRef.current.edge = 0;
        const col = colFromDisplay(line.text, ev.x - 1);
        const pressed = { anchor: { abs: base + row, col }, head: { abs: base + row, col } };
        selRef.current = pressed;
        setSel(pressed);
        return;
      }
      if (ev.type === "drag" && dragRef.current.dragging && ev.button === 0) {
        // 对话区从屏幕第一行开始，终端报告的坐标不会小于它：拖到第一行即向上滚
        if (row <= 0 || row >= g.transcriptRows) {
          dragRef.current.edge = row <= 0 ? -1 : 1;
          dragRef.current.timer ??= setInterval(() => {
            const gg = geomRef.current;
            if (gg.blocked || dragRef.current.edge === 0) return;
            // scrollPage 的正数是向上翻（离底部更远），与 edge 的方向相反
            moveScroll((s) => scrollPage(s, -dragRef.current.edge * 2));
            const b2 = absStartOf(gg.visible);
            const edgeRow = dragRef.current.edge < 0 ? 0 : gg.visible.lines.length - 1;
            const edgeLine = gg.visible.lines[edgeRow];
            if (edgeLine === undefined) return;
            const col = dragRef.current.edge < 0 ? 0 : edgeLine.text.length;
            setSel((prev) =>
              prev === undefined ? prev : { ...prev, head: { abs: b2 + edgeRow, col } },
            );
          }, 60);
          return;
        }
        dragRef.current.edge = 0;
        const line = lineAt(row);
        if (line === undefined) return;
        const head = { abs: base + row, col: colFromDisplay(line.text, ev.x - 1) };
        setSel((prev) => (prev === undefined ? prev : { ...prev, head }));
        return;
      }
      if (ev.type === "release") {
        if (!dragRef.current.dragging) return;
        dragRef.current.dragging = false;
        stopEdgeScroll();
        const s = selRef.current;
        if (s === undefined) return;
        // 单击省略行切换当前工具 diff；拖动仍按原选区复制。
        if (selIsEmpty(s)) {
          setSel(undefined);
          const key = lineAt(row)?.key;
          if (key?.endsWith(":diff:more") === true) {
            const owner = key.slice(0, -":diff:more".length);
            const next = new Set(diffExpandedRef.current);
            if (next.has(owner)) next.delete(owner);
            else next.add(owner);
            diffExpandedRef.current = next;
            const source = sourceRef.current;
            if (source !== undefined && !g.visible.atBottom) {
              const after = transcriptBlocks({ ...source, diffExpanded: next });
              const fromBottom = reanchorFromBottom(
                blocksRef.current.blocks,
                after,
                width,
                g.transcriptRows,
                g.visible.lines[0],
                lineCache.current,
              );
              setScroll((current) => ({ ...current, fromBottom, follow: fromBottom === 0 }));
            }
            laidTotal.current = undefined;
            setDiffExpanded(next);
          }
          return;
        }
        copySelection(false);
      }
    });
    return () => {
      off();
      dragRef.current.dragging = false;
      if (dragRef.current.timer !== undefined) {
        clearInterval(dragRef.current.timer);
        dragRef.current.timer = undefined;
      }
    };
  }, [fullscreen, mouse, absStartOf, copySelection, stopEdgeScroll, moveScroll, width]);

  // 全屏滚动状态维护：离开底部后新内容只标记不打断；到顶后夹紧 fromBottom
  useEffect(() => {
    if (!fullscreen) return;
    if (scroll.follow) {
      laidTotal.current = undefined;
      return;
    }
    const total = countLaidLines(blocksRef.current.blocks, width, lineCache.current);
    const prev = laidTotal.current;
    laidTotal.current = total;
    if (prev !== undefined && total > prev) {
      setScroll((s) =>
        s.follow ? s : { ...s, fromBottom: s.fromBottom + (total - prev), newContent: true },
      );
    } else if (geomRef.current.visible.clampedFromBottom !== scroll.fromBottom) {
      setScroll(applyClamp(scroll, geomRef.current.visible.clampedFromBottom));
    }
  });

  useEffect(() => {
    if (!recordOpen) return;
    if (recordScroll.follow) {
      recordTotal.current = undefined;
      return;
    }
    const total = countLaidLines(blocksRef.current.blocks, width, lineCache.current);
    const prev = recordTotal.current;
    recordTotal.current = total;
    if (prev !== undefined && total > prev) {
      setRecordScroll((s) =>
        s.follow ? s : { ...s, fromBottom: s.fromBottom + total - prev, newContent: true },
      );
    } else if (geomRef.current.visible.clampedFromBottom !== recordScroll.fromBottom) {
      setRecordScroll(applyClamp(recordScroll, geomRef.current.visible.clampedFromBottom));
    }
  });

  // 宽度变化 → 整段对话重排：作废排版缓存与选区（abs 行号随重排失效）
  useEffect(() => {
    if (!fullscreen && !recordOpen) return;
    lineCache.current.clear();
    laidTotal.current = undefined;
    setSel(undefined);
  }, [fullscreen, width, recordOpen]);

  // 全屏退出前把对话按当前宽度铺成纯文本行（runTui 在恢复主屏后打印）
  useEffect(() => {
    if (!fullscreen || transcriptOut === undefined) return;
    transcriptOut.current = () =>
      exportBlocksRef.current.blocks.flatMap((b) =>
        layoutCached(b, exportBlocksRef.current.width, lineCache.current).map((line) => {
          if (b.key === "welcome") return line.segments?.at(-1)?.text ?? line.text;
          return line.text;
        }),
      );
  }, [fullscreen, transcriptOut]);

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
      if (submitting.current || busy) {
        pushLine("! 会话忙（Turn 进行中）；先 Ctrl+C 中断再切换");
        return;
      }
      if (switching.current) return;
      if (switchSession === undefined) {
        pushLine("! 当前环境不支持会话切换");
        return;
      }
      switching.current = true;
      setSwitchPending(true);
      let switched = false;
      try {
        const res = await switchSession(id, { allowForeign });
        if (res.kind === "ok") {
          const epoch = sessionEpoch.current++;
          const sep: TranscriptItem = {
            kind: "separator",
            key: `sw-${epoch}`,
            text: `已切换到会话 ${res.session.id}`,
          };
          if (fullscreen) {
            // 旧会话的完结条目与本地提示行冻结进视口前缀；键加纪元前缀防碰撞
            const frozenItems = interleaveClient<ViewEntry, TranscriptItem>(
              entriesRef.current,
              0,
              clientLinesRef.current,
              (e) =>
                e.kind === "notice" && e.subtype === "config" && hiddenNotices.current.has(e.key)
                  ? []
                  : [{ ...e, key: `z${epoch}:${e.key}` }],
              (line) => ({
                kind: "header",
                key: `z${epoch}:c${line.id}`,
                lines: [{ key: `z${epoch}:c${line.id}`, text: line.text, dim: true }],
              }),
            );
            setFrozen((prev) => [...prev, ...frozenItems, sep]);
            setClientLines([]);
            setSel(undefined);
            setScroll(scrollToBottom());
          } else {
            staticQueue.current.push(sep);
            staticWritten.current.clear();
          }
          switched = true;
          pastes.reset(inputRef.current);
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
          res.kind === "busy"
            ? "! 会话忙（Turn 进行中）；先 Ctrl+C 中断再切换"
            : `! ${res.message}`,
        );
      } finally {
        if (!switched) {
          switching.current = false;
          setSwitchPending(false);
        }
      }
    },
    [switchSession, pushLine, fullscreen, busy, pastes],
  );

  const doNew = useCallback(async (): Promise<void> => {
    if (submitting.current || busy) {
      pushLine("! 会话忙（Turn 进行中）；先中断再新建");
      return;
    }
    if (switching.current) return;
    if (newSession === undefined) {
      pushLine("! 当前环境不支持新建会话");
      return;
    }
    switching.current = true;
    setSwitchPending(true);
    let switched = false;
    try {
      const res = await newSession();
      if (res.kind === "ok") {
        images.clear();
        updateInput(images.strip(inputRef.current), images.strip(inputRef.current).length);
        pastes.reset(inputRef.current);
        if (fullscreen) {
          // 视口整体换成新会话：欢迎区重新出现，翻阅与选区清空（ADR-0021 第 2 条）
          setFrozen([]);
          setSel(undefined);
          setScroll(scrollToBottom());
          lineCache.current.clear();
        } else {
          const sep: TranscriptItem = {
            kind: "separator",
            key: `new-${res.session.id}`,
            text: `新会话 ${res.session.id}`,
          };
          staticQueue.current.push(sep);
          sessionEpoch.current++;
          staticWritten.current.clear();
        }
        switched = true;
        setSession(res.session);
        setClientLines([]);
        setOverlay(undefined);
      } else {
        pushLine(
          res.kind === "busy"
            ? "! 会话忙（Turn 进行中）；先中断再新建"
            : `! ${res.kind === "error" ? res.message : "新建会话失败"}`,
        );
      }
    } finally {
      if (!switched) {
        switching.current = false;
        setSwitchPending(false);
      }
    }
  }, [newSession, pushLine, fullscreen, busy, pastes]);

  /** 模型选择页左栏数据快照（打开时与向导完成后拉取） */
  const loadPickerData = useCallback(async () => {
    if (provider === undefined) return { providers: [], presets: [] };
    const providers = await provider.config.describeProviders(provider.workspaceRoot);
    const configured = new Set(providers.map((p) => p.id));
    const presets = listProviderPresets().filter((p) => !configured.has(p.id));
    return { providers, presets };
  }, [provider]);

  /** 打开模型选择页：保留草稿，临时进入备用屏幕。 */
  const openPicker = useCallback(
    (focus: "left" | "right"): void => {
      if (submitting.current || busy || pending !== undefined) {
        pushLine("! 会话忙，模型选择页仅在空闲时可打开");
        return;
      }
      if (provider === undefined) {
        pushLine("! 当前环境不支持模型选择页");
        return;
      }
      void loadPickerData()
        .then((data) => {
          void alt.enter(async () => {
            setPickerData(data);
            setPicker({ focus });
            await waitCommit(pickerCommitted, true);
          });
        })
        .catch((e: unknown) => {
          pushLine(`! ${errText(e)}`);
        });
    },
    [busy, pending, provider, loadPickerData, pushLine, alt],
  );

  const closePicker = useCallback(
    () =>
      alt.leave(async () => {
        setPicker(undefined);
        await waitCommit(pickerCommitted, false);
      }),
    [alt],
  );

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

  /** 打开服务商页：保留草稿，临时进入备用屏幕。 */
  const openProviderPage = useCallback(
    (
      presetId?: string,
      modelTarget?: { providerId: string; modelId?: string | undefined },
    ): void => {
      if (submitting.current || busy || pending !== undefined) {
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
      void alt.enter(async () => {
        setProviderPageTarget(modelTarget);
        setProviderPageKey((k) => k + 1);
        setProviderPageOpen(true);
        if (presetId !== undefined) ops.startWizard(presetId);
        await waitCommit(providerCommitted, true);
      });
    },
    [busy, pending, provider, ops, pushLine, alt],
  );

  const closeProviderPage = useCallback(
    () =>
      alt.leave(async () => {
        setProviderPageOpen(false);
        await waitCommit(providerCommitted, false);
      }),
    [alt],
  );

  /** 主屏 /provider key 弹层（add 已改为服务商页内嵌） */
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
  const pageOpen = pickerOpen || providerPageOpen || recordOpen;
  const closeRecord = useCallback(
    () =>
      alt.leave(async () => {
        setSel(undefined);
        setRecordOpen(false);
        await waitCommit(recordCommitted, false);
      }),
    [alt],
  );
  const toggleReasoning = useCallback(() => {
    if (pending !== undefined || pendingQ !== undefined) return;
    if (recordOpen) {
      void closeRecord();
      return;
    }
    if (pickerOpen || providerPageOpen || dialogOpen) return;
    const source = sourceRef.current;
    if (
      source === undefined ||
      (![...source.frozen, ...source.entries].some(
        (entry) => entry.kind === "assistant" && entry.reasoning !== "",
      ) &&
        !source.live.live.assistants.some((entry) => entry.reasoning !== ""))
    ) {
      flashNote("本会话还没有思考内容");
      return;
    }
    setSel(undefined);
    if (fullscreen) {
      if (!scroll.follow) {
        const next = transcriptBlocks({ ...source, expanded: !expanded });
        const fromBottom = reanchorFromBottom(
          blocksRef.current.blocks,
          next,
          width,
          geomRef.current.transcriptRows,
          geomRef.current.visible.lines[0],
          lineCache.current,
        );
        setScroll((s) => ({ ...s, fromBottom, follow: fromBottom === 0 }));
      }
      laidTotal.current = undefined;
      setExpanded(!expanded);
      return;
    }
    void alt.enter(async () => {
      setRecordScroll(scrollToBottom());
      setRecordOpen(true);
      await waitCommit(recordCommitted, true);
    });
  }, [
    pending,
    recordOpen,
    closeRecord,
    pickerOpen,
    providerPageOpen,
    dialogOpen,
    flashNote,
    fullscreen,
    scroll.follow,
    expanded,
    width,
    alt,
  ]);
  const inputIdle =
    !pageOpen && !dialogOpen && pending === undefined && pendingQ === undefined && !busy;
  const imageModel = (): { supported: boolean; hint: string } => {
    const ref = session.state().config.model;
    const found = runtime
      .listModels()
      .find((m) => m.ref.provider === ref.provider && m.ref.model === ref.model);
    return {
      supported: found?.capabilities.imageInput === true,
      hint: `当前模型 ${ref.provider}/${ref.model} 未声明支持图片输入；可在 /provider → 编辑模型里开启`,
    };
  };
  const insertImage = (image: {
    data: Uint8Array;
    mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    label: string;
  }): void => {
    const token = images.add(image);
    const v = inputRef.current;
    const c = cursorRef.current;
    updateInput(v.slice(0, c) + token + v.slice(c), c + token.length);
  };
  const onPasteImage = async (text: string): Promise<boolean> => {
    const found = await droppedImage(text, imagePlatform);
    if (found.kind === "none") return false;
    if (found.kind === "too_large") {
      pushLine("! 图片超过 5 MB / 8000 px 限制");
      return false;
    }
    const model = imageModel();
    if (!model.supported) {
      pushLine(`! ${model.hint}`);
      return false;
    }
    insertImage(found.image);
    return true;
  };
  const pasteClipboardImage = (): void => {
    if (
      clipboardPlatform !== undefined ? clipboardPlatform !== "win32" : process.platform !== "win32"
    ) {
      pushLine("! 当前平台暂不支持从剪贴板粘贴图片");
      return;
    }
    const model = imageModel();
    if (!model.supported) {
      pushLine(`! ${model.hint}`);
      return;
    }
    void (clipboard ?? imagePlatform.clipboard)
      .readImage()
      .then((result) => {
        if (result === undefined) {
          pushLine("! 剪贴板中没有图片");
          return;
        }
        const checked = checkImage(result.data);
        if (checked.kind !== "ok") {
          pushLine("! 图片超过 5 MB / 8000 px 限制");
          return;
        }
        const current = imageModel();
        if (!current.supported) {
          pushLine(`! ${current.hint}`);
          return;
        }
        insertImage({ data: result.data, mimeType: checked.mimeType, label: "剪贴板" });
      })
      .catch((e: unknown) => {
        // base64 输出超过读取缓冲（约 6 MB 原图）时 execFile 报 maxBuffer
        pushLine(
          /maxBuffer/i.test(errText(e))
            ? "! 图片超过 5 MB / 8000 px 限制"
            : `! 读取剪贴板失败：${errText(e)}`,
        );
      });
  };

  const completionCtx = useMemo(
    () => ({
      effortLevels: session.reasoningEffortInfo().available,
      providerIds,
    }),
    [session, providerIds, view.revision],
  );
  const completedTurn = view.lastTurn?.turnIndex ?? 0;
  const fileCompletion = completeFileRefs(
    input,
    cursor,
    indexed?.session === session && indexed.turn === completedTurn ? indexed.entries : [],
  );
  const indexing =
    fileCompletion !== undefined &&
    (indexed?.session !== session || indexed.turn !== completedTurn);
  const candidates =
    fileCompletion?.candidates ??
    (input.startsWith("/") ? completeSlash(input, completionCtx) : []);
  const completionOpen = inputIdle && completionOn && (candidates.length > 0 || indexing);
  const selected = candidates[Math.min(completionIndex, Math.max(0, candidates.length - 1))];

  useEffect(() => {
    if (!indexing || !inputIdle) return;
    let cancelled = false;
    void session.fileIndex().then(
      (entries) => {
        if (!cancelled) setIndexed({ session, turn: completedTurn, entries });
      },
      () => {
        if (!cancelled) setIndexed({ session, turn: completedTurn, entries: [] });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [indexing, inputIdle, session, completedTurn]);

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

  const applyCandidate = (item: Candidate, execute: boolean): void => {
    if (fileCompletion !== undefined) {
      const next =
        input.slice(0, fileCompletion.start) + item.insert + input.slice(fileCompletion.end);
      updateInput(next, fileCompletion.start + item.insert.length);
      setCompletionOn(!item.insert.endsWith(" "));
      return;
    }
    updateInput(item.insert, item.insert.length);
    if (execute) {
      setCompletionOn(false);
    }
  };

  const recallHistory = (direction: -1 | 1): void => {
    if (inputHistory.length === 0) return;
    const next = Math.max(
      0,
      Math.min(inputHistory.length, (historyIndex ?? inputHistory.length) + direction),
    );
    if (historyIndex === undefined) setHistoryDraft(images.strip(input));
    setHistoryIndex(next === inputHistory.length ? undefined : next);
    const value =
      next === inputHistory.length
        ? historyDraft
        : (pastes.add(inputHistory[next] ?? "") ?? inputHistory[next] ?? "");
    updateInput(value, value.length);
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
    // 选区存在时（全屏）：Ctrl+C 复制并清除（不中断不退出）；
    // Esc 最先清选区；其他按键清高亮后继续各自路由
    if (selRef.current !== undefined) {
      if (key.ctrl && ch === "c") {
        copySelection(true);
        return;
      }
      setSel(undefined);
      dragRef.current.dragging = false;
      stopEdgeScroll();
      if (key.escape && ch === "" && !key.meta && !key.ctrl) return;
    }
    if (key.ctrl && ch === "o") {
      toggleReasoning();
      return;
    }
    if (key.escape && ch === "" && !key.meta && !key.ctrl) {
      if (escapeTimer.current !== undefined) clearTimeout(escapeTimer.current);
      escapeTimer.current = undefined;
      swallowUntil.current = noteBareEscape(now);
      if (recordOpen) {
        void closeRecord();
        return;
      }
      if (!pageOpen && !dialogOpen && pending === undefined && pendingQ === undefined) {
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
    if (recordOpen) {
      const page = Math.max(1, rows - 4);
      if (key.pageUp || key.pageDown || key.upArrow || key.downArrow) {
        moveScroll((s) =>
          scrollPage(s, key.pageUp ? page : key.pageDown ? -page : key.upArrow ? 1 : -1),
        );
        return;
      }
      if (key.ctrl && key.home) {
        setRecordScroll(scrollToTop());
        return;
      }
      if (key.ctrl && key.end) {
        setRecordScroll(scrollToBottom());
        return;
      }
      if (!(key.ctrl && (ch === "c" || ch === "d"))) return;
    }
    if (key.tab && key.shift) {
      if (pageOpen || dialogOpen || pending !== undefined || pendingQ !== undefined) return;
      cycleEffort();
      return;
    }
    if (isAltM(ch, key)) {
      if (pageOpen || dialogOpen || pending !== undefined || pendingQ !== undefined) return;
      cyclePreset();
      return;
    }
    if (key.meta && !key.ctrl && (ch === "v" || ch === "V")) {
      if (inputIdle) pasteClipboardImage();
      return;
    }
    // 全屏视口翻阅（ADR-0021）：弹层/页面/权限待决时不响应
    if (fullscreen && !pageOpen && !dialogOpen && pending === undefined && pendingQ === undefined) {
      const page = Math.max(1, budget.conversation - 1);
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
    if (
      !dialogOpen &&
      !pageOpen &&
      pendingQ === undefined &&
      completionOpen &&
      selected !== undefined
    ) {
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
        if (fileCompletion !== undefined) {
          applyCandidate(selected, false);
          return;
        }
        const text = selected.insert;
        updateInput("", 0);
        setCompletionOn(true);
        if (fullscreen) setScroll(scrollToBottom());
        void runSlash(text, session, provider)
          .then((r) => {
            const opens = r.kind === "overlay" || r.kind === "picker" || r.kind === "provider-page";
            if (!opens) clearInput();
            if (r.kind === "exit") requestExit();
            else if (r.kind === "new") void doNew();
            else if (r.kind === "overlay") {
              if (r.name === "theme") clearInput();
              if (r.name === "resume" && submitting.current)
                pushLine("! 会话忙（Turn 进行中）；先中断再切换");
              else setOverlay(r.name);
            } else if (r.kind === "picker") openPicker(r.focus);
            else if (r.kind === "provider-page") openProviderPage(r.presetId, r.modelTarget);
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
    if (key.ctrl && ch === "c") {
      if (recordOpen) {
        if (busy) session.interrupt();
        else void closeRecord().then(exit);
        return;
      }
      if (pickerOpen) {
        wizard.cancel();
        void closePicker().then(exit);
        return;
      }
      if (providerPageOpen) {
        ops.wizard.cancel();
        void closeProviderPage().then(exit);
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
      if (recordOpen) {
        void closeRecord().then(requestExit);
        return;
      }
      if (pickerOpen) {
        wizard.cancel();
        void closePicker().then(requestExit);
        return;
      }
      if (providerPageOpen) {
        ops.wizard.cancel();
        void closeProviderPage().then(requestExit);
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
    updateInput("", 0);
  }, []);

  useEffect(() => {
    let active = true;
    setHistoryIndex(undefined);
    void session.readInputHistory().then((rows) => {
      if (active) setInputHistory(rows);
    });
    return () => {
      active = false;
    };
  }, [session]);
  const onSubmit = useCallback(
    (line: string) => {
      const text = line.trim();
      if (text === "") return;
      if (switching.current) {
        pushLine("! 正在切换会话，请稍候");
        return;
      }
      const historyText = images.strip(pastes.expand(text));
      if (!text.startsWith("/") && images.in(text).length > 0) {
        const model = imageModel();
        if (!model.supported) {
          pushLine(`! ${model.hint}`);
          return;
        }
      }
      if (historyText !== "") {
        setInputHistory((history) =>
          history.at(-1) === historyText ? history : [...history.slice(-999), historyText],
        );
        void session.recordInputHistory(historyText);
      }
      setHistoryIndex(undefined);
      if (text.startsWith("/")) {
        void runSlash(text, session, provider)
          .then((r) => {
            const opens = r.kind === "overlay" || r.kind === "picker" || r.kind === "provider-page";
            if (!opens) clearInput();
            if (r.kind === "exit") requestExit();
            else if (r.kind === "new") void doNew();
            else if (r.kind === "overlay") {
              if (r.name === "theme") clearInput();
              if (r.name === "resume" && submitting.current)
                pushLine("! 会话忙（Turn 进行中）；先中断再切换");
              else setOverlay(r.name);
            } else if (r.kind === "picker") openPicker(r.focus);
            else if (r.kind === "provider-page") openProviderPage(r.presetId, r.modelTarget);
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
      if (submitting.current) return;
      const attachments = images.in(text);
      clearInput();
      images.clear();
      if (fullscreen) setScroll(scrollToBottom());
      // 历史存原文，发给模型的也是展开后的原文
      submitting.current = true;
      setSubmitPending(true);
      void session
        .submit({ text: pastes.expand(text), ...(attachments.length > 0 ? { attachments } : {}) })
        .catch((e: unknown) => {
          pushLine(`! ${errText(e)}`);
        })
        .finally(() => {
          submitting.current = false;
          setSubmitPending(false);
        });
    },
    [
      session,
      pushLine,
      clearInput,
      requestExit,
      doSwitch,
      doNew,
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
      : pendingQ !== undefined
        ? "等待回答提问"
        : busy
          ? "会话忙，Ctrl+C 可中断"
          : switchPending
            ? "正在切换会话，请稍候"
            : dialogOpen
              ? "弹层打开中，Esc 关闭"
              : undefined;

  const resumeItems: PickItem<string>[] = (resumeList ?? []).map((s) => ({
    label: resumeLabel(s, width - 10),
    hint: `${s.locked === true ? "locked " : ""}${s.id === session.id ? "当前" : ""}`.trim(),
    value: s.id,
  }));

  // /shell 选择页（ADR-0022 第 4 节）：auto 在前，未安装灰显不可选，
  // 当前选择高亮；被 env/config 覆盖时顶部说明。
  // shellInfo/listShells 只在弹层打开时取值，不随每帧渲染重复探测
  const shellPick =
    overlay === "shell" ? { info: session.shellInfo(), detected: session.listShells() } : undefined;
  const shellItems: PickItem<string>[] =
    shellPick === undefined
      ? []
      : [
          {
            label: "auto",
            hint:
              shellPick.info.effective !== undefined
                ? `自动（当前为 ${shellPick.info.effective.kind}）`
                : "自动选择",
            value: "auto",
          },
          ...shellPick.detected.map((d) => ({
            label: d.available ? `${d.kind}  ${d.name}` : `${d.kind}（未安装）`,
            hint: d.executable,
            value: d.kind,
            disabled: !d.available,
          })),
        ];
  const shellNote =
    shellPick?.info.overriddenBy !== undefined
      ? `当前由 ${shellPick.info.overriddenBy === "env" ? "NOCTURNE_SHELL" : "config.json"} 指定，选择写入 settings.json 但不生效`
      : undefined;

  const budget = frameBudget(
    rows,
    completionOpen ? Math.min(8, Math.max(indexing ? 1 : 0, candidates.length)) : 0,
    input.split("\n").length,
    fullscreen && !pageOpen ? todoPanelRows(view.todos.length) : 0,
  );
  const promptOverlay = pending !== undefined || pendingQ !== undefined;
  const popupHeight = Math.min(
    budget.conversation,
    pending !== undefined
      ? permissionDialogRows(pending, width)
      : pendingQ !== undefined
        ? questionDialogRows(pendingQ, questionPage.index, questionPage.confirm)
        : 0,
  );
  const conversationHeight = budget.conversation - popupHeight;
  const escapePrompt = (): void => {
    if (escapeTimer.current !== undefined) clearTimeout(escapeTimer.current);
    escapeTimer.current = setTimeout(() => {
      escapeTimer.current = undefined;
      if (interruptible.current) session.interrupt();
    }, 80);
  };
  const g = glyphs(env);
  const editor = composerWindow(`${g.prompt} `, input, cursor, width, budget.input);

  // Static 始终保持挂载，进出备用屏幕时不会重新写入旧回滚区。
  const pageBody = pickerOpen ? (
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
          try {
            await closePicker();
            // 先切换本会话模型（不可用模型在此拒绝，ADR-0026 §5），
            // 成功后才落默认模型——避免把默认模型写到不可用的 ref 上
            await session.setModel(ref);
            if (setDefault && provider !== undefined) {
              await provider.config.setDefaultModel(ref);
              provider.updateProviders(await provider.reloadConfig());
            }
          } catch (e) {
            pushLine(`! ${errText(e)}`);
          }
        })();
      }}
      onClose={() => {
        void closePicker();
      }}
      width={width}
      height={budget.frameHeight}
      active={wizardOverlay === undefined}
    />
  ) : providerPageOpen ? (
    <ProviderPage
      key={providerPageKey}
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
      onListModels={ops.listModels}
      onSaveModel={ops.saveModel}
      initialModelTarget={providerPageTarget}
      onMouseFrame={fullscreen ? reportDialogMouse : undefined}
      onClose={() => {
        void closeProviderPage();
      }}
      notice={ops.notice}
      busyText={ops.busyText}
      width={width}
      height={budget.frameHeight}
      termRows={rows}
      active
    />
  ) : null;

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
    theme,
  });
  // —— 全屏视口（ADR-0021 第 1 条）：欢迎区在块表最前随对话滚走；
  // 冻结前缀是 /resume 切换时旧会话的完结条目；live 块每次渲染重排。
  const transcriptSource: Parameters<typeof transcriptBlocks>[0] = {
    welcome,
    notices: bootNotes,
    frozen,
    entries: view.entries,
    hide: hideNotice,
    live: view,
    clientLines,
    ascii: env.ascii,
    reasoning,
    now: reasoningNow,
    expanded: fullscreen ? expanded : true,
    diffExpanded,
    theme,
  };
  sourceRef.current = transcriptSource;
  const blocks: LineBlock[] = fullscreen || recordOpen ? transcriptBlocks(transcriptSource) : [];
  exportBlocksRef.current = { blocks, width };
  blocksRef.current = { blocks, width };
  const showBanner = fullscreen && !scroll.follow && !promptOverlay;
  const transcriptRows = recordOpen
    ? Math.max(0, budget.frameHeight - 2)
    : Math.max(0, conversationHeight - (showBanner ? 1 : 0));
  const activeScroll = recordOpen ? recordScroll : scroll;
  const activeBlocks = blocksRef.current.blocks;
  const visible: VisibleWindow =
    fullscreen || recordOpen
      ? selectVisible(
          activeBlocks,
          width,
          transcriptRows,
          promptOverlay ? 0 : activeScroll.fromBottom,
          lineCache.current,
        )
      : EMPTY_WINDOW;
  // 选区高亮需要绝对行号；未翻到顶时先用 countLaidLines 求总数换算
  const selBase =
    fullscreen && sel !== undefined
      ? visible.exhausted
        ? visible.sliceStart
        : countLaidLines(activeBlocks, width, lineCache.current) -
          visible.collectedLength +
          visible.sliceStart
      : 0;

  // —— inline（普通屏幕）：Static 回滚区记账 + 活动区行
  const header: TranscriptItem[] = [
    { kind: "header", key: `header:${session.id}`, lines: welcome },
    ...bootNotes.map((note, i): TranscriptItem => ({
      kind: "header",
      key: `boot:${session.id}:${i}`,
      lines: [{ key: `boot:${i}`, text: `! ${note}`, color: theme.warning }],
    })),
  ];
  const activityLines: LaidLine[] = [];
  if (!fullscreen) {
    // 本地提示行按推入位置进回滚区；落在未完结条目之后的先留在活动区
    const staticEntries: TranscriptItem[] = [
      ...header,
      ...interleaveClient<ViewEntry, TranscriptItem>(
        prefix,
        0,
        clientLines.filter((line) => line.after <= prefix.length),
        (entry) => (hideNotice(entry) ? [] : [entry]),
        (line) => ({
          kind: "header",
          key: `client:${line.id}`,
          lines: [{ key: `client:${line.id}`, text: line.text, dim: true }],
        }),
      ),
    ];
    const completedLive = new Map<string, string>();
    for (const assistant of view.live.assistants) {
      const step = takeMarkdownBlocks(
        assistant.text,
        staticWritten.current.get(assistant.messageId) ?? 0,
        false,
      );
      completedLive.set(assistant.messageId, step.tail);
      for (const part of step.parts) {
        const key = `a:${assistant.messageId}:@${part.offset}`;
        staticEntries.push({
          kind: "header",
          key,
          lines: renderMarkdown(part.text, width, key, theme),
        });
      }
      staticWritten.current.set(assistant.messageId, step.written);
    }
    const staticBlocks = staticEntries.flatMap<TranscriptItem>((entry) =>
      entry.kind === "assistant" ? assistantBlocks(entry, staticWritten.current) : [entry],
    );
    for (const entry of staticBlocks) {
      const id = `${sessionEpoch.current}:${entry.key}`;
      if (staticKeys.current.has(id)) continue;
      staticKeys.current.add(id);
      staticQueue.current.push({ ...entry, key: id });
    }
    const { tail } = splitCompletedPrefix(view.entries);
    const activityView: SessionView = {
      ...view,
      live: {
        ...view.live,
        assistants: view.live.assistants.map((a) => ({
          ...a,
          text: completedLive.get(a.messageId) ?? a.text,
        })),
      },
    };
    const clientRows = (line: ClientLine): LaidLine[] => [
      { key: `client:${line.id}`, text: line.text, dim: true },
    ];
    const pendingLines = clientLines.filter((line) => line.after > prefix.length);
    activityLines.push(
      ...interleaveClient<ViewEntry, LaidLine[]>(
        tail,
        prefix.length,
        pendingLines.filter((line) => line.after < view.entries.length),
        (entry) => [
          layoutEntry(entry, width, env.ascii, reasoning, reasoningNow, false, false, theme),
        ],
        clientRows,
      ).flat(),
      ...layoutLive(activityView, width, env.ascii, reasoning, reasoningNow, false, theme),
      ...pendingLines.filter((line) => line.after >= view.entries.length).flatMap(clientRows),
    );
  }
  const shownActivity = conversationHeight > 0 ? activityLines.slice(-conversationHeight) : [];
  const activityHeight = shownActivity.length;
  const prompt = `${g.prompt} `;
  const inputY = -(budget.input + budget.completion + budget.status);

  const candidateStart = Math.max(0, completionIndex - budget.completion + 1);
  const shownCandidates = candidates.slice(candidateStart, candidateStart + budget.completion);
  const overlayBody =
    pending !== undefined ? (
      <PermissionDialog
        key={pending.requestId}
        pending={pending}
        active={!dialogOpen}
        onReply={replyPermission}
        height={popupHeight}
        onEscape={escapePrompt}
        width={width}
      />
    ) : pendingQ !== undefined ? (
      <QuestionDialog
        key={pendingQ.requestId}
        pending={pendingQ}
        active={!dialogOpen}
        onReply={replyQuestion}
        height={popupHeight}
        onPageChange={(index, confirm) => {
          setQuestionPage({ requestId: pendingQ.requestId, index, confirm });
        }}
        onEscape={escapePrompt}
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
    ) : overlay === "theme" ? (
      <ThemePage
        width={width}
        height={budget.conversation}
        active
        onSave={async (id) => {
          await runtime.setPreference("theme", id);
          onThemeChange?.(id);
          setOverlay(undefined);
          clearInput();
        }}
        onCancel={() => {
          setOverlay(undefined);
        }}
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
    ) : overlay === "shell" && shellPick !== undefined ? (
      <PickList
        title="选择 shell"
        note={shellNote}
        items={shellItems}
        initialValue={shellPick.info.selected}
        active
        width={width}
        onPick={(kind) => {
          setOverlay(undefined);
          clearInput();
          void session.setShell(kind).catch((e: unknown) => {
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
        title={wizardOverlay.kind === "add" ? "添加服务商" : `更新密钥 ${wizardOverlay.providerId}`}
        state={wizard.state}
        active
        width={width}
        maxRows={Math.max(4, budget.conversation - 2)}
        offsetY={-budget.frameHeight}
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

  // 鼠标处理器读最新一帧的视口几何；页面/弹层占用对话区时整块屏蔽
  geomRef.current = {
    visible,
    transcriptRows,
    blocked: pageOpen || overlayBody !== null,
  };

  /** LaidLine → Text；selected 给本行的选区字符范围时用主题底色拆分 */
  const renderLine = (
    line: LaidLine,
    selected?: { start: number; end: number },
  ): React.JSX.Element => {
    const segments = selected === undefined ? line.segments : selSegments(line, selected, theme);
    // 空行没有可拆分的字符：空 Text 在 Ink 里高度为 0，会让下方各行整体上移。
    // 占一格空格保住行高；落在选区里用选区底色示意空行也被选中。
    if (segments?.every((seg) => seg.text === "") === true) {
      return (
        <Text
          key={line.key}
          {...((selected?.end ?? 0) > 0
            ? { color: theme.selected, backgroundColor: theme.selectionBg }
            : {})}
        >
          {" "}
        </Text>
      );
    }
    return (
      <Text
        key={line.key}
        wrap="truncate"
        {...(line.color !== undefined ? { color: line.color } : {})}
        dimColor={line.dim === true}
        bold={line.bold === true}
        italic={line.italic === true}
      >
        {segments !== undefined
          ? segments.map((seg, i) => (
              <Text
                key={i}
                {...(seg.color !== undefined ? { color: seg.color } : {})}
                {...(seg.backgroundColor !== undefined
                  ? { backgroundColor: seg.backgroundColor }
                  : {})}
                dimColor={seg.dim === true}
                bold={seg.bold === true}
                italic={seg.italic === true}
                strikethrough={seg.strikethrough === true}
              >
                {seg.text}
              </Text>
            ))
          : line.text === ""
            ? " "
            : line.text}
      </Text>
    );
  };

  const recordBody = !recordOpen ? null : (
    <Box flexDirection="column" width={width} height={budget.frameHeight}>
      <Text wrap="truncate" bold>
        完整记录
      </Text>
      <Box flexDirection="column" height={transcriptRows} overflow="hidden">
        {visible.lines.map((line) => renderLine(line))}
        <Box flexGrow={1} />
      </Box>
      <Text dimColor wrap="truncate">
        PgUp/PgDn 翻阅 · Esc 返回
      </Text>
    </Box>
  );

  // 底部固定区：清单（全屏）、输入框光标登记 + Composer + 候选 + 状态栏
  const chrome = (
    <>
      <InputCursor
        active={budget.input > 0 && !pageOpen}
        prefix={prompt}
        text={editor.cursorBefore}
        width={width}
        y={inputY + editor.cursorRow}
      />
      {fullscreen && budget.todo > 0 ? (
        <TodoPanel items={view.todos} width={width} height={budget.todo} />
      ) : null}
      {promptOverlay ? overlayBody : null}
      <Composer
        pastes={pastes}
        value={input}
        cursor={cursor}
        onChange={(next, nextCursor) => {
          updateInput(next, nextCursor);
          setHistoryIndex(undefined);
        }}
        onCursor={(next) => {
          cursorRef.current = next;
          setCursor(next);
        }}
        onHistory={recallHistory}
        onSubmit={onSubmit}
        onPasteImage={onPasteImage}
        active={!dialogOpen && pending === undefined && pendingQ === undefined && !pageOpen}
        disabledReason={composerDisabled}
        width={width}
        height={budget.input}
        showRule={budget.inputRule > 0}
        suspendNav={completionOpen}
        swallowRef={swallowRef}
      />
      {budget.completion > 0 && indexing ? <Text dimColor>正在索引…</Text> : null}
      {budget.completion > 0 && !indexing
        ? shownCandidates.map((item, i) => (
            <Text
              key={item.insert}
              wrap="truncate"
              {...(i + candidateStart === completionIndex
                ? { color: theme.selected, backgroundColor: theme.selectionBg }
                : {})}
            >
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
          note={note ?? (expanded && fullscreen ? "思考已展开（Ctrl+O 收起）" : undefined)}
        />
      ) : null}
    </>
  );

  onOutputLayout?.(
    pageBody !== null || recordBody !== null || overlayBody !== null ? 0 : budget.conversation,
    pickerOpen
      ? "model"
      : providerPageOpen
        ? "provider"
        : recordOpen
          ? "record"
          : overlayBody !== null
            ? "overlay"
            : "conversation",
  );

  return (
    <TuiEnvContext.Provider value={env}>
      {fullscreen ? null : (
        <Transcript
          entries={staticQueue.current}
          width={width}
          reasoning={reasoning}
          now={reasoningNow}
        />
      )}
      {pageBody ??
        recordBody ??
        (fullscreen ? (
          // 全屏：固定帧高 rows-1，上为可滚动视口，下为输入/候选/状态栏
          <Box flexDirection="column" width={width} height={budget.frameHeight}>
            <Box flexDirection="column" height={conversationHeight} overflow="hidden">
              {(promptOverlay ? null : overlayBody) ?? (
                <>
                  {visible.lines.map((line, i) =>
                    renderLine(
                      line,
                      sel === undefined ? undefined : selRangeOnLine(sel, selBase + i),
                    ),
                  )}
                  {/* 弹窗打开时对话仍顶端对齐，不整体下移（弹窗贴在输入框上方） */}
                  <Box flexGrow={1} />
                  {showBanner ? (
                    <Text color={theme.warning} wrap="truncate">
                      {scroll.newContent ? NEW_CONTENT_HINT : SCROLLED_HINT}
                    </Text>
                  ) : null}
                </>
              )}
            </Box>
            {chrome}
          </Box>
        ) : (
          <Box flexDirection="column" width={width}>
            <Box
              flexDirection="column"
              height={promptOverlay || overlayBody === null ? activityHeight : budget.conversation}
              overflow="hidden"
            >
              {(promptOverlay ? null : overlayBody) ??
                shownActivity.map((line) => renderLine(line))}
            </Box>
            {chrome}
          </Box>
        ))}
    </TuiEnvContext.Provider>
  );
}

export type { SessionView };
