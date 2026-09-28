/**
 * 全屏服务商页（tui.md §8；ADR-0019 第 2 条）：
 * 页头（Logo/标题/副标题，首次配置含"第 N 步，共 2 步"）固定不动——
 * 页面高度锁定为终端行数，内容超出时只在列表或表单区域内滚动，
 * 页头与底部按键提示始终完整可见。
 * Logo 自适应：行数 <30 或宽度 <64 时降级为单行文字标题，不画像素 Logo。
 *
 * 未配置预设 Enter → 同页内嵌向导（WizardView，Core 编排，omp 风格表单）；
 * 已配置条目 Enter → 内联操作条（换密钥/刷新模型列表/调整思考档位/编辑模型/删除）；
 * 「编辑模型」打开模型列表/编辑子视图（ADR-0024 第 5 节，model-settings-view.tsx）；
 * 手写层条目 Enter → 模型列表只读查看；当前会话所用服务商不可删除。
 * 全页无打字是非题：删除确认等为 ↑↓/←→ 选项式（ConfirmBox）。
 * 由 App 在备用屏内渲染；进出序列在 App（ADR-0017 约束沿用）。
 * 本组件只管页面内状态与按键，业务逻辑都在父级（Core 公开 API）。
 */
import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";

import type {
  ModelSettingsPatch,
  ModelSettingsView,
  ProviderOverview,
  WizardPreset,
} from "@nocturne/core";

import { useTuiEnv } from "../env.js";
import { truncateLine } from "../format.js";
import { theme } from "../theme.js";
import type { WizardState } from "../wizard-io.js";
import { ConfirmBox } from "./confirm-box.js";
import { ModelEditPane, ModelListPane } from "./model-settings-view.js";
import { PixelLogo } from "./pixel-logo.js";
import { WizardView } from "./wizard-view.js";
import { InputCursor } from "./input-cursor.js";

/** 列表行：预设（可附带同 id 已配置条目）或预设外的已配置条目 */
export type ProviderRow =
  | { kind: "preset"; preset: WizardPreset; configured?: ProviderOverview }
  | { kind: "entry"; overview: ProviderOverview };

