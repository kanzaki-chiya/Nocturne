/**
 * Windows 桌面端会话正文文件引用右键菜单（ADR-0124）：
 * 普通工作区文件依次为「打开」「打开方式 ›」「在资源管理器中显示」、分隔线、
 * 「复制相对路径」「复制绝对路径」；二级菜单复用 `list_file_apps` / `open_file_with_app`
 * 最多展示前三个系统推荐应用与「更多打开方式…」（原生 `SHOpenWithDialog`）。
 * 目录省略「打开方式」，工作区外保留既有打开边界，受保护类型仅保留安全编辑器入口。
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useDataUriBlobUrl } from "./data-uri";
import { FAILED_APP_LIST } from "./FileOpenMenu";
import type { DesktopHost, FileAppList } from "./host";
import { Menu, MenuItem, MenuSeparator, MenuSubmenu } from "./Menu";
import { outsideOpenable, type PrefsStore } from "./prefs";
import { ICON_SM, Icon, type IconName } from "./ui";

export const MAX_RECOMMENDED_APPS = 3;

export interface FileRefTarget {
  absolutePath: string;
  relativePath?: string | undefined;
  withinWorkspace: boolean;
  isDirectory: boolean;
  line?: number | undefined;
  endLine?: number | undefined;
}

export interface FileRefMenuHooks {
  open: (
    absolutePath: string,
    line?: number,
    ref?: { endLine?: number | undefined },
  ) => Promise<void>;
  editors: () => { vscode: boolean; cursor: boolean };
  openInEditor: (editor: "vscode" | "cursor", absolutePath: string, line?: number) => Promise<void>;
  openFolder: (absolutePath: string) => Promise<void>;
  copy: (text: string) => Promise<void>;
  reveal: (absolutePath: string) => Promise<void>;
  listFileApps?: ((absolutePath: string) => Promise<FileAppList>) | undefined;
  openFileWithApp?:
    ((absolutePath: string, id: string, line?: number) => Promise<void>) | undefined;
  openFileWithDialog?: ((absolutePath: string) => Promise<void>) | undefined;
}

export interface OpenWithEntry {
  key: string;
  label: string;
  icon: { src: string } | { glyph: IconName };
  run: () => Promise<void>;
}

/** 是否具备 Windows 会话文件引用增强菜单所需的全部宿主能力（枚举、按应用打开、原生选择器）。 */
export function hasWindowsFileRefMenuCapabilities(hooks: FileRefMenuHooks): boolean {
  return (
    hooks.listFileApps !== undefined &&
    hooks.openFileWithApp !== undefined &&
    hooks.openFileWithDialog !== undefined
  );
}

/** 生成「打开方式 ›」二级菜单内容：普通文件取前 3 个系统推荐 + 原生选择器；受保护类型只列安全编辑器。 */
export function buildOpenWithEntries(
  list: FileAppList,
  editors: { vscode: boolean; cursor: boolean },
  path: string,
  line: number | undefined,
  hooks: FileRefMenuHooks,
): { apps: OpenWithEntry[]; showPicker: boolean } {
  const apps: OpenWithEntry[] = [];
  const openWithApp = hooks.openFileWithApp;
  if (!list.launchesCode && openWithApp !== undefined) {
    for (const app of list.apps.slice(0, MAX_RECOMMENDED_APPS)) {
      apps.push({
        key: app.id,
        label: app.name,
        icon: app.iconDataUrl !== undefined ? { src: app.iconDataUrl } : { glyph: "code" },
        run: () => openWithApp(path, app.id, line),
      });
    }
  }
  if (list.launchesCode || (list.failed && apps.length === 0)) {
    const pushEditor = (kind: "vscode" | "cursor", label: string) => {
      if (!editors[kind]) return;
      const src = list.editorIcons[kind];
      apps.push({
        key: `editor-${kind}`,
        label,
        icon: src !== undefined ? { src } : { glyph: "code" },
        run: () => hooks.openInEditor(kind, path, line),
      });
    };
    pushEditor("vscode", "VS Code");
    pushEditor("cursor", "Cursor");
  }
  return {
    apps,
    showPicker: !list.launchesCode && hooks.openFileWithDialog !== undefined,
  };
}

