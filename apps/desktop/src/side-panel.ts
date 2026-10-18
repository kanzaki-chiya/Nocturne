/**
 * 右侧面板的纯逻辑（ADR-0060 第 1–4 节及修订）：标签模型、按会话持久化与恢复、
 * 旧全局标签迁移、宽度上下限、快速打开排名、变更汇总、终端默认 shell。界面在 SidePanel.tsx。
 */
import type { TurnChanges } from "@nocturne/core/protocol";

/** runtime.listShells 的一项（Core platform/shells.ts DetectedShell 的结构） */
export interface ShellOption {
  kind: string;
  name: string;
  executable?: string | undefined;
  available: boolean;
}

/** 新标签页：地址栏 + 工具列表；不持久化 */
export interface NewTab {
  id: string;
  kind: "new";
}

/** 变更：显示所属会话的改动；focusSeq 是「查看变更」要定位的那一轮 */
export interface ChangesTab {
  id: string;
  kind: "changes";
  focusSeq?: number | undefined;
  /** 每次定位递增，同一轮再点一次也能重新滚动 */
  focusNonce?: number | undefined;
}

/**
 * 文件：按绝对路径读取（rpc.md `runtime.readFile`），不依赖会话。workspace 是打开时
 * 所在会话的工作区（标签显示项目名）；工作区外的文件没有 workspace，标签显示所在目录名。
 */
export interface FileTab {
  id: string;
  kind: "file";
  absolutePath: string;
  workspace?: string | undefined;
  line?: number | undefined;
  endLine?: number | undefined;
  /** 每次定位递增：同一文件再点另一行时重新滚动 */
  focusNonce?: number | undefined;
}

/**
 * 终端（ADR-0060 第 4 节）：一个标签一个进程，不持久化。cwd 是创建时的工作目录，
 * label 是标签上的项目名；shell 是用户在下拉里换过的可执行文件，缺省跟随设置里的 Shell。
 */
export interface TerminalTab {
  id: string;
  kind: "terminal";
  cwd: string;
  label: string;
  shell?: string | undefined;
}

export type PanelTab = NewTab | ChangesTab | FileTab | TerminalTab;

/** 存进本机偏好的标签：只有「文件」和「变更」（新标签页、终端不恢复） */
export type StoredPanelTab =
  | { id: string; kind: "changes" }
  | {
      id: string;
      kind: "file";
      absolutePath: string;
      workspace?: string;
      line?: number;
      endLine?: number;
    };

export const PANEL_MIN_WIDTH = 320;
export const PANEL_MAX_WIDTH = 960;
export const PANEL_DEFAULT_WIDTH = 520;
/** 对话区至少留这么宽；更窄时面板改为盖在对话区上（ADR-0060 第 1 节） */
export const CONVERSATION_MIN_WIDTH = 480;
/** 概览浮层停靠时对话列让出的宽度（side-panel.css 的 --ov-reserve） */
export const OVERVIEW_RESERVE = 300;
/** 每个会话记住的最近在面板里打开过的文件数（Ctrl+P 空查询排在前面） */
export const RECENT_FILES_MAX = 20;

/** 「变更」右侧文件树的宽度（ADR-0060 修订 2026-10-18（二）），按会话记住 */
export const CHANGE_TREE_MIN_WIDTH = 180;
export const CHANGE_TREE_MAX_WIDTH = 420;
export const CHANGE_TREE_DEFAULT_WIDTH = 260;

export function clampTreeWidth(width: number): number {
  if (!Number.isFinite(width)) return CHANGE_TREE_DEFAULT_WIDTH;
  return Math.round(Math.min(CHANGE_TREE_MAX_WIDTH, Math.max(CHANGE_TREE_MIN_WIDTH, width)));
}

/**
 * 一个会话的面板（ADR-0060 修订 2026-10-18（二））：标签、当前标签、开关，以及
 * 「变更」的文件树宽度和换行偏好。面板宽度是全局的，不在这里。
 */
export interface SessionPanel {
  open: boolean;
  tabs: PanelTab[];
  activeId: string;
  treeWidth: number;
  wrap: boolean;
  /** 最近在面板里打开过的文件（绝对路径，新的在前，至多 RECENT_FILES_MAX 个） */
  recent: string[];
}

