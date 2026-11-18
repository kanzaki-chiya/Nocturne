import { useCallback, useEffect, useRef, useState } from "react";
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

const MEMORY_TYPE_LABEL: Record<MemoryType, string> = {
  user: "用户",
  feedback: "反馈",
  project: "项目",
  reference: "参考",
};

interface SelectedMemory {
  scope: "global" | "project";
  name: string;
}

function memoryFilePath(dir: string, name: string): string {
  const trimmed = dir.replace(/[\\/]+$/, "");
  const sep = dir.includes("\\") ? "\\" : "/";
  return `${trimmed}${sep}${name}.md`;
}

function formatUpdatedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("zh-CN", { hour12: false });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  const [selected, setSelected] = useState<SelectedMemory>();
  const [detail, setDetail] = useState<MemoryEntry>();
  const [otherOpen, setOtherOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmClear, setConfirmClear] = useState<OtherProjectMemory>();
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState(false);

  const refreshGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const selectedRef = useRef<SelectedMemory | undefined>(undefined);
  selectedRef.current = selected;
  const confirmClearRef = useRef<OtherProjectMemory | undefined>(undefined);
  confirmClearRef.current = confirmClear;

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
          scope: target.scope,
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
        const overview = current.scope === "global" ? result.global : result.project;
        if (overview?.entries.some((entry) => entry.name === current.name)) {
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

  const openEntry = (scope: "global" | "project", meta: MemoryEntryMeta) => {
    const target: SelectedMemory = { scope, name: meta.name };
    setError("");
    setConfirmDelete(false);
    setSelected(target);
    setDetail(undefined);
    void loadEntryDetail(target);
  };

  const leaveDetail = () => {
    detailGeneration.current++;
    setError("");
    setConfirmDelete(false);
    setSelected(undefined);
    setDetail(undefined);
  };

  const confirmDeleteMemory = async () => {
    if (!client || busy || selected === undefined) return;
    const target = selected;
    setBusy(true);
    setError("");
    try {
      await client.runtime.deleteMemory({
        scope: target.scope,
        ...(target.scope === "project" ? { workspaceRoot } : {}),
        name: target.name,
      });
      detailGeneration.current++;
      setConfirmDelete(false);
      setSelected(undefined);
      setDetail(undefined);
      setToast(`已删除 ${target.name}`);
      await refresh();
    } catch (e) {
      setConfirmDelete(false);
      setError(errorMessage(e));
      void refresh();
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

  const selectedOverview =
    selected === undefined || data === undefined
      ? undefined
      : selected.scope === "global"
        ? data.global
        : data.project;
  const selectedMeta =
    selected !== undefined && selectedOverview !== undefined
      ? selectedOverview.entries.find((entry) => entry.name === selected.name)
      : undefined;
  const inDetail =
    selected !== undefined && selectedOverview !== undefined && selectedMeta !== undefined;

  const empty =
    data?.global.entries.length === 0 &&
    (data.project === undefined || data.project.entries.length === 0) &&
    data.otherProjects.length === 0;

  return (
    <div className="page3 memory-page">
      <div className="spage">
        <div className="readable">
          {inDetail ? (
            <>
              <PageHeader
                title={<span className="memory-detail-title">{selected.name}</span>}
                crumb={{
                  parent: "记忆",
                  onBack: leaveDetail,
                }}
                actions={
                  <>
                    <IconButton
                      aria-label="在资源管理器中打开"
                      title="在资源管理器中打开"
                      onClick={() => void attempt(() => openDirectory(selectedOverview.dir))}
                    >
                      <Icon name="folder" size={ICON_MD} />
                    </IconButton>
                    <Button
                      variant="danger"
                      disabled={busy || !client}
                      onClick={() => {
                        setConfirmDelete(true);
                      }}
                    >
                      删除
                    </Button>
                  </>
                }
              />
              {error && (
                <div className="errt" role="alert">
                  {error}
                </div>
              )}
              <div className="sbody">
                <SettingsGroup title="概况" plain>
                  <SettingsRow label="类型">
                    {MEMORY_TYPE_LABEL[detail?.type ?? selectedMeta.type]}
                  </SettingsRow>
                  <SettingsRow label="位置">
                    <code>{memoryFilePath(selectedOverview.dir, selected.name)}</code>
                  </SettingsRow>
                  <SettingsRow label="更新时间">
                    {formatUpdatedAt(detail?.updatedAt ?? selectedMeta.updatedAt)}
                  </SettingsRow>
                </SettingsGroup>
                {detail !== undefined && (
                  <div className="memory-content">
                    <Markdown text={detail.content} openUrl={openUrl} />
                  </div>
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
                          openEntry("global", meta);
                        }}
                      />
                      {data.project !== undefined && (
                        <MemoryScopeGroup
                          title="项目"
                          scope="project"
                          overview={data.project}
                          onOpenDirectory={(dir) => void attempt(() => openDirectory(dir))}
                          onOpenEntry={(meta) => {
                            openEntry("project", meta);
                          }}
                        />
                      )}
                      {data.otherProjects.length > 0 && (
                        <section
                          className="group"
                          aria-label={`其他项目 · ${data.otherProjects.length}`}
                        >
                          <div className="ghead">
                            <h2>
                              <button
                                type="button"
                                className="memory-fold-toggle"
                                aria-expanded={otherOpen}
                                onClick={() => {
                                  setOtherOpen((open) => !open);
                                }}
                              >
                                <Icon
                                  name="right_small"
                                  size={ICON_SM}
                                  className={`fold-arrow${otherOpen ? " down" : ""}`}
                                />
                                <span>其他项目</span>
                                <span className="count"> · {data.otherProjects.length}</span>
                              </button>
                            </h2>
                          </div>
                          {otherOpen &&
                            data.otherProjects.map((proj) => (
                              <SettingsRow
                                key={proj.key}
                                label={
                                  <code className="memory-other-path" title={proj.path}>
                                    {proj.path}
                                  </code>
                                }
                              >
                                <span className="memory-other-count">{proj.count} 条</span>
                                <Button
                                  size="sm"
                                  disabled={busy || !client}
                                  onClick={() => {
                                    setConfirmClear(proj);
                                  }}
                                >
                                  清空
                                </Button>
                              </SettingsRow>
                            ))}
                        </section>
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
        <Scrim
          onClose={() => {
            if (!busy) setConfirmDelete(false);
          }}
        >
          <div className="dlg narrow" role="dialog" aria-label={`删除 ${selected.name}？`}>
            <div className="dh3">
              <b>删除 {selected.name}？</b>
            </div>
            <div className="df">
              <span className="sp" />
              <Button
                autoFocus
                disabled={busy}
                onClick={() => {
                  setConfirmDelete(false);
                }}
              >
                取消
              </Button>
              <Button
                variant="danger-solid"
                disabled={busy}
                onClick={() => {
                  void confirmDeleteMemory();
                }}
              >
                删除
              </Button>
            </div>
          </div>
        </Scrim>
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
          aria-label="在资源管理器中打开"
          title="在资源管理器中打开"
          onClick={() => {
            onOpenDirectory(overview.dir);
          }}
        >
          <Icon name="folder" size={ICON_SM} />
        </IconButton>
      }
    >
      {overview.entries.map((entry) => (
        <SettingsListRow
          key={`${scope}-${entry.name}`}
          name={entry.name}
          mono
          description={entry.description}
          status={MEMORY_TYPE_LABEL[entry.type]}
          disabled={!overview.enabled}
          onOpen={() => {
            onOpenEntry(entry);
          }}
        />
      ))}
      <MemoryWarnings warnings={overview.warnings} />
    </SettingsGroup>
  );
}

function MemoryWarnings({ warnings }: { warnings: readonly string[] }) {
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