function OpenWithIcon({ icon }: { icon: OpenWithEntry["icon"] }) {
  const imgSrc = useDataUriBlobUrl("src" in icon ? icon.src : undefined);
  return (
    <span className="sp-open-icon" aria-hidden="true">
      {"src" in icon ? (
        imgSrc !== undefined ? (
          <img src={imgSrc} alt="" draggable={false} />
        ) : null
      ) : (
        <Icon name={icon.glyph} size={ICON_SM} />
      )}
    </span>
  );
}

const activeClosers = new Set<() => void>();

/** 确保任意时刻至多一个文件引用右键菜单打开（切换目标时立即收起旧菜单并作废旧查询）。 */
export function registerFileRefMenuCloser(closer: () => void): () => void {
  activeClosers.add(closer);
  return () => {
    activeClosers.delete(closer);
  };
}

export function closeOtherFileRefMenus(except?: () => void): void {
  for (const closer of activeClosers) {
    if (closer !== except) closer();
  }
}

export interface FileRefPanelController {
  openFile: (absolutePath: string, line?: number, ref?: { endLine?: number | undefined }) => void;
  previewsHtml: (absolutePath: string) => boolean;
  viewSource: (absolutePath: string, line?: number) => void;
}

/** 构造桌面端 `Conversation.fileLinks`：左键与右键「打开」共用 `prefs.fileOpener` 分派逻辑。 */
export function createFileLinkHooks(input: {
  host: DesktopHost;
  prefs: PrefsStore;
  editors: { vscode: boolean; cursor: boolean };
  getPanel: () => FileRefPanelController | null;
}) {
  const { host, prefs, editors, getPanel } = input;
  const fileApps = host.fileApps;
  const openWithDialog = fileApps?.openWithDialog;
  // 缺省 Nocturne 面板（ADR-0060）；面板之外的选择照旧
  const opener = () => prefs.get().fileOpener ?? "panel";
  return {
    open: async (absolutePath: string, line?: number, ref?: { endLine?: number | undefined }) => {
      const kind = opener();
      if (kind === "panel") {
        getPanel()?.openFile(absolutePath, line, ref);
        return;
      }
      // 选中的编辑器没装（或探测失败）时退回系统默认程序
      if (kind === "system" || !editors[kind]) {
        await host.openPath(absolutePath);
        return;
      }
      await host.openInEditor(kind, absolutePath, line);
    },
    outsideOpenable: () => outsideOpenable(opener(), editors),
    editors: () => editors,
    openInEditor: (editor: "vscode" | "cursor", absolutePath: string, line?: number) =>
      host.openInEditor(editor, absolutePath, line),
    // 目录交给系统（资源管理器打开）；open_with_default 对目录不拦截
    openFolder: (absolutePath: string) => host.openPath(absolutePath),
    copy: async (text: string) => {
      await navigator.clipboard.writeText(text);
    },
    reveal: (absolutePath: string) => host.revealItem(absolutePath),
    // 工作区内的 HTML 左键进面板浏览器；「查看源码」照旧进文件标签
    previewsHtml: (absolutePath: string) =>
      opener() === "panel" && getPanel()?.previewsHtml(absolutePath) === true,
    viewSource: async (absolutePath: string, line?: number) => {
      getPanel()?.viewSource(absolutePath, line);
      return Promise.resolve();
    },
    ...(fileApps !== undefined
      ? {
          listFileApps: (absolutePath: string) => fileApps.list(absolutePath),
          openFileWithApp: (absolutePath: string, id: string, line?: number) =>
            fileApps.open(absolutePath, id, line),
          ...(openWithDialog !== undefined
            ? { openFileWithDialog: (absolutePath: string) => openWithDialog(absolutePath) }
            : {}),
        }
      : {}),
  };
}