/** 存进本机偏好的会话面板：终端和新标签页不存 */
export interface StoredSessionPanel {
  open?: boolean;
  tabs: StoredPanelTab[];
  activeTab?: string;
  treeWidth?: number;
  wrap?: boolean;
  recent?: string[];
}

/** 记一次打开：挪到最前，去重（按 samePath），超出上限丢最旧的 */
export function pushRecent(recent: readonly string[], absolutePath: string): string[] {
  return [absolutePath, ...recent.filter((path) => !samePath(path, absolutePath))].slice(
    0,
    RECENT_FILES_MAX,
  );
}

/** 会话第一次打开时面板关着，只有一个新标签页；有记录就按记录恢复 */
export function restoreSessionPanel(
  stored: StoredSessionPanel | undefined,
  newId: () => string,
): SessionPanel {
  const { tabs, activeId } = restoreTabs(stored?.tabs, stored?.activeTab, newId);
  return {
    open: stored?.open === true,
    tabs,
    activeId,
    treeWidth: clampTreeWidth(stored?.treeWidth ?? CHANGE_TREE_DEFAULT_WIDTH),
    wrap: stored?.wrap !== false,
    recent: [...(stored?.recent ?? [])],
  };
}

export function storeSessionPanel(panel: SessionPanel): StoredSessionPanel {
  const tabs = storedTabs(panel.tabs);
  return {
    ...(panel.open ? { open: true } : {}),
    tabs,
    ...(tabs.some((tab) => tab.id === panel.activeId) ? { activeTab: panel.activeId } : {}),
    ...(panel.treeWidth !== CHANGE_TREE_DEFAULT_WIDTH ? { treeWidth: panel.treeWidth } : {}),
    ...(panel.wrap ? {} : { wrap: false }),
    ...(panel.recent.length > 0 ? { recent: [...panel.recent] } : {}),
  };
}

/** 逐会话校验存储的面板；损坏的会话整条丢弃，不影响其余 */
export function parseStoredSessionPanels(value: unknown): Record<string, StoredSessionPanel> {
  const result: Record<string, StoredSessionPanel> = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return result;
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (id === "" || typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    result[id] = {
      ...(entry.open === true ? { open: true } : {}),
      tabs: parseStoredTabs(entry.tabs),
      ...(str(entry.activeTab) ? { activeTab: entry.activeTab } : {}),
      ...(typeof entry.treeWidth === "number" && Number.isFinite(entry.treeWidth)
        ? { treeWidth: clampTreeWidth(entry.treeWidth) }
        : {}),
      ...(entry.wrap === false ? { wrap: false } : {}),
      ...(Array.isArray(entry.recent) && entry.recent.some(str)
        ? { recent: entry.recent.filter(str).slice(0, RECENT_FILES_MAX) }
        : {}),
    };
  }
  return result;
}

/** 第 1、2 轮存下的全局面板（prefs 里的 panelTabs / panelActiveTab / panelOpen） */
export interface LegacyPanel {
  tabs?: StoredPanelTab[] | undefined;
  activeTab?: string | undefined;
  open?: boolean | undefined;
}

/**
 * 旧全局标签迁移到最近一次打开的会话（只做一次，ADR-0060 修订 2026-10-18（二））：
 * 按会话列表里最近活动的会话认领；它已经有自己的记录就不覆盖。没有会话或没有标签时不迁。
 */
export function migrateGlobalPanel(
  legacy: LegacyPanel,
  sessions: readonly { id: string; mtimeMs: number }[],
  existing: Record<string, StoredSessionPanel>,
): Record<string, StoredSessionPanel> {
  const tabs = legacy.tabs ?? [];
  if (tabs.length === 0) return existing;
  const recent = sessions.reduce<{ id: string; mtimeMs: number } | undefined>(
    (best, s) => (best === undefined || s.mtimeMs > best.mtimeMs ? s : best),
    undefined,
  );
  if (recent === undefined || existing[recent.id] !== undefined) return existing;
  return {
    ...existing,
    [recent.id]: {
      ...(legacy.open === true ? { open: true } : {}),
      tabs,
      ...(legacy.activeTab !== undefined && tabs.some((tab) => tab.id === legacy.activeTab)
        ? { activeTab: legacy.activeTab }
        : {}),
    },
  };
}

