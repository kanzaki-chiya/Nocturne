import { useEffect, useMemo, useRef, useState } from "react";
import { RpcError } from "@nocturne/rpc/client";
import {
  describeSchedulePlan,
  PERMISSION_PRESET_NAMES,
  REASONING_EFFORT_LEVELS,
  SCHEDULE_DAYS,
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
import "./pages.css";
import "./mcp.css";
import "./schedule.css";

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
  onOpenSession: (sessionId: string) => void;
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
    if (selectedId === "new" || selectedId === null) {
      filledId.current = null;
      return;
    }
    if (filledId.current === selectedId) return;
    const task = tasks.find((item) => item.id === selectedId);
    if (task === undefined) return;
    filledId.current = selectedId;
    setDraft(draftFrom(task));
    setConfirmDelete(false);
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

  const runNow = async () => {
    if (api === undefined || selected === undefined) return;
    setBusy(true);
    setNotice(undefined);
    try {
      const result = await api.runSchedule({ id: selected.id });
      if (result.started) onOpenSession(result.sessionId);
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
      <header className="ph3">
        <div className="grow">
          <h3>定时任务</h3>
          <span className="sub">
            只在 Nocturne 打开时运行 · 错过的只补最近一次 · 无人值守，需要确认的操作会被直接拒绝
          </span>
        </div>
        <button
          type="button"
          className="btn primary"
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
        </button>
      </header>
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
      <div className="cols3">
        <nav className="plist" aria-label="任务">
          {loading && tasks.length === 0 ? <p className="hint">正在读取…</p> : null}
          {!loading && tasks.length === 0 ? <p className="hint">还没有定时任务。</p> : null}
          {enabled.length > 0 && <h5>启用</h5>}
          {enabled.map((task) => (
            <TaskLink
              key={task.id}
              task={task}
              on={task.id === selectedId}
              onSelect={setSelectedId}
            />
          ))}
          {paused.length > 0 && <h5>已暂停</h5>}
          {paused.map((task) => (
            <TaskLink
              key={task.id}
              task={task}
              on={task.id === selectedId}
              onSelect={setSelectedId}
            />
          ))}
        </nav>
        <div className="pane">
          {selectedId === null && <p className="hint">从左边选一个任务，或新建一个。</p>}
          {(selected !== undefined || selectedId === "new") && (
            <>
              <div className="t1">
                <h3>{selected?.name ?? (draft.name.trim() || "新任务")}</h3>
                <span className="tagc">
                  {workspaceLabel(
                    draft.workspace === "" ? null : draft.workspace,
                    workspaceChoices,
                  )}
                </span>
                {selected !== undefined && (
                  <span className="acts">
                    <button
                      type="button"
                      className={`mcp-switch${selected.enabled ? " on" : ""}`}
                      role="switch"
                      aria-checked={selected.enabled}
                      disabled={readOnly || busy}
                      title={readOnly ? "请在电脑上操作" : undefined}
                      onClick={() => {
                        void save({
                          ...inputFrom(draftFrom(selected), selected),
                          enabled: !selected.enabled,
                        });
                      }}
                    >
                      {selected.enabled ? "启用" : "已暂停"}
                    </button>
                    <button
                      type="button"
                      className="btn"
                      disabled={busy}
                      onClick={() => void runNow()}
                    >
                      ▶ 立即运行
                    </button>
                  </span>
                )}
              </div>
              {selected !== undefined && (
                <dl className="kv">
                  <div>
                    <dt>下次运行</dt>
                    <dd>
                      {selected.schedule.type === "manual"
                        ? "只在点「立即运行」时运行"
                        : selected.enabled
                          ? formatScheduleWhen(selected.nextRunAt)
                          : "已暂停"}
                    </dd>
                  </div>
                  <div>
                    <dt>上次运行</dt>
                    <dd
                      className={resultClass(
                        selected.lastRun?.result,
                        selected.lastRun?.denied ?? 0,
                      )}
                    >
                      {describeLastRun(selected.lastRun)}
                    </dd>
                  </div>
                  <div>
                    <dt>最近 7 天</dt>
                    <dd>
                      运行 {selected.stats.last7Days.runs} 次 · 跳过{" "}
                      {selected.stats.last7Days.skipped} 次
                    </dd>
                  </div>
                  <div>
                    <dt>平均用时</dt>
                    <dd>{formatDuration(selected.stats.averageDurationMs)}</dd>
                  </div>
                </dl>
              )}
              {selected !== undefined && (
                <div className="tabs" role="tablist">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={tab === "settings"}
                    className={tab === "settings" ? "on" : undefined}
                    onClick={() => {
                      setTab("settings");
                    }}
                  >
                    设置
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={tab === "history"}
                    className={tab === "history" ? "on" : undefined}
                    onClick={() => {
                      setTab("history");
                    }}
                  >
                    历史
                  </button>
                </div>
              )}
              {readOnly && (
                <p className="sched-readonly" role="note">
                  请在电脑上操作。手机上可以查看，也可以立即运行。
                </p>
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
                  <label className="field">
                    <span className="lab">
                      <span>名称</span>
                    </span>
                    <input
                      className={`input${field === "name" ? " err" : ""}`}
                      value={draft.name}
                      disabled={readOnly}
                      onChange={(event) => {
                        setDraft({ ...draft, name: event.target.value });
                      }}
                    />
                  </label>
                  <label className="field">
                    <span className="lab">
                      <span>指令</span>
                      <small>每次运行都在新会话里，作为第一条消息发出；需要的背景写在这里</small>
                    </span>
                    <textarea
                      className={`input${field === "prompt" ? " err" : ""}`}
                      aria-label="指令"
                      value={draft.prompt}
                      disabled={readOnly}
                      onChange={(event) => {
                        setDraft({ ...draft, prompt: event.target.value });
                      }}
                    />
                  </label>
                  <div className="sched-row">
                    <label className="field">
                      <span className="lab">
                        <span>工作区</span>
                      </span>
                      <select
                        className="input"
                        aria-label="工作区"
                        value={draft.workspace}
                        disabled={readOnly}
                        onChange={(event) => {
                          setDraft({ ...draft, workspace: event.target.value });
                        }}
                      >
                        <option value="">普通对话</option>
                        {workspaceChoices
                          .filter((item) => item.path !== null)
                          .map((item) => (
                            <option key={item.path} value={item.path ?? ""}>
                              {item.label}
                            </option>
                          ))}
                      </select>
                    </label>
                    <label className="field">
                      <span className="lab">
                        <span>模型</span>
                      </span>
                      <select
                        className={`input${field === "model" ? " err" : ""}`}
                        aria-label="模型"
                        value={draft.model}
                        disabled={readOnly}
                        onChange={(event) => {
                          setDraft({ ...draft, model: event.target.value });
                        }}
                      >
                        <option value="">默认</option>
                        {draft.model !== "" &&
                          !models.some(
                            (model) => `${model.ref.provider}/${model.ref.model}` === draft.model,
                          ) && <option value={draft.model}>{draft.model}</option>}
                        {models.map((model) => {
                          const id = `${model.ref.provider}/${model.ref.model}`;
                          return (
                            <option key={id} value={id} title={model.ref.model}>
                              {model.displayName ?? model.ref.model} · {model.ref.provider}
                            </option>
                          );
                        })}
                      </select>
                    </label>
                  </div>
                  <div className="field">
                    <span className="lab">
                      <span>计划</span>
                      <small>本地时间；最小间隔 30 分钟</small>
                    </span>
                    <div className="seg" role="group" aria-label="计划类型">
                      {PLAN_TYPES.map((item) => (
                        <button
                          key={item.type}
                          type="button"
                          aria-pressed={draft.planType === item.type}
                          className={draft.planType === item.type ? "on" : undefined}
                          disabled={readOnly}
                          onClick={() => {
                            setDraft({ ...draft, planType: item.type });
                          }}
                        >
                          {item.label}
                        </button>
                      ))}
                    </div>
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
                            <select
                              className="input"
                              aria-label="星期"
                              value={draft.day}
                              disabled={readOnly}
                              onChange={(event) => {
                                setDraft({ ...draft, day: event.target.value as ScheduleDay });
                              }}
                            >
                              {SCHEDULE_DAYS.map((day) => (
                                <option key={day} value={day}>
                                  {day === "mon"
                                    ? "周一"
                                    : day === "tue"
                                      ? "周二"
                                      : day === "wed"
                                        ? "周三"
                                        : day === "thu"
                                          ? "周四"
                                          : day === "fri"
                                            ? "周五"
                                            : day === "sat"
                                              ? "周六"
                                              : "周日"}
                                </option>
                              ))}
                            </select>
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
                    <span className="hint">{describeSchedulePlan(planFrom(draft))}</span>
                  </div>
                  <div className="sched-row">
                    <label className="field">
                      <span className="lab">
                        <span>权限</span>
                      </span>
                      <select
                        className="input"
                        aria-label="权限"
                        value={draft.preset}
                        disabled={readOnly}
                        onChange={(event) => {
                          setDraft({ ...draft, preset: event.target.value });
                        }}
                      >
                        <option value="">默认</option>
                        {PERMISSION_PRESET_NAMES.map((name) => (
                          <option key={name} value={name}>
                            {name} · {presetOption(name).tag}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span className="lab">
                        <span>思考档位</span>
                      </span>
                      <select
                        className="input"
                        aria-label="思考档位"
                        value={draft.effort}
                        disabled={readOnly}
                        onChange={(event) => {
                          setDraft({ ...draft, effort: event.target.value });
                        }}
                      >
                        <option value="">默认</option>
                        <option value="off">{effortOption("off").tag}</option>
                        {REASONING_EFFORT_LEVELS.map((level) => (
                          <option key={level} value={level}>
                            {effortOption(level).tag}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span className="lab">
                        <span>单次时长上限</span>
                      </span>
                      <select
                        className={`input${field === "maxDurationMinutes" ? " err" : ""}`}
                        aria-label="单次时长上限"
                        value={draft.maxDuration}
                        disabled={readOnly}
                        onChange={(event) => {
                          setDraft({ ...draft, maxDuration: event.target.value });
                        }}
                      >
                        {!DURATIONS.map(String).includes(draft.maxDuration) && (
                          <option value={draft.maxDuration}>{draft.maxDuration} 分钟</option>
                        )}
                        {DURATIONS.map((minutes) => (
                          <option key={minutes} value={String(minutes)}>
                            {minutes} 分钟
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="sched-callout">
                    <b>无人值守</b>
                    <span>
                      运行时没人能点确认：审查后仍需要你确认的操作会被直接拒绝，模型会在最终回复里列出没做成的部分。需要写文件或跑命令的任务，先点一次「立即运行」看看会被拒绝什么，再决定放宽权限或写规则。
                    </span>
                  </div>
                  {formError !== undefined && (
                    <p className="errt" role="alert">
                      {formError}
                    </p>
                  )}
                  {notice !== undefined && <p className="hint">{notice}</p>}
                  <div className="formacts">
                    <button type="submit" className="btn primary" disabled={readOnly || busy}>
                      保存
                    </button>
                    <button
                      type="button"
                      className="btn ghost"
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
                    </button>
                    <span className="grow" />
                    {selected !== undefined &&
                      (confirmDelete ? (
                        <button
                          type="button"
                          className="btn danger"
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
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn danger"
                          disabled={readOnly || busy}
                          title={readOnly ? "请在电脑上操作" : undefined}
                          onClick={() => {
                            setConfirmDelete(true);
                          }}
                        >
                          删除任务
                        </button>
                      ))}
                  </div>
                  {selected !== undefined && (
                    <span className="hint">删除任务不会删除它运行出来的会话。</span>
                  )}
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
                    <div className="sched-hist" role="table" aria-label="运行历史">
                      <div className="sched-hist-row head" role="row">
                        <span>计划时间</span>
                        <span>触发</span>
                        <span>结果</span>
                        <span>用时</span>
                        <span>会话</span>
                      </div>
                      {history.map((entry) => (
                        <div
                          className="sched-hist-row"
                          role="row"
                          key={`${entry.id}:${entry.result}`}
                        >
                          <span className="mono">{formatScheduleWhen(entry.scheduledAt)}</span>
                          <span>
                            {entry.result === "skipped" ? "—" : scheduleTriggerLabel(entry.trigger)}
                          </span>
                          <span className={`res ${resultClass(entry.result, entry.denied ?? 0)}`}>
                            {scheduleResultLabel(entry.result)}
                            {entry.result === "skipped" && (
                              <small>{scheduleSkipLabel(entry.reason)}</small>
                            )}
                            {entry.result === "done" && (entry.denied ?? 0) > 0 && (
                              <small>{entry.denied} 项被拒绝</small>
                            )}
                            {entry.result === "error" && entry.error !== undefined && (
                              <small>{entry.error}</small>
                            )}
                            {entry.trigger === "catchup" &&
                              entry.result === "done" &&
                              entry.startedAt !== undefined && (
                                <small>{formatScheduleWhen(entry.startedAt)} 补跑</small>
                              )}
                          </span>
                          <span className="mono">{formatDurationClock(entry.durationMs)}</span>
                          {entry.sessionId !== undefined ? (
                            <button
                              type="button"
                              className="go"
                              onClick={() => {
                                if (entry.sessionId !== undefined) onOpenSession(entry.sessionId);
                              }}
                            >
                              打开会话 →
                            </button>
                          ) : (
                            <span className="go none">—</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  <p className="hint">
                    保留最近 200 条。跳过的原因：上一次还在运行、同时运行的定时任务已满 2
                    个、错过的计划时间。
                  </p>
                </div>
              )}
            </>
          )}
        </div>
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
    <button
      type="button"
      className={`sched-item${on ? " on" : ""}${task.enabled ? "" : " paused"}`}
      aria-current={on ? "true" : undefined}
      onClick={() => {
        onSelect(task.id);
      }}
    >
      <span className="n">{task.name}</span>
      <span className={`r ${resultClass(task.enabled ? task.lastRun?.result : undefined)}`}>
        {result}
      </span>
      <span className="s">{subtitle}</span>
    </button>
  );
}
