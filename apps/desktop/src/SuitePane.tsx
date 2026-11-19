import { useCallback, useEffect, useRef, useState } from "react";
import type {
  MemoryDescription,
  MemoryEntry,
  MemoryEntryMeta,
  SuiteRecord,
  SuiteThreadView,
  SuiteView,
  UpdateSuiteInput,
} from "@nocturne/core/protocol";
import type { RpcClient, RpcSession } from "@nocturne/rpc/client";

import {
  MemoryDeleteDialog,
  MemoryEntryDetail,
  MemoryEntryRow,
  MemoryWarnings,
} from "./MemoryPage";
import { Menu, MenuItem } from "./Menu";
import {
  groupSuiteThreads,
  suiteThreadDot,
  suiteThreadModelLabel,
  suiteThreadSecondary,
} from "./suite-ui";
import { Button, EmptyState, ICON_SM, Icon, SegmentedControl } from "./ui";
import "./ensemble-panel.css";
import "./pages.css";
import "./memory.css";
import "./suite-panel.css";

type SuitePanelTab = "overview" | "memory" | "instructions";

interface OpenThreadMenu {
  anchor: HTMLElement;
  thread: SuiteThreadView;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface SuitePaneProps {
  suiteId: string;
  suiteRecord: SuiteRecord | undefined;
  suiteView: SuiteView | undefined;
  session: Pick<RpcSession, "resolveThread">;
  client: RpcClient | undefined;
  openUrl: (url: string) => void;
  openDirectory?: ((path: string) => Promise<void>) | undefined;
  onOpenThread: (thread: SuiteThreadView) => void;
  onUpdateSuite: (input: UpdateSuiteInput) => Promise<SuiteRecord>;
  version?: number | undefined;
}

export function SuitePane({
  suiteId,
  suiteRecord,
  suiteView,
  session,
  client,
  openUrl,
  openDirectory,
  onOpenThread,
  onUpdateSuite,
  version = 0,
}: SuitePaneProps) {
  const [tab, setTab] = useState<SuitePanelTab>("overview");
  const [resolvedOpen, setResolvedOpen] = useState(false);
  const [menu, setMenu] = useState<OpenThreadMenu | null>(null);
  const [actionError, setActionError] = useState("");

  // ── 记忆标签状态 ──
  const [memoryData, setMemoryData] = useState<MemoryDescription>();
  const [selectedName, setSelectedName] = useState<string>();
  const [detail, setDetail] = useState<MemoryEntry>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [memoryError, setMemoryError] = useState("");
  const [toast, setToast] = useState("");
  const [memoryBusy, setMemoryBusy] = useState(false);
  const memoryRefreshGen = useRef(0);
  const memoryDetailGen = useRef(0);
  const selectedNameRef = useRef<string | undefined>(undefined);
  selectedNameRef.current = selectedName;

  // ── 说明标签状态 ──
  const savedInstructions = suiteRecord?.instructions ?? "";
  const [instructionsDraft, setInstructionsDraft] = useState(savedInstructions);
  const [savingInstructions, setSavingInstructions] = useState(false);
  const [saveError, setSaveError] = useState("");
  const prevSavedRef = useRef({ suiteId, saved: savedInstructions });

  useEffect(() => {
    const prev = prevSavedRef.current;
    if (prev.suiteId !== suiteId) {
      prevSavedRef.current = { suiteId, saved: savedInstructions };
      setInstructionsDraft(savedInstructions);
      setSaveError("");
      setSelectedName(undefined);
      setDetail(undefined);
      setConfirmDelete(false);
      setMemoryError("");
      return;
    }
    if (prev.saved !== savedInstructions) {
      setInstructionsDraft((cur) => (cur === prev.saved ? savedInstructions : cur));
      prevSavedRef.current = { suiteId, saved: savedInstructions };
    }
  }, [suiteId, savedInstructions]);

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
    async (name: string) => {
      if (!client || suiteId === "") return;
      const generation = ++memoryDetailGen.current;
      try {
        const entry = await client.runtime.readMemory({
          scope: "suite",
          key: suiteId,
          name,
        });
        if (generation !== memoryDetailGen.current) return;
        setDetail(entry);
        setMemoryError("");
      } catch (cause) {
        if (generation === memoryDetailGen.current) {
          setMemoryError(errorMessage(cause));
        }
      }
    },
    [client, suiteId],
  );

