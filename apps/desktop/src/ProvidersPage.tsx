/**
 * 服务商页：左列「已配置」，页头「添加服务商」进入选择页与添加表单。
 * 字段由 describeProviderSetup 驱动，不在前端写死某个服务商的字段。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { BrandIcon } from "./BrandIcon";
import { providerIcon } from "./brand-icons";
import { LoginWaitCard } from "./LoginWaitCard";
import { ModelSettingsDialog } from "./ModelSettingsDialog";
import type { LoginCompleted, LoginStarted, RpcClient, RpcProvider } from "@nocturne/rpc/client";
import { RpcError } from "@nocturne/rpc/client";
import { refKey } from "./session-controls";
import type {
  AccountStorageSetup,
  ModelRoleInfo,
  ModelSettingsView,
  PrepareProviderResult,
  ProviderOverview,
  ProviderPreset,
  ProviderSetupDescription,
  SetupProviderEntry,
  ToggleImpact,
  UpdateSetupProviderPatch,
} from "./rpc-types";
import {
  Badge,
  Button,
  DataTable,
  DetailHeader,
  EmptyState,
  Field,
  Form,
  FormFooter,
  IconButton,
  ListGroup,
  ListItem,
  MasterDetail,
  PageHeader,
  SegmentedControl,
  SettingsGroup,
  Switch,
  ICON_MD,
  ICON_SM,
  Icon,
} from "./ui";
import "./pages.css";
import "./mcp.css";

/* ---------------- 小工具 ---------------- */

const PRESET_GROUPS: readonly { key: ProviderPreset["group"]; label: string }[] = [
  { key: "vendor", label: "厂商" },
  { key: "relay", label: "中转" },
  { key: "local", label: "本地" },
  { key: "custom", label: "自定义" },
];

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** ProviderSetupError → 字段名（-32005，data.field 已映射进 RpcError.field）。 */
function fieldError(e: unknown): { field: string; message: string } | null {
  if (e instanceof RpcError && e.field !== undefined) {
    return { field: e.field, message: e.message };
  }
  return null;
}

/** 上下文按千分位完整显示；最大输出用 K（效果图 A 屏） */
function fullTokens(n: number | undefined): string {
  return n === undefined ? "—" : n.toLocaleString("en-US");
}
function shortTokens(n: number | undefined): string {
  if (n === undefined) return "—";
  return n >= 1024 && n % 1024 === 0
    ? `${n / 1024}K`
    : n >= 1000
      ? `${Math.round(n / 1000)}K`
      : String(n);
}

function caps(m: ModelSettingsView): { r: boolean; i: boolean } {
  return {
    r: m.fields.reasoning.value !== "none" && m.fields.reasoning.value !== undefined,
    i: m.fields.imageInput.value === true,
  };
}

const failed = (p: ProviderOverview): boolean =>
  p.credentialStatus === "expired" || p.credentialStatus === "missing";

function statusDot(p: ProviderOverview): "ok" | "warn" {
  return failed(p) || p.credentialStatus === "expiring" ? "warn" : "ok";
}
function originText(p: ProviderOverview): string {
  switch (p.origin) {
    case "setup":
      return "providers.json";
    case "user":
      return "config.json";
    case "magpie":
      return "magpie.json（由 Magpie 维护）";
    case "project":
      return "项目配置";
    case "env":
      return "环境变量";
    case "cli":
      return "命令行参数";
  }
}
function typeText(t: ProviderOverview["type"]): string {
  return t === "openai-compatible" ? "OpenAI 兼容" : "Anthropic 兼容";
}

/** 模型角色中文名（describeToggleImpact 的停用确认列表） */
const ROLE_LABELS: Record<ModelRoleInfo["role"], string> = {
  task: "子代理模型",
  vision: "视觉模型",
  smol: "轻量模型",
};

/** 停用确认的受影响项（ADR-0054 §4：列出会话数、默认模型与角色） */
function impactLines(impact: ToggleImpact, subject: string): string[] {
  const lines: string[] = [];
  if (impact.affectedSessions > 0) {
    lines.push(
      `${impact.affectedSessions} 个打开的会话正在用 ${subject}，下一轮发送时需要先换模型`,
    );
  }
  if (impact.defaultModel) {
    lines.push(`默认模型是 ${subject}，改为按未设置处理：新会话需要先选模型`);
  }
  for (const role of impact.roles) {
    lines.push(`${ROLE_LABELS[role]}是 ${subject}，改为按未设置处理`);
  }
  return lines;
}

/** Core 的提问行面向终端（结尾冒号、「回车跳过」）：表单只取标签部分 */
function labelOf(prompt: string): string {
  return prompt
    .replace(/[：:]\s*$/, "")
    .replace(/（[^）]*回车[^）]*）/, "")
    .replace(/\s*\[[^\]]*\]$/, "")
    .trim();
}

/** 获取结果默认只露出的模型名个数；更多时可展开为限高内部滚动的完整列表 */
const PEEK_MODELS = 4;

type FetchedModel = PrepareProviderResult["models"][number];

function FetchedModels({ models, open }: { models: FetchedModel[]; open: boolean }) {
  if (!open) {
    return (
      <div className="ms" data-testid="fetched-peek">
        {models.slice(0, PEEK_MODELS).map((m) => (
          <span key={m.id} title={m.displayName ?? m.id}>
            {m.id}
          </span>
        ))}
        <span className="more">等 {models.length - PEEK_MODELS} 个</span>
      </div>
    );
  }
  return (
    <div className="fetched-models" data-testid="fetched-list">
      <DataTable
        aria-label="获取到的模型"
        rows={models}
        rowKey={(m) => m.id}
        columns={[
          {
            key: "id",
            header: "模型",
            mono: true,
            render: (m) => <span title={m.displayName ?? m.id}>{m.id}</span>,
          },
          {
            key: "cap",
            header: "能力",
            render: (m) => (
              <span className="cap">
                {m.reasoning !== undefined && m.reasoning !== "none" && <b title="推理">R</b>}
                {m.imageInput === true && <b title="看图">I</b>}
              </span>
            ),
          },
          {
            key: "ctx",
            header: "上下文",
            numeric: true,
            mono: true,
            render: (m) => fullTokens(m.contextWindow),
          },
          {
            key: "out",
            header: "最大输出",
            numeric: true,
            mono: true,
            render: (m) => {
              const implausible =
                m.maxOutputTokens !== undefined &&
                m.contextWindow !== undefined &&
                m.maxOutputTokens >= m.contextWindow;
              return (
                <span
                  className={implausible ? "implausible" : undefined}
                  title={implausible ? "上游声明的最大输出不小于上下文窗口，已忽略" : undefined}
                >
                  {shortTokens(m.maxOutputTokens)}
                </span>
              );
            },
          },
        ]}
      />
    </div>
  );
}

/* ---------------- 页面 ---------------- */

type Sel =
  { kind: "provider"; id: string } | { kind: "add" } | { kind: "preset"; id: string } | null;

