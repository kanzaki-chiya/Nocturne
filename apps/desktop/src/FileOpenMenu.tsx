/**
 * 「文件」标签顶栏的「打开」分裂按钮与菜单（ADR-0060 修订 2026-11-21、ADR-0102）：
 * 左半用默认程序打开（等同资源管理器里双击），右半弹出菜单——系统建议的应用（名称、
 * 图标都来自系统）、资源管理器 / 另存为 / 复制路径、自动换行。每次打开菜单都重新查询。
 */
import { useEffect, useRef, useState } from "react";

import type { FileApp, FileAppList } from "./host";
import { Menu, MenuItem, MenuSeparator } from "./Menu";
import { Button, ICON_SM, Icon, type IconName } from "./ui";

export interface FileOpenActions {
  /** 系统建议的应用；外壳不提供或查询失败时 failed 为 true */
  listApps: (absolutePath: string) => Promise<FileAppList>;
  openWithApp: (absolutePath: string, id: string, line?: number) => Promise<void>;
  /** 系统默认程序（外壳 open_with_default：会被直接执行的类型改为在资源管理器中显示） */
  openDefault: (absolutePath: string) => Promise<void>;
  /** 兜底：检测到的编辑器（带行号打开） */
  editors: { vscode: boolean; cursor: boolean };
  openInEditor: (editor: "vscode" | "cursor", absolutePath: string, line?: number) => Promise<void>;
  reveal: (absolutePath: string) => Promise<void>;
  copy: (text: string) => Promise<void>;
  /** HTML：在面板浏览器标签里打开（没有内置浏览器时用系统浏览器） */
  openInBrowser: (absolutePath: string) => Promise<void>;
  browserLabel: string;
}

/** 外壳没有这组命令、或查询本身报错时按「查询失败」处理：菜单退回 VS Code / Cursor 与系统默认程序 */
export const FAILED_APP_LIST: FileAppList = {
  apps: [],
  launchesCode: false,
  failed: true,
  editorIcons: {},
};

export type OpenTarget = { kind: "app"; app: FileApp } | { kind: "default" } | { kind: "none" };

/**
 * 左半「打开」的去向：系统默认程序 → 列表第一项 → 脚本类与查询失败交给 open_with_default
 * （脚本改为在资源管理器中显示）→ 都没有时禁用。
 */
export function openTarget(list: FileAppList): OpenTarget {
  const app = list.apps.find((item) => item.isDefault) ?? list.apps[0];
  if (app !== undefined) return { kind: "app", app };
  if (list.launchesCode || list.failed) return { kind: "default" };
  return { kind: "none" };
}

interface MenuEntry {
  key: string;
  label: string;
  icon: { src: string } | { glyph: IconName };
  run: () => Promise<void> | void;
}

/** 菜单应用组：系统应用；为空时退回检测到的 VS Code / Cursor（查询失败再加「系统默认程序」）；HTML 末尾加浏览器项 */
export function appEntries(
  list: FileAppList,
  path: string,
  line: number | undefined,
  html: boolean,
  actions: FileOpenActions,
): MenuEntry[] {
  const entries: MenuEntry[] = list.apps.map((app) => ({
    key: app.id,
    label: app.name,
    icon: app.iconDataUrl !== undefined ? { src: app.iconDataUrl } : { glyph: "code" },
    run: () => actions.openWithApp(path, app.id, line),
  }));
  if (list.apps.length === 0) {
    const editor = (kind: "vscode" | "cursor", label: string) => {
      if (!actions.editors[kind]) return;
      const src = list.editorIcons[kind];
      entries.push({
        key: kind,
        label,
        icon: src !== undefined ? { src } : { glyph: "code" },
        run: () => actions.openInEditor(kind, path, line),
      });
    };
    editor("vscode", "VS Code");
    editor("cursor", "Cursor");
    if (list.failed) {
      entries.push({
        key: "system",
        label: "系统默认程序",
        icon: { glyph: "external_link" },
        run: () => actions.openDefault(path),
      });
    }
  }
  if (html) {
    entries.push({
      key: "browser",
      label: actions.browserLabel,
      icon: { glyph: "earth" },
      run: () => actions.openInBrowser(path),
    });
  }
  return entries;
}

function EntryIcon({ icon }: { icon: MenuEntry["icon"] }) {
  return (
    <span className="sp-open-icon" aria-hidden="true">
      {"src" in icon ? (
        <img src={icon.src} alt="" draggable={false} />
      ) : (
        <Icon name={icon.glyph} size={ICON_SM} />
      )}
    </span>
  );
}

export interface FileOpenButtonProps {
  path: string;
  line?: number | undefined;
  /** 文件已不存在：左半禁用，菜单只剩复制 */
  missing: boolean;
  html: boolean;
  /** 工作区内的相对路径（面包屑那段）；工作区外为 undefined */
  relativePath?: string | undefined;
  /** 另存为；文本或图片读到之前、或拿不到保存方式时为 undefined */
  onSaveAs?: (() => void) | undefined;
  /** 自动换行开关；不是文本时为 undefined（不显示） */
  wrap?: boolean | undefined;
  onWrap?: ((wrap: boolean) => void) | undefined;
  /** 每次重新读取文件时变化：重新查询系统应用 */
  reloadKey?: number | undefined;
  actions: FileOpenActions;
  onError: (message: string | undefined) => void;
}