  const refreshMemory = useCallback(async () => {
    if (!client || suiteId === "") return;
    const generation = ++memoryRefreshGen.current;
    try {
      const result = await client.runtime.describeMemory({ suiteId });
      if (generation !== memoryRefreshGen.current) return;
      setMemoryData(result);
      setMemoryError("");

      const currentName = selectedNameRef.current;
      if (currentName !== undefined) {
        if (result.suite?.entries.some((entry) => entry.name === currentName)) {
          void loadEntryDetail(currentName);
        } else {
          memoryDetailGen.current += 1;
          setSelectedName(undefined);
          setDetail(undefined);
          setConfirmDelete(false);
        }
      }
    } catch (cause) {
      if (generation === memoryRefreshGen.current) {
        setMemoryError(errorMessage(cause));
      }
    }
  }, [client, suiteId, loadEntryDetail]);

  useEffect(() => {
    if (tab !== "memory") return;
    void refreshMemory();
    const offProviders = client?.onProvidersChanged(() => {
      void refreshMemory();
    });
    const offSettings = client?.onSettingsChanged(() => {
      void refreshMemory();
    });
    return () => {
      memoryRefreshGen.current += 1;
      memoryDetailGen.current += 1;
      offProviders?.();
      offSettings?.();
    };
  }, [tab, client, refreshMemory, version]);

  const resolveThread = (threadId: string, reopen: boolean) => {
    setMenu(null);
    setActionError("");
    void session
      .resolveThread({ thread: threadId, ...(reopen ? { reopen: true } : {}) })
      .catch((cause: unknown) => {
        setActionError(errorMessage(cause));
      });
  };

  const openEntry = (meta: MemoryEntryMeta) => {
    setMemoryError("");
    setConfirmDelete(false);
    setSelectedName(meta.name);
    setDetail(undefined);
    void loadEntryDetail(meta.name);
  };

  const leaveDetail = () => {
    memoryDetailGen.current += 1;
    setMemoryError("");
    setConfirmDelete(false);
    setSelectedName(undefined);
    setDetail(undefined);
  };

  const confirmDeleteMemory = async () => {
    if (!client || memoryBusy || selectedName === undefined || suiteId === "") return;
    const targetName = selectedName;
    setMemoryBusy(true);
    setMemoryError("");
    try {
      await client.runtime.deleteMemory({
        scope: "suite",
        key: suiteId,
        name: targetName,
      });
      memoryDetailGen.current += 1;
      setConfirmDelete(false);
      setSelectedName(undefined);
      setDetail(undefined);
      setToast(`已删除 ${targetName}`);
      await refreshMemory();
    } catch (cause) {
      setConfirmDelete(false);
      setMemoryError(errorMessage(cause));
      void refreshMemory();
    } finally {
      setMemoryBusy(false);
    }
  };

  const saveInstructions = async () => {
    if (suiteRecord === undefined || savingInstructions) return;
    setSavingInstructions(true);
    setSaveError("");
    try {
      await onUpdateSuite({ id: suiteRecord.id, instructions: instructionsDraft });
    } catch (cause) {
      setSaveError(errorMessage(cause));
    } finally {
      setSavingInstructions(false);
    }
  };

  const groups = groupSuiteThreads(suiteView?.threads ?? []);
  const suiteMemory = memoryData?.suite;
  const selectedMeta =
    selectedName !== undefined && suiteMemory !== undefined
      ? suiteMemory.entries.find((entry) => entry.name === selectedName)
      : undefined;
  const inMemoryDetail =
    selectedName !== undefined && suiteMemory !== undefined && selectedMeta !== undefined;
  const instructionsDirty = suiteRecord !== undefined && instructionsDraft !== savedInstructions;

