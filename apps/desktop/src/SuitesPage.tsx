import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SuiteRecord } from "@nocturne/core/protocol";
import type { RpcClient } from "@nocturne/rpc/client";

import { Dropdown } from "./Dropdown";
import { Menu, MenuItem, MenuSeparator } from "./Menu";
import { ConfirmDialog, Scrim } from "./ProvidersPage";
import { projectName } from "./session-tree";
import {
  Button,
  EmptyState,
  Field,
  ICON_SM,
  Icon,
  IconButton,
  PageHeader,
  SettingsGroup,
  SettingsListRow,
} from "./ui";
import "./pages.css";
import "./suites.css";

export interface SuiteWorkspaceOption {
  path: string;
  label: string;
}

export interface SuitesPageProps {
  client: RpcClient | undefined;
  workspaces: readonly SuiteWorkspaceOption[];
  version?: number | undefined;
  needsAttentionBySuite?: ReadonlyMap<string, number> | undefined;
  readOnly?: boolean | undefined;
  onOpenSuite: (id: string) => void;
  onChanged?: () => void;
  onLoaded?: ((suites: SuiteRecord[]) => void) | undefined;
}

interface SuiteDraft {
  name: string;
  goal: string;
  workspace: string;
  instructions: string;
}

type DialogState =
  { mode: "create"; draft: SuiteDraft } | { mode: "edit"; suite: SuiteRecord; draft: SuiteDraft };