/**
 * 被删除的会话（ADR-0060 修订 2026-10-18（二）的「删除时清理」）：判定已删除就整套
 * 清理——结束终端、删掉面板记录，不因为会话还开着而只做一半。
 *
 * - candidates：有面板记录（偏好里或本次运行里）的会话；
 * - seen：本次运行里出现在会话列表里的会话。列过、这次没有，就是被删了，开没开着都算；
 * - 没进过列表的会话只有打开着（刚建好，列表还没跟上）才暂缓，否则是上次运行以后被删的；
 * - current（正在看的会话）也暂缓，离开后下一份列表再判。
 */
export function vanishedSessions(
  candidates: Iterable<string>,
  listed: readonly { id: string }[],
  seen: ReadonlySet<string>,
  open: ReadonlySet<string>,
  current: string | null,
): string[] {
  const present = new Set(listed.map((s) => s.id));
  return [...new Set(candidates)].filter(
    (id) => !present.has(id) && id !== current && (seen.has(id) || !open.has(id)),
  );
}

/**
 * 概览浮层能否停靠（ADR-0060 修订 2026-10-18（三））：面板关着、对话列让出浮层位置后
 * 对话区仍不小于 480px 才停靠；否则盖在对话区上。只看窗口宽度，不受停靠本身影响，
 * 拖动窗口跨过阈值时只切换一次。
 */
export function overviewDocks(bodyWidth: number, sidebarWidth: number): boolean {
  return bodyWidth - sidebarWidth - OVERVIEW_RESERVE >= CONVERSATION_MIN_WIDTH;
}

/** 面板宽度夹在上下限之间；窗口很窄时上限再让出对话区的一部分 */
export function clampPanelWidth(width: number, available?: number): number {
  const max =
    available === undefined
      ? PANEL_MAX_WIDTH
      : Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, available - 160));
  if (!Number.isFinite(width)) return Math.min(PANEL_DEFAULT_WIDTH, max);
  return Math.round(Math.min(max, Math.max(PANEL_MIN_WIDTH, width)));
}

/** 面板是否盖在对话区上：并排时对话区会小于 480px */
export function panelOverlays(
  bodyWidth: number,
  sidebarWidth: number,
  panelWidth: number,
): boolean {
  return bodyWidth - sidebarWidth - panelWidth < CONVERSATION_MIN_WIDTH;
}

const str = (value: unknown): value is string => typeof value === "string" && value !== "";
const posInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

/** 逐项校验存储的标签；损坏的条目丢弃，不影响其余 */
export function parseStoredTabs(value: unknown): StoredPanelTab[] {
  if (!Array.isArray(value)) return [];
  const tabs: StoredPanelTab[] = [];
  const ids = new Set<string>();
  let changes = false;
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const raw = item as Record<string, unknown>;
    if (!str(raw.id) || ids.has(raw.id)) continue;
    if (raw.kind === "changes" && !changes) {
      changes = true;
      ids.add(raw.id);
      tabs.push({ id: raw.id, kind: "changes" });
    } else if (raw.kind === "file" && str(raw.absolutePath) && isAbsolutePath(raw.absolutePath)) {
      // 第 1 轮存下的标签还带 sessionId / relativePath，忽略即可
      ids.add(raw.id);
      tabs.push({
        id: raw.id,
        kind: "file",
        absolutePath: raw.absolutePath,
        ...(str(raw.workspace) ? { workspace: raw.workspace } : {}),
        ...(posInt(raw.line) ? { line: raw.line } : {}),
        ...(posInt(raw.line) && posInt(raw.endLine) ? { endLine: raw.endLine } : {}),
      });
    }
  }
  return tabs;
}

/** 要存的标签：去掉新标签页和一次性的定位计数 */
export function storedTabs(tabs: readonly PanelTab[]): StoredPanelTab[] {
  return tabs.flatMap((tab): StoredPanelTab[] => {
    if (tab.kind === "changes") return [{ id: tab.id, kind: "changes" }];
    if (tab.kind === "file") {
      return [
        {
          id: tab.id,
          kind: "file",
          absolutePath: tab.absolutePath,
          ...(tab.workspace !== undefined ? { workspace: tab.workspace } : {}),
          ...(tab.line !== undefined ? { line: tab.line } : {}),
          ...(tab.endLine !== undefined ? { endLine: tab.endLine } : {}),
        },
      ];
    }
    return [];
  });
}

/**
 * 重启恢复：按存储顺序还原「文件」和「变更」标签；一个都没有时给一个新标签页。
 * 选中项不存在时选第一个。文件是否还在由「文件」标签自己读取时判定。
 */
