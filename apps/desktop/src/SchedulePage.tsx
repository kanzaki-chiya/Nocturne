import { Dropdown } from "./Dropdown";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { RpcError } from "@nocturne/rpc/client";
import {
  describeSchedulePlan,
  PERMISSION_PRESET_NAMES,
  REASONING_EFFORT_LEVELS,
  SCHEDULE_DAYS,
  type PermissionPresetName,
  type ScheduleDay,
  type ScheduleHistoryEntry,
  type ScheduleListResult,
  type SchedulePlan,
  type SchedulePlanType,
  type ScheduleRunNowResult,
  type ScheduleSaveInput,
  type ScheduleTaskOverview,
} from "@nocturne/core/protocol";

import { effortOption, presetOption } from "./choice-info";
import {
  describeLastRun,
  formatDuration,
  formatDurationClock,
  formatScheduleWhen,
  scheduleResultLabel,
  scheduleSkipLabel,
  scheduleTriggerLabel,
} from "./schedule-format";
import {
  Badge,
  Button,
  SegmentedControl,
  Switch,
  DataTable,
  DetailHeader,
  EmptyState,
  Field,
  FormFooter,
  ListGroup,
  ListItem,
  MasterDetail,
  PageHeader,
  SettingsGroup,
  SettingsRow,
} from "./ui";
import "./pages.css";
import "./mcp.css";
import "./schedule.css";

const SCHEDULE_PRESET_DESCRIPTIONS: Record<PermissionPresetName, string> = {
  "read-only": "只读；任何需要确认的操作都会被直接拒绝",
  default: "可读工作区与只读子代理；改文件、命令、联网等需要确认的操作会被直接拒绝",
  "auto-edit": "可写工作区文件；需要确认的命令、联网会被直接拒绝",
  guarded: "工作区内读写、常规命令与联网放行；高危命令与工作区外改文件会被直接拒绝",
  smart: "工作区内读写放行，命令与联网先交安全审查判断；仍需确认的操作会被直接拒绝",
  bypass: "除凭据与受保护配置外全部放行",
};

/** 页面只用到的运行时方法，桌面与手机网页都能传 `client.runtime` */
export interface SchedulePageApi {
  listSchedules(): Promise<ScheduleListResult>;
  saveSchedule(input: ScheduleSaveInput): Promise<ScheduleTaskOverview>;
  deleteSchedule(input: { id: string }): Promise<void>;
  runSchedule(input: { id: string }): Promise<ScheduleRunNowResult>;
  scheduleHistory(input: { id: string }): Promise<ScheduleHistoryEntry[]>;
  listModels?(input?: { workspaceRoot?: string | undefined }): Promise<ScheduleModelOption[]>;
}

/** 模型下拉只用到的字段，避免页面依赖 Provider 实现 */
export interface ScheduleModelOption {
  ref: { provider: string; model: string };
  displayName?: string | undefined;
}

export interface ScheduleWorkspaceOption {
  /** null = 普通对话 */
  path: string | null;
  label: string;
}

const PLAN_TYPES: { type: SchedulePlanType; label: string }[] = [
  { type: "interval", label: "每 N 分钟" },
  { type: "hourly", label: "每小时" },
  { type: "daily", label: "每天" },
  { type: "weekdays", label: "工作日" },
  { type: "weekly", label: "每周" },
  { type: "manual", label: "手动" },
  { type: "cron", label: "cron" },
];

const DURATIONS = [30, 60, 120, 240];

interface Draft {
  name: string;
  prompt: string;
  workspace: string;
  model: string;
  effort: string;
  preset: string;
  planType: SchedulePlanType;
  minutes: string;
  time: string;
  day: ScheduleDay;
  cron: string;
  maxDuration: string;
}

const EMPTY_DRAFT: Draft = {
  name: "",
  prompt: "",
  workspace: "",
  model: "",
  effort: "",
  preset: "",
  planType: "weekdays",
  minutes: "30",
  time: "09:00",
  day: "mon",
  cron: "0 9 * * 1-5",
  maxDuration: "60",
};