export function ProvidersPage({
  client,
  currentProvider: sessionProvider,
  currentModel: sessionModel,
  inUse,
  openUrl,
  providersVersion,
}: {
  /** 常驻后台的 client；全局服务商配置与 cwd 无关，可为 undefined（尚未就绪） */
  client: RpcClient | undefined;
  /** 当前会话使用的 provider id（标记「当前」）；草稿态为 undefined，此时改用默认模型的服务商 */
  currentProvider: string | undefined;
  /** 当前会话使用的模型 id（编辑对话框的「是否仍在列表」提示） */
  currentModel?: string | undefined;
  /** 已打开会话正在使用的 provider id（删除置灰） */
  inUse?: ReadonlySet<string> | undefined;
  openUrl: (url: string) => void;
  /** providersChanged 计数：变化时重取 */
  providersVersion: number;
}) {
  const [data, setData] = useState<{
    providers: ProviderOverview[];
    presets: ProviderPreset[];
    defaultKey: string | null;
    defaultProvider: string | undefined;
  }>({ providers: [], presets: [], defaultKey: null, defaultProvider: undefined });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sel, setSel] = useState<Sel>(null);
  const [addQuery, setAddQuery] = useState("");
  const currentProvider = sessionProvider ?? data.defaultProvider;
  const currentRef = useRef(sessionProvider);
  currentRef.current = sessionProvider;
  const lastProviderRef = useRef<string | undefined>(undefined);
  if (sel?.kind === "provider") lastProviderRef.current = sel.id;

  const generation = useRef(0);
  const refresh = useCallback(async () => {
    if (client === undefined) return;
    const current = ++generation.current;
    try {
      const [d, , def] = await Promise.all([
        client.provider.describeProviders().then((value) => {
          if (current === generation.current)
            setData((old) => ({ ...old, providers: value.providers }));
          return value;
        }),
        client.provider.listProviderPresets().then((value) => {
          if (current === generation.current) setData((old) => ({ ...old, presets: value }));
          return value;
        }),
        client.runtime.defaultModel().then((value) => {
          if (current === generation.current)
            setData((old) => ({
              ...old,
              defaultKey: value === undefined ? null : refKey(value),
              defaultProvider: value?.provider,
            }));
          return value;
        }),
      ]);
      if (current !== generation.current) return;
      setLoadError(null);
      // 首次拿到数据时定默认选中（当前服务商 > 第一个已配置 > 添加选择页）
      setSel((cur) => {
        if (cur !== null) return cur;
        const current = currentRef.current ?? def?.provider;
        if (current !== undefined && d.providers.some((p) => p.id === current)) {
          return { kind: "provider", id: current };
        }
        const first = d.providers[0];
        if (first !== undefined) return { kind: "provider", id: first.id };
        return { kind: "add" };
      });
    } catch (e) {
      if (current === generation.current) setLoadError(errText(e));
    }
  }, [client]);
  useEffect(() => {
    void refresh();
    return () => {
      generation.current++;
    };
  }, [refresh, providersVersion]);

  const configured = data.providers;
  const available = useMemo(() => {
    const filtered = data.presets.filter(
      (p) => p.defaultName === "" || !configured.some((c) => c.id === p.defaultName),
    );
    return [
      ...filtered.filter((p) => p.defaultName !== ""),
      ...filtered.filter((p) => p.defaultName === ""),
    ];
  }, [data.presets, configured]);
  const groupedAvailable = useMemo(() => {
    const q = addQuery.trim().toLowerCase();
    const matched =
      q === ""
        ? available
        : available.filter(
            (p) => p.label.toLowerCase().includes(q) || p.id.toLowerCase().includes(q),
          );
    return PRESET_GROUPS.map(({ key, label }) => ({
      key,
      label,
      items: matched.filter((p) => p.group === key),
    })).filter((g) => g.items.length > 0);
  }, [available, addQuery]);
  const selProvider =
    sel?.kind === "provider" ? configured.find((p) => p.id === sel.id) : undefined;
  const selPreset = sel?.kind === "preset" ? available.find((p) => p.id === sel.id) : undefined;

  // 选中项消失（删除后、或预设已被配置）回落到列表第一项或添加选择页
  useEffect(() => {
    if (sel === null || sel.kind === "add") return;
    const gone =
      sel.kind === "provider"
        ? !configured.some((p) => p.id === sel.id)
        : !available.some((p) => p.id === sel.id);
    if (!gone) return;
    const first = configured[0];
    setSel(first !== undefined ? { kind: "provider", id: first.id } : { kind: "add" });
  }, [sel, configured, available]);

  const backToProvider = () => {
    const target =
      (lastProviderRef.current !== undefined &&
      configured.some((p) => p.id === lastProviderRef.current)
        ? lastProviderRef.current
        : undefined) ??
      (currentProvider !== undefined && configured.some((p) => p.id === currentProvider)
        ? currentProvider
        : undefined) ??
      configured[0]?.id;
    if (target !== undefined) setSel({ kind: "provider", id: target });
  };

  return (
    <section className="page3" data-testid="providers-page" aria-label="服务商">
      <div className="spage">
        <div className="readable">
          <PageHeader
            title="服务商"
            actions={
              <Button
                variant="primary"
                size="sm"
                disabled={client === undefined}
                onClick={() => {
                  setAddQuery("");
                  setSel({ kind: "add" });
                }}
              >
                添加服务商
              </Button>
            }
          />
          <MasterDetail
            framed
            listLabel="服务商列表"
            list={
              configured.length > 0 ? (
                <ListGroup title="已配置" count={configured.length}>
                  {configured.map((p) => {
                    const off = p.enabled === false;
                    return (
                      <ListItem
                        key={p.id}
                        icon={<BrandIcon icon={providerIcon(p.id)} size="md" />}
                        label={p.displayName ?? p.id}
                        title={p.displayName !== undefined ? p.id : undefined}
                        mono={p.displayName === undefined}
                        selected={sel?.kind === "provider" && sel.id === p.id}
                        dot={off ? "hollow" : statusDot(p)}
                        off={off}
                        onClick={() => {
                          setSel({ kind: "provider", id: p.id });
                        }}
                      />
                    );
                  })}
                </ListGroup>
              ) : null
            }
          >
            {client === undefined ? (
              <EmptyState>后台尚未就绪，稍后自动刷新。</EmptyState>
            ) : (
              <>
                {loadError !== null && <p className="desc err">{loadError}</p>}
                {selProvider !== undefined && (
                  <ProviderDetail
                    key={selProvider.id}
                    client={client}
                    provider={selProvider}
                    inUse={inUse?.has(selProvider.id) === true}
                    defaultKey={data.defaultKey}
                    editable={
                      selProvider.managed &&
                      !data.presets.some(
                        (pr) => pr.defaultName !== "" && pr.defaultName === selProvider.id,
                      )
                    }
                    inUseModel={
                      sessionProvider !== undefined
                        ? selProvider.id === sessionProvider
                          ? sessionModel
                          : undefined
                        : data.defaultKey?.startsWith(`${selProvider.id}/`) === true
                          ? data.defaultKey.slice(selProvider.id.length + 1)
                          : undefined
                    }
                    openUrl={openUrl}
                    onChanged={() => void refresh()}
                  />
                )}
                {sel?.kind === "add" && (
                  <>
                    <DetailHeader
                      leading={
                        configured.length > 0 ? (
                          <IconButton aria-label="返回" onClick={backToProvider}>
                            <Icon name="arrow_left" size={ICON_MD} />
                          </IconButton>
                        ) : undefined
                      }
                      title="添加服务商"
                    />
                    <div className="sbody">
                      <div className="addsearch">
                        <Icon name="search" size={ICON_MD} />
                        <input
                          type="text"
                          aria-label="搜索"
                          value={addQuery}
                          spellCheck={false}
                          onChange={(e) => {
                            setAddQuery(e.target.value);
                          }}
                        />
                      </div>
                      {groupedAvailable.map((g) => (
                        <SettingsGroup key={g.key} title={g.label} plain className="addgroup">
                          <div className="addgrid">
                            {g.items.map((p) => (
                              <button
                                key={p.id}
                                type="button"
                                className="addcard"
                                onClick={() => {
                                  setSel({ kind: "preset", id: p.id });
                                }}
                              >
                                <span className="addcard-ic" aria-hidden="true">
                                  {p.defaultName === "" ? (
                                    "+"
                                  ) : (
                                    <BrandIcon icon={providerIcon(p.id)} size="lg" />
                                  )}
                                </span>
                                <span className="addcard-label">{p.label}</span>
                                <Icon name="right_small" size={ICON_SM} className="addcard-chev" />
                              </button>
                            ))}
                          </div>
                        </SettingsGroup>
                      ))}
                    </div>
                  </>
                )}
                {selPreset !== undefined && (
                  <PresetForm
                    key={selPreset.id}
                    client={client}
                    preset={selPreset}
                    openUrl={openUrl}
                    onBack={() => {
                      setSel({ kind: "add" });
                    }}
                    onSaved={(providerId) => {
                      setAddQuery("");
                      setSel({ kind: "provider", id: providerId });
                      void refresh();
                    }}
                  />
                )}
                {sel === null && loadError === null && <EmptyState>选择左侧条目</EmptyState>}
              </>
            )}
          </MasterDetail>
        </div>
      </div>
    </section>
  );
}

/* ---------------- 已配置详情（A/C 屏） ---------------- */

/** 登录流程状态：选保存位置 → 等待授权；完成后若有一次性密钥单独展示 */
type ReloginState =
  | { kind: "idle" }
  | { kind: "storage"; setup: AccountStorageSetup }
  | { kind: "starting" }
  | { kind: "waiting"; login: LoginStarted };