export function restoreTabs(
  stored: readonly StoredPanelTab[] | undefined,
  activeId: string | undefined,
  newId: () => string,
): { tabs: PanelTab[]; activeId: string } {
  const tabs: PanelTab[] = (stored ?? []).map((tab) => ({ ...tab }));
  if (tabs.length === 0) {
    const id = newId();
    return { tabs: [{ id, kind: "new" }], activeId: id };
  }
  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0];
  return { tabs, activeId: active?.id ?? "" };
}

/** 拖动排序：把 fromId 移到 toId 的位置 */
export function moveTab(tabs: readonly PanelTab[], fromId: string, toId: string): PanelTab[] {
  const from = tabs.findIndex((tab) => tab.id === fromId);
  const to = tabs.findIndex((tab) => tab.id === toId);
  if (from < 0 || to < 0 || from === to) return [...tabs];
  const next = [...tabs];
  const [moved] = next.splice(from, 1);
  if (moved !== undefined) next.splice(to, 0, moved);
  return next;
}

/** 关掉一个标签后选中的标签：右边一个，没有就左边一个；最后一个关掉时由调用方补新标签页 */
export function nextActiveAfterClose(
  tabs: readonly PanelTab[],
  closedId: string,
  activeId: string,
): string | undefined {
  if (closedId !== activeId) return activeId;
  const index = tabs.findIndex((tab) => tab.id === closedId);
  return (tabs[index + 1] ?? tabs[index - 1])?.id;
}

/** 路径的最后一段（目录名 / 文件名），Windows 与 POSIX 分隔符都认 */
export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1);
}

/** 所在目录：去掉最后一段；没有上级时原样返回 */
export function dirName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut <= 0 ? trimmed : trimmed.slice(0, cut);
}

/** 绝对路径（盘符或 POSIX 根）；runtime.readFile 只收绝对路径 */
export function isAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("/");
}

/**
 * 网络路径（`\\server\share`、`//server/share`、`\\?\UNC\...`）：回答里的这类引用
 * 不链接化、不送去判断存在性（ADR-0060 修订 2026-10-18；Core 侧同样拦截）。
 */
export function isNetworkPath(path: string): boolean {
  const p = path.replaceAll("/", "\\");
  if (/^\\\\[?.]\\unc\\/i.test(p)) return true;
  return p.startsWith("\\\\") && !/^\\\\[?.]\\/.test(p);
}

/** 路径在工作区内时给出相对路径（Windows 不分大小写），否则 undefined */
export function relativeTo(workspace: string, absolute: string): string | undefined {
  const root = workspace.replace(/[\\/]+$/, "");
  if (absolute.length <= root.length) return undefined;
  const sep = absolute[root.length];
  if (sep !== "\\" && sep !== "/") return undefined;
  if (!samePath(absolute.slice(0, root.length), root)) return undefined;
  return absolute.slice(root.length + 1);
}

/**
 * 文件标签的显示：文件名、范围（工作区内是项目名，工作区外是所在目录名）、
 * 面包屑里的路径（工作区内是相对路径，工作区外只有文件名）。
 */
export function fileTabLabel(tab: Pick<FileTab, "absolutePath" | "workspace">): {
  name: string;
  scope: string;
  path: string;
} {
  const name = baseName(tab.absolutePath);
  const relative =
    tab.workspace === undefined ? undefined : relativeTo(tab.workspace, tab.absolutePath);
  if (tab.workspace !== undefined && relative !== undefined) {
    return { name, scope: baseName(tab.workspace), path: relative.replaceAll("\\", "/") };
  }
  return { name, scope: baseName(dirName(tab.absolutePath)), path: name };
}

/**
 * 标签上的项目名放得下才显示（第 1 轮报告：窄标签只剩一个字母加省略号）：
 * 文件名整段显示之后，剩余宽度要能放下整个项目名，否则整段隐藏。
 */
export function projectFits(
  labelWidth: number,
  nameWidth: number,
  projectWidth: number,
  gap = 6,
): boolean {
  return nameWidth + gap + projectWidth <= labelWidth + 0.5;
}

/** Core auto 规则的顺序（platform/shells.ts autoOrder）：Windows 上 pwsh → Git Bash → cmd */
const AUTO_SHELL_ORDER = ["pwsh", "bash", "cmd", "sh"] as const;

