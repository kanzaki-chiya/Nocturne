/**
 * 全屏服务商页（tui.md §8；ADR-0019 第 2 条）：
 * 页头（Logo/标题/副标题，首次配置含"第 N 步，共 2 步"）固定不动——
 * 页面高度锁定为终端行数，内容超出时只在列表或表单区域内滚动，
 * 页头与底部按键提示始终完整可见。
 * Logo 自适应：行数 <30 或宽度 <64 时降级为单行文字标题，不画像素 Logo。
 *
 * 未配置预设 Enter → 覆盖列表的配置对话框（WizardView，Core 编排）；
 * 已配置条目 Enter → 居中操作对话框（換密钥/刷新模型列表/编辑模型/删除）；
 * 「编辑模型」打开模型列表/编辑子视图（ADR-0024 第 5 节，model-settings-view.tsx）；
 * 手写层条目 Enter → 模型列表只读查看；当前会话所用服务商不可删除。
 * Delete → 可删除条目直达删除确认（ADR-0030 §6）；当前会话在用/只读/未配置条目
 * 拒绝并给原因（沿用结果行），不开确认框；Backspace 仍只删过滤字符。
 * 全页无打字是非题：删除确认等复用对话框按钮。
 * 由 App 在备用屏内渲染；进出序列在 App（ADR-0017 约束沿用）。
 * 本组件只管页面内状态与按键，业务逻辑都在父级（Core 公开 API）。
 */
import { Box, Text, useInput, type DOMElement } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";

import type {
  ModelSettingsPatch,
  ModelSettingsView,
  ProviderOverview,
  WizardPreset,
} from "@nocturne/core";

import { useTuiEnv } from "../env.js";
import { truncateLine } from "../format.js";
import { useTheme } from "../theme.js";
import type { WizardState } from "../wizard-io.js";
import { providerCredentialDescription } from "../text-format.js";
import { ProviderDialog } from "./provider-dialog.js";
import { ModelEditPane, ModelListPane } from "./model-settings-view.js";
import { screenRect, type DialogMouseFrame } from "./dialog/mouse.js";
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

/** 按过滤词筛选行（渲染 useMemo 与按键 handler 共用，后者从 queryRef 取最新值） */
function filterRows(allRows: ProviderRow[], query: string): ProviderRow[] {
  if (query === "") return allRows;
  const q = query.toLowerCase();
  return allRows.filter((r) => {
    const label = (r.kind === "preset" ? r.preset.label : r.overview.id).toLowerCase();
    const id = (
      r.kind === "preset" ? (r.configured?.id ?? r.preset.id) : r.overview.id
    ).toLowerCase();
    const host = (r.kind === "preset" ? r.configured?.host : r.overview.host)?.toLowerCase() ?? "";
    return label.includes(q) || id.includes(q) || host.includes(q);
  });
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
    `已配置 • ${providerCredentialDescription(p) || keySourceText(p)} • ${p.modelCount} 个模型` +
    (tags.length > 0 ? ` • ${tags.join(" • ")}` : "");
  return { mark: dotOn, name: p.id, detail, configured: true };
}

/** 交给父级执行的操作（删除在页内确认后走 onConfirmRemove；「编辑模型」为页内子视图） */
export type ProviderOp = "key" | "refresh" | "login" | "logout";

/**
 * 底部列表提示（ADR-0039 §2）；操作名称只在对话框内显示。
 */
