/**
 * 全屏模型选择页（tui.md §7；ADR-0017）：
 * 左栏范围/服务商 + 右栏搜索/列表/详情 + 底部按键提示。
 * 由 App 在备用屏内渲染（进出序列在 App）；本组件只管页面内状态与按键。
 *
 * 数据只展示上游或配置明确声明的字段：未声明的上下文/最大输出/价格
 * 留空或 ?（ADR-0016，不编造数据）。能力标记只在声明时显示 R/I。
 */
import { Box, Text, useInput } from "ink";
import { useMemo, useState } from "react";
import stringWidth from "string-width";

import type { ModelInfo, ModelRef, ProviderOverview, WizardPreset } from "@nocturne/core";

import { useTuiEnv } from "../env.js";
import { boxSafe, truncateLine } from "../format.js";
import { useTheme } from "../theme.js";
import type { WizardState } from "../wizard-io.js";
import { InputCursor } from "./input-cursor.js";
import { WizardView } from "./wizard-view.js";

/** 右栏范围（tui.md §7 左栏前两项 + 已配置服务商） */
export type PickerScope = { kind: "recent" } | { kind: "all" } | { kind: "provider"; id: string };

type LeftItem =
  | { kind: "scope"; scope: "recent" | "all"; label: string }
  | { kind: "provider"; id: string; count: number }
  | { kind: "preset"; id: string };

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

/** 模糊过滤：provider/model 全形与 displayName 的子串匹配（大小写不敏感） */
function matchQuery(m: ModelInfo, q: string): boolean {
  if (q === "") return true;
  const needle = q.toLowerCase();
  return (
    refText(m.ref).toLowerCase().includes(needle) ||
    (m.displayName?.toLowerCase().includes(needle) ?? false)
  );
}

interface Row {
  model: ModelInfo;
  recent: boolean;
}

/** 右栏模型集合：scope 过滤 → query 过滤；all/provider 范围最近使用置顶 */
function rightRows(
  scope: PickerScope,
  models: readonly ModelInfo[],
  recents: readonly ModelRef[],
  query: string,
): { recentRows: Row[]; restRows: Row[] } {
  const inScope = (m: ModelInfo): boolean => {
    if (scope.kind === "provider") return m.ref.provider === scope.id;
    if (scope.kind === "recent") return recents.some((r) => refEq(r, m.ref));
    return true;
  };
  const pool = models.filter((m) => inScope(m) && matchQuery(m, query));
  const isRecent = (m: ModelInfo): boolean => recents.some((r) => refEq(r, m.ref));
  if (scope.kind === "recent") {
    // 保持 recents 新→旧顺序
    const ordered = recents
      .map((r) => pool.find((m) => refEq(m.ref, r)))
      .filter((m): m is ModelInfo => m !== undefined);
    return { recentRows: [], restRows: ordered.map((model) => ({ model, recent: true })) };
  }
  const recentRows = pool.filter(isRecent).map((model) => ({ model, recent: true }));
  const restRows = pool.filter((m) => !isRecent(m)).map((model) => ({ model, recent: false }));
  return { recentRows, restRows };
}

const NARROW = 80;
const LEFT_W = 18;