/**
 * 终端的 shell（ADR-0060 修订 2026-10-18（二））：标签里换过的优先（仍然可用的话）；
 * 否则跟随「设置 › 常规 › 执行 › Shell」的生效值——种类名（pwsh / bash / cmd …）
 * 或可执行文件路径；`auto`、没设置、或设置的那种 shell 没安装时按 auto 规则选。
 */
export function terminalShell(
  shells: readonly ShellOption[],
  chosen?: string,
  setting?: string,
): ShellOption | undefined {
  const usable = shells.filter((s) => s.available && s.executable !== undefined);
  const byPath = (path: string) =>
    usable.find((s) => s.executable !== undefined && samePath(s.executable, path));
  if (chosen !== undefined) {
    const hit = byPath(chosen);
    if (hit !== undefined) return hit;
  }
  const wanted = setting?.trim();
  if (wanted !== undefined && wanted !== "" && wanted !== "auto") {
    const hit = isAbsolutePath(wanted) ? byPath(wanted) : usable.find((s) => s.kind === wanted);
    if (hit !== undefined) return hit;
  }
  for (const kind of AUTO_SHELL_ORDER) {
    const hit = usable.find((s) => s.kind === kind);
    if (hit !== undefined) return hit;
  }
  return usable[0];
}

/** 工作区内路径拼绝对路径：沿用工作区自己的分隔符 */
export function joinWorkspace(workspace: string, relative: string): string {
  const sep = workspace.includes("\\") ? "\\" : "/";
  const rel = relative.replace(/[\\/]+/g, sep).replace(/^[\\/]+/, "");
  return workspace.replace(/[\\/]+$/, "") + sep + rel;
}

/** 同一路径（Windows 不分大小写、不分分隔符） */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) =>
    p
      .replace(/[\\/]+/g, "/")
      .replace(/\/$/, "")
      .toLowerCase();
  return norm(a) === norm(b);
}

export function isHtmlPath(path: string): boolean {
  return /\.html?$/i.test(path);
}

export interface QuickOpenHit {
  path: string;
  name: string;
  dir: string;
}

/**
 * Ctrl+P 排名（与 @ 补全同一套档位）：文件名前缀 > 文件名包含 > 路径包含 >
 * 路径按字符顺序匹配；同档短路径在前。只列文件。空查询时先列 recent（最近在面板里
 * 打开过的相对路径，新的在前），其余按路径字母序。
 */
export function rankQuickOpen(
  query: string,
  entries: readonly { path: string; kind: "file" | "directory" }[],
  limit = 50,
  recent: readonly string[] = [],
): QuickOpenHit[] {
  const q = query.trim().toLowerCase().replaceAll("\\", "/");
  if (q === "") {
    const order = new Map(recent.map((path, index) => [path, index]));
    const files = entries
      .filter((entry) => entry.kind === "file")
      .map((entry) => entry.path)
      .sort((a, b) => {
        const ra = order.get(a);
        const rb = order.get(b);
        if (ra !== undefined || rb !== undefined) {
          return (ra ?? Infinity) - (rb ?? Infinity);
        }
        return a.localeCompare(b);
      });
    return files.slice(0, limit).map((path) => {
      const cut = path.lastIndexOf("/");
      return { path, name: path.slice(cut + 1), dir: path.slice(0, cut + 1) };
    });
  }
  const subsequence = (text: string): boolean => {
    let at = 0;
    for (const ch of text) if (ch === q[at]) at += 1;
    return at === q.length;
  };
  const ranked = entries.flatMap((entry) => {
    if (entry.kind !== "file") return [];
    const path = entry.path.toLowerCase();
    const slash = path.lastIndexOf("/");
    const name = path.slice(slash + 1);
    const rank =
      q === ""
        ? 0
        : name.startsWith(q)
          ? 0
          : name.includes(q)
            ? 1
            : path.includes(q)
              ? 2
              : subsequence(path)
                ? 3
                : -1;
    if (rank < 0) return [];
    const original = entry.path;
    const cut = original.lastIndexOf("/");
    return [
      { path: original, name: original.slice(cut + 1), dir: original.slice(0, cut + 1), rank },
    ];
  });
  ranked.sort(
    (a, b) => a.rank - b.rank || a.path.length - b.path.length || a.path.localeCompare(b.path),
  );
  return ranked.slice(0, limit).map(({ path, name, dir }) => ({ path, name, dir }));
}

