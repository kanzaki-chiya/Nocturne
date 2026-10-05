import { useCallback, useEffect, useRef, useState } from "react";

import { PERMISSION_PRESET_NAMES, type ModelRef, type SessionView } from "@nocturne/core/protocol";
import type { RpcRuntime, RpcSession } from "@nocturne/rpc/client";

import type { ChoiceControl, ChoiceGroup, ComposerControls } from "./Composer";
import type { PrefsStore } from "./prefs";

type ModelInfo = Awaited<ReturnType<RpcRuntime["listModels"]>>[number];
type ShellInfo = Awaited<ReturnType<RpcSession["shellInfo"]>>;
type ShellEntry = Awaited<ReturnType<RpcSession["listShells"]>>[number];
type EffortInfo = Awaited<ReturnType<RpcSession["reasoningEffortInfo"]>>;
type SettingItem = Awaited<ReturnType<RpcRuntime["describeSettings"]>>[number];

export const refKey = (ref: ModelRef): string => `${ref.provider}/${ref.model}`;
const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function modelOption(info: ModelInfo) {
  return {
    value: refKey(info.ref),
    label: info.ref.model,
    detail: info.ref.provider,
    ...(info.unavailable !== undefined ? { disabled: info.unavailable.reason } : {}),
  };
}

/** 模型菜单分组：最近使用（在清单内）在前，其余按 listModels 顺序。 */
export function modelGroups(models: ModelInfo[], recents: ModelRef[]): ChoiceGroup[] {
  const byKey = new Map(models.map((info) => [refKey(info.ref), info]));
  const seen = new Set<string>();
  const recent: ModelInfo[] = [];
  for (const ref of recents) {
    const info = byKey.get(refKey(ref));
    if (info !== undefined && !seen.has(refKey(ref))) {
      seen.add(refKey(ref));
      recent.push(info);
    }
  }
  const rest = models.filter((info) => !seen.has(refKey(info.ref)));
  const groups: ChoiceGroup[] = [];
  if (recent.length > 0) groups.push({ label: "最近使用", options: recent.map(modelOption) });
  if (rest.length > 0) groups.push({ label: "全部模型", options: rest.map(modelOption) });
  return groups;
}

export interface SessionControls {
  controls: ComposerControls;
  /** 状态栏 Shell 菜单数据（打开时先调 loadShells 探测） */
  shellControl: ChoiceControl;
  shell: ShellInfo | undefined;
  shells: readonly ShellEntry[] | undefined;
  /** 面板打开时调用；每次调用重新探测 */
  loadShells(): void;
  setShell(kind: string): Promise<void>;
  visionHint: () => Promise<string | undefined>;
}