function ProviderDetail({
  client,
  provider: p,
  inUse,
  defaultKey,
  editable,
  inUseModel,
  openUrl,
  onChanged,
}: {
  client: RpcClient;
  provider: ProviderOverview;
  inUse: boolean;
  defaultKey: string | null;
  /** 向导写入的自定义条目（内置预设条目的地址/协议由程序维护，只读） */
  editable: boolean;
  /** 该服务商正被会话/默认模型引用的模型 id（探测后若不在新清单里需二次确认） */
  inUseModel: string | undefined;
  openUrl: (url: string) => void;
  onChanged: () => void;
}) {
  const [models, setModels] = useState<ModelSettingsView[] | null>(null);
  const [query, setQuery] = useState("");
  const [editModel, setEditModel] = useState<ModelSettingsView | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | "remove" | "logout">(null);
  const [relogin, setRelogin] = useState<ReloginState>({ kind: "idle" });
  const [loginError, setLoginError] = useState<string | null>(null);
  const [unstored, setUnstored] = useState<NonNullable<LoginCompleted["unstoredKey"]> | null>(null);
  /** 删除被服务端以 provider_in_use 拒绝后置灰 */
  const [refusedInUse, setRefusedInUse] = useState(false);
  /** ADR-0054：模型级停用来源（listModels 只读 Core 字段，不自行推断） */
  const [disabledByModel, setDisabledByModel] = useState<
    Readonly<Record<string, "provider" | "model">>
  >({});
  /** 停用确认：对象正被打开会话 / 默认模型 / 模型角色使用时先弹页内确认 */
  const [confirm, setConfirm] = useState<{
    target: { kind: "provider" } | { kind: "models"; ids: string[] };
    impact: ToggleImpact;
  } | null>(null);

  const loadModels = useCallback(async () => {
    try {
      setModels(await client.provider.listModelSettings(p.id));
    } catch {
      setModels([]);
    }
    try {
      // 服务商页是唯一带 includeDisabled 的模型清单；其余列表默认滤除停用模型
      const all = await client.runtime.listModels({ includeDisabled: true });
      const disabled: Record<string, "provider" | "model"> = {};
      for (const m of all) {
        if (m.ref.provider === p.id && m.disabled !== undefined) disabled[m.ref.model] = m.disabled;
      }
      setDisabledByModel(disabled);
    } catch {
      setDisabledByModel({});
    }
  }, [client, p.id]);
  useEffect(() => {
    void loadModels();
  }, [loadModels, p.modelCount]);

  // 登录完成通知：只认本卡片发起的 loginId
  const waitingId = relogin.kind === "waiting" ? relogin.login.loginId : null;
  useEffect(() => {
    if (waitingId === null) return;
    return client.onLoginCompleted((n) => {
      if (n.loginId !== waitingId) return;
      setRelogin({ kind: "idle" });
      if (n.result !== undefined) {
        if (n.unstoredKey !== undefined) setUnstored(n.unstoredKey);
        setNotice(n.warning ?? "已重新登录");
        onChanged();
      } else if (n.error !== undefined && n.error.code !== "cancelled") {
        setLoginError(n.error.message);
      }
    });
  }, [client, waitingId, onChanged]);

  // 离开详情时取消进行中的登录
  const waitingRef = useRef(waitingId);
  waitingRef.current = waitingId;
  useEffect(
    () => () => {
      const id = waitingRef.current;
      if (id !== null) void client.login.cancel(id).catch(() => undefined);
    },
    [client],
  );

  const startLogin = async (accountStorage?: "plaintext" | "memory") => {
    setLoginError(null);
    setRelogin({ kind: "starting" });
    try {
      if (accountStorage === undefined) {
        const storage = await client.provider.describeAccountStorage(p.id);
        if (storage !== undefined) {
          setRelogin({ kind: "storage", setup: storage });
          return;
        }
      }
      const login = await client.login.start({
        providerId: p.id,
        ...(accountStorage !== undefined ? { accountStorage } : {}),
      });
      setRelogin({ kind: "waiting", login });
      openUrl(login.authorizeUrl);
    } catch (e) {
      setRelogin({ kind: "idle" });
      setLoginError(errText(e));
    }
  };

  const q = query.trim().toLowerCase();
  const filtered = (models ?? []).filter(
    (m) =>
      q === "" ||
      m.modelId.toLowerCase().includes(q) ||
      (m.fields.displayName.value ?? "").toLowerCase().includes(q),
  );

  const run = async (key: string, fn: () => Promise<string | null | undefined>) => {
    setBusy(key);
    setActionError(null);
    setNotice(null);
    try {
      const message = await fn();
      setNotice(message !== null && message !== undefined && message !== "" ? message : "已刷新");
      onChanged();
      await loadModels();
    } catch (e) {
      setActionError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const applyProviderEnabled = (enabled: boolean) =>
    run("toggle", async () => {
      await client.provider.setProviderEnabled(p.id, enabled);
      return enabled ? `已启用 ${p.id}` : `已停用 ${p.id}`;
    });
  const applyModelsEnabled = (ids: string[], enabled: boolean) =>
    run("toggle", async () => {
      await client.provider.setModelsEnabled(p.id, ids, enabled);
      return enabled ? `已启用 ${ids.length} 个模型` : `已停用 ${ids.length} 个模型`;
    });

  /** 停用：影响面非空（正被会话 / 默认模型 / 角色使用）先弹页内确认，否则直接切换 */
  const disable = async (target: { kind: "provider" } | { kind: "models"; ids: string[] }) => {
    try {
      const impact = await client.provider.describeToggleImpact(
        p.id,
        target.kind === "models" ? target.ids : undefined,
      );
      if (impact.affectedSessions === 0 && !impact.defaultModel && impact.roles.length === 0) {
        if (target.kind === "provider") await applyProviderEnabled(false);
        else await applyModelsEnabled(target.ids, false);
        return;
      }
      setConfirm({ target, impact });
    } catch (e) {
      setActionError(errText(e));
    }
  };

  const toggleModel = (modelId: string, enabled: boolean) =>
    enabled ? applyModelsEnabled([modelId], true) : disable({ kind: "models", ids: [modelId] });

  const readonlyReason = !p.managed ? `来自 ${originText(p)}，请修改该文件` : null;
  const deleteBlocked =
    readonlyReason ?? (inUse || refusedInUse ? "当前会话正在使用，不能删除" : null);
  const auth = p.authKind;
  const showRelogin = auth === "account" && failed(p);
  const off = p.enabled === false;
  const total = p.modelCount;
  const modelOnCount =
    models === null ? 0 : models.filter((m) => disabledByModel[m.modelId] !== "model").length;

  return (
    <>
      <DetailHeader
        leading={<BrandIcon icon={providerIcon(p.id)} size="md" />}
        title={p.id}
        mono
        extra={
          <>
            {p.overridden && <Badge variant="warn">被更高层覆盖</Badge>}
            {readonlyReason !== null && <Badge title={readonlyReason}>只读</Badge>}
          </>
        }
        actions={
          <>
            <Switch
              checked={!off}
              aria-label={`启用服务商 ${p.id}`}
              disabled={busy !== null}
              onChange={(next) => {
                if (next) void applyProviderEnabled(true);
                else void disable({ kind: "provider" });
              }}
            />
            <Button
              disabled={busy !== null}
              onClick={() => void run("refresh", () => client.provider.refreshUpstreamLimits(p.id))}
            >
              {busy === "refresh" ? "刷新中…" : "刷新"}
            </Button>
            {auth === "account" && p.managed && (
              <Button
                disabled={busy !== null}
                onClick={() => {
                  setDialog("logout");
                }}
              >
                退出登录
              </Button>
            )}
            <Button
              variant="danger"
              disabled={busy !== null || deleteBlocked !== null}
              title={deleteBlocked ?? undefined}
              onClick={() => {
                setDialog("remove");
              }}
            >
              删除
            </Button>
          </>
        }
      />

      {showRelogin && (
        <div className="pbanner">
          账号登录已失效
          {relogin.kind === "waiting" ? null : relogin.kind === "storage" ? (
            <SegmentedControl
              aria-label="保存位置"
              value={undefined}
              options={relogin.setup.options.map((o) => ({ value: o.value, label: o.label }))}
              onChange={(val) => {
                void startLogin(val);
              }}
            />
          ) : (
            <Button disabled={relogin.kind === "starting"} onClick={() => void startLogin()}>
              {relogin.kind === "starting" ? "启动中…" : "重新登录"}
            </Button>
          )}
        </div>
      )}
      {relogin.kind === "storage" && <p className="desc">{relogin.setup.notice}</p>}
      {relogin.kind === "waiting" && (
        <LoginWaitCard
          login={relogin.login}
          warn
          onOpenAuthorize={() => {
            openUrl(relogin.login.authorizeUrl);
          }}
          onCancel={async () => {
            await client.login.cancel(relogin.login.loginId).catch(() => undefined);
            setRelogin({ kind: "idle" });
          }}
          onSubmitManual={async (text) => {
            await client.login.submitManual(relogin.login.loginId, text);
          }}
        />
      )}
      {loginError !== null && <p className="desc err">{loginError}</p>}
      {unstored !== null && <UnstoredKey value={unstored} />}

      <ProviderConfigForm
        client={client}
        provider={p}
        editable={editable}
        inUseModel={inUseModel}
        disabled={busy !== null}
        onSaved={(message) => {
          setActionError(null);
          setNotice(message);
          onChanged();
          void loadModels();
        }}
        onPartialSaved={() => {
          onChanged();
          void loadModels();
        }}
      />

      {(actionError !== null || notice !== null) && (
        <p className={actionError !== null ? "desc err" : "desc ok-t"} role="status">
          {actionError ?? notice}
        </p>
      )}

      <SettingsGroup
        title="模型"
        plain
        count={
          models === null
            ? "…"
            : q !== ""
              ? `${filtered.length} / ${models.length}`
              : modelOnCount < models.length
                ? `${modelOnCount} / ${models.length}`
                : `${models.length} 个`
        }
        action={
          <>
            <input
              className="input md-w"
              placeholder="搜索模型"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
              }}
              aria-label="搜索模型"
            />
            <Button
              variant="ghost"
              size="sm"
              disabled={
                off ||
                busy !== null ||
                !filtered.some((m) => disabledByModel[m.modelId] === "model")
              }
              onClick={() =>
                void applyModelsEnabled(
                  filtered
                    .filter((m) => disabledByModel[m.modelId] === "model")
                    .map((m) => m.modelId),
                  true,
                )
              }
            >
              {q === "" ? "全部启用" : "启用筛选结果"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={
                off ||
                busy !== null ||
                !filtered.some((m) => disabledByModel[m.modelId] !== "model")
              }
              onClick={() =>
                void disable({
                  kind: "models",
                  ids: filtered
                    .filter((m) => disabledByModel[m.modelId] !== "model")
                    .map((m) => m.modelId),
                })
              }
            >
              {q === "" ? "全部停用" : "停用筛选结果"}
            </Button>
          </>
        }
      >
        {filtered.length > 0 && (
          <DataTable
            aria-label="模型"
            rows={filtered}
            rowKey={(m) => m.modelId}
            rowClassName={(m) =>
              off || disabledByModel[m.modelId] !== undefined ? "off" : undefined
            }
            columns={[
              {
                key: "on",
                header: "启用",
                render: (m) => (
                  <Switch
                    checked={disabledByModel[m.modelId] !== "model"}
                    aria-label={`启用 ${m.modelId}`}
                    disabled={off || busy !== null}
                    onChange={() =>
                      void toggleModel(m.modelId, disabledByModel[m.modelId] === "model")
                    }
                  />
                ),
              },
              {
                key: "model",
                header: "模型",
                render: (m) => (
                  <span className="model-cell">
                    <span title={m.modelId}>{m.fields.displayName.value ?? m.modelId}</span>
                    {defaultKey === `${p.id}/${m.modelId}` && <Badge variant="accent">默认</Badge>}
                  </span>
                ),
              },
              {
                key: "cap",
                header: "能力",
                render: (m) => {
                  const c = caps(m);
                  return (
                    <span className="cap">
                      {c.r && <b title="推理">R</b>}
                      {c.i && <b title="图片输入">I</b>}
                    </span>
                  );
                },
              },
              {
                key: "ctx",
                header: "上下文",
                numeric: true,
                mono: true,
                render: (m) => fullTokens(m.fields.contextWindow.value),
              },
              {
                key: "out",
                header: "最大输出",
                numeric: true,
                mono: true,
                render: (m) => {
                  const rawMaxOutput =
                    m.fields.maxOutputTokens.value ?? m.fields.maxOutputTokens.lowerValue;
                  const implausible =
                    rawMaxOutput !== undefined &&
                    m.fields.contextWindow.value !== undefined &&
                    rawMaxOutput >= m.fields.contextWindow.value &&
                    m.fields.maxOutputTokens.userValue === undefined &&
                    m.fields.maxOutputTokens.source.kind !== "user" &&
                    m.fields.maxOutputTokens.source.kind !== "config";
                  return (
                    <span
                      className={`model-output${implausible ? " implausible" : ""}`}
                      title={implausible ? "上游声明的最大输出不小于上下文窗口，已忽略" : undefined}
                    >
                      {shortTokens(implausible ? rawMaxOutput : m.fields.maxOutputTokens.value)}
                    </span>
                  );
                },
              },
              {
                key: "set",
                header: "",
                label: "操作",
                numeric: true,
                render: (m) => (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`设置 ${m.modelId}`}
                    onClick={() => {
                      setEditModel(m);
                    }}
                  >
                    设置
                  </Button>
                ),
              },
            ]}
          />
        )}
        {models !== null && filtered.length === 0 && (
          <EmptyState inline>{models.length === 0 ? "没有模型" : "无匹配模型"}</EmptyState>
        )}
      </SettingsGroup>

      {confirm !== null && (
        <ConfirmDialog
          title={
            confirm.target.kind === "provider"
              ? `停用 ${p.id}？`
              : `停用 ${confirm.target.ids.length} 个模型？`
          }
          body={
            confirm.target.kind === "provider"
              ? `停用后 ${p.id} 的 ${total} 个模型都不能再用，下面这些地方会受影响：`
              : "停用后这些模型不能再用，下面这些地方会受影响："
          }
          extra={
            <ul className="cflist">
              {impactLines(
                confirm.impact,
                confirm.target.kind === "provider"
                  ? `${p.id} 的模型`
                  : confirm.target.ids.length === 1
                    ? `${p.id}/${confirm.target.ids[0] ?? ""}`
                    : "选中的模型",
              ).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          }
          note="配置和密钥都会保留，重新启用后恢复。"
          confirmLabel="停用"
          onClose={() => {
            setConfirm(null);
          }}
          onConfirm={async () => {
            const target = confirm.target;
            if (target.kind === "provider") await applyProviderEnabled(false);
            else await applyModelsEnabled(target.ids, false);
            setConfirm(null);
          }}
        />
      )}

      {editModel !== null && (
        <ModelSettingsDialog
          view={editModel}
          provider={client.provider}
          providerId={p.id}
          readonly={!p.managed}
          onClose={() => {
            setEditModel(null);
          }}
          onSaved={() => {
            void loadModels();
            onChanged();
          }}
        />
      )}
      {dialog === "remove" && (
        <ConfirmDialog
          title={`删除 ${p.id}？`}
          body="删除这个服务商的配置和保存的凭据。config.json 里的同名条目不受影响。"
          confirmLabel="删除"
          danger
          onClose={() => {
            setDialog(null);
          }}
          onConfirm={async () => {
            try {
              await client.provider.removeSetupProvider(p.id);
              setDialog(null);
              onChanged();
            } catch (e) {
              setDialog(null);
              if (e instanceof RpcError && e.code === "provider_in_use") setRefusedInUse(true);
              setActionError(errText(e));
            }
          }}
        />
      )}
      {dialog === "logout" && (
        <ConfirmDialog
          title={`退出登录 ${p.id}？`}
          body="只删除本机保存的账号凭据。之后需要重新登录才能使用这个服务商。"
          confirmLabel="退出登录"
          onClose={() => {
            setDialog(null);
          }}
          onConfirm={async () => {
            try {
              await client.provider.logoutProvider(p.id);
              setDialog(null);
              setNotice("已删除本机凭据");
              onChanged();
            } catch (e) {
              setDialog(null);
              setActionError(errText(e));
            }
          }}
        />
      )}
    </>
  );
}

/** 一次性密钥：只出现在这一条 login.completed 里，界面只显示不保存 */
function UnstoredKey({ value }: { value: NonNullable<LoginCompleted["unstoredKey"]> }) {
  return (
    <div className="keybox">
      <span>没有可用的系统凭据存储，登录得到的密钥不会保存。请现在复制：</span>
      <code>{value.key}</code>
      <span className="fine">之后在环境变量 {value.envName} 里设置它。这个密钥只显示这一次。</span>
    </div>
  );
}

/* ---------------- 确认对话框 ---------------- */

/* Esc 关闭是模态语义而不是「恰好焦点在遮罩里」：要在整个窗口生效，
   又必须尊重对话框内部控件与其他键盘处理器对事件的消费。捕获阶段的监听
   先于目标执行，看不到输入法等控件稍后对 Esc 的 preventDefault；每个遮罩
   各挂一个窗口监听则按注册顺序执行，分两步打开的嵌套弹层里外层先关。
   所以全部遮罩共用一个窗口冒泡监听 + 模块级栈：冒泡阶段执行时目标控件与
   更早注册的处理器（权限卡片、提问卡片的捕获监听）都已消化完事件，
   未被消费的 Esc 只交给栈顶（最后打开）的遮罩，一次 Esc 只关最上层 */
interface ScrimEntry {
  el: HTMLDivElement | null;
  close: () => void;
}
const scrimStack: ScrimEntry[] = [];
let escListenerActive = false;

function onScrimKeyDown(event: KeyboardEvent) {
  if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
  // 「最上层」不能按入栈顺序判断：React 的 effect 子先于父执行，同时挂载的
  // 嵌套遮罩外层反而后入栈。同一 z-index 下绘制顺序就是文档序（后代必在祖先
  // 之后、后写的兄弟在前者之后），取仍在 DOM 中的条目里文档序最靠后的那个
  let top: ScrimEntry | undefined;
  for (const entry of scrimStack) {
    // 卸载到 effect 清理之间的条目已不在 DOM：跳过（不能再关，也不能吃掉这次 Esc）
    const el = entry.el;
    if (el?.isConnected !== true) continue;
    const topEl = top?.el;
    if (top === undefined || topEl == null) {
      top = entry;
      continue;
    }
    if ((topEl.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) {
      top = entry;
    }
  }
  if (top === undefined) return;
  event.preventDefault();
  top.close();
}

function subscribeScrimEsc() {
  if (escListenerActive) return;
  escListenerActive = true;
  window.addEventListener("keydown", onScrimKeyDown);
}

function unsubscribeScrimEsc() {
  if (!escListenerActive) return;
  escListenerActive = false;
  window.removeEventListener("keydown", onScrimKeyDown);
}

export function Scrim({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  // 关闭后把焦点还给打开对话框前聚焦的元素（如概览里的删除按钮）；元素已卸载则放弃。
  // 必须在首次渲染时捕获：对话框内的 autoFocus 在提交阶段就把焦点挪进对话框，
  // 等 effect 再读 activeElement 已经晚了
  const [returnFocusTo] = useState<HTMLElement | null>(() => {
    const active = document.activeElement;
    return active instanceof HTMLElement ? active : null;
  });
  const root = useRef<HTMLDivElement>(null);
  // onClose 每次渲染都换引用；栈条目只注册一次、经 ref 读最新回调，
  // 避免 effect 反复重跑导致入栈出栈交错
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // React 提交阶段会把焦点恢复给提交前聚焦的元素（触发器），覆盖按钮的 autoFocus，
  // 导致焦点从没进过对话框、Esc 冒泡不到遮罩。提交后（effect）再把焦点拉进对话框
  useEffect(() => {
    const el = root.current;
    if (el?.contains(document.activeElement) !== true) {
      el?.querySelector<HTMLElement>(
        "button, input, select, textarea, a[href], [tabindex]",
      )?.focus();
    }
    const entry: ScrimEntry = {
      el: el ?? null,
      close: () => {
        onCloseRef.current();
      },
    };
    scrimStack.push(entry);
    subscribeScrimEsc();
    return () => {
      const index = scrimStack.indexOf(entry);
      if (index !== -1) scrimStack.splice(index, 1);
      if (scrimStack.length === 0) unsubscribeScrimEsc();
      if (returnFocusTo?.isConnected) returnFocusTo.focus();
    };
  }, [returnFocusTo]);
  return (
    <div
      ref={root}
      className="scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {children}
    </div>
  );
}

/**
 * 应用内确认框：主界面不用 window.confirm（eslint no-alert）。默认焦点在「取消」，
 * Esc、点遮罩都等于取消，按确认才执行 onConfirm。
 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  danger = false,
  extra,
  note,
  onClose,
  onConfirm,
}: {
  title: string;
  body?: string | undefined;
  confirmLabel: string;
  danger?: boolean;
  /** 正文下的补充内容（如停用确认的受影响列表） */
  extra?: ReactNode;
  /** 列表后的说明（配置保留等） */
  note?: string;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  // busy 置位渲染前拦截重复确认（快速双击）：onConfirm 每次打开至多执行一次，
  // 失败恢复为可重试（界面仍在原位显示错误的是各调用方的责任）
  const confirming = useRef(false);
  return (
    <Scrim onClose={onClose}>
      <div className="dlg narrow" role="dialog" aria-label={title}>
        <div className="dh3">
          <b>{title}</b>
          {body !== undefined && <span>{body}</span>}
          {extra}
          {note !== undefined && <span>{note}</span>}
        </div>
        <div className="df">
          <span className="sp" />
          <Button onClick={onClose} disabled={busy} autoFocus>
            取消
          </Button>
          <Button
            variant={danger ? "danger-solid" : "primary"}
            disabled={busy}
            onClick={() => {
              if (confirming.current) return;
              confirming.current = true;
              setBusy(true);
              void onConfirm().finally(() => {
                confirming.current = false;
                setBusy(false);
              });
            }}
          >
            {busy ? "处理中…" : confirmLabel}
          </Button>
        </div>
      </div>
    </Scrim>
  );
}

/* ---------------- 详情内联配置表单 ---------------- */

type ProbedModels = Awaited<ReturnType<RpcProvider["probeSetupProviderModels"]>>["models"];

type ProbeState =
  | { kind: "idle" }
  | { kind: "err"; message: string }
  | { kind: "confirm"; models: ProbedModels; missingModel: string };

/**
 * 服务商详情内联配置表单：
 * - 自定义条目可改协议、显示名称、服务地址、请求头与会话标识请求头；
 * - 其他条目以只读输入框显示协议与完整 baseURL；
 * - apiKey / none 且 managed 时显示 API Key 输入框；
 * - 地址或协议变更后点保存时先自动探测模型列表，失败时在服务地址下报错并允许「仍然保存」。
 */
function ProviderConfigForm({
  client,
  provider: p,
  editable,
  inUseModel,
  disabled,
  onSaved,
  onPartialSaved,
}: {
  client: RpcClient;
  provider: ProviderOverview;
  editable: boolean;
  inUseModel: string | undefined;
  disabled: boolean;
  onSaved: (message: string) => void;
  onPartialSaved: () => void;
}) {
  const showKeyField = (p.authKind === "apiKey" || p.authKind === "none") && p.managed;
  const [entry, setEntry] = useState<SetupProviderEntry | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState(p.displayName ?? "");
  const [type, setType] = useState<"openai-compatible" | "anthropic">(p.type);
  const [baseURL, setBaseURL] = useState(p.baseURL ?? "");
  const [apiKey, setApiKey] = useState("");
  const [headers, setHeaders] = useState<{ name: string; value: string }[]>([]);
  const [sessionHeader, setSessionHeader] = useState("");
  const [probe, setProbe] = useState<ProbeState>({ kind: "idle" });
  const [fieldErr, setFieldErr] = useState<{ field: string; message: string } | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!editable) return;
    let alive = true;
    client.provider
      .describeSetupProvider(p.id)
      .then((e) => {
        if (!alive) return;
        if (e === null) {
          setLoadErr(`"${p.id}" 不是向导写入的条目，不能在程序里编辑`);
          return;
        }
        setEntry(e);
        setLoadErr(null);
        setDisplayName(e.displayName ?? "");
        setType(e.type ?? "openai-compatible");
        setBaseURL(e.baseURL ?? "");
        setHeaders(Object.entries(e.headers ?? {}).map(([name, value]) => ({ name, value })));
        setSessionHeader(e.sessionHeader ?? "");
      })
      .catch((e: unknown) => {
        if (alive) setLoadErr(errText(e));
      });
    return () => {
      alive = false;
    };
  }, [client, p.id, editable]);

  const savedHeaders = useMemo(
    () => Object.entries(entry?.headers ?? {}).map(([name, value]) => ({ name, value })),
    [entry],
  );
  const headersChanged =
    headers.length !== savedHeaders.length ||
    headers.some(
      (row, i) =>
        row.name !== (savedHeaders[i]?.name ?? "") || row.value !== (savedHeaders[i]?.value ?? ""),
    );
  const entryDirty =
    editable &&
    entry !== null &&
    (type !== (entry.type ?? "openai-compatible") ||
      displayName !== (entry.displayName ?? "") ||
      baseURL !== (entry.baseURL ?? "") ||
      sessionHeader !== (entry.sessionHeader ?? "") ||
      headersChanged);
  const keyDirty = showKeyField && apiKey.trim() !== "";
  const dirty = entryDirty || keyDirty;

  const endpointChanged =
    editable &&
    entry !== null &&
    (type !== (entry.type ?? "openai-compatible") ||
      baseURL.trim() !== (entry.baseURL ?? "").trim());

  const resetProbe = () => {
    setProbe((cur) => (cur.kind === "idle" ? cur : { kind: "idle" }));
  };

  const resetToSaved = () => {
    if (entry !== null) {
      setDisplayName(entry.displayName ?? "");
      setType(entry.type ?? "openai-compatible");
      setBaseURL(entry.baseURL ?? "");
      setHeaders(Object.entries(entry.headers ?? {}).map(([name, value]) => ({ name, value })));
      setSessionHeader(entry.sessionHeader ?? "");
    }
    setApiKey("");
    setProbe({ kind: "idle" });
    setFieldErr(null);
    setSaveErr(null);
  };

  /** 头行 → headers 表；整行空白忽略，名称或值仅填一侧时报错 */
  const buildHeaders = (): { headers: Record<string, string> } | { error: string } => {
    const out: Record<string, string> = {};
    for (const row of headers) {
      const name = row.name.trim();
      const value = row.value.trim();
      if (name === "" && value === "") continue;
      if (name === "") return { error: "请求头名称不能为空" };
      if (value === "") return { error: `请求头 ${name} 的值不能为空` };
      out[name] = value;
    }
    return { headers: out };
  };

  const save = async () => {
    if (!dirty || saving || disabled) return;
    setFieldErr(null);
    setSaveErr(null);

    let builtHeaders: Record<string, string> | undefined;
    if (entryDirty) {
      const built = buildHeaders();
      if ("error" in built) {
        setFieldErr({ field: "headers", message: built.error });
        return;
      }
      builtHeaders = built.headers;
      if (type === "openai-compatible" && baseURL.trim() === "") {
        setFieldErr({ field: "baseURL", message: "服务地址不能为空" });
        return;
      }
    }

    setSaving(true);
    try {
      let modelsToSave: ProbedModels | undefined;
      if (entryDirty && endpointChanged) {
        if (probe.kind === "confirm") {
          modelsToSave = probe.models;
        } else if (probe.kind === "err") {
          modelsToSave = undefined;
        } else {
          try {
            const result = await client.provider.probeSetupProviderModels({
              providerId: p.id,
              type,
              baseURL: baseURL.trim(),
              ...(builtHeaders !== undefined ? { headers: builtHeaders } : {}),
            });
            if (!mounted.current) return;
            if (inUseModel !== undefined && !result.models.some((m) => m.id === inUseModel)) {
              setProbe({ kind: "confirm", models: result.models, missingModel: inUseModel });
              return;
            }
            modelsToSave = result.models;
          } catch (e) {
            if (!mounted.current) return;
            setProbe({ kind: "err", message: errText(e) });
            return;
          }
        }
      }

      let savedMessage: string | null = null;
      if (entryDirty) {
        try {
          const patch: UpdateSetupProviderPatch = {
            displayName,
            type,
            baseURL,
            headers: builtHeaders,
            sessionHeader,
            ...(modelsToSave !== undefined ? { models: modelsToSave } : {}),
          };
          const result = await client.provider.updateSetupProvider(p.id, patch);
          if (!mounted.current) return;
          savedMessage = result.message;
          const trimmedName = displayName.trim();
          const trimmedUrl = baseURL.trim();
          const trimmedSession = sessionHeader.trim();
          const nextEntry: SetupProviderEntry = {
            ...entry,
            type,
            ...(trimmedName !== "" ? { displayName: trimmedName } : { displayName: undefined }),
            ...(trimmedUrl !== "" ? { baseURL: trimmedUrl } : { baseURL: undefined }),
            ...(builtHeaders !== undefined && Object.keys(builtHeaders).length > 0
              ? { headers: builtHeaders }
              : { headers: undefined }),
            ...(trimmedSession !== ""
              ? { sessionHeader: trimmedSession }
              : { sessionHeader: undefined }),
          };
          setEntry(nextEntry);
          setDisplayName(nextEntry.displayName ?? "");
          setBaseURL(nextEntry.baseURL ?? "");
          setHeaders(
            Object.entries(nextEntry.headers ?? {}).map(([name, value]) => ({ name, value })),
          );
          setSessionHeader(nextEntry.sessionHeader ?? "");
          setProbe({ kind: "idle" });
        } catch (e) {
          if (!mounted.current) return;
          const fe = fieldError(e);
          if (
            fe !== null &&
            (fe.field === "displayName" ||
              fe.field === "baseURL" ||
              fe.field === "headers" ||
              fe.field === "sessionHeader")
          ) {
            setFieldErr(fe);
          } else {
            setSaveErr(errText(e));
          }
          return;
        }
      }

      if (keyDirty) {
        try {
          await client.provider.setCredential(p.id, apiKey.trim());
          if (!mounted.current) return;
          setApiKey("");
          savedMessage = savedMessage ?? "已更换密钥";
        } catch (e) {
          if (!mounted.current) return;
          setSaveErr(errText(e));
          if (entryDirty) onPartialSaved();
          return;
        }
      }

      onSaved(savedMessage ?? "已保存");
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  const urlError =
    fieldErr?.field === "baseURL"
      ? fieldErr.message
      : probe.kind === "err"
        ? `获取模型列表失败：${probe.message}`
        : undefined;
  const footerReason =
    saveErr !== null ? (
      <span className="errt" role="alert">
        {saveErr}
      </span>
    ) : probe.kind === "confirm" ? (
      <span className="warn-t" role="status">
        在用的 {probe.missingModel} 不在新列表里，保存后需重新选择模型
      </span>
    ) : loadErr !== null ? (
      <span className="errt" role="alert">
        {loadErr}
      </span>
    ) : undefined;

  return (
    <Form className="provider-form">
      <Field label="协议" htmlFor={editable ? undefined : "pd-type"}>
        {editable ? (
          <SegmentedControl
            aria-label="协议"
            value={type}
            options={[
              { value: "openai-compatible", label: "OpenAI 兼容" },
              { value: "anthropic", label: "Anthropic 兼容" },
            ]}
            onChange={(val) => {
              setType(val);
              setFieldErr(null);
              resetProbe();
            }}
          />
        ) : (
          <input id="pd-type" className="input lg" readOnly value={typeText(p.type)} />
        )}
      </Field>

      {editable && (
        <Field
          label="显示名称"
          htmlFor="pd-name"
          error={fieldErr?.field === "displayName" ? fieldErr.message : undefined}
        >
          <input
            id="pd-name"
            className={`input lg${fieldErr?.field === "displayName" ? " err" : ""}`}
            value={displayName}
            onChange={(e) => {
              setDisplayName(e.target.value);
              if (fieldErr?.field === "displayName") setFieldErr(null);
            }}
          />
        </Field>
      )}

      <Field label="服务地址" htmlFor="pd-url" error={editable ? urlError : undefined}>
        {editable ? (
          <input
            id="pd-url"
            className={`input lg mono${urlError !== undefined ? " err" : ""}`}
            spellCheck={false}
            value={baseURL}
            onChange={(e) => {
              setBaseURL(e.target.value);
              if (fieldErr?.field === "baseURL") setFieldErr(null);
              resetProbe();
            }}
          />
        ) : (
          <input
            id="pd-url"
            className={p.baseURL !== undefined ? "input lg mono" : "input lg"}
            readOnly
            value={p.baseURL ?? "官方端点"}
          />
        )}
      </Field>

      {showKeyField && (
        <Field label="API Key" htmlFor="pd-key">
          <input
            id="pd-key"
            className="input lg mono key-input"
            type="password"
            autoComplete="off"
            placeholder={p.authKind === "apiKey" ? "••••••••" : undefined}
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value);
              setSaveErr(null);
            }}
          />
        </Field>
      )}

      {editable && (
        <>
          <Field
            label="自定义请求头"
            error={fieldErr?.field === "headers" ? fieldErr.message : undefined}
          >
            {headers.map((row, i) => (
              <div className="kvline" key={i}>
                <input
                  className="input lg mono"
                  aria-label={`请求头 ${i + 1} 名称`}
                  value={row.name}
                  onChange={(e) => {
                    setHeaders((cur) =>
                      cur.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)),
                    );
                    if (fieldErr?.field === "headers") setFieldErr(null);
                    resetProbe();
                  }}
                />
                <input
                  className="input lg mono"
                  aria-label={`请求头 ${i + 1} 值`}
                  value={row.value}
                  onChange={(e) => {
                    setHeaders((cur) =>
                      cur.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)),
                    );
                    if (fieldErr?.field === "headers") setFieldErr(null);
                    resetProbe();
                  }}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setHeaders((cur) => cur.filter((_, j) => j !== i));
                    if (fieldErr?.field === "headers") setFieldErr(null);
                    resetProbe();
                  }}
                >
                  删除
                </Button>
              </div>
            ))}
            <div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setHeaders((cur) => [...cur, { name: "", value: "" }]);
                }}
              >
                <Icon name="add" size={ICON_SM} />
                添加请求头
              </Button>
            </div>
          </Field>

          <Field
            label="会话标识请求头"
            htmlFor="pd-session"
            error={fieldErr?.field === "sessionHeader" ? fieldErr.message : undefined}
          >
            <input
              id="pd-session"
              className={`input lg mono${fieldErr?.field === "sessionHeader" ? " err" : ""}`}
              spellCheck={false}
              value={sessionHeader}
              onChange={(e) => {
                setSessionHeader(e.target.value);
                if (fieldErr?.field === "sessionHeader") setFieldErr(null);
              }}
            />
          </Field>
        </>
      )}

      {(editable || showKeyField) && (
        <FormFooter reason={footerReason}>
          <Button disabled={!dirty || saving || disabled} onClick={resetToSaved}>
            取消
          </Button>
          <Button
            variant="primary"
            disabled={!dirty || saving || disabled}
            onClick={() => void save()}
          >
            {saving ? "保存中…" : probe.kind === "err" ? "仍然保存" : "保存"}
          </Button>
        </FormFooter>
      )}
    </Form>
  );
}

