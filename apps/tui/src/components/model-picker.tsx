/**
 * 全屏模型选择页（tui.md §7；ADR-0017、ADR-0045）：
 * PageShell 双栏——左栏是范围筛选（最近使用 / 全部模型 / 已配置服务商 / 未配置预设），
 * 右栏列出模型，说明区显示当前行的详情。「仅本会话 / 设为默认」与思考档位选择是页内小对话框。
 * 由 App 在备用屏内渲染（进出序列在 App）；本组件只管页面内状态与按键。
 *
 * 数据只展示上游或配置明确声明的字段：未声明的上下文/最大输出/价格
 * 留空或 ?（ADR-0016，不编造数据）。能力标记只在声明时显示 R/I。
 */
import { Box, Text, useInput } from "ink";
import { useMemo, useState } from "react";

import type { ModelInfo, ModelRef, ProviderOverview, ProviderPreset } from "@nocturne/core";
import { clampReasoningEffort, type ReasoningEffort } from "@nocturne/core";
import { Segmented } from "./dialog/segmented.js";

import { useTuiEnv } from "../env.js";
import { useTheme } from "../theme.js";
import type { WizardState } from "../wizard-io.js";
import type { DialogMouseFrame } from "./dialog/mouse.js";
import {
  PageShell,
  type ShellGroup,
  type ShellRow,
  type ShellSideItem,
  type ShellSpan,
} from "./page/page-shell.js";
import { WizardView } from "./wizard-view.js";

/** 右栏范围（tui.md §7 左栏前两项 + 已配置服务商） */
export type PickerScope = { kind: "recent" } | { kind: "all" } | { kind: "provider"; id: string };

function refEq(a: ModelRef, b: ModelRef): boolean {
  return a.provider === b.provider && a.model === b.model;
}

function refText(r: ModelRef): string {
  return `${r.provider}/${r.model}`;
}