/** 会话内输入框与状态栏共用的会话数据（模型/档位/预设/Shell）。 */
export function useSessionControls(
  session: RpcSession,
  runtime: RpcRuntime,
  view: SessionView,
  prefs: PrefsStore,
  /** 服务商配置变更计数：变化时重新拉取模型/预设等数据 */
  providersVersion = 0,
): SessionControls {
  const [snapshot, setSnapshot] = useState<{
    model: ModelRef | undefined;
    preset: string | undefined;
    effort: EffortInfo | undefined;
    shell: ShellInfo | undefined;
    models: ModelInfo[];
    recents: ModelRef[];
  } | null>(null);
  const [shells, setShells] = useState<readonly ShellEntry[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const request = useRef(0);
  const mounted = useRef(true);
  const current = useRef(session);
  current.current = session;
  const mutation = useRef(false);

  const refresh = useCallback(async () => {
    const id = ++request.current;
    try {
      const [state, effort, shell, models, recents] = await Promise.all([
        session.state(),
        session.reasoningEffortInfo(),
        session.shellInfo(),
        runtime.listModels(),
        runtime.listRecentModels(),
      ]);
      if (id !== request.current || !mounted.current) return;
      setSnapshot({
        model: state.config.model,
        preset: state.config.permissionPreset,
        effort,
        shell,
        models,
        recents,
      });
      setError(undefined);
    } catch (failure) {
      if (id === request.current && mounted.current) setError(message(failure));
    }
  }, [session, runtime]);

  // 持久条目、状态与配置变化时刷新
  useEffect(() => {
    void refresh();
    return () => {
      request.current += 1;
    };
  }, [
    refresh,
    providersVersion,
    view.entries.length,
    view.status,
    view.config.model?.provider,
    view.config.model?.model,
    view.config.reasoningEffort,
    view.config.permissionPreset,
  ]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    setSnapshot(null);
    setShells(undefined);
    setError(undefined);
    mutation.current = false;
  }, [session]);

  const choose = useCallback(
    async (action: () => Promise<void>) => {
      if (mutation.current) return;
      mutation.current = true;
      try {
        await action();
        if (current.current === session) await refresh();
      } catch (failure) {
        if (current.current === session) setError(message(failure));
      } finally {
        if (current.current === session) mutation.current = false;
      }
    },
    [session, refresh],
  );

  const loadShells = useCallback(() => {
    void session.listShells().then(
      (detected) => {
        if (current.current === session) setShells(detected);
      },
      (failure: unknown) => {
        if (current.current === session) setError(message(failure));
      },
    );
  }, [session]);

  const setShell = useCallback(
    async (kind: string) =>
      choose(async () => {
        await session.setShell(kind);
      }),
    [session, choose],
  );

  const model = snapshot?.model ?? view.config.model;
  const busy = view.status !== "idle" && view.status !== "failed";
  const effort = snapshot?.effort;
  const effortNote = [
    effort?.available.length === 0 ? "该模型未声明可用思考档位" : undefined,
    effort !== undefined && effort.current !== effort.effective
      ? `本 Turn 使用 ${effort.effective}；${effort.current} 将在下一 Turn 生效`
      : undefined,
  ]
    .filter((text): text is string => text !== undefined)
    .join("；");

  const modelControl: ChoiceControl = {
    value: model === undefined ? undefined : refKey(model),
    label: model?.model ?? "模型 —",
    groups: modelGroups(snapshot?.models ?? [], snapshot?.recents ?? []),
    ...(busy ? { disabled: "当前 Turn 结束后可切换" } : {}),
    onSelect: (value) =>
      choose(async () => {
        const info = snapshot?.models.find((item) => refKey(item.ref) === value);
        await session.setModel(info?.ref ?? value);
      }),
  };
  const effortControl: ChoiceControl = {
    value: effort?.current ?? view.config.reasoningEffort,
    label: effort?.current ?? view.config.reasoningEffort ?? "—",
    heading: `思考档位 · ${model?.model ?? "—"}`,
    groups: [
      {
        options: ["off", ...(effort?.available ?? [])].map((level) => ({
          value: level,
          label: level,
        })),
      },
    ],
    ...(effortNote !== "" ? { note: effortNote } : {}),
    onSelect: (value) =>
      choose(async () => {
        await session.setReasoningEffort(value);
        prefs.update({ lastEffort: value });
      }),
  };
  const presetControl: ChoiceControl = {
    value: snapshot?.preset ?? view.config.permissionPreset,
    label: snapshot?.preset ?? view.config.permissionPreset ?? "—",
    groups: [{ options: PERMISSION_PRESET_NAMES.map((name) => ({ value: name, label: name })) }],
    ...(busy ? { disabled: "当前 Turn 结束后可切换" } : {}),
    onSelect: (value) =>
      choose(async () => {
        await session.setPermissionPreset(value);
      }),
  };
  const controls: ComposerControls = {
    model: modelControl,
    effort: effortControl,
    preset: presetControl,
    ...(error !== undefined ? { error } : {}),
  };

  const shell = snapshot?.shell;
  const shellControl: ChoiceControl = {
    value: shell?.selected,
    label: shell?.effective?.kind ?? shell?.selected ?? "—",
    groups: [
      {
        options: [
          { value: "auto", label: "auto", detail: "自动选择" },
          ...(shells ?? []).map((item) => ({
            value: item.kind,
            label: `${item.kind} · ${item.name}`,
            ...(item.executable !== undefined && item.executable !== ""
              ? { detail: item.executable }
              : {}),
            ...(item.available ? {} : { disabled: "未安装" }),
          })),
        ],
      },
    ],
    ...(busy ? { disabled: "当前 Turn 结束后可切换" } : {}),
    ...(shells === undefined
      ? { note: "正在探测 Shell…" }
      : shell?.overriddenBy !== undefined
        ? {
            note: `选择被 ${shell.overriddenBy === "env" ? "NOCTURNE_SHELL" : "config.json"} 覆盖，当前实际使用 ${shell.effective?.kind ?? "—"}。`,
          }
        : {}),
    onSelect: (value) =>
      choose(async () => {
        await session.setShell(value);
      }),
  };

  const visionHint = useCallback(async (): Promise<string | undefined> => {
    const info = await session.visionInfo();
    if (info.imageInput) return undefined;
    if (info.available) {
      return `当前模型不支持图片，将由 ${info.model ?? "视觉模型"} 描述后发送`;
    }
    const currentModel = view.config.model;
    return `当前模型 ${currentModel === undefined ? "—" : `${currentModel.provider}/${currentModel.model}`} 未声明支持图片输入，图片不会发给模型`;
  }, [session, view.config.model]);

  return { controls, shellControl, shell, shells, loadShells, setShell, visionHint };
}

export interface DraftCreateOptions {
  model: ModelRef | undefined;
  reasoningEffort?: string;
  permissionPreset?: string;
}

export interface DraftControls {
  controls: ComposerControls;
  /** 第一条消息建会话用的选项；未触碰的预设/档位省略，让 Core 解析项目默认 */
  createOptions(): DraftCreateOptions;
  error?: string;
}

