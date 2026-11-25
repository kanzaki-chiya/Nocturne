import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { RpcClient } from "@nocturne/rpc/client";
import type {
  MemoryDescription,
  MemoryEntry,
  MemoryEntryMeta,
  MemoryScopeOverview,
  MemoryType,
  OtherProjectMemory,
} from "@nocturne/core/protocol";
import { Markdown } from "./Conversation";
import { isMacOS } from "./platform";
import { Scrim } from "./ProvidersPage";
import {
  Button,
  EmptyState,
  ICON_MD,
  ICON_SM,
  Icon,
  IconButton,
  PageHeader,
  SettingsGroup,
  SettingsListRow,
  SettingsRow,
  Switch,
} from "./ui";
import "./pages.css";
import "./mcp.css";
import "./memory.css";

export const MEMORY_TYPE_LABEL: Record<MemoryType, string> = {
  user: "用户",
  feedback: "反馈",
  project: "项目",
  reference: "参考",
};

/**
 * 详情身份（ADR-0122 §2）：
 * - global：全局条目；
 * - project：当前工作区的项目条目，按 workspaceRoot 解析；
 * - other-project：其他项目条目，必须以项目 key + 条目名寻址，避免同名条目串读。
 */
export type SelectedMemory =
  | { scope: "global"; name: string }
  | { scope: "project"; name: string }
  | { scope: "other-project"; key: string; name: string };

export function memoryFilePath(dir: string, name: string): string {
  const trimmed = dir.replace(/[\\/]+$/, "");
  const sep = dir.includes("\\") ? "\\" : "/";
  return `${trimmed}${sep}${name}.md`;
}

export function formatUpdatedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("zh-CN", { hour12: false });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pathBasename(value: string): string {
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? value;
}

/** 其他项目的记忆目录：projects 根与全局目录同为 memory/ 的直接子目录（ADR-0098 §1） */
function otherProjectDir(globalDir: string, key: string): string {
  const sep = globalDir.includes("\\") ? "\\" : "/";
  const parts = globalDir.replace(/[\\/]+$/, "").split(/[\\/]/);
  parts.pop();
  return `${parts.join(sep)}${sep}projects${sep}${key}`;
}

function selectorFor(target: SelectedMemory): string {
  if (target.scope === "other-project") {
    return `[data-mem-entry="${target.name}"][data-mem-key="${target.key}"] .slist-main`;
  }
  return `[data-mem-entry="${target.name}"][data-mem-scope="${target.scope}"] .slist-main`;
}

function entriesOf(data: MemoryDescription, target: SelectedMemory): MemoryEntryMeta[] {
  if (target.scope === "global") return data.global.entries;
  if (target.scope === "project") return data.project?.entries ?? [];
  return data.otherProjects.find((p) => p.key === target.key)?.entries ?? [];
}

function projectDirOf(
  data: MemoryDescription,
  target: Exclude<SelectedMemory, { scope: "global" }>,
): string {
  if (target.scope === "project") return data.project?.dir ?? "";
  return otherProjectDir(data.global.dir, target.key);
}

/** 选中条目的概览元数据：范围 + 项目键 + 条目名三项同时匹配（ADR-0122 §2） */
function metaOf(
  data: MemoryDescription,
  target: SelectedMemory,
): { meta: MemoryEntryMeta; dir: string } | undefined {
  const meta = entriesOf(data, target).find((entry) => entry.name === target.name);
  if (meta === undefined) return undefined;
  if (target.scope === "global") return { meta, dir: data.global.dir };
  return { meta, dir: projectDirOf(data, target) };
}

