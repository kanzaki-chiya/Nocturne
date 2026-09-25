/**
 * TUI 根组件（tui.md §2）：回放区（<Static> 完结前缀）+ 活动区 +
 * 权限对话框 + 弹层 + 输入行 + 状态栏。
 * 键位路由：Ctrl+C 中断/退出，Ctrl+D 退出，Esc 由弹层组件自闭。
 * /resume：注入的 switchSession 回调执行切换；旧回放冻结进 Static，
 * 新会话重建 SessionView 重放（tui.md §4）。
 */
import { Box, useApp, useInput, useStdout } from "ink";
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
import { Panel } from "./components/panel.js";
import { PermissionDialog } from "./components/permission-dialog.js";
import { PickList, type PickItem } from "./components/pick-list.js";
import { StatusBar } from "./components/status-bar.js";
import { Transcript, type TranscriptItem } from "./components/transcript.js";
import { WizardView } from "./components/wizard-view.js";
import { TuiEnvContext, type TuiEnv } from "./env.js";
import { useSessionView } from "./session-view.js";
import type { SwitchSessionFn } from "./types.js";
import { useProviderWizard } from "./wizard-io.js";

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

export function App({
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
  /** /provider 与模型选择页的配置桥（cli 注入）；缺省时相关命令提示不可用 */
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

  // /provider 向导（add/key）：主屏弹层 + picker 内嵌共用一份状态机
  const wizard = useProviderWizard(provider?.config);
  const [wizardOverlay, setWizardOverlay] = useState<ProviderWizardStart | undefined>(undefined);
  /** /provider remove 确认 */
  const [providerRemove, setProviderRemove] = useState<string | undefined>(undefined);

  const busy = view.status !== "idle";
  const pending = view.pendingPermission;
  // 思考档位段（ADR-0018）：模型声明了可用档位才显示；config_changed 触发重渲染后取新值
  const effortInfo = session.reasoningEffortInfo();
  const effort = effortInfo.available.length > 0 ? effortInfo.current : undefined;
  const { prefix, tail } = splitCompletedPrefix(view.entries);
  const prefixRef = useRef(prefix);
  prefixRef.current = prefix;
  const transcriptItems = useMemo(() => [...frozen, ...prefix], [frozen, prefix]);

  const pushLine = useCallback((text: string) => {
    if (text === "") return;
    setClientLines((prev) => [...prev.slice(-19), ...text.split("\n")]);
  }, []);

  // 初始会话的打开提示（恢复修复摘要等）进提示区——与切换路径同口径；
  // --tui 下 main.ts 不再向 stderr 预打印，避免双份
  useEffect(() => {
    for (const n of sessionNotes(initialSession)) pushLine(`! ${n}`);
  }, [initialSession, pushLine]);

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

  /** 主屏 /provider add|key 弹层 */
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
            pushLine(
              `已保存 ${outcome.providerId}${outcome.model !== undefined ? `（默认 ${outcome.model}）` : ""}`,
            );
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
      if (pickerOpen || dialogOpen || pending !== undefined) return;
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
    [session, pushLine, requestExit, doSwitch, openPicker, openProviderWizard, provider],
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

  return (
    <TuiEnvContext.Provider value={env}>
      <Box flexDirection="column">
        <Transcript entries={transcriptItems} width={width} />
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
        />
        <StatusBar view={view} sessionId={session.id} width={width} effort={effort} />
      </Box>
    </TuiEnvContext.Provider>
  );
}

export type { SessionView };