function pickDefaultModel(
  models: ModelInfo[],
  recents: ModelRef[],
  configured: ModelRef | undefined,
): ModelRef | undefined {
  const byKey = new Map(models.map((info) => [refKey(info.ref), info]));
  for (const ref of recents) {
    const info = byKey.get(refKey(ref));
    if (info !== undefined && info.unavailable === undefined) return info.ref;
  }
  if (configured !== undefined) {
    const info = byKey.get(refKey(configured));
    if (info?.unavailable === undefined) return configured;
  }
  return models.find((info) => info.unavailable === undefined)?.ref;
}

/** 空状态（未建会话）的草稿控件：数据来自常驻后台的 runtime。 */
export function useDraftControls(
  runtime: RpcRuntime | undefined,
  prefs: PrefsStore,
  /** 服务商配置变更计数：变化时重新拉取模型列表 */
  providersVersion = 0,
): DraftControls {
  const [data, setData] = useState<{
    models: ModelInfo[];
    recents: ModelRef[];
    configured: ModelRef | undefined;
    settings: SettingItem[];
  } | null>(null);
  const [picked, setPicked] = useState<{
    model?: string;
    effort?: string;
    preset?: string;
  }>({});
  const [error, setError] = useState<string | undefined>(undefined);
  const request = useRef(0);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  useEffect(() => {
    if (runtime === undefined) return;
    const id = ++request.current;
    let cancelled = false;
    void Promise.all([
      runtime.listModels(),
      runtime.listRecentModels(),
      runtime.defaultModel(),
      runtime.describeSettings(),
    ]).then(
      ([models, recents, configured, settings]) => {
        if (cancelled || id !== request.current) return;
        setData({ models, recents, configured, settings });
        setError(undefined);
        // lastEffort 作为初始（已选）档位；后续按所选模型的可用集合过滤
        const lastEffort = prefsRef.current.get().lastEffort;
        if (lastEffort !== undefined) {
          setPicked((current) => ({ ...current, effort: current.effort ?? lastEffort }));
        }
      },
      (failure: unknown) => {
        if (!cancelled && id === request.current) setError(message(failure));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [runtime, providersVersion]);

  const models = data?.models ?? [];
  const byKey = new Map(models.map((info) => [refKey(info.ref), info]));
  const defaultRef = pickDefaultModel(models, data?.recents ?? [], data?.configured);
  const modelKey = picked.model ?? (defaultRef === undefined ? undefined : refKey(defaultRef));
  const model = modelKey === undefined ? undefined : byKey.get(modelKey);
  const levels = ["off", ...(model?.capabilities.reasoningEffort ?? [])];
  const settingsEffort = data?.settings.find((item) => item.key === "reasoningEffort")?.effective;
  const fallbackEffort =
    settingsEffort !== undefined && levels.includes(settingsEffort) ? settingsEffort : "off";
  // 显式档位 = 用户选过或来自 prefs.lastEffort；模型切换后不在可用集合内则回落默认
  const effortExplicit = picked.effort !== undefined && levels.includes(picked.effort);
  const effort =
    picked.effort !== undefined && levels.includes(picked.effort) ? picked.effort : fallbackEffort;
  const preset =
    picked.preset ?? data?.settings.find((item) => item.key === "permissions.preset")?.effective;
  const effortNote =
    model !== undefined && (model.capabilities.reasoningEffort?.length ?? 0) === 0
      ? "该模型未声明可用思考档位"
      : undefined;

  const controls: ComposerControls = {
    model: {
      value: modelKey,
      label: model?.ref.model ?? "模型 —",
      groups: modelGroups(models, data?.recents ?? []),
      onSelect: (value) => {
        setPicked((current) => ({ ...current, model: value }));
      },
    },
    effort: {
      value: effort,
      label: effort,
      heading: `思考档位 · ${model?.ref.model ?? "—"}`,
      groups: [{ options: levels.map((level) => ({ value: level, label: level })) }],
      ...(effortNote !== undefined ? { note: effortNote } : {}),
      onSelect: (value) => {
        setPicked((current) => ({ ...current, effort: value }));
        prefs.update({ lastEffort: value });
      },
    },
    preset: {
      value: preset,
      label: preset ?? "—",
      groups: [{ options: PERMISSION_PRESET_NAMES.map((name) => ({ value: name, label: name })) }],
      onSelect: (value) => {
        setPicked((current) => ({ ...current, preset: value }));
      },
    },
    ...(error !== undefined ? { error } : {}),
  };

  const createOptions = (): DraftCreateOptions => ({
    model: model?.ref ?? defaultRef,
    ...(effortExplicit ? { reasoningEffort: effort } : {}),
    ...(picked.preset !== undefined ? { permissionPreset: picked.preset } : {}),
  });

  return { controls, createOptions, ...(error !== undefined ? { error } : {}) };
}
