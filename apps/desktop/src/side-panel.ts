/**
 * 右侧面板的纯逻辑（ADR-0060 第 1–3 节）：标签模型、持久化与恢复、宽度上下限、
 * 快速打开排名、变更汇总。界面在 SidePanel.tsx。
 */
import type { TurnChanges } from "@nocturne/core/protocol";

/** 新标签页：地址栏 + 工具列表；不持久化 */
export interface NewTab {
  id: string;
  kind: "new";
}

/** 变更：跟随当前会话；focusSeq 是「查看变更」要定位的那一轮 */
export interface ChangesTab {
  id: string;
  kind: "changes";
  focusSeq?: number | undefined;
  /** 每次定位递增，同一轮再点一次也能重新滚动 */
  focusNonce?: number | undefined;
}

/**
 * 文件：创建时绑定会话的工作区（标签显示项目名），切换会话不影响它。
 * sessionId 是创建时的会话：读取文件要经过这个工作区的某个会话（rpc.md session.readFile）。
 */
export interface FileTab {
  id: string;
  kind: "file";
  workspace: string;
  sessionId: string;
  absolutePath: string;
  relativePath: string;
  line?: number | undefined;
  endLine?: number | undefined;
  /** 每次定位递增：同一文件再点另一行时重新滚动 */
  focusNonce?: number | undefined;
}

export type PanelTab = NewTab | ChangesTab | FileTab;

/** 存进本机偏好的标签：只有「文件」和「变更」（新标签页不恢复） */
export type StoredPanelTab =
  | { id: string; kind: "changes" }
  | {
      id: string;
      kind: "file";
      workspace: string;
      sessionId: string;
      absolutePath: string;
      relativePath: string;
      line?: number;
      endLine?: number;
    };

export const PANEL_MIN_WIDTH = 320;
export const PANEL_MAX_WIDTH = 960;
export const PANEL_DEFAULT_WIDTH = 520;
/** 对话区至少留这么宽；更窄时面板改为盖在对话区上（ADR-0060 第 1 节） */
export const CONVERSATION_MIN_WIDTH = 480;

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
    } else if (
      raw.kind === "file" &&
      str(raw.workspace) &&
      str(raw.sessionId) &&
      str(raw.absolutePath) &&
      typeof raw.relativePath === "string"
    ) {
      ids.add(raw.id);
      tabs.push({
        id: raw.id,
        kind: "file",
        workspace: raw.workspace,
        sessionId: raw.sessionId,
        absolutePath: raw.absolutePath,
        relativePath: raw.relativePath,
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
          workspace: tab.workspace,
          sessionId: tab.sessionId,
          absolutePath: tab.absolutePath,
          relativePath: tab.relativePath,
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
 * 路径按字符顺序匹配；同档短路径在前。只列文件。
 */
export function rankQuickOpen(
  query: string,
  entries: readonly { path: string; kind: "file" | "directory" }[],
  limit = 50,
): QuickOpenHit[] {
  const q = query.trim().toLowerCase().replaceAll("\\", "/");
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

export interface ChangeTreeDir {
  kind: "dir";
  /** 目录相对路径（/ 分隔，空串是根） */
  path: string;
  name: string;
  children: ChangeTreeNode[];
}
export type ChangeTreeNode = ChangeTreeDir | { kind: "file"; item: ChangeItem; name: string };

/**
 * 按目录折叠的文件树：路径相对工作区显示（displayPath 由调用方先做），
 * 只有一个子目录的目录链合并成一级（a/b/c）。
 */
export function buildChangeTree(
  items: readonly ChangeItem[],
  label: (item: ChangeItem) => string,
): ChangeTreeDir {
  const root: ChangeTreeDir = { kind: "dir", path: "", name: "", children: [] };
  for (const item of items) {
    const parts = label(item).replaceAll("\\", "/").split("/").filter(Boolean);
    const name = parts.pop() ?? item.path;
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
    dir.children.push({ kind: "file", item, name });
  }
  const compact = (dir: ChangeTreeDir): ChangeTreeDir => {
    dir.children = dir.children.map((child) => (child.kind === "dir" ? compact(child) : child));
    const only = dir.children[0];
    if (dir.path !== "" && dir.children.length === 1 && only?.kind === "dir") {
      return { ...only, name: `${dir.name}/${only.name}` };
    }
    return dir;
  };
  const sortChildren = (dir: ChangeTreeDir) => {
    dir.children.sort((a, b) =>
      a.kind !== b.kind
        ? a.kind === "dir"
          ? -1
          : 1
        : a.name.localeCompare(b.name) ||
          (a.kind === "file" && b.kind === "file" ? b.item.seq - a.item.seq : 0),
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
    if (/^[A-Za-z]:[\\/]/.test(text) || text.startsWith("/") || text.startsWith("\\\\")) {
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