export interface FileRefMenuProps {
  anchor: HTMLElement;
  label: string;
  hit: FileRefTarget;
  canOpen: boolean;
  hooks: FileRefMenuHooks;
  onRun: (action: () => Promise<void>) => void;
  onClose: () => void;
}

export function FileRefMenu({
  anchor,
  label,
  hit,
  canOpen,
  hooks,
  onRun,
  onClose,
}: FileRefMenuProps) {
  const [appList, setAppList] = useState<FileAppList | null>(null);
  const requestSeq = useRef(0);
  const supportsOpenWith = hit.withinWorkspace && !hit.isDirectory;
  const listFileApps = hooks.listFileApps;

  useEffect(() => {
    if (!supportsOpenWith) {
      setAppList(null);
      return;
    }
    const seq = ++requestSeq.current;
    setAppList(null);
    let cancelled = false;
    const query =
      listFileApps !== undefined
        ? listFileApps(hit.absolutePath)
        : Promise.resolve(FAILED_APP_LIST);
    void query
      .then((result) => {
        if (cancelled || requestSeq.current !== seq) return;
        setAppList(result);
      })
      .catch(() => {
        if (cancelled || requestSeq.current !== seq) return;
        setAppList(FAILED_APP_LIST);
      });
    return () => {
      cancelled = true;
      requestSeq.current += 1;
    };
  }, [supportsOpenWith, hit.absolutePath, listFileApps]);

  const editors = hooks.editors();
  const submenu =
    appList !== null
      ? buildOpenWithEntries(appList, editors, hit.absolutePath, hit.line, hooks)
      : null;
  const showOpenWith =
    supportsOpenWith && (submenu === null || submenu.apps.length > 0 || submenu.showPicker);
  const openDefault = () =>
    hit.isDirectory
      ? hooks.openFolder(hit.absolutePath)
      : hooks.open(hit.absolutePath, hit.line, { endLine: hit.endLine });
  const relative = hit.relativePath;

  return createPortal(
    <Menu anchor={anchor} label={label} onClose={onClose}>
      {canOpen && (
        <MenuItem
          icon={<Icon name="external_link" size={ICON_SM} />}
          label="打开"
          onSelect={() => {
            onRun(openDefault);
          }}
        />
      )}
      {showOpenWith && (
        <MenuSubmenu
          icon={<Icon name="code" size={ICON_SM} />}
          label="打开方式"
          right={<Icon name="right_small" size={ICON_SM} />}
          className="file-ref-submenu"
          ready={submenu !== null}
        >
          {submenu?.apps.map((entry) => (
            <MenuItem
              key={entry.key}
              icon={<OpenWithIcon icon={entry.icon} />}
              label={entry.label}
              onSelect={() => {
                onRun(entry.run);
              }}
            />
          ))}
          {submenu !== null && submenu.apps.length > 0 && submenu.showPicker && <MenuSeparator />}
          {submenu?.showPicker === true && (
            <MenuItem
              icon={<OpenWithIcon icon={{ glyph: "more_1" }} />}
              label="更多打开方式…"
              onSelect={() => {
                onRun(async () => {
                  if (hooks.openFileWithDialog === undefined) throw new Error("无法打开此文件");
                  await hooks.openFileWithDialog(hit.absolutePath);
                });
              }}
            />
          )}
        </MenuSubmenu>
      )}
      <MenuItem
        icon={<Icon name="folder" size={ICON_SM} />}
        label="在资源管理器中显示"
        onSelect={() => {
          onRun(() => hooks.reveal(hit.absolutePath));
        }}
      />
      <MenuSeparator />
      {relative !== undefined && (
        <MenuItem
          icon={<Icon name="copy_2" size={ICON_SM} />}
          label="复制相对路径"
          onSelect={() => {
            onRun(() => hooks.copy(relative));
          }}
        />
      )}
      <MenuItem
        icon={<Icon name="copy_2" size={ICON_SM} />}
        label="复制绝对路径"
        onSelect={() => {
          onRun(() => hooks.copy(hit.absolutePath));
        }}
      />
    </Menu>,
    document.body,
  );
}