export function FileOpenButton(props: FileOpenButtonProps) {
  const { path, line, missing, html, relativePath, onSaveAs, wrap, onWrap, actions, onError } =
    props;
  const arrow = useRef<HTMLButtonElement>(null);
  const [known, setKnown] = useState<FileAppList>();
  const [menu, setMenu] = useState<{ list: FileAppList | undefined } | null>(null);
  const generation = useRef(0);
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  const query = async (): Promise<FileAppList> => {
    try {
      return await actionsRef.current.listApps(path);
    } catch {
      return FAILED_APP_LIST;
    }
  };

  // 文件换了、重新读取或文件出现/消失时重查一次，决定左半能不能用
  useEffect(() => {
    const token = ++generation.current;
    setKnown(undefined);
    setMenu(null);
    if (missing) return;
    void query().then((list) => {
      if (generation.current === token) setKnown(list);
    });
    // query 读 ref 里的最新 actions，只随路径、存在与否和重新读取重查
  }, [path, missing, props.reloadKey]);

  const run = (action: () => Promise<void> | void) => {
    onError(undefined);
    void Promise.resolve()
      .then(action)
      .catch((e: unknown) => {
        onError(e instanceof Error ? e.message : String(e));
      });
  };

  const openMain = () => {
    run(async () => {
      const list = await query();
      setKnown(list);
      const target = openTarget(list);
      if (target.kind === "app") await actions.openWithApp(path, target.app.id, line);
      else if (target.kind === "default") await actions.openDefault(path);
    });
  };

  const toggleMenu = () => {
    if (menu !== null) {
      setMenu(null);
      return;
    }
    if (missing) {
      setMenu({ list: undefined });
      return;
    }
    // 先查完再挂菜单：Menu 只在挂载时定位并聚焦第一项
    const token = generation.current;
    void query().then((list) => {
      if (generation.current !== token) return;
      setKnown(list);
      setMenu({ list });
    });
  };

  const pick = (action: () => Promise<void> | void) => {
    setMenu(null);
    arrow.current?.focus();
    run(action);
  };

  const apps = menu?.list !== undefined ? appEntries(menu.list, path, line, html, actions) : [];
  const fileItems: MenuEntry[] = [
    ...(missing
      ? []
      : [
          {
            key: "reveal",
            label: "在资源管理器中打开",
            icon: { glyph: "folder" as const },
            run: () => actions.reveal(path),
          },
        ]),
    ...(!missing && onSaveAs !== undefined
      ? [{ key: "save", label: "另存为…", icon: { glyph: "download_2" as const }, run: onSaveAs }]
      : []),
    {
      key: "copy-abs",
      label: "复制绝对路径",
      icon: { glyph: "copy_2" },
      run: () => actions.copy(path),
    },
    ...(relativePath !== undefined
      ? [
          {
            key: "copy-rel",
            label: "复制相对路径",
            icon: { glyph: "copy_2" as const },
            run: () => actions.copy(relativePath),
          },
        ]
      : []),
  ];
  const showWrap = !missing && wrap !== undefined && onWrap !== undefined;
  const mainDisabled = missing || (known !== undefined && openTarget(known).kind === "none");

  return (
    <>
      <div className="sp-open" role="group" aria-label="打开">
        <Button size="sm" className="sp-open-main" disabled={mainDisabled} onClick={openMain}>
          <Icon name="external_link" size={ICON_SM} />
          打开
        </Button>
        <Button
          ref={arrow}
          size="sm"
          className="sp-open-more"
          aria-label="打开方式"
          title="打开方式"
          aria-haspopup="menu"
          aria-expanded={menu !== null}
          onClick={toggleMenu}
        >
          <Icon name="down_small" size={ICON_SM} />
        </Button>
      </div>
      {menu !== null && (
        <Menu
          anchor={arrow.current}
          align="right"
          placement="below"
          className="sp-open-menu"
          label="打开方式"
          onClose={() => {
            setMenu(null);
          }}
        >
          {apps.map((entry) => (
            <MenuItem
              key={entry.key}
              icon={<EntryIcon icon={entry.icon} />}
              label={entry.label}
              onSelect={() => {
                pick(entry.run);
              }}
            />
          ))}
          {apps.length > 0 && <MenuSeparator />}
          {fileItems.map((entry) => (
            <MenuItem
              key={entry.key}
              icon={<EntryIcon icon={entry.icon} />}
              label={entry.label}
              onSelect={() => {
                pick(entry.run);
              }}
            />
          ))}
          {showWrap && (
            <>
              <MenuSeparator />
              <MenuItem
                toggle
                checked={wrap}
                icon={<EntryIcon icon={{ glyph: "corner_down_left" }} />}
                label="自动换行"
                onSelect={() => {
                  pick(() => {
                    onWrap(!wrap);
                  });
                }}
              />
            </>
          )}
        </Menu>
      )}
    </>
  );
}