export function MemoryPage({
  client,
  workspaceRoot,
  version,
  openDirectory,
  openUrl,
}: {
  client: RpcClient | undefined;
  workspaceRoot: string | undefined;
  version: number;
  openDirectory: (path: string) => Promise<void>;
  openUrl: (url: string) => void;
}) {
  const [data, setData] = useState<MemoryDescription>();
  const [projectView, setProjectView] = useState<{ key: string; path: string }>();
  const [selected, setSelected] = useState<SelectedMemory>();
  const [detail, setDetail] = useState<MemoryEntry>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmClear, setConfirmClear] = useState<OtherProjectMemory>();
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState(false);

  const spageRef = useRef<HTMLDivElement>(null);
  const refreshGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const selectedRef = useRef<SelectedMemory | undefined>(undefined);
  selectedRef.current = selected;
  const confirmClearRef = useRef<OtherProjectMemory | undefined>(undefined);
  confirmClearRef.current = confirmClear;
  const dataRef = useRef<MemoryDescription | undefined>(undefined);
  dataRef.current = data;

  // 逐级返回时的滚动位置与焦点恢复（ADR-0122 §1）
  const scrollMemory = useRef({ overview: 0, project: 0 });
  const focusMemory = useRef({ overview: "", project: "" });
  const pendingApply = useRef<{ scroll: number; selectors: string[] } | undefined>(undefined);

  const rootRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const pending = pendingApply.current;
    if (pending === undefined) return;
    pendingApply.current = undefined;
    const spage = spageRef.current;
    if (spage !== null) spage.scrollTop = pending.scroll;
    // 焦点查找限定在本实例容器：SettingsDeck 隐藏但保留其他设置页，
    // 其中的面包屑返回按钮（.crumb）必须先渲染，不能抢占记忆页的恢复焦点
    const root = rootRef.current;
    if (root === null) return;
    for (const selector of pending.selectors) {
      const el = root.querySelector<HTMLElement>(selector);
      if (el !== null) {
        el.focus();
        return;
      }
    }
  });

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => {
      setToast("");
    }, 2400);
    return () => {
      clearTimeout(timer);
    };
  }, [toast]);

  const loadEntryDetail = useCallback(
    async (target: SelectedMemory) => {
      if (!client) return;
      const generation = ++detailGeneration.current;
      try {
        const entry = await client.runtime.readMemory({
          scope: target.scope === "other-project" ? "project" : target.scope,
          ...(target.scope === "other-project" ? { key: target.key } : {}),
          ...(target.scope === "project" ? { workspaceRoot } : {}),
          name: target.name,
        });
        if (generation !== detailGeneration.current) return;
        setDetail(entry);
        setError("");
      } catch (e) {
        if (generation === detailGeneration.current) {
          setError(errorMessage(e));
        }
      }
    },
    [client, workspaceRoot],
  );

  const refresh = useCallback(async () => {
    if (!client) return;
    const generation = ++refreshGeneration.current;
    try {
      const result = await client.runtime.describeMemory({ workspaceRoot });
      if (generation !== refreshGeneration.current) return;
      setData(result);
      setError("");

      const current = selectedRef.current;
      if (current !== undefined) {
        // 以范围 + 项目键 + 条目名校验，避免不同项目的同名条目串读
        if (metaOf(result, current) !== undefined) {
          void loadEntryDetail(current);
        } else {
          detailGeneration.current++;
          setSelected(undefined);
          setDetail(undefined);
          setConfirmDelete(false);
        }
      }

      const clearing = confirmClearRef.current;
      if (
        clearing !== undefined &&
        !result.otherProjects.some((item) => item.key === clearing.key)
      ) {
        setConfirmClear(undefined);
      }
    } catch (e) {
      if (generation === refreshGeneration.current) {
        setError(errorMessage(e));
      }
    }
  }, [client, workspaceRoot, loadEntryDetail]);

  useEffect(() => {
    void refresh();
    const offProviders = client?.onProvidersChanged(() => {
      void refresh();
    });
    const offSettings = client?.onSettingsChanged(() => {
      void refresh();
    });
    return () => {
      refreshGeneration.current++;
      detailGeneration.current++;
      offProviders?.();
      offSettings?.();
    };
  }, [client, refresh, version]);

  const attempt = async (action: () => Promise<void>) => {
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const toggleScope = async (scope: "global" | "project", next: boolean) => {
    if (!client || busy) return;
    setBusy(true);
    setError("");
    try {
      await client.runtime.updateSettings(
        scope === "global" ? { "memory.global": next } : { "memory.project": next },
      );
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  // ---- 逐级导航：进入时记忆滚动位置与行身份，返回时恢复（ADR-0122 §1） ----

  const openProject = (proj: OtherProjectMemory) => {
    scrollMemory.current.overview = spageRef.current?.scrollTop ?? 0;
    focusMemory.current.overview = `[data-mem-key="${proj.key}"] .slist-main`;
    setError("");
    setProjectView({ key: proj.key, path: proj.path });
    pendingApply.current = { scroll: 0, selectors: [".crumb"] };
  };

  const openEntry = (target: SelectedMemory) => {
    const fromProject = target.scope === "other-project" && projectView?.key === target.key;
    scrollMemory.current[fromProject ? "project" : "overview"] = spageRef.current?.scrollTop ?? 0;
    focusMemory.current[fromProject ? "project" : "overview"] = selectorFor(target);
    setError("");
    setConfirmDelete(false);
    setSelected(target);
    setDetail(undefined);
    void loadEntryDetail(target);
    pendingApply.current = { scroll: 0, selectors: [".crumb"] };
  };

  const backToOverview = () => {
    detailGeneration.current++;
    setError("");
    setConfirmDelete(false);
    setSelected(undefined);
    setDetail(undefined);
    setProjectView(undefined);
    pendingApply.current = {
      scroll: scrollMemory.current.overview,
      selectors: overviewFocusChain(),
    };
  };

  const backToParentList = (target: SelectedMemory) => {
    detailGeneration.current++;
    setError("");
    setConfirmDelete(false);
    setSelected(undefined);
    setDetail(undefined);
    if (target.scope === "other-project" && projectView?.key === target.key) {
      pendingApply.current = {
        scroll: scrollMemory.current.project,
        selectors: [focusMemory.current.project].filter((s) => s !== ""),
      };
    } else {
      pendingApply.current = {
        scroll: scrollMemory.current.overview,
        selectors: [focusMemory.current.overview, "[data-mem-scope] .slist-main"].filter(
          (s) => s !== "",
        ),
      };
    }
  };

  /** 删除成功后回到父列表并更新数量；焦点落到相邻条目，删空的项目子页落回页头（ADR-0122 §4） */
  const navigateAfterDelete = (target: SelectedMemory) => {
    const snapshot = dataRef.current;
    const before = snapshot !== undefined ? entriesOf(snapshot, target) : [];
    const index = before.findIndex((entry) => entry.name === target.name);
    const remaining = before.filter((entry) => entry.name !== target.name);
    const neighbor = index >= 0 ? (remaining[index] ?? remaining[index - 1]) : remaining[0];
    detailGeneration.current++;
    setConfirmDelete(false);
    setSelected(undefined);
    setDetail(undefined);

    if (target.scope === "other-project" && projectView?.key === target.key) {
      pendingApply.current = {
        scroll: scrollMemory.current.project,
        selectors: [
          neighbor !== undefined ? selectorFor({ ...target, name: neighbor.name }) : "",
          ".crumb",
        ].filter((s) => s !== ""),
      };
      return;
    }
    if (target.scope !== "other-project") {
      pendingApply.current = {
        scroll: scrollMemory.current.overview,
        selectors: [
          neighbor !== undefined ? selectorFor({ ...target, name: neighbor.name }) : "",
          "[data-mem-scope] .slist-main",
        ].filter((s) => s !== ""),
      };
    }
  };

  // 项目子页的可恢复焦点：返回总览时落回原项目行，删空的项目行消失则落到下一行，
  // 没有其他项目时回到「全局记忆」开关（ADR-0122 §4 空项目规则）
  const overviewFocusChain = () => {
    const chain: string[] = [];
    if (focusMemory.current.overview !== "") chain.push(focusMemory.current.overview);
    chain.push("[data-mem-key] .slist-main");
    chain.push('[role="switch"][aria-label="全局记忆"]');
    return chain;
  };

  const confirmDeleteMemory = async () => {
    if (!client || busy || selected === undefined) return;
    const target = selected;
    setBusy(true);
    setError("");
    try {
      await client.runtime.deleteMemory({
        scope: target.scope === "other-project" ? "project" : target.scope,
        ...(target.scope === "other-project" ? { key: target.key } : {}),
        ...(target.scope === "project" ? { workspaceRoot } : {}),
        name: target.name,
      });
      navigateAfterDelete(target);
      setToast(`已删除 ${target.name}`);
      await refresh();
    } catch (e) {
      // 失败时保留条目并允许重试：留在详情，错误在详情顶部显示（ADR-0122 §4）；
      // 不做整页刷新，避免错误被立即覆盖、条目仍未删的位置被误更新
      setConfirmDelete(false);
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const confirmClearOtherProject = async (target: OtherProjectMemory) => {
    if (!client || busy) return;
    setBusy(true);
    setError("");
    try {
      await client.runtime.clearMemory({ scope: "project", key: target.key });
      setConfirmClear(undefined);
      await refresh();
    } catch (e) {
      setConfirmClear(undefined);
      setError(errorMessage(e));
      void refresh();
    } finally {
      setBusy(false);
    }
  };

  const selectedLocation =
    selected !== undefined && data !== undefined ? metaOf(data, selected) : undefined;
  const inDetail = selected !== undefined && selectedLocation !== undefined;

  const activeProject =
    projectView !== undefined && data !== undefined
      ? data.otherProjects.find((p) => p.key === projectView.key)
      : undefined;

  const empty =
    data?.global.entries.length === 0 &&
    (data.project === undefined || data.project.entries.length === 0) &&
    data.otherProjects.length === 0;

  const crumbParentFor = (target: SelectedMemory): ReactNode => {
    if (target.scope !== "other-project") return "记忆";
    const proj = data?.otherProjects.find((p) => p.key === target.key);
    const path = proj?.path ?? projectView?.path ?? target.key;
    return (
      <span className="mono" title={path}>
        {path}
      </span>
    );
  };

  const deleteLocation = (target: SelectedMemory): { icon: "earth" | "folder"; text: string } => {
    if (target.scope === "global") return { icon: "earth", text: "全局" };
    if (target.scope === "project") return { icon: "folder", text: workspaceRoot ?? "" };
    const proj = data?.otherProjects.find((p) => p.key === target.key);
    return { icon: "folder", text: proj?.path ?? projectView?.path ?? target.key };
  };

  return (
    <div className="page3 memory-page" ref={rootRef}>
      <div className="spage" ref={spageRef}>
        <div className="readable">
          {inDetail && data !== undefined ? (
            <MemoryEntryDetail
              name={selected.name}
              dir={selectedLocation.dir}
              meta={selectedLocation.meta}
              detail={detail}
              busy={busy}
              disableDelete={busy || !client}
              error={error}
              crumbParent={crumbParentFor(selected)}
              onBack={() => {
                backToParentList(selected);
              }}
              onOpenDirectory={(dir) => void attempt(() => openDirectory(dir))}
              onRequestDelete={() => {
                setConfirmDelete(true);
              }}
              openUrl={openUrl}
            />
          ) : projectView !== undefined && data !== undefined ? (
            <>
              <PageHeader
                title={
                  <span className="mono" title={projectView.path}>
                    {projectView.path}
                  </span>
                }
                crumb={{
                  parent: "记忆",
                  onBack: backToOverview,
                }}
                extra={<span className="phead-count">{activeProject?.entries.length ?? 0} 条</span>}
                actions={
                  <IconButton
                    aria-label={isMacOS() ? "在访达中显示" : "在资源管理器中打开"}
                    title={isMacOS() ? "在访达中显示" : "在资源管理器中打开"}
                    onClick={() => {
                      void attempt(() =>
                        openDirectory(otherProjectDir(data.global.dir, projectView.key)),
                      );
                    }}
                  >
                    <Icon name="folder" size={ICON_MD} />
                  </IconButton>
                }
              />
              {error !== "" && (
                <div className="errt" role="alert">
                  {error}
                </div>
              )}
              <div className="sbody">
                {activeProject === undefined || activeProject.entries.length === 0 ? (
                  <EmptyState>没有记忆</EmptyState>
                ) : (
                  <section
                    className="group"
                    aria-label={`${projectView.path} · ${activeProject.entries.length}`}
                  >
                    {activeProject.entries.map((entry) => (
                      <MemoryEntryRow
                        key={entry.name}
                        entry={entry}
                        rowData={{ "data-mem-entry": entry.name, "data-mem-key": projectView.key }}
                        onOpen={() => {
                          openEntry({
                            scope: "other-project",
                            key: projectView.key,
                            name: entry.name,
                          });
                        }}
                      />
                    ))}
                  </section>
                )}
              </div>
            </>
          ) : (
            <>
              <PageHeader title="记忆" />
              {error && (
                <div className="errt" role="alert">
                  {error}
                </div>
              )}
              {data !== undefined && (
                <div className="sbody">
                  <SettingsGroup>
                    <SettingsRow label="全局记忆">
                      <Switch
                        checked={data.global.enabled}
                        aria-label="全局记忆"
                        disabled={busy || !client}
                        onChange={(next) => {
                          void toggleScope("global", next);
                        }}
                      />
                    </SettingsRow>
                    {data.project !== undefined && (
                      <SettingsRow label="项目记忆">
                        <Switch
                          checked={data.project.enabled}
                          aria-label="项目记忆"
                          disabled={busy || !client}
                          onChange={(next) => {
                            void toggleScope("project", next);
                          }}
                        />
                      </SettingsRow>
                    )}
                  </SettingsGroup>
                  {empty ? (
                    <div>
                      <EmptyState>没有记忆</EmptyState>
                      <MemoryWarnings
                        warnings={[...data.global.warnings, ...(data.project?.warnings ?? [])]}
                      />
                    </div>
                  ) : (
                    <>
                      <MemoryScopeGroup
                        title="全局"
                        scope="global"
                        overview={data.global}
                        onOpenDirectory={(dir) => void attempt(() => openDirectory(dir))}
                        onOpenEntry={(meta) => {
                          openEntry({ scope: "global", name: meta.name });
                        }}
                      />
                      {data.project !== undefined && (
                        <MemoryScopeGroup
                          title="项目"
                          scope="project"
                          overview={data.project}
                          onOpenDirectory={(dir) => void attempt(() => openDirectory(dir))}
                          onOpenEntry={(meta) => {
                            openEntry({ scope: "project", name: meta.name });
                          }}
                        />
                      )}
                      {data.otherProjects.length > 0 && (
                        <SettingsGroup title="其他项目" count={data.otherProjects.length} plain>
                          {data.otherProjects.map((proj) => (
                            <SettingsListRow
                              key={proj.key}
                              rowData={{ "data-mem-key": proj.key }}
                              name={pathBasename(proj.path)}
                              description={proj.path}
                              descriptionMono
                              title={proj.path}
                              status={
                                <span className="memory-other-status">
                                  <span className="memory-other-count">
                                    {proj.entries.length} 条
                                  </span>
                                  <Button
                                    size="sm"
                                    disabled={busy || !client}
                                    onClick={() => {
                                      setConfirmClear(proj);
                                    }}
                                  >
                                    清空
                                  </Button>
                                </span>
                              }
                              onOpen={() => {
                                openProject(proj);
                              }}
                            />
                          ))}
                        </SettingsGroup>
                      )}
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {toast && (
        <div className="toast3" role="status">
          ✓ {toast}
        </div>
      )}
      {confirmDelete && selected !== undefined && (
        <MemoryDeleteDialog
          name={selected.name}
          location={deleteLocation(selected)}
          busy={busy}
          onClose={() => {
            if (!busy) setConfirmDelete(false);
          }}
          onConfirm={() => {
            void confirmDeleteMemory();
          }}
        />
      )}
      {confirmClear !== undefined && (
        <Scrim
          onClose={() => {
            if (!busy) setConfirmClear(undefined);
          }}
        >
          <div
            className="dlg narrow"
            role="dialog"
            aria-label={`清空 ${confirmClear.path} 的记忆？`}
          >
            <div className="dh3">
              <b>清空 {confirmClear.path} 的记忆？</b>
            </div>
            <div className="df">
              <span className="sp" />
              <Button
                autoFocus
                disabled={busy}
                onClick={() => {
                  setConfirmClear(undefined);
                }}
              >
                取消
              </Button>
              <Button
                variant="danger-solid"
                disabled={busy}
                onClick={() => {
                  void confirmClearOtherProject(confirmClear);
                }}
              >
                清空
              </Button>
            </div>
          </div>
        </Scrim>
      )}
    </div>
  );
}

function MemoryScopeGroup({
  title,
  scope,
  overview,
  onOpenDirectory,
  onOpenEntry,
}: {
  title: string;
  scope: "global" | "project";
  overview: MemoryScopeOverview;
  onOpenDirectory: (dir: string) => void;
  onOpenEntry: (entry: MemoryEntryMeta) => void;
}) {
  return (
    <SettingsGroup
      title={title}
      count={overview.entries.length}
      plain
      action={
        <IconButton
          size="sm"
          aria-label={isMacOS() ? "在访达中显示" : "在资源管理器中打开"}
          title={isMacOS() ? "在访达中显示" : "在资源管理器中打开"}
          onClick={() => {
            onOpenDirectory(overview.dir);
          }}
        >
          <Icon name="folder" size={ICON_SM} />
        </IconButton>
      }
    >
      {overview.entries.map((entry) => (
        <MemoryEntryRow
          key={`${scope}-${entry.name}`}
          entry={entry}
          disabled={!overview.enabled}
          rowData={{ "data-mem-entry": entry.name, "data-mem-scope": scope }}
          onOpen={() => {
            onOpenEntry(entry);
          }}
        />
      ))}
      <MemoryWarnings warnings={overview.warnings} />
    </SettingsGroup>
  );
}

export function MemoryEntryRow({
  entry,
  disabled = false,
  rowData,
  onOpen,
}: {
  entry: MemoryEntryMeta;
  disabled?: boolean | undefined;
  rowData?: Record<`data-${string}`, string> | undefined;
  onOpen: () => void;
}) {
  return (
    <SettingsListRow
      name={entry.name}
      mono
      description={entry.description}
      status={MEMORY_TYPE_LABEL[entry.type]}
      disabled={disabled}
      onOpen={onOpen}
      rowData={rowData}
    />
  );
}

export function MemoryEntryDetail({
  name,
  dir,
  meta,
  detail,
  disableDelete,
  error,
  crumbParent,
  onBack,
  onOpenDirectory,
  onRequestDelete,
  openUrl,
}: {
  name: string;
  dir: string;
  meta: MemoryEntryMeta;
  detail: MemoryEntry | undefined;
  busy?: boolean | undefined;
  disableDelete?: boolean | undefined;
  error?: string | undefined;
  /** 面包屑父级内容；缺省为「记忆」 */
  crumbParent?: ReactNode | undefined;
  onBack: () => void;
  onOpenDirectory?: ((path: string) => void) | undefined;
  onRequestDelete: () => void;
  openUrl: (url: string) => void;
}) {
  return (
    <>
      <PageHeader
        title={<span className="memory-detail-title">{name}</span>}
        crumb={{
          parent: crumbParent ?? "记忆",
          onBack,
        }}
        actions={
          <>
            {onOpenDirectory !== undefined && (
              <IconButton
                aria-label={isMacOS() ? "在访达中显示" : "在资源管理器中打开"}
                title={isMacOS() ? "在访达中显示" : "在资源管理器中打开"}
                onClick={() => {
                  onOpenDirectory(dir);
                }}
              >
                <Icon name="folder" size={ICON_MD} />
              </IconButton>
            )}
            <Button variant="danger" disabled={disableDelete} onClick={onRequestDelete}>
              删除
            </Button>
          </>
        }
      />
      {error !== undefined && error !== "" && (
        <div className="errt" role="alert">
          {error}
        </div>
      )}
      <div className="sbody">
        <SettingsGroup title="概况" plain>
          <SettingsRow label="类型">{MEMORY_TYPE_LABEL[detail?.type ?? meta.type]}</SettingsRow>
          <SettingsRow label="位置">
            <code>{memoryFilePath(dir, name)}</code>
          </SettingsRow>
          <SettingsRow label="更新时间">
            {formatUpdatedAt(detail?.updatedAt ?? meta.updatedAt)}
          </SettingsRow>
        </SettingsGroup>
        {detail !== undefined && (
          <div className="memory-content">
            <Markdown text={detail.content} openUrl={openUrl} />
          </div>
        )}
      </div>
    </>
  );
}

export function MemoryDeleteDialog({
  name,
  location,
  busy,
  onClose,
  onConfirm,
}: {
  name: string;
  /** 目标所在位置（ADR-0122 §4）：项目记忆显示 folder + 项目路径，全局显示 earth + 「全局」；缺省不显示 */
  location?: { icon: "earth" | "folder"; text: string } | undefined;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const isProject = location?.icon === "folder";
  return (
    <Scrim onClose={onClose}>
      <div
        className="dlg narrow"
        role="dialog"
        aria-label={isProject ? `删除 ${name}（${location.text}）？` : `删除 ${name}？`}
      >
        <div className="dh3">
          <b>
            删除 <span className="mono">{name}</span>？
          </b>
        </div>
        {location !== undefined && (
          <div className="db">
            <div className="del-proj">
              <Icon name={location.icon} size={ICON_SM} />
              <code>{location.text}</code>
            </div>
          </div>
        )}
        <div className="df">
          <span className="sp" />
          <Button autoFocus disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button variant="danger-solid" disabled={busy} onClick={onConfirm}>
            删除
          </Button>
        </div>
      </div>
    </Scrim>
  );
}

export function MemoryWarnings({ warnings }: { warnings: readonly string[] }) {
  return warnings.length ? (
    <details className="memory-warnings">
      <summary>
        <Icon name="right_small" size={ICON_SM} className="fold-arrow" />
        {warnings.length} 条警告，查看
      </summary>
      {warnings.map((w, i) => (
        <div key={`${i}-${w}`}>{w}</div>
      ))}
    </details>
  ) : null;
}
