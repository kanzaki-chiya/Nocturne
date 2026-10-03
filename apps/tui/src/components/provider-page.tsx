/**
 * 全屏服务商页（tui.md §8；ADR-0019 第 2 条、ADR-0045）：
 * 用 PageShell 画双栏——左栏「已配置 / 可添加」用于跳转，右栏按组列出全部服务商。
 * 首次配置（带 stepLabel）时顶部保留像素 Logo；从 /provider 进入则不画 Logo。
 *
 * 未配置预设 Enter → 覆盖列表的配置对话框（WizardView，Core 编排）；
 * 已配置条目 Enter → 居中操作对话框（換密钥/刷新模型列表/编辑模型/删除）；
 * 「编辑模型」打开模型列表/编辑子视图（ADR-0024 第 5 节，model-settings-view.tsx）；
 * 手写层条目 Enter → 模型列表只读查看；当前会话所用服务商不可删除。
 * Delete → 可删除条目直达删除确认（ADR-0030 §6）；当前会话在用/只读/未配置条目
 * 拒绝并给原因（沿用说明区），不开确认框；Backspace 仍只删过滤字符。
 * 由 App 在备用屏内渲染；进出序列在 App（ADR-0017 约束沿用）。
 * 本组件只管页面内状态与按键，业务逻辑都在父级（Core 公开 API）。
 */
import { Box, Text } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";

import type {
  ModelSettingsPatch,
  ModelSettingsView,
  ProviderOverview,
  ProviderPreset,
} from "@nocturne/core";

import { useTuiEnv } from "../env.js";
import { useTheme } from "../theme.js";
import type { WizardState } from "../wizard-io.js";
import { providerCredentialDescription } from "../text-format.js";
import { ProviderDialog } from "./provider-dialog.js";
import { ModelEditPane, ModelListPane } from "./model-settings-view.js";
import type { DialogMouseFrame } from "./dialog/mouse.js";
import {
  PageShell,
  type ShellGroup,
  type ShellNotice,
  type ShellRow,
  type ShellSideItem,
  type ShellSpan,
} from "./page/page-shell.js";
import { PixelLogo } from "./pixel-logo.js";
import { WizardView } from "./wizard-view.js";

/** 列表行：预设（可附带同 id 已配置条目）或预设外的已配置条目 */
export type ProviderRow =
  | { kind: "preset"; preset: ProviderPreset; configured?: ProviderOverview }
  | { kind: "entry"; overview: ProviderOverview };

/** 预设行与已配置条目合并：内置预设按 defaultName 匹配，其余条目追加 */
export function buildProviderRows(
  presets: readonly ProviderPreset[],
  entries: readonly ProviderOverview[],
): ProviderRow[] {
  const used = new Set<string>();
  const rows: ProviderRow[] = presets.map((preset) => {
    const configured =
      preset.defaultName !== "" ? entries.find((e) => e.id === preset.defaultName) : undefined;
    if (configured !== undefined) used.add(configured.id);
    return { kind: "preset", preset, ...(configured !== undefined ? { configured } : {}) };
  });
  for (const e of entries) {
    if (!used.has(e.id)) rows.push({ kind: "entry", overview: e });
  }
  return rows;
}

function keySourceText(p: ProviderOverview): string {
  switch (p.keySource) {
    case "credential":
      return "凭据文件";
    case "env":
      return `环境变量 ${p.keyEnvName ?? ""}`.trim();
    default:
      return "密钥缺失";
  }
}

const STATUS_TEXT = {
  valid: "有效",
  expiring: "即将过期",
  expired: "已失效",
  missing: "缺少密钥",
} as const;

const GROUPS: readonly ShellGroup[] = [
  { id: "configured", label: "已配置" },
  { id: "available", label: "可添加" },
];

function entryOf(row: ProviderRow): ProviderOverview | undefined {
  return row.kind === "preset" ? row.configured : row.overview;
}