function draftFrom(task: ScheduleTaskOverview): Draft {
  const plan = task.schedule;
  return {
    name: task.name,
    prompt: task.prompt,
    workspace: task.workspace ?? "",
    model: task.model ?? "",
    effort: task.reasoningEffort ?? "",
    preset: task.permissionPreset ?? "",
    planType: plan.type,
    minutes: plan.type === "interval" ? String(plan.minutes) : "30",
    time: "time" in plan ? plan.time : "09:00",
    day: plan.type === "weekly" ? plan.day : "mon",
    cron: plan.type === "cron" ? plan.expr : "0 9 * * 1-5",
    maxDuration: String(task.maxDurationMinutes),
  };
}

function planFrom(draft: Draft): SchedulePlan {
  switch (draft.planType) {
    case "interval":
      return { type: "interval", minutes: Number(draft.minutes) };
    case "hourly":
      return { type: "hourly" };
    case "daily":
      return { type: "daily", time: draft.time };
    case "weekdays":
      return { type: "weekdays", time: draft.time };
    case "weekly":
      return { type: "weekly", day: draft.day, time: draft.time };
    case "manual":
      return { type: "manual" };
    case "cron":
      return { type: "cron", expr: draft.cron.trim() };
  }
}

function inputFrom(draft: Draft, task?: ScheduleTaskOverview): ScheduleSaveInput {
  const minutes = Number(draft.maxDuration);
  return {
    ...(task !== undefined ? { id: task.id, enabled: task.enabled } : {}),
    name: draft.name.trim(),
    prompt: draft.prompt,
    workspace: draft.workspace === "" ? null : draft.workspace,
    ...(draft.model !== "" ? { model: draft.model } : {}),
    ...(draft.effort !== ""
      ? { reasoningEffort: draft.effort as ScheduleSaveInput["reasoningEffort"] }
      : {}),
    ...(draft.preset !== "" ? { permissionPreset: draft.preset } : {}),
    schedule: planFrom(draft),
    ...(Number.isFinite(minutes) ? { maxDurationMinutes: minutes } : {}),
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fieldOf(error: unknown): string | undefined {
  return error instanceof RpcError ? error.field : undefined;
}

function workspaceLabel(path: string | null, options: readonly ScheduleWorkspaceOption[]): string {
  if (path === null || path === "") return "普通对话";
  return (
    options.find((item) => item.path === path)?.label ??
    path.split(/[/\\]/).filter(Boolean).at(-1) ??
    path
  );
}

function resultClass(result: ScheduleHistoryEntry["result"] | undefined, denied = 0): string {
  if (result === "done" && denied > 0) return "warn";
  if (result === "done") return "ok";
  if (result === "error" || result === "aborted") return "bad";
  return "dim";
}

const SCHED_HIST_COLUMNS: readonly {
  key: string;
  label: string;
  align?: "right";
  render: (entry: ScheduleHistoryEntry, onOpen: (sessionId: string) => void) => ReactNode;
}[] = [
  {
    key: "scheduledAt",
    label: "计划时间",
    render: (entry) => <span className="mono">{formatScheduleWhen(entry.scheduledAt)}</span>,
  },
  {
    key: "trigger",
    label: "触发",
    render: (entry) => (
      <span>{entry.result === "skipped" ? "—" : scheduleTriggerLabel(entry.trigger)}</span>
    ),
  },
  {
    key: "result",
    label: "结果",
    render: (entry) => (
      <span className={`res ${resultClass(entry.result, entry.denied ?? 0)}`}>
        {scheduleResultLabel(entry.result)}
        {entry.result === "skipped" && <small>{scheduleSkipLabel(entry.reason)}</small>}
        {entry.result === "done" && (entry.denied ?? 0) > 0 && (
          <small>{entry.denied} 项被拒绝</small>
        )}
        {entry.result === "error" && entry.error !== undefined && <small>{entry.error}</small>}
        {entry.trigger === "catchup" &&
          entry.result === "done" &&
          entry.startedAt !== undefined && (
            <small>{formatScheduleWhen(entry.startedAt)} 补跑</small>
          )}
      </span>
    ),
  },
  {
    key: "duration",
    label: "用时",
    align: "right",
    render: (entry) => <span className="mono">{formatDurationClock(entry.durationMs)}</span>,
  },
  {
    key: "session",
    label: "会话",
    align: "right",
    render: (entry, onOpen) =>
      entry.sessionId !== undefined ? (
        <button
          type="button"
          className="go"
          onClick={() => {
            if (entry.sessionId !== undefined) onOpen(entry.sessionId);
          }}
        >
          打开会话 →
        </button>
      ) : (
        <span className="go none">—</span>
      ),
  },
];

export function SchedulePage({
  api,
  workspaces,
  readOnly = false,
  onOpenSession,
  onChanged,
}: {
  api: SchedulePageApi | undefined;
  workspaces: readonly ScheduleWorkspaceOption[];
  /** 手机端：新建、编辑、删除、启停禁用，立即运行仍可用 */
  readOnly?: boolean;
  /** 返回 false 表示目标会话不存在（已删除），页面留在原处并提示 */
  onOpenSession: (sessionId: string) => unknown;
  onChanged?: () => void;
}) {
  const [list, setList] = useState<ScheduleListResult | undefined>();
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [reload, setReload] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [tab, setTab] = useState<"settings" | "history">("settings");
  const [history, setHistory] = useState<ScheduleHistoryEntry[] | undefined>();
  const [historyError, setHistoryError] = useState<string | undefined>();
  const [models, setModels] = useState<ScheduleModelOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | undefined>();
  const [field, setField] = useState<string | undefined>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();
  const filledId = useRef<string | null>(null);

  useEffect(() => {
    if (api === undefined) return;
    let alive = true;
    setLoading(true);
    void api
      .listSchedules()
      .then((result) => {
        if (!alive) return;
        setList(result);
        setLoadError(undefined);
      })
      .catch((error: unknown) => {
        if (alive) setLoadError(message(error));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [api, reload]);

  const tasks = list?.tasks ?? [];
  const selected = tasks.find((task) => task.id === selectedId);
  useEffect(() => {
    if (selectedId === "new" || selected !== undefined) return;
    const first = tasks.find((task) => task.enabled) ?? tasks[0];
    if (first !== undefined) setSelectedId(first.id);
  }, [tasks, selectedId, selected]);

  useEffect(() => {
    setConfirmDelete(false);
  }, [selectedId]);

  useEffect(() => {
    if (selectedId === "new" || selectedId === null) {
      filledId.current = null;
      return;
    }
    if (filledId.current === selectedId) return;
    const task = tasks.find((item) => item.id === selectedId);
    if (task === undefined) return;
    filledId.current = selectedId;
    setDraft(draftFrom(task));
    setFormError(undefined);
    setField(undefined);
  }, [selectedId, tasks]);

  useEffect(() => {
    if (api?.listModels === undefined) return;
    let alive = true;
    const workspace = draft.workspace === "" ? undefined : draft.workspace;
    void api
      .listModels(workspace === undefined ? {} : { workspaceRoot: workspace })
      .then((rows) => {
        if (alive) setModels(rows);
      })
      .catch(() => {
        if (alive) setModels([]);
      });
    return () => {
      alive = false;
    };
  }, [api, draft.workspace]);

  useEffect(() => {
    if (api === undefined || tab !== "history" || selected === undefined) return;
    let alive = true;
    setHistory(undefined);
    void api
      .scheduleHistory({ id: selected.id })
      .then((rows) => {
        if (alive) {
          setHistory(rows);
          setHistoryError(undefined);
        }
      })
      .catch((error: unknown) => {
        if (alive) setHistoryError(message(error));
      });
    return () => {
      alive = false;
    };
  }, [api, tab, selected]);

  const enabled = tasks.filter((task) => task.enabled);
  const paused = tasks.filter((task) => !task.enabled);
  const workspaceChoices = useMemo(() => {
    const choices = [...workspaces];
    if (selected?.workspace && !choices.some((item) => item.path === selected.workspace)) {
      choices.push({ path: selected.workspace, label: workspaceLabel(selected.workspace, []) });
    }
    return choices;
  }, [workspaces, selected]);

  const refresh = () => {
    setReload((value) => value + 1);
    onChanged?.();
  };

  const save = async (input: ScheduleSaveInput) => {
    if (api === undefined || readOnly) return;
    setBusy(true);
    setFormError(undefined);
    setField(undefined);
    try {
      const saved = await api.saveSchedule(input);
      filledId.current = null;
      setSelectedId(saved.id);
      setNotice(undefined);
      refresh();
    } catch (error) {
      setField(fieldOf(error));
      setFormError(message(error));
    } finally {
      setBusy(false);
    }
  };

  const openSession = async (sessionId: string) => {
    setNotice(undefined);
    setHistoryError(undefined);
    const opened = await onOpenSession(sessionId);
    if (opened === false) {
      const deletedMsg = "这次运行的会话已删除";
      setNotice(deletedMsg);
      setHistoryError(deletedMsg);
    }
  };

  const runNow = async () => {
    if (api === undefined || selected === undefined) return;
    setBusy(true);
    setNotice(undefined);
    try {
      const result = await api.runSchedule({ id: selected.id });
      if (result.started) await openSession(result.sessionId);
      else setNotice(scheduleSkipLabel(result.reason));
      refresh();
    } catch (error) {
      setNotice(message(error));
    } finally {
      setBusy(false);
    }
  };

  if (api === undefined) {
    return (
      <section className="page3 schedule-page" aria-label="定时任务">
        <p className="hint" role="status">
          连接后显示定时任务。
        </p>
      </section>
    );
  }

  const schedulerNote =
    list?.scheduler.running === false
      ? list.scheduler.reason === "locked"
        ? "另一个 Nocturne 正在调度，这个窗口不会触发。"
        : "当前没有在调度：定时任务只在桌面端打开时运行。"
      : undefined;

  return (
    <section className="page3 schedule-page" aria-label="定时任务" aria-busy={loading || busy}>
      <div className="spage flush">
        <PageHeader
          title={readOnly ? "" : "定时任务"}
          actions={
            <>
              {" "}
              <Button
                variant="primary"
                disabled={readOnly}
                title={readOnly ? "请在电脑上操作" : undefined}
                onClick={() => {
                  setSelectedId("new");
                  setDraft(EMPTY_DRAFT);
                  setTab("settings");
                  setConfirmDelete(false);
                  setFormError(undefined);
                }}
              >
                ＋ 新建任务
              </Button>
            </>
          }
        />
        {(schedulerNote !== undefined ||
          (list?.warnings.length ?? 0) > 0 ||
          loadError !== undefined) && (
          <p className="hint warnt sched-banner" role="status">
            {loadError ?? schedulerNote}
            {list?.warnings.map((warning) => (
              <span key={warning}> {warning}</span>
            ))}
          </p>
        )}
        <MasterDetail
          listLabel="任务"
          list={
            <>
              {loading && tasks.length === 0 ? <p className="desc">正在读取…</p> : null}
              {!loading && tasks.length === 0 ? (
                <EmptyState inline>还没有定时任务。</EmptyState>
              ) : null}
              {enabled.length > 0 && (
                <ListGroup title="启用" count={enabled.length}>
                  {" "}
                  {enabled.map((task) => (
                    <TaskLink
                      key={task.id}
                      task={task}
                      on={task.id === selectedId}
                      onSelect={setSelectedId}
                    />
                  ))}
                </ListGroup>
              )}
              {paused.length > 0 && (
                <ListGroup title="已暂停" count={paused.length}>
                  {" "}
                  {paused.map((task) => (
                    <TaskLink
                      key={task.id}
                      task={task}
                      on={task.id === selectedId}
                      onSelect={setSelectedId}
                    />
                  ))}
                </ListGroup>
              )}
            </>
          }
        >
          {(selected !== undefined || selectedId === "new") && (
            <>
              <DetailHeader
                title={selected?.name ?? (draft.name.trim() || "新任务")}
                extra={
                  <Badge>
                    {workspaceLabel(
                      draft.workspace === "" ? null : draft.workspace,
                      workspaceChoices,
                    )}
                  </Badge>
                }
                actions={
                  selected !== undefined ? (
                    <>
                      {" "}
                      <Switch
                        aria-label="启用"
                        checked={selected.enabled}
                        disabled={readOnly || busy}
                        title={readOnly ? "请在电脑上操作" : undefined}
                        onChange={(next) => {
                          void save({
                            ...inputFrom(draftFrom(selected), selected),
                            enabled: next,
                          });
                        }}
                      />
                      <Button disabled={busy} onClick={() => void runNow()}>
                        ▶ 立即运行
                      </Button>
                    </>
                  ) : undefined
                }
              />
              {readOnly && (
                <p className="sched-readonly" role="note">
                  请在电脑上操作
                </p>
              )}
              {selected !== undefined && (
                <SettingsGroup title="运行状态">
                  <SettingsRow label="下次运行">
                    <span className="val">
                      {selected.schedule.type === "manual"
                        ? "只在点「立即运行」时运行"
                        : selected.enabled
                          ? formatScheduleWhen(selected.nextRunAt)
                          : "已暂停"}
                    </span>
                  </SettingsRow>
                  <SettingsRow label="上次运行">
                    <span
                      className={`val ${resultClass(selected.lastRun?.result, selected.lastRun?.denied ?? 0)}`}
                    >
                      {describeLastRun(selected.lastRun)}
                    </span>
                  </SettingsRow>
                  <SettingsRow label="最近 7 天">
                    <span className="val">
                      运行 {selected.stats.last7Days.runs} 次 · 跳过{" "}
                      {selected.stats.last7Days.skipped} 次
                    </span>
                  </SettingsRow>
                  <SettingsRow label="平均用时">
                    <span className="val">{formatDuration(selected.stats.averageDurationMs)}</span>
                  </SettingsRow>
                </SettingsGroup>
              )}
              {selected !== undefined && (
                <SegmentedControl
                  role="tablist"
                  value={tab}
                  options={[
                    { value: "settings", label: "设置" },
                    { value: "history", label: "历史" },
                  ]}
                  onChange={setTab}
                />
              )}
              {(tab === "settings" || selectedId === "new") && (
                <form
                  className="form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (readOnly) return;
                    void save(inputFrom(draft, selected));
                  }}
                >
                  <Field label="名称">
                    <input
                      aria-label="名称"
                      className={`input lg${field === "name" ? " err" : ""}`}
                      value={draft.name}
                      disabled={readOnly}
                      onChange={(event) => {
                        setDraft({ ...draft, name: event.target.value });
                      }}
                    />
                  </Field>
                  <Field label="指令">
                    <textarea
                      className={`textarea${field === "prompt" ? " err" : ""}`}
                      aria-label="指令"
                      value={draft.prompt}
                      disabled={readOnly}
                      onChange={(event) => {
                        setDraft({ ...draft, prompt: event.target.value });
                      }}
                    />
                  </Field>
                  <div className="sched-row">
                    <Field label="工作区">
                      <Dropdown
                        label="工作区"
                        appearance="lg"
                        value={draft.workspace}
                        disabled={readOnly ? "请在电脑上操作" : undefined}
                        options={[
                          { value: "", label: "普通对话" },
                          ...workspaceChoices
                            .filter((item) => item.path !== null)
                            .map((item) => ({ value: item.path ?? "", label: item.label })),
                        ]}
                        onChange={(value) => {
                          setDraft({ ...draft, workspace: value });
                        }}
                      />
                    </Field>
                    <Field label="模型">
                      <Dropdown
                        label="模型"
                        appearance="lg"
                        value={draft.model}
                        disabled={readOnly ? "请在电脑上操作" : undefined}
                        options={[
                          { value: "", label: "默认" },
                          ...(draft.model !== "" &&
                          !models.some((m) => `${m.ref.provider}/${m.ref.model}` === draft.model)
                            ? [{ value: draft.model, label: draft.model }]
                            : []),
                          ...models.map((m) => ({
                            value: `${m.ref.provider}/${m.ref.model}`,
                            label: m.displayName ?? m.ref.model,
                            description: m.ref.provider,
                          })),
                        ]}
                        onChange={(value) => {
                          setDraft({ ...draft, model: value });
                        }}
                      />
                    </Field>
                  </div>
                  <Field label="计划">
                    <SegmentedControl
                      aria-label="计划类型"
                      disabled={readOnly}
                      value={draft.planType}
                      options={PLAN_TYPES.map((item) => ({
                        value: item.type,
                        label: item.label,
                      }))}
                      onChange={(planType) => {
                        setDraft({ ...draft, planType });
                      }}
                    />
                    <div className="sched-plan">
                      {draft.planType === "interval" && (
                        <>
                          <span className="hint">间隔</span>
                          <input
                            className="input mono narrow"
                            aria-label="间隔分钟"
                            value={draft.minutes}
                            disabled={readOnly}
                            onChange={(event) => {
                              setDraft({ ...draft, minutes: event.target.value });
                            }}
                          />
                          <span className="hint">分钟</span>
                        </>
                      )}
                      {(draft.planType === "daily" ||
                        draft.planType === "weekdays" ||
                        draft.planType === "weekly") && (
                        <>
                          {draft.planType === "weekly" && (
                            <Dropdown
                              label="星期"
                              appearance="lg"
                              value={draft.day}
                              disabled={readOnly ? "请在电脑上操作" : undefined}
                              options={SCHEDULE_DAYS.map((day) => ({
                                value: day,
                                label: {
                                  mon: "周一",
                                  tue: "周二",
                                  wed: "周三",
                                  thu: "周四",
                                  fri: "周五",
                                  sat: "周六",
                                  sun: "周日",
                                }[day],
                              }))}
                              onChange={(value) => {
                                setDraft({ ...draft, day: value as ScheduleDay });
                              }}
                            />
                          )}
                          <span className="hint">时间</span>
                          <input
                            className="input mono narrow"
                            aria-label="时间"
                            value={draft.time}
                            disabled={readOnly}
                            onChange={(event) => {
                              setDraft({ ...draft, time: event.target.value });
                            }}
                          />
                          {draft.planType === "weekdays" && (
                            <span className="hint">周一至周五</span>
                          )}
                        </>
                      )}
                      {draft.planType === "hourly" && <span className="hint">每个整点</span>}
                      {draft.planType === "manual" && (
                        <span className="hint">只在点「立即运行」时运行</span>
                      )}
                      {draft.planType === "cron" && (
                        <input
                          className={`input mono${field === "schedule" ? " err" : ""}`}
                          aria-label="cron 表达式"
                          value={draft.cron}
                          disabled={readOnly}
                          onChange={(event) => {
                            setDraft({ ...draft, cron: event.target.value });
                          }}
                        />
                      )}
                    </div>
                    <span className="desc">{describeSchedulePlan(planFrom(draft))}</span>
                  </Field>
                  <div className="sched-row">
                    <Field label="权限">
                      <Dropdown
                        label="权限"
                        appearance="lg"
                        value={draft.preset}
                        disabled={readOnly ? "请在电脑上操作" : undefined}
                        options={[
                          {
                            value: "",
                            label: "默认",
                            description:
                              "跟随工作区默认权限预设；无人值守下需要确认的操作会被直接拒绝",
                          },
                          ...PERMISSION_PRESET_NAMES.map((name) => {
                            const info = presetOption(name);
                            return {
                              value: name,
                              label: name,
                              ...(info.tag !== undefined ? { tag: info.tag } : {}),
                              description: SCHEDULE_PRESET_DESCRIPTIONS[name],
                              ...(info.risk ? { risk: true } : {}),
                            };
                          }),
                        ]}
                        onChange={(value) => {
                          setDraft({ ...draft, preset: value });
                        }}
                      />
                    </Field>
                    <Field label="思考档位">
                      <Dropdown
                        label="思考档位"
                        appearance="lg"
                        value={draft.effort}
                        disabled={readOnly ? "请在电脑上操作" : undefined}
                        options={[
                          { value: "", label: "默认" },
                          { value: "off", label: effortOption("off").tag ?? "off" },
                          ...REASONING_EFFORT_LEVELS.map((level) => ({
                            value: level,
                            label: effortOption(level).tag ?? level,
                          })),
                        ]}
                        onChange={(value) => {
                          setDraft({ ...draft, effort: value });
                        }}
                      />
                    </Field>
                    <Field label="单次时长上限">
                      <Dropdown
                        label="单次时长上限"
                        appearance="lg"
                        value={draft.maxDuration}
                        disabled={readOnly ? "请在电脑上操作" : undefined}
                        options={[
                          ...(!DURATIONS.map(String).includes(draft.maxDuration)
                            ? [{ value: draft.maxDuration, label: `${draft.maxDuration} 分钟` }]
                            : []),
                          ...DURATIONS.map((minutes) => ({
                            value: String(minutes),
                            label: `${minutes} 分钟`,
                          })),
                        ]}
                        onChange={(value) => {
                          setDraft({ ...draft, maxDuration: value });
                        }}
                      />
                    </Field>
                  </div>
                  {formError !== undefined && (
                    <p className="errt" role="alert">
                      {formError}
                    </p>
                  )}
                  {notice !== undefined && <p className="hint">{notice}</p>}
                  <FormFooter
                    reason={
                      <>
                        {" "}
                        {selected !== undefined &&
                          (confirmDelete ? (
                            <Button
                              variant="danger-solid"
                              disabled={readOnly || busy}
                              onClick={() => {
                                setBusy(true);
                                void api
                                  .deleteSchedule({ id: selected.id })
                                  .then(() => {
                                    setSelectedId(null);
                                    setConfirmDelete(false);
                                    refresh();
                                  })
                                  .catch((error: unknown) => {
                                    setFormError(message(error));
                                  })
                                  .finally(() => {
                                    setBusy(false);
                                  });
                              }}
                            >
                              确认删除
                            </Button>
                          ) : (
                            <Button
                              variant="danger"
                              disabled={readOnly || busy}
                              title={readOnly ? "请在电脑上操作" : undefined}
                              onClick={() => {
                                setConfirmDelete(true);
                              }}
                            >
                              删除任务
                            </Button>
                          ))}
                      </>
                    }
                  >
                    <Button
                      disabled={readOnly || busy}
                      onClick={() => {
                        if (selected !== undefined) setDraft(draftFrom(selected));
                        else {
                          setSelectedId(tasks[0]?.id ?? null);
                          setDraft(EMPTY_DRAFT);
                        }
                        setFormError(undefined);
                      }}
                    >
                      取消
                    </Button>

                    <Button type="submit" variant="primary" disabled={readOnly || busy}>
                      保存
                    </Button>
                  </FormFooter>
                </form>
              )}
              {tab === "history" && selected !== undefined && (
                <div>
                  {historyError !== undefined && (
                    <p className="errt" role="alert">
                      {historyError}
                    </p>
                  )}
                  {history === undefined && historyError === undefined && (
                    <p className="hint">正在读取历史…</p>
                  )}
                  {history?.length === 0 && <p className="hint">还没有运行记录。</p>}
                  {history !== undefined && history.length > 0 && (
                    <DataTable
                      aria-label="运行历史"
                      rows={history}
                      rowKey={(entry) => `${entry.id}:${entry.result}`}
                      columns={SCHED_HIST_COLUMNS.map((col) => ({
                        key: col.key,
                        header: col.label,
                        numeric: col.align === "right",
                        render: (entry: ScheduleHistoryEntry) =>
                          col.render(entry, (id) => {
                            void openSession(id);
                          }),
                      }))}
                    />
                  )}
                </div>
              )}
            </>
          )}
        </MasterDetail>
      </div>
    </section>
  );
}

function TaskLink({
  task,
  on,
  onSelect,
}: {
  task: ScheduleTaskOverview;
  on: boolean;
  onSelect: (id: string) => void;
}) {
  const result =
    !task.enabled && task.schedule.type === "manual"
      ? "手动"
      : !task.enabled
        ? "已暂停"
        : task.running
          ? "运行中"
          : task.lastRun !== undefined
            ? scheduleResultLabel(task.lastRun.result)
            : "—";
  const subtitle =
    task.schedule.type === "manual"
      ? "只在点「立即运行」时运行"
      : `${describeSchedulePlan(task.schedule)}${task.enabled && task.nextRunAt !== undefined ? ` · 下次 ${formatScheduleWhen(task.nextRunAt)}` : ""}`;
  return (
    <ListItem
      label={task.name}
      selected={on}
      dot={task.running ? "run" : task.enabled ? "ok" : "hollow"}
      meta={result}
      title={subtitle}
      onClick={() => {
        onSelect(task.id);
      }}
    />
  );
}