/** 上下文长度缩写：1m / 262k；未声明 ?（tui.md §7 列表列） */
function ctxText(m: ModelInfo): string {
  const n = m.contextWindow;
  if (n === undefined) return "?";
  if (n >= 1_000_000) return `${trimNum(n / 1_000_000)}m`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function outText(m: ModelInfo): string {
  const n = m.maxOutputTokens;
  if (n === undefined) return "?";
  if (n >= 1_000_000) return `${trimNum(n / 1_000_000)}m`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function trimNum(n: number): string {
  return n.toFixed(n >= 10 ? 0 : 1).replace(/\.0$/, "");
}

function priceText(m: ModelInfo): string {
  const p = m.pricing;
  if (p === undefined || (p.input === undefined && p.output === undefined)) return "";
  // 价格保留最多两位小数（$0.27/1.10、$1.75/14），整数无小数
  const fmt = (v: number | undefined): string =>
    v === undefined ? "?" : v.toFixed(2).replace(/\.?0+$/, "");
  return `$${fmt(p.input)}/${fmt(p.output)}`;
}

const CLEAR_ID = "__clear__";

/** 范围内的模型：最近使用按 recents 新→旧排在前，其余按模型列表顺序 */
function scopeRows(
  scope: PickerScope,
  models: readonly ModelInfo[],
  recents: readonly ModelRef[],
): { recent: ModelInfo[]; rest: ModelInfo[] } {
  const inScope = (m: ModelInfo): boolean => {
    if (scope.kind === "provider") return m.ref.provider === scope.id;
    if (scope.kind === "recent") return recents.some((r) => refEq(r, m.ref));
    return true;
  };
  const pool = models.filter(inScope);
  const recent = recents
    .map((r) => pool.find((m) => refEq(m.ref, r)))
    .filter((m): m is ModelInfo => m !== undefined);
  if (scope.kind === "recent") return { recent, rest: [] };
  return { recent, rest: pool.filter((m) => !recents.some((r) => refEq(r, m.ref))) };
}

const scopeId = (scope: PickerScope): string =>
  scope.kind === "provider" ? `provider:${scope.id}` : `scope:${scope.kind}`;

export function ModelPicker({
  models,
  recents,
  providers,
  presets,
  current,
  defaultModel,
  currentEffort,
  savedEffort,
  selectionOnly = false,
  clearLabel,
  title,
  initialScope,
  initialFocus,
  wizard,
  onStartWizard,
  onPick,
  onClose,
  onMouseFrame,
  width,
  height,
  active,
}: {
  models: readonly ModelInfo[];
  recents: readonly ModelRef[];
  providers: readonly ProviderOverview[];
  /** 尚未配置的预设服务商（左栏 ○） */
  presets: readonly ProviderPreset[];
  current: ModelRef | undefined;
  defaultModel: ModelRef | undefined;
  initialScope?: PickerScope | undefined;
  /** /provider 无参打开时焦点在左栏（tui.md §7） */
  initialFocus?: "left" | "right" | undefined;
  /** 向导内嵌状态（undefined = 无向导）；preset Enter 时经 onStartWizard 启动 */
  wizard:
    | {
        state: WizardState;
        submit: (v: string) => void;
        submitMulti: (indices: number[]) => void;
        cancel: () => void;
      }
    | undefined;
  onStartWizard: (presetId: string) => void;
  currentEffort?: ReasoningEffort | undefined;
  savedEffort?: ReasoningEffort | undefined;
  /** 审查/角色模型选择只返回引用，不更改会话模型、默认模型或档位。 */
  selectionOnly?: boolean;
  clearLabel?: string | undefined;
  /** 面包屑；默认「模型」，设置页里选角色模型时传「设置 › 子代理模型」 */
  title?: readonly string[] | undefined;
  onPick: (ref: string, setDefault: boolean, effort: ReasoningEffort | null) => void;
  onClose: () => void;
  onMouseFrame?: ((frame: DialogMouseFrame | undefined) => void) | undefined;
  width: number;
  height: number;
  active: boolean;
}): React.JSX.Element {
  const env = useTuiEnv();
  const theme = useTheme();
  const [scope, setScope] = useState<PickerScope>(initialScope ?? { kind: "all" });
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const [action, setAction] = useState<0 | 1 | undefined>(undefined);
  const [effort, setEffort] = useState<ReasoningEffort | undefined>();

  const { recent, rest } = useMemo(
    () => scopeRows(scope, models, recents),
    [scope, models, recents],
  );
  const byId = useMemo(() => {
    const map = new Map<string, ModelInfo>();
    for (const m of [...recent, ...rest]) map.set(refText(m.ref), m);
    return map;
  }, [recent, rest]);

  const scopeLabel =
    scope.kind === "recent" ? "最近使用" : scope.kind === "all" ? "全部模型" : scope.id;
  const groups: ShellGroup[] = [
    { id: "recent", label: "最近使用" },
    { id: "rest", label: recent.length > 0 ? "其余模型" : scopeLabel },
  ];

  const rows = useMemo<ShellRow[]>(() => {
    const out: ShellRow[] = [];
    if (clearLabel !== undefined)
      out.push({ id: CLEAR_ID, cells: [{ text: clearLabel }], search: clearLabel });
    const build = (m: ModelInfo, group: "recent" | "rest"): ShellRow => {
      const reasoning = m.capabilities.reasoning !== "none" ? "R" : " ";
      const image = m.capabilities.imageInput ? "I" : " ";
      const trail: { text: string; tone: "accent" | "accentAlt" | "muted" }[] = [];
      if (m.unavailable !== undefined) trail.push({ text: "协议不支持", tone: "muted" });
      if (current !== undefined && refEq(m.ref, current))
        trail.push({ text: "当前", tone: "accent" });
      if (defaultModel !== undefined && refEq(m.ref, defaultModel))
        trail.push({ text: "默认", tone: "accentAlt" });
      return {
        id: refText(m.ref),
        group,
        cells: [
          { text: refText(m.ref) },
          { text: `${reasoning} ${image}`, tone: "muted" },
          { text: ctxText(m), tone: "muted", align: "right" },
        ],
        trail,
        search: `${refText(m.ref)} ${m.displayName ?? ""}`,
      };
    };
    for (const m of recent) out.push(build(m, "recent"));
    for (const m of rest) out.push(build(m, "rest"));
    return out;
  }, [clearLabel, recent, rest, current, defaultModel]);

  const sideItems = useMemo<ShellSideItem[]>(() => {
    const items: ShellSideItem[] = [
      { id: "scope:recent", label: "最近使用" },
      { id: "scope:all", label: "全部模型" },
    ];
    providers.forEach((p, i) => {
      items.push({
        id: `provider:${p.id}`,
        label: p.id,
        count: p.modelCount,
        dot: { text: env.ascii ? "*" : "●", tone: "success" },
        ...(i === 0 ? { separatorBefore: true } : {}),
      });
    });
    presets.forEach((p, i) => {
      items.push({
        id: `preset:${p.id}`,
        label: p.id,
        dot: { text: env.ascii ? "o" : "○", tone: "muted" },
        tone: "muted",
        cyclable: false,
        ...(i === 0 ? { separatorBefore: true } : {}),
      });
    });
    return items;
  }, [providers, presets, env.ascii]);

  const wizardActive = wizard?.state.running === true;
  const narrow = width < 72;
  const selectedModel = picked !== undefined ? byId.get(picked) : undefined;
  const overlayOpen = action !== undefined || effort !== undefined;

  const describe = (row: ShellRow | undefined): ShellSpan[][] => {
    if (row === undefined) return [];
    if (row.id === CLEAR_ID)
      return [[{ text: `选择「${clearLabel ?? ""}」会清除设置层里的这项引用`, tone: "muted" }]];
    const m = byId.get(row.id);
    if (m === undefined) return [];
    const price = priceText(m);
    const details = [
      `上下文 ${ctxText(m)}`,
      `最大输出 ${outText(m)}`,
      price !== "" ? `${price} 每 M` : "",
      m.capabilities.reasoning !== "none" ? "推理" : "",
      m.capabilities.imageInput ? "图片输入" : "",
      current !== undefined && refEq(m.ref, current) ? "当前会话" : "",
      defaultModel !== undefined && refEq(m.ref, defaultModel) ? "默认模型" : "",
    ].filter((t) => t !== "");
    return [
      [
        { text: refText(m.ref), tone: "secondary" },
        ...(m.displayName !== undefined
          ? [{ text: `  ${m.displayName}`, tone: "muted" as const }]
          : []),
      ],
      // ADR-0026 §5：不可用模型在详情位置显示原因
      m.unavailable !== undefined
        ? [{ text: m.unavailable.reason, tone: "warning" as const }]
        : [{ text: details.join(" • "), tone: "muted" as const }],
    ];
  };

  const pick = (id: string): void => {
    if (id === CLEAR_ID) {
      onPick("", false, null);
      return;
    }
    const m = byId.get(id);
    if (m === undefined) return;
    if (selectionOnly) onPick(refText(m.ref), false, null);
    else {
      setPicked(id);
      setAction(0);
    }
  };

  // 页内小对话框：「仅本会话 / 设为默认」→ 思考档位
  useInput(
    (_ch, key) => {
      const m = selectedModel;
      if (m === undefined) {
        setAction(undefined);
        setEffort(undefined);
        return;
      }
      if (effort !== undefined) {
        const choices: ReasoningEffort[] = ["off", ...(m.capabilities.reasoningEffort ?? [])];
        if (key.escape) setEffort(undefined);
        else if (key.leftArrow || key.rightArrow) {
          setEffort(
            choices[
              (choices.indexOf(effort) + (key.leftArrow ? -1 : 1) + choices.length) % choices.length
            ],
          );
        } else if (key.return) onPick(refText(m.ref), true, effort);
        return;
      }
      if (key.escape) {
        setAction(undefined);
        return;
      }
      if (key.leftArrow || key.rightArrow) {
        setAction((a) => (a === 0 ? 1 : 0));
        return;
      }
      if (key.return) {
        const levels = m.capabilities.reasoningEffort ?? [];
        if (action === 1 && levels.length > 0) {
          const preferred =
            currentEffort !== undefined &&
            (currentEffort === "off" || levels.includes(currentEffort))
              ? currentEffort
              : (clampReasoningEffort(savedEffort ?? "off", levels) ?? "off");
          setEffort(preferred);
        } else onPick(refText(m.ref), action === 1, null);
      }
    },
    { isActive: active && !wizardActive && overlayOpen },
  );

  const dialogW = Math.min(60, Math.max(20, width - 4));
  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      <PageShell
        title={title ?? ["模型"]}
        count={({ index, total }) => (total > 0 ? `${index}/${total}` : "无匹配")}
        subtitle={
          selectionOnly
            ? "只选择模型，不改变当前模型、默认模型或思考档位"
            : "选择当前会话使用的模型；也可以设为默认"
        }
        rows={rows}
        groups={groups}
        sidebar={{ items: sideItems, mode: "filter", activeId: scopeId(scope) }}
        arrows="focus"
        describe={describe}
        hints={({ focus }) =>
          focus === "side"
            ? [
                ["↑↓", "移动"],
                ["Enter", "应用"],
                ["←→", "切换栏"],
                ["Esc", "关闭"],
              ]
            : [
                ["↑↓", "移动"],
                ["←→", narrow ? "切换范围" : "切换栏"],
                ["输入", "过滤"],
                ["Enter", "选择"],
                ["Esc", "关闭"],
              ]
        }
        emptyText="（无匹配模型）"
        width={width}
        height={height}
        active={active && !wizardActive && !overlayOpen}
        {...(initialFocus === "left" ? { initialFocus: "side" as const } : {})}
        resetToken={scopeId(scope)}
        mouseLayer="model-picker"
        onMouseFrame={onMouseFrame}
        onClose={onClose}
        onActivate={pick}
        onSideActivate={(id) => {
          if (id.startsWith("preset:")) {
            onStartWizard(id.slice("preset:".length));
            return undefined;
          }
          if (id === "scope:recent") setScope({ kind: "recent" });
          else if (id === "scope:all") setScope({ kind: "all" });
          else setScope({ kind: "provider", id: id.slice("provider:".length) });
          return id.startsWith("provider:") ? "list" : undefined;
        }}
      />
      {overlayOpen && selectedModel !== undefined && !wizardActive ? (
        <Box
          position="absolute"
          width={width}
          height={height}
          alignItems="center"
          justifyContent="center"
        >
          <Box
            flexDirection="column"
            width={dialogW}
            paddingX={1}
            borderStyle={env.ascii ? "classic" : "round"}
            borderColor={theme.border}
            backgroundColor={theme.overlayBg}
          >
            <Text bold color={theme.accent} wrap="truncate">
              {refText(selectedModel.ref)}
            </Text>
            {effort !== undefined ? (
              <>
                <Text>默认思考档位 · Enter 确认，Esc 返回</Text>
                <Segmented
                  options={["off", ...(selectedModel.capabilities.reasoningEffort ?? [])]}
                  selected={["off", ...(selectedModel.capabilities.reasoningEffort ?? [])].indexOf(
                    effort,
                  )}
                  focused
                  width={dialogW - 4}
                  maxLines={1}
                />
              </>
            ) : (
              <Text>
                <Text
                  {...(action === 0
                    ? { color: theme.selected, backgroundColor: theme.selectionBg }
                    : {})}
                >
                  [仅本会话]
                </Text>{" "}
                <Text
                  {...(action === 1
                    ? { color: theme.selected, backgroundColor: theme.selectionBg }
                    : {})}
                >
                  [设为默认]
                </Text>
                <Text color={theme.muted}> 左右选择，Enter 确认，Esc 返回</Text>
              </Text>
            )}
          </Box>
        </Box>
      ) : null}
      {wizardActive ? (
        <Box position="absolute" width={width} height={height}>
          <WizardView
            title="添加服务商"
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
      ) : null}
    </Box>
  );
}