  return (
    <div className="suite-pane">
      <div className="suite-subbar">
        <SegmentedControl
          size="sm"
          role="tablist"
          aria-label="组曲"
          value={tab}
          options={[
            { value: "overview", label: "总览" },
            { value: "memory", label: "记忆" },
            { value: "instructions", label: "说明" },
          ]}
          onChange={setTab}
        />
      </div>

      {actionError !== "" && tab === "overview" && (
        <div className="suite-error" role="alert">
          {actionError}
        </div>
      )}

      {tab === "overview" && (
        <div className="suite-overview" role="tabpanel" aria-label="总览">
          {groups.map((group) => {
            if (group.threads.length === 0) return null;
            const isResolved = group.key === "resolved";
            return (
              <div
                key={group.key}
                className="suite-group"
                role="group"
                aria-label={`${group.label} ${group.threads.length}`}
              >
                {isResolved ? (
                  <button
                    type="button"
                    className="suite-group-toggle"
                    aria-expanded={resolvedOpen}
                    onClick={() => {
                      setResolvedOpen((open) => !open);
                    }}
                  >
                    <span>{group.label}</span>
                    <span className="suite-group-count">{group.threads.length}</span>
                    <Icon
                      name="right_small"
                      size={ICON_SM}
                      className={`fold-arrow${resolvedOpen ? " down" : ""}`}
                    />
                  </button>
                ) : (
                  <div className="suite-group-head">
                    <span>{group.label}</span>
                    <span className="suite-group-count">{group.threads.length}</span>
                  </div>
                )}
                {(!isResolved || resolvedOpen) &&
                  group.threads.map((thread) => {
                    const secondary = suiteThreadSecondary(thread);
                    return (
                      <button
                        key={thread.threadId}
                        type="button"
                        className={`suite-thread-row${
                          group.key === "needs_attention" ? " hot" : ""
                        }${isResolved ? " dim" : ""}`}
                        onClick={() => {
                          onOpenThread(thread);
                        }}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          setActionError("");
                          setMenu({ anchor: event.currentTarget, thread });
                        }}
                      >
                        <span
                          className={`ensemble-dot suite-dot ${suiteThreadDot(thread)}`}
                          aria-hidden="true"
                        />
                        <span className="suite-thread-title">{thread.title}</span>
                        <span className="suite-thread-model">{suiteThreadModelLabel(thread)}</span>
                        {secondary.text !== "" && (
                          <span className={`suite-thread-sub${secondary.warn ? " warn" : ""}`}>
                            {secondary.text}
                          </span>
                        )}
                      </button>
                    );
                  })}
              </div>
            );
          })}
        </div>
      )}

      {tab === "memory" && (
        <div className="suite-memory page3 memory-page" role="tabpanel" aria-label="记忆">
          {inMemoryDetail ? (
            <MemoryEntryDetail
              name={selectedName}
              dir={suiteMemory.dir}
              meta={selectedMeta}
              detail={detail}
              busy={memoryBusy}
              disableDelete={memoryBusy || !client}
              error={memoryError}
              onBack={leaveDetail}
              onOpenDirectory={
                openDirectory !== undefined
                  ? (dir) => {
                      void openDirectory(dir).catch((cause: unknown) => {
                        setMemoryError(errorMessage(cause));
                      });
                    }
                  : undefined
              }
              onRequestDelete={() => {
                setConfirmDelete(true);
              }}
              openUrl={openUrl}
            />
          ) : (
            <>
              {memoryError !== "" && (
                <div className="errt" role="alert">
                  {memoryError}
                </div>
              )}
              {memoryData !== undefined &&
                (suiteMemory === undefined || suiteMemory.entries.length === 0 ? (
                  <div>
                    <EmptyState>没有记忆</EmptyState>
                    <MemoryWarnings warnings={suiteMemory?.warnings ?? []} />
                  </div>
                ) : (
                  <div>
                    {suiteMemory.entries.map((entry) => (
                      <MemoryEntryRow
                        key={entry.name}
                        entry={entry}
                        disabled={!suiteMemory.enabled}
                        onOpen={() => {
                          openEntry(entry);
                        }}
                      />
                    ))}
                    <MemoryWarnings warnings={suiteMemory.warnings} />
                  </div>
                ))}
            </>
          )}
          {toast !== "" && (
            <div className="toast3" role="status">
              ✓ {toast}
            </div>
          )}
          {confirmDelete && selectedName !== undefined && (
            <MemoryDeleteDialog
              name={selectedName}
              busy={memoryBusy}
              onClose={() => {
                if (!memoryBusy) setConfirmDelete(false);
              }}
              onConfirm={() => {
                void confirmDeleteMemory();
              }}
            />
          )}
        </div>
      )}

      {tab === "instructions" && (
        <div className="suite-doc" role="tabpanel" aria-label="说明">
          <textarea
            className="suite-doc-input"
            aria-label="说明"
            spellCheck={false}
            value={instructionsDraft}
            disabled={savingInstructions || suiteRecord === undefined}
            onChange={(event) => {
              setInstructionsDraft(event.target.value);
            }}
          />
          {saveError !== "" && (
            <div className="suite-doc-error" role="alert">
              {saveError}
            </div>
          )}
          <div className="suite-doc-acts">
            <Button
              disabled={!instructionsDirty || savingInstructions}
              onClick={() => {
                setSaveError("");
                setInstructionsDraft(savedInstructions);
              }}
            >
              取消
            </Button>
            <Button
              variant="primary"
              disabled={!instructionsDirty || savingInstructions}
              onClick={() => {
                void saveInstructions();
              }}
            >
              保存
            </Button>
          </div>
        </div>
      )}

      {menu !== null && (
        <Menu
          anchor={menu.anchor}
          onClose={() => {
            setMenu(null);
          }}
        >
          <MenuItem
            label={menu.thread.resolved ? "重开" : "完成"}
            onSelect={() => {
              resolveThread(menu.thread.threadId, menu.thread.resolved);
            }}
          />
        </Menu>
      )}
    </div>
  );
}