interface OpenRowMenu {
  anchor: HTMLElement;
  suite: SuiteRecord;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function SuitesPage({
  client,
  workspaces,
  version = 0,
  needsAttentionBySuite,
  readOnly = false,
  onOpenSuite,
  onChanged,
  onLoaded,
}: SuitesPageProps) {
  const [suites, setSuites] = useState<SuiteRecord[]>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<DialogState>();
  const [dialogError, setDialogError] = useState("");
  const [menu, setMenu] = useState<OpenRowMenu | null>(null);
  const [confirmArchive, setConfirmArchive] = useState<SuiteRecord>();
  const refreshGeneration = useRef(0);
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;

  const refresh = useCallback(async () => {
    if (!client) return;
    const generation = ++refreshGeneration.current;
    try {
      const list = await client.runtime.listSuites();
      if (generation !== refreshGeneration.current) return;
      onLoadedRef.current?.(list);
      setSuites(list);
      setError("");
    } catch (cause) {
      if (generation === refreshGeneration.current) {
        setError(errorMessage(cause));
      }
    }
  }, [client]);

  useEffect(() => {
    void refresh();
    return () => {
      refreshGeneration.current += 1;
    };
  }, [refresh, version]);

  const workspaceChoices = useMemo(() => {
    const choices = [...workspaces];
    if (dialog?.mode === "edit") {
      const current = dialog.suite.workspaces[0];
      if (current !== undefined && !choices.some((item) => item.path === current)) {
        choices.push({ path: current, label: projectName(current) });
      }
    }
    return choices;
  }, [workspaces, dialog]);

  const openCreate = () => {
    setDialogError("");
    setDialog({
      mode: "create",
      draft: {
        name: "",
        goal: "",
        workspace: workspaces[0]?.path ?? "",
        instructions: "",
      },
    });
  };

  const openEdit = (suite: SuiteRecord) => {
    setDialogError("");
    setDialog({
      mode: "edit",
      suite,
      draft: {
        name: suite.name,
        goal: suite.goal ?? "",
        workspace: suite.workspaces[0] ?? workspaces[0]?.path ?? "",
        instructions: suite.instructions,
      },
    });
  };

  const submitDialog = async () => {
    if (!client || !dialog || busy) return;
    const trimmedName = dialog.draft.name.trim();
    if (trimmedName === "" || dialog.draft.workspace === "") return;
    setBusy(true);
    setDialogError("");
    try {
      if (dialog.mode === "create") {
        await client.runtime.createSuite({
          name: trimmedName,
          ...(dialog.draft.goal.trim() !== "" ? { goal: dialog.draft.goal.trim() } : {}),
          workspaces: [dialog.draft.workspace],
          instructions: dialog.draft.instructions,
        });
      } else {
        const rest = dialog.suite.workspaces.slice(1).filter((ws) => ws !== dialog.draft.workspace);
        await client.runtime.updateSuite({
          id: dialog.suite.id,
          name: trimmedName,
          goal: dialog.draft.goal.trim() === "" ? null : dialog.draft.goal.trim(),
          workspaces: [dialog.draft.workspace, ...rest],
          instructions: dialog.draft.instructions,
        });
      }
      setDialog(undefined);
      await refresh();
      onChanged?.();
    } catch (cause) {
      setDialogError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const archiveSuite = async (suite: SuiteRecord) => {
    if (!client) return;
    setError("");
    try {
      await client.runtime.archiveSuite(suite.id);
      setConfirmArchive(undefined);
      await refresh();
      onChanged?.();
    } catch (cause) {
      setConfirmArchive(undefined);
      setError(errorMessage(cause));
    }
  };

  return (
    <section className="page3 suites-page" aria-label="组曲" aria-busy={busy}>
      <div className="spage">
        <div className="readable">
          {!readOnly && (
            <PageHeader
              title="组曲"
              actions={
                <Button variant="primary" size="sm" disabled={!client || busy} onClick={openCreate}>
                  <Icon name="add" size={ICON_SM} />
                  新建
                </Button>
              }
            />
          )}
          {error !== "" && (
            <div className="errt" role="alert">
              {error}
            </div>
          )}
          {suites?.length === 0 ? (
            readOnly ? null : (
              <EmptyState
                action={
                  <Button variant="primary" disabled={!client || busy} onClick={openCreate}>
                    <Icon name="add" size={ICON_SM} />
                    新建
                  </Button>
                }
              />
            )
          ) : (
            suites !== undefined && (
              <div className="sbody">
                <SettingsGroup plain>
                  {suites.map((suite) => {
                    const attention = needsAttentionBySuite?.get(suite.id) ?? 0;
                    return (
                      <SettingsListRow
                        key={suite.id}
                        name={suite.name}
                        description={suite.goal}
                        status={
                          attention > 0 ? (
                            <span className="suites-attn">
                              <span className="suites-attn-dot" aria-hidden="true" />
                              {attention}
                            </span>
                          ) : undefined
                        }
                        toggle={
                          readOnly ? undefined : (
                            <IconButton
                              size="sm"
                              aria-label={`${suite.name} 操作`}
                              onClick={(event) => {
                                event.stopPropagation();
                                setMenu({ anchor: event.currentTarget, suite });
                              }}
                            >
                              <Icon name="more" size={ICON_SM} />
                            </IconButton>
                          )
                        }
                        onOpen={() => {
                          onOpenSuite(suite.id);
                        }}
                        onContextMenu={
                          readOnly
                            ? undefined
                            : (event) => {
                                event.preventDefault();
                                setMenu({ anchor: event.currentTarget, suite });
                              }
                        }
                      />
                    );
                  })}
                </SettingsGroup>
              </div>
            )
          )}
        </div>
      </div>

      {!readOnly && menu !== null && (
        <Menu
          anchor={menu.anchor}
          align="right"
          onClose={() => {
            setMenu(null);
          }}
        >
          <MenuItem
            label="编辑"
            onSelect={() => {
              const target = menu.suite;
              setMenu(null);
              openEdit(target);
            }}
          />
          <MenuSeparator />
          <MenuItem
            label="归档"
            danger
            onSelect={() => {
              const target = menu.suite;
              setMenu(null);
              setConfirmArchive(target);
            }}
          />
        </Menu>
      )}

      {!readOnly && dialog !== undefined && (
        <Scrim
          onClose={() => {
            if (!busy) setDialog(undefined);
          }}
        >
          <div
            className="dlg"
            role="dialog"
            aria-label={dialog.mode === "create" ? "新建组曲" : "编辑组曲"}
          >
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void submitDialog();
              }}
            >
              <div className="dh3">
                <b>{dialog.mode === "create" ? "新建组曲" : "编辑组曲"}</b>
              </div>
              <div className="db">
                <Field label="名称">
                  <input
                    aria-label="名称"
                    className="input lg"
                    autoFocus
                    disabled={busy}
                    value={dialog.draft.name}
                    onChange={(event) => {
                      const value = event.target.value;
                      setDialog((cur) =>
                        cur === undefined ? cur : { ...cur, draft: { ...cur.draft, name: value } },
                      );
                    }}
                  />
                </Field>
                <Field label="目标">
                  <input
                    aria-label="目标"
                    className="input lg"
                    disabled={busy}
                    value={dialog.draft.goal}
                    onChange={(event) => {
                      const value = event.target.value;
                      setDialog((cur) =>
                        cur === undefined ? cur : { ...cur, draft: { ...cur.draft, goal: value } },
                      );
                    }}
                  />
                </Field>
                <Field label="工作区">
                  <Dropdown
                    label="工作区"
                    appearance="lg"
                    value={dialog.draft.workspace}
                    disabled={busy ? "正在处理" : undefined}
                    options={workspaceChoices.map((item) => ({
                      value: item.path,
                      label: item.label,
                    }))}
                    onChange={(value) => {
                      setDialog((cur) =>
                        cur === undefined
                          ? cur
                          : { ...cur, draft: { ...cur.draft, workspace: value } },
                      );
                    }}
                  />
                </Field>
                <Field label="说明">
                  <textarea
                    aria-label="说明"
                    className="textarea"
                    spellCheck={false}
                    disabled={busy}
                    value={dialog.draft.instructions}
                    onChange={(event) => {
                      const value = event.target.value;
                      setDialog((cur) =>
                        cur === undefined
                          ? cur
                          : { ...cur, draft: { ...cur.draft, instructions: value } },
                      );
                    }}
                  />
                </Field>
              </div>
              {dialogError !== "" && (
                <div className="errt" role="alert">
                  {dialogError}
                </div>
              )}
              <div className="df">
                <span className="sp" />
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setDialog(undefined);
                  }}
                >
                  取消
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={
                    busy || dialog.draft.name.trim() === "" || dialog.draft.workspace === ""
                  }
                >
                  保存
                </Button>
              </div>
            </form>
          </div>
        </Scrim>
      )}

      {!readOnly && confirmArchive !== undefined && (
        <ConfirmDialog
          title={`归档 ${confirmArchive.name}？`}
          confirmLabel="归档"
          danger
          onClose={() => {
            setConfirmArchive(undefined);
          }}
          onConfirm={() => archiveSuite(confirmArchive)}
        />
      )}
    </section>
  );
}