/** 服务商页右栏的一行（ADR-0045 第 3 节）：状态点、名称、状态、认证方式 + 当前/模型数 */
function shellRow(
  row: ProviderRow,
  id: string,
  currentId: string | undefined,
  dots: { on: string; off: string },
): ShellRow {
  const p = entryOf(row);
  if (p === undefined) {
    const label = row.kind === "preset" ? row.preset.label : "";
    return {
      id,
      group: "available",
      cells: [
        {
          spans: [
            { text: dots.off, tone: "muted" },
            { text: ` ${label}`, tone: "muted" },
          ],
        },
        { text: "未配置", tone: "muted" },
      ],
      search: label,
    };
  }
  const status =
    p.credentialStatus !== undefined
      ? STATUS_TEXT[p.credentialStatus]
      : p.keySource === "missing"
        ? STATUS_TEXT.missing
        : "已配置";
  const statusTone =
    p.credentialStatus === undefined || p.credentialStatus === "valid" ? "success" : "warning";
  const auth = [p.auth ?? keySourceText(p)].join("");
  const trail: { text: string; tone: "accent" | "muted" | "warning" }[] = [];
  if (p.id === currentId) trail.push({ text: "当前", tone: "accent" });
  if (p.overridden) trail.push({ text: "被 config.json 覆盖", tone: "warning" });
  if (!p.managed) trail.push({ text: "只读", tone: "muted" });
  trail.push({ text: `${p.modelCount} 个模型`, tone: "muted" });
  return {
    id,
    group: "configured",
    cells: [
      {
        spans: [{ text: dots.on, tone: statusTone }, { text: ` ${p.id}` }],
      },
      { text: status, tone: statusTone },
      { text: auth, tone: "muted" },
    ],
    trail,
    search: `${p.id} ${p.host ?? ""} ${row.kind === "preset" ? row.preset.label : ""}`,
  };
}

/** 交给父级执行的操作（删除在页内确认后走 onConfirmRemove；「编辑模型」为页内子视图） */
export type ProviderOp = "key" | "refresh" | "login" | "logout";