export function ModelPicker({
  models,
  recents,
  providers,
  presets,
  current,
  defaultModel,
  initialScope,
  initialFocus,
  wizard,
  onStartWizard,
  onPick,
  onClose,
  width,
  height,
  active,
}: {
  models: readonly ModelInfo[];
  recents: readonly ModelRef[];
  providers: readonly ProviderOverview[];
  /** 尚未配置的预设服务商（左栏 ○） */
  presets: readonly WizardPreset[];
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
  onPick: (ref: string, setDefault: boolean) => void;
  onClose: () => void;
  width: number;
  height: number;
  active: boolean;
}): React.JSX.Element {
  const narrow = width < NARROW;
  const [focus, setFocus] = useState<"left" | "right">(
    narrow ? "right" : (initialFocus ?? "right"),
  );
  const [scope, setScope] = useState<PickerScope>(initialScope ?? { kind: "all" });
  const [query, setQuery] = useState("");
  const [leftCursor, setLeftCursor] = useState(0);
  const [rightCursor, setRightCursor] = useState(0);
  const [action, setAction] = useState<0 | 1 | undefined>(undefined);

  const leftItems = useMemo<LeftItem[]>(() => {
    const items: LeftItem[] = [
      { kind: "scope", scope: "recent", label: "最近使用" },
      { kind: "scope", scope: "all", label: "全部模型" },
    ];
    for (const p of providers) {
      items.push({ kind: "provider", id: p.id, count: p.modelCount });
    }
    for (const p of presets) {
      items.push({ kind: "preset", id: p.id });
    }
    return items;
  }, [providers, presets]);

  const { recentRows, restRows } = useMemo(
    () => rightRows(scope, models, recents, query),
    [scope, models, recents, query],
  );
  const rows = useMemo(() => [...recentRows, ...restRows], [recentRows, restRows]);
  const cursor = Math.min(rightCursor, Math.max(0, rows.length - 1));
  const selected = rows[cursor]?.model;

  // 窄屏 ←/→ 循环范围：recent → all → 各 provider
  const scopeCycle = useMemo<PickerScope[]>(
    () => [
      { kind: "recent" },
      { kind: "all" },
      ...providers.map((p): PickerScope => ({ kind: "provider", id: p.id })),
    ],
    [providers],
  );

  const scopeIndex = scopeCycle.findIndex((s) =>
    s.kind === scope.kind
      ? s.kind !== "provider"
        ? true
        : s.id === (scope as { id: string }).id
      : false,
  );

  const applyLeft = (item: LeftItem): void => {
    if (item.kind === "scope") {
      setScope({ kind: item.scope });
      setRightCursor(0);
      return;
    }
    if (item.kind === "provider") {
      setScope({ kind: "provider", id: item.id });
      setRightCursor(0);
      setFocus("right");
      return;
    }
    // ○ 预设 → /provider add 弹层流程（完成后回到本页，App 侧选中新增服务商）
    onStartWizard(item.id);
  };

  const cycleScope = (dir: 1 | -1): void => {
    const next = scopeCycle[(scopeIndex + dir + scopeCycle.length) % scopeCycle.length];
    if (next !== undefined) {
      setScope(next);
      setRightCursor(0);
    }
  };

  const wizardActive = wizard?.state.running === true;
  const pageSize = Math.max(1, height - 8);

  useInput(
    (ch, key) => {
      // 内联选项条：←/→ 选择、Enter 确认、Esc 返回
      if (action !== undefined) {
        if (key.escape) {
          setAction(undefined);
          return;
        }
        if (key.leftArrow || key.rightArrow) {
          setAction((a) => (a === 0 ? 1 : 0));
          return;
        }
        if (key.return) {
          const m = selected;
          if (m !== undefined) onPick(refText(m.ref), action === 1);
          return;
        }
        return;
      }

      if (key.escape) {
        if (query !== "") {
          setQuery("");
          setRightCursor(0);
          return;
        }
        onClose();
        return;
      }

      if (key.leftArrow) {
        if (narrow) cycleScope(-1);
        else setFocus("left");
        return;
      }
      if (key.rightArrow) {
        if (narrow) cycleScope(1);
        else setFocus("right");
        return;
      }

      if (focus === "left" && !narrow) {
        if (key.upArrow) {
          setLeftCursor((c) => (c + leftItems.length - 1) % leftItems.length);
          return;
        }
        if (key.downArrow) {
          setLeftCursor((c) => (c + 1) % leftItems.length);
          return;
        }
        if (key.return) {
          const item = leftItems[leftCursor];
          if (item !== undefined) applyLeft(item);
          return;
        }
      } else {
        if (key.upArrow) {
          setRightCursor((c) => (c + rows.length - 1) % Math.max(1, rows.length));
          return;
        }
        if (key.downArrow) {
          setRightCursor((c) => (c + 1) % Math.max(1, rows.length));
          return;
        }
        if (key.pageUp) {
          setRightCursor((c) => Math.max(0, c - pageSize));
          return;
        }
        if (key.pageDown) {
          setRightCursor((c) => Math.min(Math.max(0, rows.length - 1), c + pageSize));
          return;
        }
        if (key.home) {
          setRightCursor(0);
          return;
        }
        if (key.end) {
          setRightCursor(Math.max(0, rows.length - 1));
          return;
        }
        if (key.return) {
          if (selected !== undefined) setAction(0);
          return;
        }
      }

      // 打字自动聚焦右栏搜索框；Backspace 删字符
      if (key.backspace || key.delete) {
        if (query !== "") {
          setQuery((q) => q.slice(0, -1));
          setRightCursor(0);
        }
        return;
      }
      if (ch !== "" && !key.ctrl && !key.meta) {
        setFocus("right");
        setQuery((q) => q + ch);
        setRightCursor(0);
      }
    },
    { isActive: active && !wizardActive },
  );

  // 向导内嵌：右栏替换为向导视图（preset Enter 启动；完成回列表由 App 驱动）
  const rightPane = wizardActive ? (
    <WizardView
      title="添加服务商"
      state={wizard.state}
      active={active}
      width={width - (narrow ? 6 : LEFT_W + 6)}
      maxRows={height}
      offsetY={-height}
      offsetX={narrow ? 0 : LEFT_W}
      onSubmit={wizard.submit}
      onSubmitMulti={wizard.submitMulti}
      onCancel={wizard.cancel}
    />
  ) : (
    <RightPane
      scope={scope}
      query={query}
      rows={rows}
      recentCount={recentRows.length}
      cursor={cursor}
      focus={focus}
      narrow={narrow}
      action={action}
      current={current}
      defaultModel={defaultModel}
      width={width - (narrow ? 4 : LEFT_W + 4)}
      height={height}
      offsetX={narrow ? 0 : LEFT_W}
    />
  );

  return (
    <Box flexDirection="row" width={width} height={height}>
      {narrow ? null : (
        <LeftPane
          items={leftItems}
          cursor={leftCursor}
          focus={focus}
          scope={scope}
          width={LEFT_W}
          height={height}
        />
      )}
      {rightPane}
    </Box>
  );
}