/* ---------------- 添加服务商（B 屏） ---------------- */

type CredentialInput = Parameters<RpcProvider["prepareProvider"]>[0]["credential"];
type FetchState =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "ok"; result: PrepareProviderResult }
  | { kind: "err"; message: string; field: boolean };
type DraftLogin =
  | { kind: "none" }
  | { kind: "starting" }
  | { kind: "waiting"; login: LoginStarted }
  | { kind: "done"; loginId: string; account?: string };

/** 表单初值：名称、地址按预设预填，固定值不进表单 */
function initialValues(setup: ProviderSetupDescription): Record<string, string> {
  const values: Record<string, string> = {};
  for (const f of setup.fields) if (f.fixed === undefined) values[f.key] = "";
  return values;
}

function PresetForm({
  client,
  preset,
  openUrl,
  onBack,
  onSaved,
}: {
  client: RpcClient;
  preset: ProviderPreset;
  openUrl: (url: string) => void;
  onBack: () => void;
  onSaved: (providerId: string) => void;
}) {
  const [setup, setSetup] = useState<ProviderSetupDescription | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  /** choose 的选择（OpenRouter：浏览器登录 / 粘贴密钥）；无 choose 时为 null */
  const [choice, setChoice] = useState<"login" | "apiKey" | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [envName, setEnvName] = useState("");
  const [manualId, setManualId] = useState("");
  const [fieldErr, setFieldErr] = useState<Record<string, string>>({});
  const [fetchState, setFetchState] = useState<FetchState>({ kind: "idle" });
  /** 获取结果的完整列表是否展开（每次重新获取后回到折叠） */
  const [listOpen, setListOpen] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [commitErr, setCommitErr] = useState<string | null>(null);
  const [draftLogin, setDraftLogin] = useState<DraftLogin>({ kind: "none" });
  const [unstored, setUnstored] = useState<NonNullable<LoginCompleted["unstoredKey"]> | null>(null);
  const [loginErr, setLoginErr] = useState<string | null>(null);
  const [storagePick, setStoragePick] = useState<"plaintext" | "memory" | null>(null);

  /** 已准备、未提交的草稿；离开或作废时 discardProvider */
  const draftRef = useRef<string | null>(null);
  /** 本表单发起、未被提交消费的草稿登录（进行中或已完成）；放弃时 login.cancel */
  const loginRef = useRef<string | null>(null);
  /** 每次获取的序号：取消或作废后迟到的结果直接丢弃并释放草稿 */
  const fetchSeq = useRef(0);

  const discardDraft = useCallback(() => {
    const id = draftRef.current;
    draftRef.current = null;
    if (id !== null) void client.provider.discardProvider(id).catch(() => undefined);
  }, [client]);
  /**
   * 放弃草稿登录：进行中的取消，已完成未提交的丢弃暂存凭据。
   * RPC 把 Core 的 LoginSession.cancel 与 discardDraftLogin 都映射为 login.cancel（rpc.md 3.4）。
   */
  const discardLogin = useCallback(() => {
    const id = loginRef.current;
    loginRef.current = null;
    if (id !== null) void client.login.cancel(id).catch(() => undefined);
  }, [client]);

  // 离开表单（卸载）时释放草稿与草稿登录
  useEffect(
    () => () => {
      fetchSeq.current += 1;
      discardDraft();
      discardLogin();
    },
    [discardDraft, discardLogin],
  );

  useEffect(() => {
    let cancelled = false;
    client.provider
      .describeProviderSetup(preset.id)
      .then((s) => {
        if (cancelled) return;
        setSetup(s);
        setValues(initialValues(s));
        setChoice(s.credential.choose?.options[0]?.method ?? null);
        const env = s.credential.methods.find((m) => m.kind === "env");
        if (env?.kind === "env") setEnvName(env.defaultName);
      })
      .catch((e: unknown) => {
        if (!cancelled) setSetupError(errText(e));
      });
    return () => {
      cancelled = true;
    };
  }, [client, preset.id]);

  // 草稿登录完成通知
  const waitingId = draftLogin.kind === "waiting" ? draftLogin.login.loginId : null;
  useEffect(() => {
    if (waitingId === null) return;
    return client.onLoginCompleted((n) => {
      if (n.loginId !== waitingId) return;
      if (n.result !== undefined) {
        setDraftLogin({
          kind: "done",
          loginId: n.loginId,
          ...(n.result.account !== undefined ? { account: n.result.account } : {}),
        });
        if (n.unstoredKey !== undefined) setUnstored(n.unstoredKey);
      } else {
        loginRef.current = null;
        setDraftLogin({ kind: "none" });
        if (n.error !== undefined && n.error.code !== "cancelled") setLoginErr(n.error.message);
      }
    });
  }, [client, waitingId]);

  if (setupError !== null) {
    return (
      <>
        <DetailHeader
          leading={
            <IconButton aria-label="返回" onClick={onBack}>
              <Icon name="arrow_left" size={ICON_MD} />
            </IconButton>
          }
          title={`添加 ${preset.label}`}
        />
        <p className="desc err">{setupError}</p>
      </>
    );
  }
  if (setup === null) {
    return (
      <>
        <DetailHeader
          leading={
            <IconButton aria-label="返回" onClick={onBack}>
              <Icon name="arrow_left" size={ICON_MD} />
            </IconButton>
          }
          title={`添加 ${preset.label}`}
        />
        <p className="desc">加载表单…</p>
      </>
    );
  }

  const methods = setup.credential.methods;
  const apiKeyMethod = methods.find(
    (m): m is Extract<(typeof methods)[number], { kind: "apiKey" }> => m.kind === "apiKey",
  );
  const envMethod = methods.find(
    (m): m is Extract<(typeof methods)[number], { kind: "env" }> => m.kind === "env",
  );
  const loginMethod = methods.find(
    (m): m is Extract<(typeof methods)[number], { kind: "login" }> => m.kind === "login",
  );
  const externalMethod = methods.find(
    (m): m is Extract<(typeof methods)[number], { kind: "external-file" }> =>
      m.kind === "external-file",
  );
  /** 实际生效的凭据方式 */
  const mode: "apiKey" | "env" | "login" | "external-file" | null = (() => {
    const primary = setup.credential.choose !== undefined ? choice : methods[0]?.kind;
    if (primary === "login") return "login";
    if (primary === "external-file") return "external-file";
    if (primary === "apiKey" || primary === "env") {
      if (apiKeyMethod?.available === true) return "apiKey";
      return envMethod !== undefined ? "env" : null;
    }
    return null;
  })();
  const storageSetup = setup.credential.accountStorage;

  const nameValue = (): string | undefined => {
    const fixed = setup.fields.find((f) => f.key === "name")?.fixed;
    const typed = values.name?.trim();
    return fixed ?? (typed !== undefined && typed !== "" ? typed : undefined);
  };
  const baseURLValue = (): string | undefined => {
    const field = setup.fields.find((f) => f.key === "baseURL");
    const typed = values.baseURL?.trim();
    return field?.fixed ?? (typed !== undefined && typed !== "" ? typed : undefined);
  };

  const credentialInput = (): CredentialInput | null => {
    switch (mode) {
      case "apiKey":
        return apiKey.trim() !== ""
          ? { kind: "apiKey", key: apiKey.trim() }
          : setup.keyOptional === true
            ? { kind: "apiKey", key: "" }
            : null;
      case "env":
        return {
          kind: "env",
          name: envName.trim() !== "" ? envName.trim() : (envMethod?.defaultName ?? ""),
        };
      case "login":
        return draftLogin.kind === "done" ? { kind: "login", loginId: draftLogin.loginId } : null;
      case "external-file":
        return { kind: "external-file" };
      case null:
        return null;
    }
  };

  /** 输入一改，已获取的结果作废（草稿释放），保存重新置灰 */
  const invalidate = () => {
    fetchSeq.current += 1;
    discardDraft();
    setFetchState({ kind: "idle" });
    setCommitErr(null);
  };
  const clearFieldErr = (key: string) => {
    setFieldErr((cur) => {
      if (!(key in cur)) return cur;
      const { [key]: _removed, ...rest } = cur;
      return rest;
    });
  };
  /** 名称或地址变了，草稿登录与它们绑定，必须重新登录 */
  const resetLogin = () => {
    discardLogin();
    setDraftLogin({ kind: "none" });
    setUnstored(null);
  };
  const setField = (k: string, v: string) => {
    setValues((cur) => ({ ...cur, [k]: v }));
    clearFieldErr(k);
    if ((k === "name" || k === "baseURL") && draftLogin.kind !== "none") resetLogin();
    invalidate();
  };

  const credential = credentialInput();
  const fetched = fetchState.kind === "ok" ? fetchState.result : null;
  const needManual = fetched?.needsManualModel === true;
  const canSave = fetched !== null && !committing && (!needManual || manualId.trim() !== "");

  /** 有输入框的字段：字段错误显示在这些输入框下，其余（preset、draftId）写在结果区 */
  const visibleFields = setup.fields.filter(
    (f) => f.fixed === undefined && f.key !== "sessionHeader",
  );
  const fieldInputs: Record<string, true> = {};
  for (const f of visibleFields) fieldInputs[f.key] = true;
  if (mode === "apiKey" || mode === "env") fieldInputs.credential = true;
  if (needManual) fieldInputs.modelId = true;

  const fetchModels = async () => {
    if (credential === null || fetchState.kind === "busy") return;
    invalidate();
    const seq = fetchSeq.current;
    setFetchState({ kind: "busy" });
    setListOpen(false);
    setFieldErr({});
    const name = nameValue();
    const baseURL = baseURLValue();
    try {
      const result = await client.provider.prepareProvider({
        presetId: preset.id,
        ...(name !== undefined &&
        setup.fields.some((f) => f.key === "name" && f.fixed === undefined)
          ? { name }
          : {}),
        ...(baseURL !== undefined &&
        setup.fields.some((f) => f.key === "baseURL" && f.fixed === undefined)
          ? { baseURL }
          : {}),
        credential,
      });
      if (seq !== fetchSeq.current) {
        // 已取消或输入已改：迟到的草稿直接释放
        void client.provider.discardProvider(result.draftId).catch(() => undefined);
        return;
      }
      draftRef.current = result.draftId;
      setFetchState({ kind: "ok", result });
    } catch (e) {
      if (seq !== fetchSeq.current) return;
      const fe = fieldError(e);
      const shown = fe !== null && fe.field in fieldInputs;
      if (fe !== null && shown) setFieldErr({ [fe.field]: fe.message });
      setFetchState({ kind: "err", message: errText(e), field: shown });
    }
  };
  const cancelFetch = () => {
    fetchSeq.current += 1;
    setFetchState({ kind: "idle" });
  };

  const save = async () => {
    const draftId = draftRef.current;
    if (draftId === null || committing) return;
    setCommitting(true);
    setCommitErr(null);
    try {
      const r = await client.provider.commitProvider(
        draftId,
        needManual ? manualId.trim() : undefined,
      );
      draftRef.current = null;
      loginRef.current = null; // 提交已消费草稿登录
      setApiKey("");
      onSaved(r.providerId);
    } catch (e) {
      const fe = fieldError(e);
      if (fe?.field === "draftId") {
        // 草稿过期或已提交：结果作废，需要重新获取
        draftRef.current = null;
        setFetchState({ kind: "idle" });
      } else if (fe?.field === "modelId") {
        setFieldErr({ modelId: fe.message });
      }
      setCommitErr(errText(e));
    } finally {
      setCommitting(false);
    }
  };

  /** 放弃添加：释放草稿与草稿登录，表单回到初值 */
  const abandon = () => {
    fetchSeq.current += 1;
    discardDraft();
    resetLogin();
    setValues(initialValues(setup));
    setApiKey("");
    setManualId("");
    setFieldErr({});
    setLoginErr(null);
    setCommitErr(null);
    setFetchState({ kind: "idle" });
  };
  const cancel = () => {
    abandon();
    onBack();
  };

  const startLogin = async () => {
    const name = nameValue();
    if (name === undefined) {
      setFieldErr({ name: "先填写名称" });
      return;
    }
    setLoginErr(null);
    setDraftLogin({ kind: "starting" });
    const baseURL = baseURLValue();
    try {
      const login = await client.login.startDraft({
        presetId: preset.id,
        name,
        ...(baseURL !== undefined ? { baseURL } : {}),
        ...(storagePick !== null ? { accountStorage: storagePick } : {}),
      });
      loginRef.current = login.loginId;
      setDraftLogin({ kind: "waiting", login });
      openUrl(login.authorizeUrl);
    } catch (e) {
      setDraftLogin({ kind: "none" });
      setLoginErr(errText(e));
    }
  };

  const fixedFields = setup.fields.filter((f) => f.fixed !== undefined);
  const printNotices = (fetched?.notices ?? []).filter((n) => n.kind === "print");

  return (
    <>
      <DetailHeader
        leading={
          <IconButton aria-label="返回" onClick={cancel}>
            <Icon name="arrow_left" size={ICON_MD} />
          </IconButton>
        }
        title={`添加 ${setup.label}`}
      />
      <div className="form">
        {fixedFields.map((f) => (
          <Field key={f.key} label={labelOf(f.prompt)}>
            <span className="val mono fixed-val">{f.fixed}</span>
          </Field>
        ))}
        {visibleFields.map((f) => (
          <Field
            key={f.key}
            label={labelOf(f.prompt)}
            htmlFor={`pf-${f.key}`}
            error={fieldErr[f.key]}
          >
            <input
              id={`pf-${f.key}`}
              className={`input lg mono${fieldErr[f.key] !== undefined ? " err" : ""}`}
              type="text"
              spellCheck={false}
              value={values[f.key] ?? ""}
              onChange={(e) => {
                setField(f.key, e.target.value);
              }}
            />
          </Field>
        ))}

        {setup.credential.choose !== undefined && (
          <Field label={labelOf(setup.credential.choose.prompt).replace(/（[^）]*）/, "")}>
            <SegmentedControl
              aria-label={labelOf(setup.credential.choose.prompt).replace(/（[^）]*）/, "")}
              value={choice}
              options={setup.credential.choose.options.map((o) => ({
                value: o.method,
                label: o.label,
              }))}
              onChange={(method) => {
                if (choice === method) return;
                setChoice(method);
                if (draftLogin.kind !== "none") resetLogin();
                invalidate();
              }}
            />
          </Field>
        )}

        {mode === "apiKey" && apiKeyMethod !== undefined && (
          <Field label={labelOf(apiKeyMethod.prompt)} htmlFor="pf-key" error={fieldErr.credential}>
            <input
              id="pf-key"
              className={`input lg mono${fieldErr.credential !== undefined ? " err" : ""}`}
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                clearFieldErr("credential");
                invalidate();
              }}
            />
          </Field>
        )}
        {mode === "env" && envMethod !== undefined && (
          <Field label={labelOf(envMethod.prompt)} htmlFor="pf-env" error={fieldErr.credential}>
            <input
              id="pf-env"
              className={`input lg mono${fieldErr.credential !== undefined ? " err" : ""}`}
              type="text"
              spellCheck={false}
              value={envName}
              onChange={(e) => {
                setEnvName(e.target.value);
                clearFieldErr("credential");
                invalidate();
              }}
            />
          </Field>
        )}
        {mode === "login" && loginMethod !== undefined && (
          <Field label={loginMethod.label} error={loginErr ?? undefined}>
            {draftLogin.kind === "done" ? (
              <div className="done">
                <b>✓</b>
                <span>
                  已登录{draftLogin.account !== undefined ? `：${draftLogin.account}` : ""}
                </span>
              </div>
            ) : draftLogin.kind === "waiting" ? (
              <LoginWaitCard
                login={draftLogin.login}
                onOpenAuthorize={() => {
                  openUrl(draftLogin.login.authorizeUrl);
                }}
                onCancel={async () => {
                  const id = draftLogin.login.loginId;
                  loginRef.current = null;
                  await client.login.cancel(id).catch(() => undefined);
                  setDraftLogin({ kind: "none" });
                }}
                onSubmitManual={async (text) => {
                  await client.login.submitManual(draftLogin.login.loginId, text);
                }}
              />
            ) : (
              <>
                {storageSetup !== undefined && (
                  <>
                    <div className="desc warn">{storageSetup.notice}</div>
                    <SegmentedControl
                      aria-label={labelOf(storageSetup.prompt)}
                      value={storagePick}
                      options={storageSetup.options.map((o) => ({
                        value: o.value,
                        label: o.label,
                      }))}
                      onChange={setStoragePick}
                    />
                  </>
                )}
                <div>
                  <Button
                    disabled={
                      draftLogin.kind === "starting" ||
                      (storageSetup !== undefined && storagePick === null)
                    }
                    onClick={() => void startLogin()}
                  >
                    {draftLogin.kind === "starting" ? "启动中…" : "开始登录"}
                  </Button>
                </div>
              </>
            )}
          </Field>
        )}
        {mode === "external-file" && externalMethod !== undefined && (
          <Field label={externalMethod.label} desc={externalMethod.renewHint} />
        )}
        {unstored !== null && <UnstoredKey value={unstored} />}

        <SettingsGroup
          title="模型"
          plain
          count={fetchState.kind === "ok" ? `${fetchState.result.modelCount} 个` : undefined}
          action={
            fetchState.kind === "busy" ? (
              <Button onClick={cancelFetch}>取消获取</Button>
            ) : (
              <Button disabled={credential === null} onClick={() => void fetchModels()}>
                获取模型
              </Button>
            )
          }
        >
          <div aria-live="polite">
            {fetchState.kind === "ok" && fetchState.result.models.length > 0 && (
              <>
                <FetchedModels
                  models={fetchState.result.models}
                  open={listOpen || fetchState.result.models.length <= PEEK_MODELS}
                />
                {fetchState.result.models.length > PEEK_MODELS && (
                  <div>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-expanded={listOpen}
                      onClick={() => {
                        setListOpen((v) => !v);
                      }}
                    >
                      {listOpen ? "收起" : "展开全部"}
                    </Button>
                  </div>
                )}
              </>
            )}
            {/* 字段错误已标在输入框下时，这里不再重复显示 */}
            {fetchState.kind === "err" && !fetchState.field && (
              <div className="desc err" role="alert">
                {fetchState.message}
              </div>
            )}
            {printNotices.length > 0 && (
              <div className="desc">{printNotices.map((n) => n.text).join(" ")}</div>
            )}
          </div>
        </SettingsGroup>

        {needManual && (
          <Field
            label={labelOf(setup.manualModel?.prompt ?? "模型 ID")}
            htmlFor="pf-model"
            error={fieldErr.modelId}
          >
            <input
              id="pf-model"
              className={`input lg mono${fieldErr.modelId !== undefined ? " err" : ""}`}
              type="text"
              spellCheck={false}
              value={manualId}
              onChange={(e) => {
                setManualId(e.target.value);
                clearFieldErr("modelId");
              }}
            />
          </Field>
        )}
        {commitErr !== null && fieldErr.modelId === undefined && (
          <p className="desc err">{commitErr}</p>
        )}

        <FormFooter>
          <Button disabled={committing} onClick={cancel}>
            取消
          </Button>
          <Button variant="primary" disabled={!canSave} onClick={() => void save()}>
            {committing ? "保存中…" : "保存"}
          </Button>
        </FormFooter>
      </div>
    </>
  );
}