/** 「变更」里的一项：某一轮的某个文件 */
export interface ChangeItem {
  key: string;
  seq: number;
  /** 第几轮（按会话里的用户消息顺序，从 1 起） */
  round: number;
  path: string;
  added: number;
  removed: number;
  approximate: boolean;
  unavailable?: string | undefined;
  status?: string | undefined;
  reverted: boolean;
}

/**
 * 汇总会话所有轮次的改动（ADR-0060 第 2 节）：新的一轮在前，轮内按路径。
 * round 按用户消息 seq 的先后编号；不在 userSeqs 里的轮按 seq 顺序补在后面。
 */
export function collectChanges(
  turns: Iterable<TurnChanges>,
  userSeqs: readonly number[],
): ChangeItem[] {
  const order = new Map(userSeqs.map((seq, index) => [seq, index + 1]));
  const items: ChangeItem[] = [];
  const sorted = [...turns].sort((a, b) => b.seq - a.seq);
  for (const turn of sorted) {
    const round = order.get(turn.seq) ?? userSeqs.filter((seq) => seq < turn.seq).length + 1;
    for (const file of [...turn.files].sort((a, b) => a.path.localeCompare(b.path))) {
      items.push({
        key: `${turn.seq}:${file.path}`,
        seq: turn.seq,
        round,
        path: file.path,
        added: file.added ?? 0,
        removed: file.removed ?? 0,
        approximate: file.approximate === true,
        unavailable: file.unavailable,
        status: file.status,
        reverted: turn.reverted !== undefined,
      });
    }
  }
  return items;
}

/** 本会话累计 +N −M（概览浮层「变更」行）；已撤销的轮不计 */
export function sessionChangeTotals(turns: Iterable<TurnChanges>): {
  added: number;
  removed: number;
  files: number;
} {
  let added = 0;
  let removed = 0;
  const files = new Set<string>();
  for (const turn of turns) {
    if (turn.reverted !== undefined) continue;
    for (const file of turn.files) {
      added += file.added ?? 0;
      removed += file.removed ?? 0;
      files.add(file.path);
    }
  }
  return { added, removed, files: files.size };
}

/**
 * 「变更」文件列表的一行：同一文件的所有轮次汇总（ADR-0060 修订 2026-10-18）。
 * 增减行数合计未撤销的轮；全部撤销时合计全部并标记 reverted。rounds 新的在前。
 */
export interface ChangeFile {
  key: string;
  path: string;
  added: number;
  removed: number;
  approximate: boolean;
  /** 所有轮都拿不到行数时的说明 */
  unavailable?: string | undefined;
  /** 第一轮新建、最后一轮删除时给出 */
  status?: string | undefined;
  reverted: boolean;
  rounds: ChangeItem[];
}