function LeftPane({
  items,
  cursor,
  focus,
  scope,
  width,
  height,
}: {
  items: readonly LeftItem[];
  cursor: number;
  focus: "left" | "right";
  scope: PickerScope;
  width: number;
  height: number;
}): React.JSX.Element {
  const env = useTuiEnv();
  const theme = useTheme();
  const dotOn = env.ascii ? "*" : "●";
  const dotOff = env.ascii ? "o" : "○";
  const line = env.ascii ? "-" : "─";
  // 分组渲染：scope 项 → 分隔 → provider → 分隔 → preset
  const rendered: React.JSX.Element[] = [];
  let lastKind: LeftItem["kind"] | "" = "";
  items.forEach((item, i) => {
    if (lastKind !== "" && item.kind !== lastKind && item.kind !== "scope") {
      rendered.push(
        <Text key={`sep-${i}`} dimColor>
          {line.repeat(Math.max(4, width - 4))}
        </Text>,
      );
    }
    lastKind = item.kind;
    const focused = focus === "left" && i === cursor;
    const cur =
      (item.kind === "scope" &&
        ((item.scope === "recent" && scope.kind === "recent") ||
          (item.scope === "all" && scope.kind === "all"))) ||
      (item.kind === "provider" && scope.kind === "provider" && scope.id === item.id);
    // ●/○ 状态点保留（2 列膨胀由栏宽余量吸收）；id/label 等动态文本过 boxSafe
    const label =
      item.kind === "scope"
        ? boxSafe(item.label)
        : item.kind === "provider"
          ? `${dotOn} ${boxSafe(item.id)} ${item.count}`
          : `${dotOff} ${boxSafe(item.id)}`;
    rendered.push(
      <Text key={i} wrap="truncate">
        <Text {...(focused ? { color: theme.selected, backgroundColor: theme.selectionBg } : {})}>
          {truncateLine(`${cur ? "> " : "  "}${label}`, width - 2)}
        </Text>
      </Text>,
    );
  });
  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      borderStyle={env.ascii ? "single" : undefined}
      borderRight={!env.ascii}
      borderLeft={false}
      borderTop={false}
      borderBottom={false}
      borderColor={theme.border}
    >
      {rendered}
    </Box>
  );
}