export function ProviderPage({
  presets,
  entries,
  currentProviderId,
  wizard,
  onStartWizard,
  onOp,
  onReadonlyHint,
  onConfirmRemove,
  onListModels,
  onSaveModel,
  onMouseFrame,
  initialModelTarget,
  onClose,
  notice,
  busyText,
  stepLabel,
  width,
  height,
  termRows,
  active,
}: {
  presets: readonly ProviderPreset[];
  /** 已配置条目（describeProviders 结果） */
  entries: readonly ProviderOverview[];
  /** 当前会话所用服务商 id（删除保护 + 「当前」标记） */
  currentProviderId?: string | undefined;
  /** 内嵌向导状态；preset Enter 时经 onStartWizard 启动 */
  wizard:
    | {
        state: WizardState;
        submit: (v: string) => void;
        submitMulti: (indices: number[]) => void;
        cancel: () => void;
      }
    | undefined;
  onStartWizard: (presetId: string) => void;
  /** 已配置条目的四个操作（父级执行；remove 已在页内确认过） */
  onOp: (providerId: string, op: ProviderOp) => void;
  /** 只读条目的提示文案（父级按 origin 给文件路径） */
  onReadonlyHint: (entry: ProviderOverview) => string;
  /** 删除确认后交给父级执行（默认取消的按钮确认）。 */
  onConfirmRemove: (providerId: string) => void;
  /**
   * 模型设置读取（ADR-0024）：Core listModelSettings 的桥；
   * 缺省时「编辑模型」给出不可用提示
   */
  onListModels?: ((providerId: string) => Promise<ModelSettingsView[]>) | undefined;
  /**
   * 模型设置保存：返回值 undefined = 成功，string = 失败原因（页内显示不退出）；
   * 成功后由调用方负责 reloadConfig + updateProviders
   */
  onSaveModel?:
    | ((
        providerId: string,
        modelId: string,
        patch: ModelSettingsPatch,
      ) => Promise<string | undefined>)
    | undefined;
  /** /provider model 直达目标：打开页后直接进入模型列表（含模型 id 时进编辑页） */
  initialModelTarget?: { providerId: string; modelId?: string | undefined } | undefined;
  onMouseFrame?: ((frame: DialogMouseFrame | undefined) => void) | undefined;
  onClose: () => void;
  /** 父级结果行（保存/刷新/删除/换密钥后的提示） */
  notice?: string | undefined;
  /** 父级忙碌提示（如"正在获取模型列表…"） */
  busyText?: string | undefined;
  /** 首次配置流程的步骤标记（"第 1 步，共 2 步"） */
  stepLabel?: string | undefined;
  width: number;
  /** 页面盒高度（全屏帧高，等于终端行数减 1） */
  height: number;
  /** 终端行数。Logo 阈值按终端行数 ≥30，不按帧高。缺省时用 height。 */
  termRows?: number | undefined;
  active: boolean;
}): React.JSX.Element {
  const env = useTuiEnv();
  const theme = useTheme();
  const allRows = useMemo(() => buildProviderRows(presets, entries), [presets, entries]);
  const [action, setAction] = useState<{ providerId: string } | undefined>(undefined);
  const [confirmRemove, setConfirmRemove] = useState<string | undefined>(undefined);
  const [localNotice, setLocalNotice] = useState<string | undefined>(undefined);
  const [wizardTitle, setWizardTitle] = useState("配置服务商");
  // 模型设置子视图（ADR-0024）：列表 → 编辑；数据经 onListModels/onSaveModel
  const [subView, setSubView] = useState<
    | { kind: "models"; providerId: string }
    | { kind: "edit"; providerId: string; modelId: string }
    | undefined
  >(undefined);
  const [modelsData, setModelsData] = useState<
    | { providerId: string; views?: readonly ModelSettingsView[] | undefined; error?: string }
    | undefined
  >(undefined);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  // 镜像 ref：一次 'data' 突发里的多个按键可能在 React 提交前到达，
  // handler 读写同步更新的 ref，不用渲染闭包里的旧状态（子视图门控同理）。
  const actionRef = useRef(action);
  const confirmRemoveRef = useRef(confirmRemove);
  const subViewRef = useRef(subView);
  const setSubViewNow = (v: typeof subView): void => {
    subViewRef.current = v;
    setSubView(v);
  };
  const setActionNow = (v: typeof action): void => {
    actionRef.current = v;
    setAction(v);
  };
  const setConfirmRemoveNow = (v: string | undefined): void => {
    confirmRemoveRef.current = v;
    setConfirmRemove(v);
  };

  const openModels = (providerId: string, modelId?: string): void => {
    if (onListModels === undefined) {
      setLocalNotice("当前环境不支持模型设置编辑");
      return;
    }
    setModelsData({ providerId });
    setSubViewNow({ kind: "models", providerId });
    void onListModels(providerId).then(
      (views) => {
        setModelsData({ providerId, views });
        if (modelId !== undefined) {
          if (views.some((v) => v.modelId === modelId)) {
            setSubViewNow({ kind: "edit", providerId, modelId });
          } else {
            setLocalNotice(`! 模型 "${modelId}" 不在 ${providerId} 的清单中`);
          }
        }
      },
      (e: unknown) => {
        setModelsData({
          providerId,
          error: e instanceof Error ? e.message : String(e),
        });
      },
    );
  };

  const saveModel = (providerId: string, modelId: string, patch: ModelSettingsPatch): void => {
    if (onSaveModel === undefined) {
      setSaveError("当前环境不支持模型设置编辑");
      return;
    }
    setSaving(true);
    setSaveError(undefined);
    void onSaveModel(providerId, modelId, patch).then((err) => {
      setSaving(false);
      if (err !== undefined) {
        setSaveError(err);
        return;
      }
      // 成功 → 回列表并刷新（结果行走页面 notice 区）
      setLocalNotice(`已保存 ${providerId}/${modelId}`);
      openModels(providerId);
    });
  };

  // /provider model 直达（挂载后进入列表；含模型 id 时继续进编辑页）
  const targetRef = useRef(initialModelTarget);
  useEffect(() => {
    const t = targetRef.current;
    if (t !== undefined) openModels(t.providerId, t.modelId);
    // 仅挂载时执行一次
  }, []);

  const wizardActive = wizard?.state.running === true;
  const noticeLine = localNotice ?? notice;

  /**
   * 删除入口（ADR-0030 §6），Delete 键与操作条「删除」共用：
   * 当前会话正在使用或只读条目拒绝并给出原因（走页面结果行，不开确认框）；
   * 可删除条目打开现有确认框，真正删除仍由确认框里的 Enter 触发。
   */
  const requestRemove = (entry: ProviderOverview): void => {
    if (entry.id === currentProviderId) {
      setLocalNotice(`"${entry.id}" 是当前会话正在使用的服务商；先 /model 切换再删除`);
      return;
    }
    if (!entry.managed) {
      setLocalNotice(onReadonlyHint(entry));
      return;
    }
    setConfirmRemoveNow(entry.id);
  };

  // 布局（ADR-0045）：首次配置保留像素 Logo（高度 ≥30 且宽度 ≥64），其余全交给 PageShell。
  const showLogo = stepLabel !== undefined && width >= 64 && (termRows ?? height) >= 30;
  const logoH = showLogo ? 5 : 0;
  const subtitle = `${stepLabel !== undefined && !showLogo ? `${stepLabel} · ` : ""}选择服务商进行配置；可配置多个，完成后按 Esc`;
  const dots = { on: env.ascii ? "*" : "●", off: env.ascii ? "o" : "○" };
  const shellRows = useMemo(() => {
    const configured: ShellRow[] = [];
    const available: ShellRow[] = [];
    allRows.forEach((row, index) => {
      const shell = shellRow(row, String(index), currentProviderId, dots);
      (entryOf(row) !== undefined ? configured : available).push(shell);
    });
    return [...configured, ...available];
  }, [allRows, currentProviderId, dots.on, dots.off]);
  const configuredCount = shellRows.filter((r) => r.group === "configured").length;
  const sideItems: ShellSideItem[] = [
    { id: "configured", label: "已配置", count: configuredCount },
    { id: "available", label: "可添加", count: shellRows.length - configuredCount, tone: "muted" },
  ];
  const rowOf = (id: string | undefined): ProviderRow | undefined =>
    id === undefined ? undefined : allRows[Number(id)];

  const openRow = (row: ProviderRow): void => {
    setLocalNotice(undefined);
    if (row.kind === "preset" && row.configured === undefined) {
      setWizardTitle(`配置 ${row.preset.label}`);
      onStartWizard(row.preset.id);
      return;
    }
    const entry = row.kind === "preset" ? row.configured : row.overview;
    if (entry === undefined) return;
    if (!entry.managed) {
      setLocalNotice(onReadonlyHint(entry));
      openModels(entry.id);
      return;
    }
    setActionNow({ providerId: entry.id });
  };

  const modelsEntry =
    subView !== undefined ? entries.find((e) => e.id === subView.providerId) : undefined;
  // 只读以 Core 视图为准（服务商在 providers.json 才可编辑，ADR-0024）；
  // 视图未加载时退回条目 managed（被 config.json 整换覆盖的条目此时仍只读）
  const modelsReadonly =
    modelsData?.views?.[0]?.readonly ?? (modelsEntry !== undefined ? !modelsEntry.managed : false);
  const modelsHint =
    modelsData?.views?.[0]?.readonlyHint ??
    (modelsReadonly && modelsEntry !== undefined ? onReadonlyHint(modelsEntry) : undefined);
  const editView =
    subView?.kind === "edit"
      ? modelsData?.views?.find((v) => v.modelId === subView.modelId)
      : undefined;

  const subHeight = Math.max(1, height - 2);
  const content =
    subView?.kind === "models" ? (
      <ModelListPane
        providerId={subView.providerId}
        views={modelsData?.providerId === subView.providerId ? modelsData.views : undefined}
        readonlyHint={modelsHint}
        error={modelsData?.providerId === subView.providerId ? modelsData.error : undefined}
        active={active}
        width={width}
        height={subHeight}
        onOpen={(modelId) => {
          setSubViewNow({ kind: "edit", providerId: subView.providerId, modelId });
          setSaveError(undefined);
        }}
        onBack={() => {
          setSubViewNow(undefined);
          setModelsData(undefined);
        }}
      />
    ) : subView?.kind === "edit" && editView !== undefined ? (
      <ModelListPane
        providerId={subView.providerId}
        views={modelsData?.views}
        readonlyHint={modelsHint}
        active={false}
        width={width}
        height={subHeight}
        onOpen={() => undefined}
        onBack={() => undefined}
      />
    ) : null;

  const noticeTone: ShellNotice["tone"] =
    noticeLine?.startsWith("!") === true ? "warning" : "accent";
  const shellNotice =
    busyText !== undefined || noticeLine !== undefined
      ? { text: busyText ?? noticeLine ?? "", tone: noticeTone }
      : undefined;
  const describe = (row: ShellRow | undefined): ShellSpan[][] => {
    const source = rowOf(row?.id);
    if (source === undefined) return [];
    const p = entryOf(source);
    if (p === undefined) {
      const label = source.kind === "preset" ? source.preset.label : "";
      return [
        [
          { text: label, tone: "secondary" },
          { text: "  尚未配置", tone: "muted" },
        ],
        [{ text: "Enter 开始配置（向导会依次询问地址、密钥和模型）", tone: "muted" }],
      ];
    }
    const credential = providerCredentialDescription(p) || keySourceText(p);
    return [
      [
        { text: p.id, tone: "secondary" },
        {
          text: `  ${p.host ?? p.type} · ${p.type} · ${p.modelCount} 个模型${p.id === currentProviderId ? " · 当前会话在用" : ""}`,
          tone: "muted",
        },
      ],
      [
        {
          text: p.managed ? `认证：${credential}` : onReadonlyHint(p),
          tone: p.managed ? "muted" : "warning",
        },
      ],
    ];
  };

  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      <Box flexDirection="column" display={subView === undefined ? "flex" : "none"}>
        {showLogo ? (
          <Box flexDirection="row" height={logoH}>
            <PixelLogo />
            <Box flexDirection="column" marginLeft={2}>
              <Text bold color={theme.accent} wrap="truncate">
                Nocturne · 首次配置
              </Text>
              <Text color={theme.info}>{stepLabel}</Text>
            </Box>
          </Box>
        ) : null}
        <PageShell
          title={["服务商"]}
          count={`${configuredCount} 已配置`}
          subtitle={subtitle}
          rows={shellRows}
          groups={GROUPS}
          sidebar={{ items: sideItems, mode: "jump" }}
          arrows="focus"
          describe={describe}
          notice={shellNotice}
          hints={({ focus }) =>
            focus === "side"
              ? [
                  ["↑↓", "移动"],
                  ["Enter", "跳转"],
                  ["Tab", width < 72 ? "切换分组" : "切换栏"],
                  ["Esc", "返回"],
                ]
              : [
                  ["↑↓", "移动"],
                  ["Enter", "操作"],
                  ["Delete", "删除"],
                  ["Tab", width < 72 ? "切换分组" : "切换栏"],
                  ["Esc", "返回"],
                ]
          }
          emptyText="（无匹配）"
          width={width}
          height={height - logoH}
          active={
            active &&
            !wizardActive &&
            action === undefined &&
            confirmRemove === undefined &&
            subView === undefined
          }
          mouseLayer="provider-list"
          onMouseFrame={onMouseFrame}
          onSelect={() => {
            setLocalNotice(undefined);
          }}
          onClose={onClose}
          onActivate={(id) => {
            const row = rowOf(id);
            if (row !== undefined) openRow(row);
          }}
          onKey={(_input, key, ctx) => {
            if (!key.delete || ctx.focus !== "list") return false;
            // Delete = 删除入口（ADR-0030 §6），不再删除过滤字符。
            // 未配置预设 / 当前会话在用 / 只读条目都给原因并停在这里，不开确认框。
            const row = rowOf(ctx.rowId);
            if (row === undefined) return true;
            const entry = entryOf(row);
            if (entry === undefined) {
              setLocalNotice(
                `"${row.kind === "preset" ? row.preset.label : ""}" 尚未配置，没有可删除的内容`,
              );
              return true;
            }
            requestRemove(entry);
            return true;
          }}
        />
      </Box>
      {subView !== undefined ? (
        <>
          <Box flexShrink={0}>
            <Text bold color={theme.accent} wrap="truncate">
              {`服务商 › ${subView.providerId} › 模型`}
            </Text>
          </Box>
          <Box flexDirection="column" height={subHeight} overflow="hidden">
            {content}
          </Box>
          <Text wrap="truncate" color={noticeLine !== undefined ? theme.accent : theme.muted}>
            {busyText ?? noticeLine ?? ""}
          </Text>
        </>
      ) : null}
      {wizardActive ? (
        <Box position="absolute" width={width} height={height}>
          <WizardView
            title={wizardTitle}
            state={wizard.state}
            active={active}
            width={width}
            height={height}
            onSubmit={wizard.submit}
            onSubmitMulti={wizard.submitMulti}
            onCancel={wizard.cancel}
            onMouseFrame={onMouseFrame}
          />
        </Box>
      ) : confirmRemove !== undefined || action !== undefined ? (
        <Box position="absolute" width={width} height={height}>
          <ProviderDialog
            key={confirmRemove !== undefined ? "remove" : "actions"}
            providerId={confirmRemove ?? action?.providerId ?? ""}
            confirmRemove={confirmRemove !== undefined}
            deleteDisabled={(confirmRemove ?? action?.providerId) === currentProviderId}
            width={width}
            height={height}
            active={active}
            onMouseFrame={onMouseFrame}
            onActivate={(op) => {
              if (confirmRemove !== undefined) {
                const id = confirmRemove;
                setConfirmRemoveNow(undefined);
                if (op === "remove") onConfirmRemove(id);
                else setLocalNotice("已取消删除");
                return;
              }
              if (action === undefined) return;
              const id = action.providerId;
              setActionNow(undefined);
              if (op === "remove") {
                const entry = entries.find((e) => e.id === id);
                if (entry !== undefined) requestRemove(entry);
              } else if (op === "model") openModels(id);
              else if (op === "key" || op === "refresh" || op === "login" || op === "logout") {
                if (op === "key") setWizardTitle(`换密钥 ${id}`);
                if (op === "login") setWizardTitle(`登录 ${id}`);
                onOp(id, op);
              }
            }}
          />
        </Box>
      ) : null}
      {subView?.kind === "edit" && editView !== undefined ? (
        <Box position="absolute" width={width} height={height}>
          <ModelEditPane
            onMouseFrame={onMouseFrame}
            view={editView}
            readonly={modelsReadonly || editView.readonly}
            readonlyHint={editView.readonlyHint}
            error={saveError}
            saving={saving}
            active={active}
            width={width}
            height={height}
            onSave={(patch) => {
              saveModel(subView.providerId, editView.modelId, patch);
            }}
            onBack={() => {
              setSubViewNow({ kind: "models", providerId: subView.providerId });
              setSaveError(undefined);
            }}
          />
        </Box>
      ) : null}
    </Box>
  );
}
