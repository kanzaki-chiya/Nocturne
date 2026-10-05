/**
 * 服务商页（desktop-v3.html A–D 屏）：左列「已配置 / 可添加」，右列详情或添加表单。
 * 字段由 describeProviderSetup 驱动，不在前端写死某个服务商的字段。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { LoginWaitCard } from "./LoginWaitCard";
import { ModelSettingsDialog } from "./ModelSettingsDialog";
import type { LoginCompleted, LoginStarted, RpcClient, RpcProvider } from "@nocturne/rpc/client";
import { RpcError } from "@nocturne/rpc/client";
import { refKey } from "./session-controls";
import type {
  AccountStorageSetup,
  ModelSettingsView,
  PrepareProviderResult,
  ProviderOverview,
  ProviderPreset,
  ProviderSetupDescription,
} from "./rpc-types";
import "./pages.css";

/* ---------------- 小工具 ---------------- */

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
function credentialText(p: ProviderOverview): { text: string; cls: string } {
  switch (p.credentialStatus) {
    case "valid":
      return { text: "● 有效", cls: "ok" };
    case "expiring":
      return { text: "● 即将过期", cls: "warn" };
    case "expired":
      return { text: "● 已失效", cls: "warn" };
    case "missing":
      return { text: "● 缺失", cls: "warn" };
    case undefined:
      return { text: "—", cls: "" };
  }
}
function storageText(p: ProviderOverview): string {
  switch (p.credentialStorage) {
    case "system":
      return "系统凭据存储";
    case "plaintext":
      return "明文文件（无系统凭据存储）";
    case "memory":
      return "仅本次运行";
    case undefined:
      return p.keySource === "env" ? `环境变量 ${p.keyEnvName ?? ""}`.trim() : "—";
  }
}
function originText(p: ProviderOverview): string {
  switch (p.origin) {
    case "setup":
      return "providers.json";
    case "user":
      return "config.json";
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

/** Core 的提问行面向终端（结尾冒号、「回车跳过」）：表单只取标签部分 */
function labelOf(prompt: string): string {
  return prompt
    .replace(/[：:]\s*$/, "")
    .replace(/（[^）]*回车[^）]*）/, "")
    .replace(/\s*\[[^\]]*\]$/, "")
    .trim();
}
/** 说明文字去掉键盘操作提示（「直接回车…」「输入不回显」） */
function hintOf(hint: string): string {
  return hint
    .split("；")
    .filter((part) => !/回车|回显/.test(part))
    .join("；");
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
    <div className="flist" data-testid="fetched-list">
      <div className="fr h">
        <span>模型</span>
        <span>能力</span>
        <span className="num model-context">上下文</span>
        <span className="num model-output">最大输出</span>
      </div>
      <div className="fbody">
        {models.map((m) => {
          const r = m.reasoning !== undefined && m.reasoning !== "none";
          return (
            <div className="fr" key={m.id}>
              <span className="m" title={m.displayName ?? m.id}>
                {m.id}
              </span>
              <span className="cap">
                {r && <b title="推理">R</b>}
                {m.imageInput === true && <b title="看图">I</b>}
              </span>
              <span className="num model-context">{fullTokens(m.contextWindow)}</span>
              <span className="num model-output">{shortTokens(m.maxOutputTokens)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------- 页面 ---------------- */

type Sel = { kind: "provider"; id: string } | { kind: "preset"; id: string } | null;

export function ProvidersPage({
  client,
  currentProvider: sessionProvider,
  inUse,
  openUrl,
  providersVersion,
  onOpenModels,
}: {
  /** 常驻后台的 client；全局服务商配置与 cwd 无关，可为 undefined（尚未就绪） */
  client: RpcClient | undefined;
  /** 当前会话使用的 provider id（标记「当前」）；草稿态为 undefined，此时改用默认模型的服务商 */
  currentProvider: string | undefined;
  /** 已打开会话正在使用的 provider id（删除置灰） */
  inUse?: ReadonlySet<string> | undefined;
  openUrl: (url: string) => void;
  /** providersChanged 计数：变化时重取 */
  providersVersion: number;
  onOpenModels?: (() => void) | undefined;
}) {
  const [data, setData] = useState<{
    providers: ProviderOverview[];
    presets: ProviderPreset[];
    defaultKey: string | null;
    defaultProvider: string | undefined;
  }>({ providers: [], presets: [], defaultKey: null, defaultProvider: undefined });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sel, setSel] = useState<Sel>(null);
  const currentProvider = sessionProvider ?? data.defaultProvider;
  const currentRef = useRef(sessionProvider);
  currentRef.current = sessionProvider;

  const refresh = useCallback(async () => {
    if (client === undefined) return;
    try {
      const [d, presets, def] = await Promise.all([
        client.provider.describeProviders(),
        client.provider.listProviderPresets(),
        client.runtime.defaultModel(),
      ]);
      setData({
        providers: d.providers,
        presets,
        defaultKey: def === undefined ? null : refKey(def),
        defaultProvider: def?.provider,
      });
      setLoadError(null);
      // 首次拿到数据时定默认选中（当前服务商 > 第一个已配置 > 第一个可添加）
      setSel((cur) => {
        if (cur !== null) return cur;
        const current = currentRef.current ?? def?.provider;
        if (current !== undefined && d.providers.some((p) => p.id === current)) {
          return { kind: "provider", id: current };
        }
        const first = d.providers[0];
        if (first !== undefined) return { kind: "provider", id: first.id };
        const preset = presets[0];
        return preset !== undefined ? { kind: "preset", id: preset.id } : null;
      });
    } catch (e) {
      setLoadError(errText(e));
    }
  }, [client]);
  useEffect(() => {
    void refresh();
  }, [refresh, providersVersion]);

  const configured = data.providers;
  const available = useMemo(
    () =>
      data.presets.filter(
        (p) => p.defaultName === "" || !configured.some((c) => c.id === p.defaultName),
      ),
    [data.presets, configured],
  );
  const selProvider =
    sel?.kind === "provider" ? configured.find((p) => p.id === sel.id) : undefined;
  const selPreset = sel?.kind === "preset" ? available.find((p) => p.id === sel.id) : undefined;

  // 选中项消失（删除后、或预设已被配置）回落到列表第一项
  useEffect(() => {
    if (sel === null) return;
    const gone =
      sel.kind === "provider"
        ? !configured.some((p) => p.id === sel.id)
        : !available.some((p) => p.id === sel.id);
    if (!gone) return;
    const first = configured[0];
    const preset = available[0];
    setSel(
      first !== undefined
        ? { kind: "provider", id: first.id }
        : preset !== undefined
          ? { kind: "preset", id: preset.id }
          : null,
    );
  }, [sel, configured, available]);

  return (
    <section className="page3" data-testid="providers-page">
      <div className="ph3">
        <div className="grow">
          <h3>服务商</h3>
          <span className="sub">
            {configured.length} 个已配置 · 密钥和账号交给系统凭据存储，界面不留存
          </span>
        </div>
      </div>
      <div className="cols3">
        <nav className="plist" aria-label="服务商列表">
          <h5>已配置</h5>
          {configured.length === 0 && <span className="fine pad">暂无</span>}
          {configured.map((p) => (
            <a
              key={p.id}
              className={sel?.kind === "provider" && sel.id === p.id ? "on" : undefined}
              onClick={() => {
                setSel({ kind: "provider", id: p.id });
              }}
            >
              <span className={`dot ${statusDot(p)}`} />
              <span className="nm">{p.id}</span>
              <span className={`r${failed(p) ? " warn" : ""}`}>
                {p.id === currentProvider && <span className="tagc">当前</span>}
                {failed(p) ? "已失效" : `${p.modelCount} 个模型`}
              </span>
            </a>
          ))}
          <h5>可添加</h5>
          {available.map((p) => (
            <a
              key={p.id}
              className={sel?.kind === "preset" && sel.id === p.id ? "on" : undefined}
              onClick={() => {
                setSel({ kind: "preset", id: p.id });
              }}
            >
              <span className="dot off" />
              <span className="nm">{p.label}</span>
            </a>
          ))}
        </nav>
        <div className="pane">
          {client === undefined ? (
            <span className="fine">后台尚未就绪，稍后自动刷新。</span>
          ) : (
            <>
              {loadError !== null && <div className="errt">{loadError}</div>}
              {selProvider !== undefined && (
                <ProviderDetail
                  key={selProvider.id}
                  client={client}
                  provider={selProvider}
                  current={selProvider.id === currentProvider}
                  inUse={inUse?.has(selProvider.id) === true}
                  defaultKey={data.defaultKey}
                  openUrl={openUrl}
                  onChanged={() => void refresh()}
                  onOpenModels={onOpenModels}
                />
              )}
              {selPreset !== undefined && (
                <PresetForm
                  key={selPreset.id}
                  client={client}
                  preset={selPreset}
                  openUrl={openUrl}
                  onSaved={(providerId) => {
                    setSel({ kind: "provider", id: providerId });
                    void refresh();
                  }}
                />
              )}
              {sel === null && loadError === null && <span className="fine">选择左侧条目</span>}
            </>
          )}
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
  current,
  inUse,
  defaultKey,
  openUrl,
  onChanged,
  onOpenModels,
}: {
  client: RpcClient;
  provider: ProviderOverview;
  current: boolean;
  inUse: boolean;
  defaultKey: string | null;
  openUrl: (url: string) => void;
  onChanged: () => void;
  onOpenModels?: (() => void) | undefined;
}) {
  const [models, setModels] = useState<ModelSettingsView[] | null>(null);
  const [query, setQuery] = useState("");
  const [editModel, setEditModel] = useState<ModelSettingsView | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | "rekey" | "remove" | "logout">(null);
  const [relogin, setRelogin] = useState<ReloginState>({ kind: "idle" });
  const [loginError, setLoginError] = useState<string | null>(null);
  const [unstored, setUnstored] = useState<NonNullable<LoginCompleted["unstoredKey"]> | null>(null);
  /** 删除被服务端以 provider_in_use 拒绝后置灰 */
  const [refusedInUse, setRefusedInUse] = useState(false);

  const loadModels = useCallback(async () => {
    try {
      setModels(await client.provider.listModelSettings(p.id));
    } catch {
      setModels([]);
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

  const cred = credentialText(p);
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

  const deleteBlocked = !p.managed
    ? `此条目由 ${originText(p)} 定义，只读；请修改对应配置文件`
    : inUse || refusedInUse
      ? "当前会话正在使用，不能删除"
      : null;
  const auth = p.authKind;
  const showRelogin = auth === "account" && failed(p);

  return (
    <>
      <div className="t1">
        <div className="provider-heading">
          <h3 className="mono">{p.id}</h3>
          {current && <span className="tagc">当前</span>}
          {failed(p) && <span className="tagw">已失效</span>}
          {p.overridden && <span className="tagw">被更高层覆盖</span>}
        </div>
        <span className="acts">
          {(auth === "apiKey" || auth === "none") && p.managed && (
            <button
              className="btn"
              disabled={busy !== null}
              onClick={() => {
                setDialog("rekey");
              }}
            >
              {auth === "none" ? "设置密钥" : "换密钥"}
            </button>
          )}
          <button
            className="btn"
            disabled={busy !== null}
            onClick={() => void run("refresh", () => client.provider.refreshUpstreamLimits(p.id))}
          >
            {busy === "refresh" ? "刷新中…" : "刷新模型列表"}
          </button>
          {auth === "account" && p.managed && (
            <button
              className="btn"
              disabled={busy !== null}
              onClick={() => {
                setDialog("logout");
              }}
            >
              退出登录
            </button>
          )}
          <span title={deleteBlocked ?? undefined}>
            <button
              className="btn danger"
              disabled={busy !== null || deleteBlocked !== null}
              onClick={() => {
                setDialog("remove");
              }}
            >
              删除
            </button>
          </span>
        </span>
      </div>

      {!p.managed && (
        <div className="hint">只读：此条目来自 {originText(p)}，请修改对应配置文件。</div>
      )}
      {showRelogin && (
        <div className="pbanner">
          账号登录已失效<span>需要重新登录才能继续调用 {p.id} 的模型</span>
          {relogin.kind === "waiting" ? null : relogin.kind === "storage" ? (
            <span className="seg">
              {relogin.setup.options.map((o) => (
                <button key={o.value} onClick={() => void startLogin(o.value)}>
                  {o.label}
                </button>
              ))}
            </span>
          ) : (
            <button
              className="btn"
              disabled={relogin.kind === "starting"}
              onClick={() => void startLogin()}
            >
              {relogin.kind === "starting" ? "启动中…" : "重新登录"}
            </button>
          )}
        </div>
      )}
      {relogin.kind === "storage" && <div className="hint">{relogin.setup.notice}</div>}
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
      {loginError !== null && <div className="errt">{loginError}</div>}
      {unstored !== null && <UnstoredKey value={unstored} />}

      <dl className="kv">
        <div>
          <dt>类型</dt>
          <dd>{typeText(p.type)}</dd>
        </div>
        <div>
          <dt>地址</dt>
          <dd className="mono" title={p.host ?? "官方端点"}>
            {p.host ?? "官方端点"}
          </dd>
        </div>
        <div>
          <dt>认证</dt>
          <dd title={p.auth ?? ""}>{p.auth ?? "—"}</dd>
        </div>
        <div>
          <dt>凭据</dt>
          <dd className={cred.cls}>{cred.text}</dd>
        </div>
        <div>
          <dt>保存位置</dt>
          <dd>{storageText(p)}</dd>
        </div>
        <div>
          <dt>来源</dt>
          <dd className="mono">{originText(p)}</dd>
        </div>
      </dl>

      {(actionError !== null || notice !== null) && (
        <div className={actionError !== null ? "errt" : "done"}>{actionError ?? notice}</div>
      )}

      <div className="sh">
        <h4>模型</h4>
        <small>
          {models === null
            ? "…"
            : q === ""
              ? `${models.length} 个`
              : `${filtered.length} / ${models.length}`}
        </small>
        <input
          className="search"
          placeholder="搜索模型"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
          }}
          aria-label="搜索模型"
        />
      </div>
      <div className="mt">
        <div className="mr h">
          <span>模型</span>
          <span>能力</span>
          <span className="num model-context">上下文</span>
          <span className="num model-output">最大输出</span>
          <span />
        </div>
        {filtered.map((m) => {
          const c = caps(m);
          const name = m.fields.displayName.value ?? m.modelId;
          return (
            <div className="mr" key={m.modelId}>
              <span className="m">
                <span title={m.modelId}>{name}</span>
                {defaultKey === `${p.id}/${m.modelId}` && <span className="dflt">默认</span>}
                {Object.values(m.fields).some((f) => f.userValue !== undefined) && (
                  <span className="edited">已编辑</span>
                )}
              </span>
              <span className="cap">
                {c.r && <b title="推理">R</b>}
                {c.i && <b title="图片输入">I</b>}
              </span>
              <span className="num model-context">{fullTokens(m.fields.contextWindow.value)}</span>
              <span className="num model-output">
                {shortTokens(m.fields.maxOutputTokens.value)}
              </span>
              <a
                className="lnk"
                onClick={() => {
                  setEditModel(m);
                }}
              >
                设置
              </a>
            </div>
          );
        })}
        {models !== null && filtered.length === 0 && (
          <div className="mr empty">
            <span className="fine">{models.length === 0 ? "没有模型" : "无匹配模型"}</span>
          </div>
        )}
      </div>
      <span className="fine">
        R 推理 · I 图片输入。默认模型在「
        <button type="button" className="lk" onClick={onOpenModels}>
          模型
        </button>
        」页修改。
      </span>

      {editModel !== null && (
        <ModelSettingsDialog
          view={editModel}
          provider={client.provider}
          providerId={p.id}
          readonly={!p.managed}
          readonlyHint={!p.managed ? `只读：此条目来自 ${originText(p)}` : undefined}
          onClose={() => {
            setEditModel(null);
          }}
          onSaved={() => {
            void loadModels();
            onChanged();
          }}
        />
      )}
      {dialog === "rekey" && (
        <RekeyDialog
          client={client}
          providerId={p.id}
          onClose={() => {
            setDialog(null);
          }}
          onDone={() => {
            setDialog(null);
            setNotice("已更换密钥");
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

/* ---------------- 换密钥对话框 ---------------- */

function RekeyDialog({
  client,
  providerId,
  onClose,
  onDone,
}: {
  client: RpcClient;
  providerId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    if (busy || key.trim() === "") return;
    setBusy(true);
    setError(null);
    client.provider
      .setCredential(providerId, key.trim())
      .then(() => {
        setKey("");
        onDone();
      })
      .catch((e: unknown) => {
        setError(errText(e));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <Scrim onClose={onClose}>
      <div className="dlg narrow" role="dialog" aria-label={`换密钥 · ${providerId}`}>
        <div className="dh3">
          <b>换密钥 · {providerId}</b>
          <span>新密钥交给系统凭据存储，界面不留存。</span>
        </div>
        <div className="db">
          <input
            className="input"
            type="password"
            placeholder="新的 API Key"
            aria-label="新的 API Key"
            autoComplete="off"
            autoFocus
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
          {error !== null && <div className="errt">{error}</div>}
        </div>
        <div className="df">
          <span className="sp" />
          <button className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="btn primary" disabled={busy || key.trim() === ""} onClick={submit}>
            {busy ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </Scrim>
  );
}

/* ---------------- 确认对话框 ---------------- */

export function Scrim({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <div
      className="scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      {children}
    </div>
  );
}

function ConfirmDialog({
  title,
  body,
  confirmLabel,
  danger = false,
  onClose,
  onConfirm,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Scrim onClose={onClose}>
      <div className="dlg narrow" role="dialog" aria-label={title}>
        <div className="dh3">
          <b>{title}</b>
          <span>{body}</span>
        </div>
        <div className="df">
          <span className="sp" />
          <button className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            className={`btn ${danger ? "danger" : "primary"}`}
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void onConfirm().finally(() => {
                setBusy(false);
              });
            }}
          >
            {busy ? "处理中…" : confirmLabel}
          </button>
        </div>
      </div>
    </Scrim>
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
  onSaved,
}: {
  client: RpcClient;
  preset: ProviderPreset;
  openUrl: (url: string) => void;
  onSaved: (providerId: string) => void;
}) {
  const [setup, setSetup] = useState<ProviderSetupDescription | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  /** choose 的选择（OpenRouter：浏览器登录 / 粘贴密钥）；无 choose 时为 null */
  const [choice, setChoice] = useState<"login" | "apiKey" | null>(null);
  /** 密钥方式下是否改用环境变量 */
  const [useEnv, setUseEnv] = useState(false);
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
        <div className="t1">
          <h3>添加 {preset.label}</h3>
        </div>
        <div className="errt">{setupError}</div>
      </>
    );
  }
  if (setup === null) return <span className="fine">加载表单…</span>;

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
      if (apiKeyMethod?.available === true && !(useEnv && envMethod !== undefined)) return "apiKey";
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
        return apiKey.trim() !== "" ? { kind: "apiKey", key: apiKey.trim() } : null;
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
  const fieldInputs: Record<string, true> = {};
  for (const f of setup.fields) if (f.fixed === undefined) fieldInputs[f.key] = true;
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
    const sessionHeader = values.sessionHeader?.trim();
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
        ...(sessionHeader !== undefined && sessionHeader !== "" ? { sessionHeader } : {}),
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
    setUseEnv(false);
    setFieldErr({});
    setLoginErr(null);
    setCommitErr(null);
    setFetchState({ kind: "idle" });
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

  const errorUnder = (key: string) =>
    fieldErr[key] !== undefined ? <div className="errt">{fieldErr[key]}</div> : null;
  const fixedFields = setup.fields.filter((f) => f.fixed !== undefined);
  const printNotices = (fetched?.notices ?? []).filter((n) => n.kind === "print");

  return (
    <>
      <div className="t1">
        <h3>添加 {setup.label}</h3>
      </div>
      <div className="form">
        {fixedFields.length > 0 && (
          <div className="fixed">
            {fixedFields.map((f) => (
              <span key={f.key}>
                {labelOf(f.prompt)} <b className="mono">{f.fixed}</b>
              </span>
            ))}
          </div>
        )}
        {setup.fields
          .filter((f) => f.fixed === undefined)
          .map((f) => (
            <div className="field" key={f.key}>
              <div className="lab">
                <label htmlFor={`pf-${f.key}`}>{labelOf(f.prompt)}</label>
                {!f.required && <small>可选</small>}
              </div>
              <input
                id={`pf-${f.key}`}
                className={`input${fieldErr[f.key] !== undefined ? " err" : ""}`}
                type="text"
                spellCheck={false}
                placeholder={f.key === "baseURL" ? (preset.baseURL ?? "") : undefined}
                value={values[f.key] ?? ""}
                onChange={(e) => {
                  setField(f.key, e.target.value);
                }}
              />
              {errorUnder(f.key) ??
                (hintOf(f.hint) !== "" && <div className="hint">{hintOf(f.hint)}</div>)}
            </div>
          ))}

        {setup.credential.choose !== undefined && (
          <div className="field">
            <div className="lab">
              <label>{labelOf(setup.credential.choose.prompt).replace(/（[^）]*）/, "")}</label>
            </div>
            <div className="seg">
              {setup.credential.choose.options.map((o) => (
                <button
                  key={o.method}
                  className={choice === o.method ? "on" : undefined}
                  onClick={() => {
                    if (choice === o.method) return;
                    setChoice(o.method);
                    if (draftLogin.kind !== "none") resetLogin();
                    invalidate();
                  }}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {mode === "apiKey" && apiKeyMethod !== undefined && (
          <div className="field">
            <div className="lab">
              <label htmlFor="pf-key">{labelOf(apiKeyMethod.prompt)}</label>
              {envMethod !== undefined && (
                <a
                  className="lk"
                  onClick={() => {
                    setUseEnv(true);
                    setApiKey("");
                    clearFieldErr("credential");
                    invalidate();
                  }}
                >
                  改用环境变量
                </a>
              )}
            </div>
            <input
              id="pf-key"
              className={`input${fieldErr.credential !== undefined ? " err" : ""}`}
              type="password"
              autoComplete="off"
              placeholder="粘贴密钥"
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                clearFieldErr("credential");
                invalidate();
              }}
            />
            {errorUnder("credential") ?? (
              <div className="hint">
                {[
                  hintOf(apiKeyMethod.hint),
                  `交给 ${setup.credential.backend.label} 保存，不写进配置文件`,
                ]
                  .filter((s) => s !== "")
                  .join("；")}
              </div>
            )}
          </div>
        )}
        {mode === "env" && envMethod !== undefined && (
          <div className="field">
            <div className="lab">
              <label htmlFor="pf-env">{labelOf(envMethod.prompt)}</label>
              {apiKeyMethod?.available === true && (
                <a
                  className="lk"
                  onClick={() => {
                    setUseEnv(false);
                    clearFieldErr("credential");
                    invalidate();
                  }}
                >
                  改用密钥
                </a>
              )}
            </div>
            <input
              id="pf-env"
              className={`input mono${fieldErr.credential !== undefined ? " err" : ""}`}
              type="text"
              spellCheck={false}
              placeholder={envMethod.defaultName}
              value={envName}
              onChange={(e) => {
                setEnvName(e.target.value);
                clearFieldErr("credential");
                invalidate();
              }}
            />
            {errorUnder("credential") ?? (
              <div className="hint">
                {apiKeyMethod?.available === false
                  ? `${setup.credential.backend.label}不可用，改为读取环境变量；配置里只记变量名`
                  : `${hintOf(envMethod.hint)}；配置里只记变量名`}
              </div>
            )}
          </div>
        )}
        {mode === "login" && loginMethod !== undefined && (
          <div className="field">
            <div className="lab">
              <label>{loginMethod.label}</label>
              <small>在浏览器完成授权后回到这里继续</small>
            </div>
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
                    <div className="hint warnt">{storageSetup.notice}</div>
                    <div className="seg" role="group" aria-label={labelOf(storageSetup.prompt)}>
                      {storageSetup.options.map((o) => (
                        <button
                          key={o.value}
                          className={storagePick === o.value ? "on" : undefined}
                          onClick={() => {
                            setStoragePick(o.value);
                          }}
                        >
                          {o.label}
                        </button>
                      ))}
                    </div>
                  </>
                )}
                <div>
                  <button
                    className="btn"
                    disabled={
                      draftLogin.kind === "starting" ||
                      (storageSetup !== undefined && storagePick === null)
                    }
                    onClick={() => void startLogin()}
                  >
                    {draftLogin.kind === "starting" ? "启动中…" : "开始登录"}
                  </button>
                </div>
              </>
            )}
            {loginErr !== null && <div className="errt">{loginErr}</div>}
          </div>
        )}
        {mode === "external-file" && externalMethod !== undefined && (
          <div className="field">
            <div className="lab">
              <label>{externalMethod.label}</label>
            </div>
            <div className="hint">{externalMethod.renewHint}</div>
          </div>
        )}
        {unstored !== null && <UnstoredKey value={unstored} />}

        <div className="fetch" aria-live="polite">
          <div className="fl">
            {fetchState.kind === "busy" ? (
              <button className="btn" onClick={cancelFetch}>
                取消获取
              </button>
            ) : (
              <button
                className="btn"
                disabled={credential === null}
                title={credential === null ? "先填好凭据（密钥、环境变量或登录）" : undefined}
                onClick={() => void fetchModels()}
              >
                {fetchState.kind === "ok" ? "重新获取" : "获取模型"}
              </button>
            )}
            {fetchState.kind === "busy" && <span className="fine">正在获取模型列表…</span>}
            {fetchState.kind === "idle" && (
              <span className="fine">只请求模型列表，不消耗 token，也不写入任何文件</span>
            )}
            {fetchState.kind === "ok" && (
              <>
                <span className={fetchState.result.modelCount > 0 ? "ok" : "bad"}>
                  {fetchState.result.modelCount > 0
                    ? `✓ 已获取 ${fetchState.result.modelCount} 个模型`
                    : setup.fetchableModels
                      ? "未获取到模型"
                      : "✓ 凭据可用"}
                </span>
                {fetchState.result.models.length > PEEK_MODELS && (
                  <button
                    type="button"
                    className="tog"
                    aria-expanded={listOpen}
                    onClick={() => {
                      setListOpen((v) => !v);
                    }}
                  >
                    {listOpen ? "收起 ▴" : "展开全部 ▾"}
                  </button>
                )}
              </>
            )}
            {/* 字段错误已标在输入框下时，这里不再重复「获取失败」 */}
            {fetchState.kind === "err" && !fetchState.field && (
              <>
                <span className="bad">获取失败</span>
                <span className="reason">{fetchState.message}</span>
              </>
            )}
          </div>
          {fetchState.kind === "ok" && fetchState.result.models.length > 0 && (
            <FetchedModels
              models={fetchState.result.models}
              open={listOpen || fetchState.result.models.length <= PEEK_MODELS}
            />
          )}
          {printNotices.length > 0 && (
            <div className="hint">{printNotices.map((n) => n.text).join(" ")}</div>
          )}
        </div>

        {needManual && (
          <div className="field">
            <div className="lab">
              <label htmlFor="pf-model">{labelOf(setup.manualModel?.prompt ?? "模型 ID")}</label>
            </div>
            <input
              id="pf-model"
              className={`input mono${fieldErr.modelId !== undefined ? " err" : ""}`}
              type="text"
              spellCheck={false}
              value={manualId}
              onChange={(e) => {
                setManualId(e.target.value);
                clearFieldErr("modelId");
              }}
            />
            {errorUnder("modelId") ??
              (setup.manualModel !== undefined && hintOf(setup.manualModel.hint) !== "" && (
                <div className="hint">{hintOf(setup.manualModel.hint)}</div>
              ))}
          </div>
        )}
        {commitErr !== null && fieldErr.modelId === undefined && (
          <div className="errt">{commitErr}</div>
        )}

        <div className="formacts">
          <button className="btn primary" disabled={!canSave} onClick={() => void save()}>
            {committing ? "保存中…" : "保存"}
          </button>
          <button className="btn ghost" disabled={committing} onClick={abandon}>
            取消
          </button>
        </div>
      </div>
    </>
  );
}