/** 按文件汇总（输入是 collectChanges 的结果：新的一轮在前）；输出按路径排序 */
export function groupChanges(items: readonly ChangeItem[]): ChangeFile[] {
  const byPath = new Map<string, ChangeItem[]>();
  for (const item of items) {
    const list = byPath.get(item.path);
    if (list === undefined) byPath.set(item.path, [item]);
    else list.push(item);
  }
  const files: ChangeFile[] = [];
  for (const [path, rounds] of byPath) {
    const sorted = [...rounds].sort((a, b) => b.seq - a.seq);
    const live = sorted.filter((r) => !r.reverted);
    const counted = (live.length > 0 ? live : sorted).filter((r) => r.unavailable === undefined);
    const newest = sorted[0];
    const oldest = sorted[sorted.length - 1];
    files.push({
      key: `file:${path}`,
      path,
      added: counted.reduce((n, r) => n + r.added, 0),
      removed: counted.reduce((n, r) => n + r.removed, 0),
      approximate: counted.some((r) => r.approximate),
      unavailable: sorted.every((r) => r.unavailable !== undefined)
        ? newest?.unavailable
        : undefined,
      status:
        newest?.status === "deleted" ? "deleted" : oldest?.status === "added" ? "added" : undefined,
      reverted: live.length === 0,
      rounds: sorted,
    });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export interface ChangeTreeDir {
  kind: "dir";
  /** 目录相对路径（/ 分隔，空串是根） */
  path: string;
  name: string;
  children: ChangeTreeNode[];
}
export type ChangeTreeNode = ChangeTreeDir | { kind: "file"; file: ChangeFile; name: string };

/** 工作区是 Windows 路径（盘符或反斜杠）：变更标签按 Windows 写法显示路径 */
export function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:/.test(path) || path.includes("\\");
}

/** 展示用路径换成系统写法：Windows 上用反斜杠（`Z:\nocturne-mockups`），POSIX 不变 */
export function nativeSeparators(path: string, windows: boolean): string {
  return windows ? path.replaceAll("/", "\\") : path;
}

/**
 * 按目录折叠的文件树（一个文件一行）：路径相对工作区显示（displayPath 由调用方先做），
 * 只有一个子目录的目录链合并成一级，用 sep 连接（a/b/c，Windows 上 a\b\c）。
 */
export function buildChangeTree(
  files: readonly ChangeFile[],
  label: (file: ChangeFile) => string,
  sep = "/",
): ChangeTreeDir {
  const root: ChangeTreeDir = { kind: "dir", path: "", name: "", children: [] };
  for (const file of files) {
    const parts = label(file).replaceAll("\\", "/").split("/").filter(Boolean);
    const name = parts.pop() ?? file.path;
    let dir = root;
    for (const part of parts) {
      const path = dir.path === "" ? part : `${dir.path}/${part}`;
      let next = dir.children.find(
        (child): child is ChangeTreeDir => child.kind === "dir" && child.path === path,
      );
      if (next === undefined) {
        next = { kind: "dir", path, name: part, children: [] };
        dir.children.push(next);
      }
      dir = next;
    }
    dir.children.push({ kind: "file", file, name });
  }
  const compact = (dir: ChangeTreeDir): ChangeTreeDir => {
    dir.children = dir.children.map((child) => (child.kind === "dir" ? compact(child) : child));
    const only = dir.children[0];
    if (dir.path !== "" && dir.children.length === 1 && only?.kind === "dir") {
      return { ...only, name: `${dir.name}${sep}${only.name}` };
    }
    return dir;
  };
  const sortChildren = (dir: ChangeTreeDir) => {
    dir.children.sort((a, b) =>
      a.kind !== b.kind ? (a.kind === "dir" ? -1 : 1) : a.name.localeCompare(b.name),
    );
    for (const child of dir.children) if (child.kind === "dir") sortChildren(child);
  };
  const result = compact(root);
  sortChildren(result);
  return result;
}

export type AddressTarget =
  | { kind: "url"; url: string }
  | { kind: "path"; path: string }
  | { kind: "invalid"; message: string };

/**
 * 新标签页地址栏（ADR-0060 实现计划第 1 轮）：内置浏览器做好之前，网址和 HTML 路径
 * 都交给系统浏览器。裸域名补 https://；file:// 与相对路径转成绝对路径。
 */
export function parseAddress(input: string, workspace: string | undefined): AddressTarget {
  const text = input.trim();
  if (text === "") return { kind: "invalid", message: "请输入网址或 HTML 文件路径" };
  if (/^file:\/\//i.test(text)) {
    let path = decodeURI(text.replace(/^file:\/\/\/?/i, ""));
    if (!/^[A-Za-z]:/.test(path) && !path.startsWith("/")) path = `/${path}`;
    return isHtmlPath(path)
      ? { kind: "path", path: path.replace(/^\/(?=[A-Za-z]:)/, "") }
      : { kind: "invalid", message: "这一版只能打开 HTML 文件" };
  }
  if (/^https?:\/\//i.test(text)) {
    try {
      return { kind: "url", url: new URL(text).href };
    } catch {
      return { kind: "invalid", message: "网址格式不对" };
    }
  }
  if (isHtmlPath(text)) {
    if (isNetworkPath(text)) return { kind: "invalid", message: "不打开网络路径上的文件" };
    if (/^[A-Za-z]:[\\/]/.test(text) || text.startsWith("/")) {
      return { kind: "path", path: text };
    }
    if (workspace === undefined) return { kind: "invalid", message: "相对路径需要先打开一个会话" };
    return { kind: "path", path: joinWorkspace(workspace, text) };
  }
  if (!/\s/.test(text) && /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(text)) {
    const local = /^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(text);
    return { kind: "url", url: new URL(`${local ? "http" : "https"}://${text}`).href };
  }
  if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/i.test(text)) {
    return { kind: "url", url: new URL(`http://${text}`).href };
  }
  return { kind: "invalid", message: "这一版地址栏只接受网址和 HTML 文件路径" };
}