/** 预设行与已配置条目合并：内置预设按 defaultName 匹配，其余条目追加 */
export function buildProviderRows(
  presets: readonly WizardPreset[],
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

function rowLabel(row: ProviderRow, currentId: string | undefined, env: { ascii: boolean }) {
  const dotOn = env.ascii ? "*" : "●";
  const dotOff = env.ascii ? "o" : "○";
  const p = row.kind === "preset" ? row.configured : row.overview;
  if (p === undefined) {
    return {
      mark: dotOff,
      name: row.kind === "preset" ? row.preset.label : "",
      detail: "未配置",
      configured: false,
    };
  }
  const tags: string[] = [];
  if (p.id === currentId) tags.push("当前");
  if (p.overridden) tags.push("被 config.json 覆盖");
  if (!p.managed) tags.push("只读");
  const detail =
    `已配置 • ${keySourceText(p)} • ${p.modelCount} 个模型` +
    (tags.length > 0 ? ` • ${tags.join(" • ")}` : "");
  return { mark: dotOn, name: p.id, detail, configured: true };
}

const OPS = ["换密钥", "刷新模型列表", "调整思考档位", "编辑模型", "删除"] as const;
/** 交给父级执行的操作（删除在页内确认后走 onConfirmRemove；「编辑模型」为页内子视图） */
export type ProviderOp = "key" | "refresh" | "thinking";

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
  presets: readonly WizardPreset[];
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
  /** 删除确认由父级执行后的提示/执行回调（页面负责 y/n 确认交互） */
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
  const allRows = useMemo(() => buildProviderRows(presets, entries), [presets, entries]);
  const [cursor, setCursor] = useState(0);
  const [query, setQuery] = useState("");
  const [action, setAction] = useState<{ providerId: string; index: number } | undefined>(
    undefined,
  );
  const [confirmRemove, setConfirmRemove] = useState<string | undefined>(undefined);
  const [localNotice, setLocalNotice] = useState<string | undefined>(undefined);
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

  const openModels = (providerId: string, modelId?: string): void => {
    if (onListModels === undefined) {
      setLocalNotice("当前环境不支持模型设置编辑");
      return;
    }
    setModelsData({ providerId });
    setSubView({ kind: "models", providerId });
    void onListModels(providerId).then(
      (views) => {
        setModelsData({ providerId, views });
        if (modelId !== undefined) {
          if (views.some((v) => v.modelId === modelId)) {
            setSubView({ kind: "edit", providerId, modelId });
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

  const rows = useMemo(() => {
    if (query === "") return allRows;
    const q = query.toLowerCase();
    return allRows.filter((r) => {
      const label = (r.kind === "preset" ? r.preset.label : r.overview.id).toLowerCase();
      const id = (
        r.kind === "preset" ? (r.configured?.id ?? r.preset.id) : r.overview.id
      ).toLowerCase();
      const host =
        (r.kind === "preset" ? r.configured?.host : r.overview.host)?.toLowerCase() ?? "";
      return label.includes(q) || id.includes(q) || host.includes(q);
    });
  }, [allRows, query]);
  const cur = Math.min(cursor, Math.max(0, rows.length - 1));

  const wizardActive = wizard?.state.running === true;
  const noticeLine = localNotice ?? notice;

  // 布局预算（ADR-0019 第 3 条）：页头固定、整页锁高、内容区内部滚动。
  // 像素 Logo 只在高度 ≥30 且宽度 ≥64 时绘制；否则单行文字标题。
  const showLogo = width >= 64 && (termRows ?? height) >= 30;
  const headerH = showLogo ? 5 : stepLabel !== undefined ? 3 : 2;
  // 底部：结果/操作/确认区 + 按键提示行。确认框（边框+标题+说明+选项）5 行；
  // 子视图打开时页面不再追加自己的提示行（提示由子视图提供，footer 只留结果/操作行）
  const footerH = subView !== undefined ? 1 : 1 + (confirmRemove !== undefined ? 5 : 1);
  const contentH = Math.max(4, height - headerH - footerH);
  const listH = Math.max(1, contentH - 1); // 过滤行占 1 行
  const start = Math.min(
    Math.max(0, cur - Math.floor(listH / 2)),
    Math.max(0, rows.length - listH),
  );
  const visible = rows.slice(start, start + listH);
  const showScroll = rows.length > listH;
  const thumbH = Math.max(1, Math.round((listH / rows.length) * listH));
  const thumbStart = Math.round((start / Math.max(1, rows.length - listH)) * (listH - thumbH));

  useInput(
    (ch, key) => {
      // 删除确认（ConfirmBox 自己吃键时这里不再处理）
      if (confirmRemove !== undefined) return;
      // 操作条：←/→ 选择、Enter 执行、Esc 返回
      if (action !== undefined) {
        if (key.escape) {
          setAction(undefined);
          return;
        }
        if (key.leftArrow) {
          setAction((a) =>
            a === undefined ? a : { ...a, index: (a.index + OPS.length - 1) % OPS.length },
          );
          return;
        }
        if (key.rightArrow) {
          setAction((a) => (a === undefined ? a : { ...a, index: (a.index + 1) % OPS.length }));
          return;
        }
        if (key.return) {
          const op = OPS[action.index] ?? OPS[0];
          const id = action.providerId;
          setAction(undefined);
          if (op === "删除") {
            if (id === currentProviderId) {
              setLocalNotice(`"${id}" 是当前会话正在使用的服务商；先 /model 切换再删除`);
            } else {
              setConfirmRemove(id);
            }
            return;
          }
          if (op === "编辑模型") {
            setAction(undefined);
            openModels(id);
            return;
          }
          const realOp: ProviderOp =
            op === "换密钥" ? "key" : op === "刷新模型列表" ? "refresh" : "thinking";
          onOp(id, realOp);
          return;
        }
        return;
      }

      if (key.escape) {
        if (query !== "") {
          setQuery("");
          setCursor(0);
          return;
        }
        onClose();
        return;
      }
      if (key.upArrow) {
        setCursor((c) => (c + rows.length - 1) % Math.max(1, rows.length));
        return;
      }
      if (key.downArrow) {
        setCursor((c) => (c + 1) % Math.max(1, rows.length));
        return;
      }
      if (key.pageUp) {
        setCursor((c) => Math.max(0, c - listH));
        return;
      }
      if (key.pageDown) {
        setCursor((c) => Math.min(Math.max(0, rows.length - 1), c + listH));
        return;
      }
      if (key.home) {
        setCursor(0);
        return;
      }
      if (key.end) {
        setCursor(Math.max(0, rows.length - 1));
        return;
      }
      if (key.return) {
        const row = rows[cur];
        if (row === undefined) return;
        setLocalNotice(undefined);
        if (row.kind === "preset" && row.configured === undefined) {
          onStartWizard(row.preset.id);
          return;
        }
        const entry = row.kind === "preset" ? row.configured : row.overview;
        if (entry === undefined) return;
        if (!entry.managed) {
          // 只读条目：进入模型列表只读查看（ADR-0024 第 5 节）
          openModels(entry.id);
          return;
        }
        setAction({ providerId: entry.id, index: 0 });
        return;
      }
      if (key.backspace || key.delete) {
        if (query !== "") {
          setQuery((q) => q.slice(0, -1));
          setCursor(0);
        }
        return;
      }
      if (ch !== "" && !key.ctrl && !key.meta) {
        setQuery((q) => q + ch);
        setCursor(0);
      }
    },
    { isActive: active && !wizardActive && confirmRemove === undefined && subView === undefined },
  );

  const titleRow = (
    <Box flexDirection="row" height={headerH}>
      {showLogo ? <PixelLogo /> : null}
      <Box flexDirection="column" marginLeft={showLogo ? 2 : 0}>
        <Text bold color={theme.accent} wrap="truncate">
          Nocturne · 服务商
        </Text>
        <Text color={theme.muted} wrap="truncate">
          {truncateLine("选择服务商进行配置；可配置多个，完成后按 Esc", width - 2)}
        </Text>
        {stepLabel !== undefined ? <Text color={theme.info}>{stepLabel}</Text> : null}
      </Box>
    </Box>
  );

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

  const content = wizardActive ? (
    <WizardView
      title="添加服务商"
      state={wizard.state}
      active={active}
      width={width - 2}
      maxRows={contentH}
      offsetY={headerH - height}
      onSubmit={wizard.submit}
      onSubmitMulti={wizard.submitMulti}
      onCancel={wizard.cancel}
    />
  ) : subView?.kind === "models" ? (
    <ModelListPane
      providerId={subView.providerId}
      views={modelsData?.providerId === subView.providerId ? modelsData.views : undefined}
      readonlyHint={modelsHint}
      error={modelsData?.providerId === subView.providerId ? modelsData.error : undefined}
      active={active}
      width={width}
      height={contentH}
      onOpen={(modelId) => {
        setSubView({ kind: "edit", providerId: subView.providerId, modelId });
        setSaveError(undefined);
      }}
      onBack={() => {
        setSubView(undefined);
        setModelsData(undefined);
      }}
    />
  ) : subView?.kind === "edit" && editView !== undefined ? (
    <ModelEditPane
      view={editView}
      readonly={modelsReadonly || editView.readonly}
      readonlyHint={editView.readonlyHint}
      error={saveError}
      saving={saving}
      active={active}
      width={width}
      height={contentH}
      onSave={(patch) => {
        saveModel(subView.providerId, editView.modelId, patch);
      }}
      onBack={() => {
        setSubView({ kind: "models", providerId: subView.providerId });
        setSaveError(undefined);
      }}
    />
  ) : (
    <Box flexDirection="column">
      <Text wrap="truncate">
        <Text color={theme.muted}>{"过滤: "}</Text>
        {query}
        <Text inverse> </Text>
      </Text>
      <Box flexDirection="row" height={listH}>
        <Box flexDirection="column" flexGrow={1}>
          {visible.map((row, i) => {
            const idx = start + i;
            const focused = idx === cur;
            const l = rowLabel(row, currentProviderId, env);
            const text = ` ${l.mark} ${l.name}  ${l.detail}`;
            return (
              <Text key={idx} wrap="truncate">
                <Text
                  inverse={focused}
                  color={focused ? theme.accent : l.configured ? theme.success : theme.muted}
                >
                  {truncateLine(text, width - (showScroll ? 6 : 4))}
                </Text>
              </Text>
            );
          })}
          {rows.length === 0 ? <Text color={theme.muted}>（无匹配）</Text> : null}
        </Box>
        {showScroll ? (
          <Box flexDirection="column" width={1} marginLeft={1}>
            {Array.from({ length: listH }, (_, i) => (
              <Text
                key={i}
                color={i >= thumbStart && i < thumbStart + thumbH ? theme.accent : theme.muted}
              >
                {env.ascii ? (i >= thumbStart && i < thumbStart + thumbH ? "#" : "|") : "█"}
              </Text>
            ))}
          </Box>
        ) : null}
      </Box>
    </Box>
  );

  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      <InputCursor
        active={
          active &&
          !wizardActive &&
          confirmRemove === undefined &&
          action === undefined &&
          subView === undefined
        }
        prefix="过滤: "
        text={query}
        width={width - 2}
        y={headerH - height}
      />
      {titleRow}
      <Box flexDirection="column" height={contentH} overflow="hidden">
        {content}
      </Box>
      {confirmRemove !== undefined ? (
        <ConfirmBox
          title={`删除服务商 ${confirmRemove}`}
          detail="同时删除其凭据（providers.json 条目与凭据索引）"
          confirmLabel="删除"
          active={active}
          width={width}
          onConfirm={() => {
            const id = confirmRemove;
            setConfirmRemove(undefined);
            onConfirmRemove(id);
          }}
          onCancel={() => {
            setConfirmRemove(undefined);
            setLocalNotice("已取消删除");
          }}
        />
      ) : action !== undefined ? (
        <Text wrap="truncate">
          {OPS.map((op, i) => (
            <Text key={op}>
              {i > 0 ? " " : ""}
              <Text inverse={action.index === i}>[{op}]</Text>
            </Text>
          ))}
          <Text color={theme.muted}> 左右选择，Enter 执行，Esc 返回</Text>
        </Text>
      ) : (
        <Text wrap="truncate" color={noticeLine !== undefined ? theme.accent : theme.muted}>
          {truncateLine(busyText ?? noticeLine ?? "", width - 4)}
        </Text>
      )}
      {subView === undefined ? (
        <Text color={theme.muted} wrap="truncate">
          {truncateLine("↑/↓ 选择 • Enter 确认 • Esc 返回/完成 • Ctrl+C 退出", width - 4)}
        </Text>
      ) : null}
    </Box>
  );
}