const KEY_HINT = "↑/↓ 选择 • Enter 操作 • Delete 删除 • Esc 返回";

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
  const [cursor, setCursor] = useState(0);
  const [query, setQuery] = useState("");
  const [action, setAction] = useState<{ providerId: string } | undefined>(undefined);
  const [confirmRemove, setConfirmRemove] = useState<string | undefined>(undefined);
  const [localNotice, setLocalNotice] = useState<string | undefined>(undefined);
  const [wizardTitle, setWizardTitle] = useState("配置服务商");
  const rowBoxes = useRef(new Map<number, DOMElement>());
  const listBox = useRef<DOMElement | null>(null);
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
  const cursorRef = useRef(0);
  const queryRef = useRef("");
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
  const setQueryNow = (v: string): void => {
    queryRef.current = v;
    setQuery(v);
  };
  const setCursorNow = (v: number): void => {
    cursorRef.current = v;
    setCursor(v);
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

  const rows = useMemo(() => filterRows(allRows, query), [allRows, query]);
  const cur = Math.min(cursor, Math.max(0, rows.length - 1));

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

  // 布局预算（ADR-0019 第 3 条）：页头固定、整页锁高、内容区内部滚动。
  // 像素 Logo 只在高度 ≥30 且宽度 ≥64 时绘制；否则单行文字标题。
  const showLogo = width >= 64 && (termRows ?? height) >= 30;
  const headerH = showLogo ? 5 : stepLabel !== undefined ? 3 : 2;
  // 底部保留结果与列表提示；子视图自带提示，页面只保留结果行。
  const footerH = subView !== undefined ? 1 : 2;
  const contentH = Math.max(1, height - headerH - footerH);
  const listH = Math.max(1, contentH - 1); // 过滤行占 1 行
  const start = Math.min(
    Math.max(0, cur - Math.floor(listH / 2)),
    Math.max(0, rows.length - listH),
  );
  const visible = rows.slice(start, start + listH);
  const showScroll = rows.length > listH;
  const thumbH = Math.max(1, Math.round((listH / rows.length) * listH));
  const thumbStart = Math.round((start / Math.max(1, rows.length - listH)) * (listH - thumbH));

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

  useEffect(() => {
    if (
      !active ||
      !onMouseFrame ||
      wizardActive ||
      action !== undefined ||
      confirmRemove !== undefined ||
      subView !== undefined
    )
      return;
    onMouseFrame({
      layer: "provider-list",
      boxes: [...rowBoxes.current].map(([index, node]) => {
        const rect = screenRect(node);
        return {
          id: String(index),
          row: rect.row,
          colStart: rect.col,
          colEnd: rect.col + rect.width - 1,
        };
      }),
      click: (id) => {
        const index = Number(id);
        const row = rows[index];
        if (row === undefined) return;
        if (index === cursorRef.current) openRow(row);
        else setCursorNow(index);
      },
      wheel: (mouse) => {
        const rect = screenRect(listBox.current ?? undefined);
        if (
          mouse.y < rect.row ||
          mouse.y >= rect.row + rect.height ||
          mouse.x < rect.col ||
          mouse.x >= rect.col + rect.width
        )
          return;
        setCursorNow(
          Math.max(0, Math.min(rows.length - 1, cursorRef.current + (mouse.dir === "up" ? -3 : 3))),
        );
      },
    });
    return () => {
      onMouseFrame(undefined);
    };
  });

  useInput(
    (ch, key) => {
      // 子视图/对话框打开时本页不吃键（ADR-0030 §4）。isActive 的退订在
      // useEffect 里落后于已提交的帧，旧订阅仍可能被分发到，必须在处理器内再判一次。
      if (subViewRef.current !== undefined) return;
      // 对话框自管按键，冻结下层列表。
      if (confirmRemoveRef.current !== undefined) return;
      if (actionRef.current !== undefined || wizardActive) return;

      if (key.escape) {
        if (queryRef.current !== "") {
          setQueryNow("");
          setCursorNow(0);
          return;
        }
        onClose();
        return;
      }
      const rowsNow = filterRows(allRows, queryRef.current);
      const curNow = Math.min(cursorRef.current, Math.max(0, rowsNow.length - 1));
      if (key.upArrow) {
        setCursorNow((curNow + rowsNow.length - 1) % Math.max(1, rowsNow.length));
        return;
      }
      if (key.downArrow) {
        setCursorNow((curNow + 1) % Math.max(1, rowsNow.length));
        return;
      }
      if (key.pageUp) {
        setCursorNow(Math.max(0, curNow - listH));
        return;
      }
      if (key.pageDown) {
        setCursorNow(Math.min(Math.max(0, rowsNow.length - 1), curNow + listH));
        return;
      }
      if (key.home) {
        setCursorNow(0);
        return;
      }
      if (key.end) {
        setCursorNow(Math.max(0, rowsNow.length - 1));
        return;
      }
      if (key.return) {
        const row = rowsNow[curNow];
        if (row === undefined) return;
        openRow(row);
        return;
      }
      if (key.delete) {
        // Delete = 删除入口（ADR-0030 §6），不再删除过滤字符。
        // 未配置预设 / 当前会话在用 / 只读条目都给原因并停在这里，不开确认框。
        const row = rowsNow[curNow];
        if (row === undefined) return;
        if (row.kind === "preset" && row.configured === undefined) {
          setLocalNotice(`"${row.preset.label}" 尚未配置，没有可删除的内容`);
          return;
        }
        const entry = row.kind === "preset" ? row.configured : row.overview;
        if (entry !== undefined) requestRemove(entry);
        return;
      }
      if (key.backspace) {
        // Backspace 仍只删过滤字符（行为不变）
        if (queryRef.current !== "") {
          setQueryNow(queryRef.current.slice(0, -1));
          setCursorNow(0);
        }
        return;
      }
      if (ch !== "" && !key.ctrl && !key.meta) {
        setQueryNow(queryRef.current + ch);
        setCursorNow(0);
      }
    },
    {
      isActive:
        active &&
        !wizardActive &&
        action === undefined &&
        confirmRemove === undefined &&
        subView === undefined,
    },
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

  const content =
    subView?.kind === "models" ? (
      <ModelListPane
        providerId={subView.providerId}
        views={modelsData?.providerId === subView.providerId ? modelsData.views : undefined}
        readonlyHint={modelsHint}
        error={modelsData?.providerId === subView.providerId ? modelsData.error : undefined}
        active={active}
        width={width}
        height={contentH}
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
        height={contentH}
        onOpen={() => undefined}
        onBack={() => undefined}
      />
    ) : (
      <Box flexDirection="column">
        <Text wrap="truncate">
          <Text color={theme.muted}>{"过滤: "}</Text>
          {query}
          <Text color={theme.selected} backgroundColor={theme.selectionBg}>
            {" "}
          </Text>
        </Text>
        <Box ref={listBox} flexDirection="row" height={listH}>
          <Box flexDirection="column" flexGrow={1}>
            {visible.map((row, i) => {
              const idx = start + i;
              const focused = idx === cur;
              const l = rowLabel(row, currentProviderId, env);
              const marker = focused ? (env.ascii ? ">" : "▸") : " ";
              const text = `${marker} ${l.mark} ${l.name}  ${l.detail}`;
              return (
                <Box
                  key={idx}
                  ref={(node) => {
                    if (node) rowBoxes.current.set(idx, node);
                    else rowBoxes.current.delete(idx);
                  }}
                >
                  <Text wrap="truncate">
                    <Text
                      color={focused ? theme.selected : l.configured ? theme.success : theme.muted}
                      {...(focused ? { backgroundColor: theme.selectionBg } : {})}
                    >
                      {truncateLine(text, width - (showScroll ? 6 : 4))}
                    </Text>
                  </Text>
                </Box>
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
      <Text wrap="truncate" color={noticeLine !== undefined ? theme.accent : theme.muted}>
        {truncateLine(busyText ?? noticeLine ?? "", width - 4)}
      </Text>
      {subView === undefined ? (
        <Text color={theme.muted} wrap="truncate">
          {truncateLine(KEY_HINT, width - 2)}
        </Text>
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