function RightPane({
  scope,
  query,
  rows,
  recentCount,
  cursor,
  focus,
  narrow,
  action,
  current,
  defaultModel,
  width,
  height,
  offsetX,
}: {
  scope: PickerScope;
  query: string;
  rows: readonly Row[];
  recentCount: number;
  cursor: number;
  focus: "left" | "right";
  narrow: boolean;
  action: 0 | 1 | undefined;
  current: ModelRef | undefined;
  defaultModel: ModelRef | undefined;
  width: number;
  height: number;
  offsetX: number;
}): React.JSX.Element {
  const env = useTuiEnv();
  const theme = useTheme();
  const line = env.ascii ? "-" : "─";
  const sel = rows[cursor]?.model;
  const listTop = 2; // 搜索框 + 空行
  // 分隔 + 详情 2 行（不可用模型多一行原因说明，ADR-0026 §5）
  const detailH = sel?.unavailable !== undefined ? 4 : 3;
  const hintH = 1;
  const listH = Math.max(3, height - listTop - detailH - hintH);

  const start = Math.min(
    Math.max(0, cursor - Math.floor(listH / 2)),
    Math.max(0, rows.length - listH),
  );
  const visible = rows.slice(start, start + listH);

  const scopeLabel =
    scope.kind === "recent" ? "最近使用" : scope.kind === "all" ? "全部模型" : scope.id;
  const lines: React.JSX.Element[] = [];
  visible.forEach((row, i) => {
    const idx = start + i;
    // 最近使用区与其余模型之间的分隔线
    if (recentCount > 0 && idx === recentCount && restVisibleOnce(rows, recentCount)) {
      lines.push(
        <Text key="sep" dimColor>
          {line.repeat(6)} 最近使用 {line.repeat(Math.max(2, width - 18))}
        </Text>,
      );
    }
    const m = row.model;
    const focused = focus === "right" && idx === cursor;
    const name = refText(m.ref);
    const isCur = current !== undefined && refEq(m.ref, current);
    const isDef = defaultModel !== undefined && refEq(m.ref, defaultModel);
    const r = m.capabilities.reasoning !== "none" ? "R" : " ";
    const im = m.capabilities.imageInput ? "I" : " ";
    const mark = `${isCur ? "*" : " "}${isDef ? "d" : " "}`;
    const unavailableTag = m.unavailable !== undefined ? " 协议不支持" : "";
    lines.push(
      <Text key={idx} wrap="truncate">
        <Text {...(focused ? { color: theme.selected, backgroundColor: theme.selectionBg } : {})}>
          {truncateLine(
            boxSafe(
              `${focused ? ">" : " "}${mark} ${name}  ${r} ${im}  ${ctxText(m).padStart(5)} ${priceText(m).padStart(11)}`,
            ),
            width - 2 - stringWidth(unavailableTag),
          )}
        </Text>
        {/* ADR-0026 §5：不可用模型行尾灰色标注（照常列出，不可请求） */}
        {unavailableTag !== "" ? <Text dimColor>{unavailableTag}</Text> : null}
      </Text>,
    );
  });

  return (
    <Box flexDirection="column" width={width} height={height}>
      <InputCursor
        active
        prefix="搜索: "
        text={boxSafe(query)}
        width={width - 2}
        x={offsetX}
        y={-height}
      />
      <Text wrap="truncate">
        {truncateLine(boxSafe(`搜索: ${query}`), width - 2)}
        <Text color={theme.selected} backgroundColor={theme.selectionBg}>
          {" "}
        </Text>
      </Text>
      <Text dimColor>
        {scopeLabel}
        {rows.length > 0 ? ` • ${cursor + 1}/${rows.length}` : " • 无匹配"}
      </Text>
      {lines}
      {rows.length === 0 ? <Text dimColor>（无匹配模型）</Text> : null}
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>{line.repeat(Math.max(4, width - 2))}</Text>
        {sel !== undefined ? (
          <>
            <Text wrap="truncate">
              {truncateLine(
                boxSafe(
                  `${refText(sel.ref)}${sel.displayName !== undefined ? ` - ${sel.displayName}` : ""}`,
                ),
                width - 2,
              )}
            </Text>
            <Text wrap="truncate">
              {truncateLine(
                [
                  `上下文 ${ctxText(sel)}`,
                  `最大输出 ${outText(sel)}`,
                  priceText(sel) !== "" ? `${priceText(sel)} 每 M` : "",
                  sel.capabilities.reasoning !== "none" ? "推理" : "",
                  sel.capabilities.imageInput ? "图片输入" : "",
                  current !== undefined && refEq(sel.ref, current) ? "当前会话" : "",
                  defaultModel !== undefined && refEq(sel.ref, defaultModel) ? "默认模型" : "",
                ]
                  .filter((s) => s !== "")
                  .join(" • "),
                width - 2,
              )}
            </Text>
            {/* ADR-0026 §5：选中不可用模型时底部显示原因 */}
            {sel.unavailable !== undefined ? (
              <Text wrap="truncate" dimColor>
                {truncateLine(boxSafe(sel.unavailable.reason), width - 2)}
              </Text>
            ) : null}
          </>
        ) : (
          <Text dimColor>（未选中）</Text>
        )}
      </Box>
      {action !== undefined ? (
        <Text>
          <Text
            {...(action === 0 ? { color: theme.selected, backgroundColor: theme.selectionBg } : {})}
          >
            [仅本会话]
          </Text>{" "}
          <Text
            {...(action === 1 ? { color: theme.selected, backgroundColor: theme.selectionBg } : {})}
          >
            [设为默认]
          </Text>
          <Text dimColor> 左右选择，Enter 确认，Esc 返回</Text>
        </Text>
      ) : (
        <Text dimColor wrap="truncate">
          {truncateLine(
            narrow
              ? "左右切范围 上下移动 输入=搜索 Enter选择 PgUp/PgDn翻页 Esc关闭"
              : "左右切换栏 上下移动 输入=搜索 Enter选择 PgUp/PgDn翻页 Esc关闭",
            width - 2,
          )}
        </Text>
      )}
    </Box>
  );
}

/** 最近使用分隔线只画一次（rest 区首个可见行前） */
function restVisibleOnce(rows: readonly Row[], recentCount: number): boolean {
  return rows.length > recentCount;
}
