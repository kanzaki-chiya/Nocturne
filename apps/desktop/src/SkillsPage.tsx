import { useCallback, useEffect, useRef, useState } from "react";
import type { RpcClient } from "@nocturne/rpc/client";
import type { SkillOverview, SkillsDescription } from "@nocturne/core/protocol";
import { projectName } from "./session-tree";
import { Scrim } from "./ProvidersPage";
import type { SkillImportCommit, SkillImportPreview } from "./rpc-types";
import "./pages.css";
import "./mcp.css";
import "./skills.css";

export const invocationText = (skill: SkillOverview) =>
  ({ both: "模型 + 用户", user: "只限用户", model: "只限模型", none: "不加载" })[skill.invocation];
export const catalogText = (skill: SkillOverview) =>
  skill.catalogStatus === "full"
    ? `完整说明${skill.displayedDescriptionLength < skill.description.length ? "（截断）" : ""}`
    : skill.catalogStatus === "name"
      ? "只显示名字"
      : "不列出";
export const skillStatus = (skill: SkillOverview) =>
  skill.shadowedBy
    ? "被覆盖"
    : !skill.enabled
      ? "已停用"
      : skill.missingDescription
        ? "缺说明"
        : skill.ignored.length
          ? `${skill.ignored.length} 处不生效`
          : invocationText(skill);

export function SkillsPage({
  client,
  workspaceRoot,
  version,
  openDirectory,
  openUrl,
  pickFolder,
}: {
  client: RpcClient | undefined;
  workspaceRoot: string | undefined;
  version: number;
  openDirectory: (path: string, create?: boolean) => Promise<void>;
  openUrl: (url: string) => Promise<void>;
  /** 系统文件夹对话框（导入来源）；缺省时「导入技能」按钮置灰 */
  pickFolder?: (() => Promise<string | null>) | undefined;
}) {
  const [data, setData] = useState<SkillsDescription>();
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const refreshGeneration = useRef(0);
  const refresh = useCallback(async () => {
    if (!client) return;
    const generation = ++refreshGeneration.current;
    try {
      const result = await client.runtime.describeSkills({ workspaceRoot });
      if (generation !== refreshGeneration.current) return;
      setData(result);
      setSelected((old) =>
        result.skills.some((s) => s.entryPath === old) ? old : result.skills[0]?.entryPath,
      );
      setError("");
    } catch (e) {
      if (generation === refreshGeneration.current)
        setError(e instanceof Error ? e.message : String(e));
    }
  }, [client, workspaceRoot]);
  useEffect(() => {
    void refresh();
    return () => {
      refreshGeneration.current++;
    };
  }, [refresh, version]);
  const skill = data?.skills.find((s) => s.entryPath === selected);
  const parseWarnings = data?.warnings.filter((w) => w.kind === "parse") ?? [];
  const attempt = async (action: () => Promise<void>) => {
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const toggle = async () => {
    if (!client || !skill || skill.shadowedBy || busy) return;
    setBusy(true);
    await attempt(async () => {
      const result = await client.runtime.setSkillEnabled({
        name: skill.name,
        enabled: !skill.enabled,
      });
      setToast(
        `已${skill.enabled ? "停用" : "启用"} ${skill.name} · ${result.affectedSessions} 个已打开的会话将在本轮结束后更新技能目录`,
      );
      await refresh();
    });
    setBusy(false);
  };
  const budget = data?.budget;
  const empty = data?.skills.length === 0;
  return (
    <div className="page3 mcp-page skills-page">
      <header className="ph3">
        <div className="grow">
          <h3>技能</h3>
          {budget && !empty ? (
            <div className="skill-budget">
              <span>模型目录</span>
              <meter
                min={0}
                max={Math.max(1, budget.limitTokens)}
                value={budget.usedTokens}
                aria-label="模型目录预算"
              />
              <span>
                <b>
                  {budget.usedTokens.toLocaleString()} / {budget.limitTokens.toLocaleString()}
                </b>{" "}
                token · 完整说明 {budget.fullCount} 个 · 只显示名字 {budget.nameCount} 个 · 已停用{" "}
                {budget.disabledCount} 个
              </span>
            </div>
          ) : (
            <span className="sub">{empty ? "没有找到技能" : "正在扫描技能…"}</span>
          )}
          {budget?.basis === "fallback" && (
            <span className="fine">模型上下文窗口未知，使用 8,000 token 上限</span>
          )}
        </div>
        <div className="acts">
          <button
            className="btn"
            disabled={client === undefined || pickFolder === undefined}
            title={pickFolder === undefined ? "当前宿主不支持选择文件夹" : undefined}
            onClick={() => {
              setImportOpen(true);
            }}
          >
            导入技能…
          </button>
        </div>
      </header>
      {error && (
        <div className="errt" role="alert">
          {error}
        </div>
      )}
      {empty ? (
        <div className="skill-empty">
          <span className="skill-empty-icon">▤</span>
          <h4>把常用的做法写成技能</h4>
          <p>
            技能是一个带 SKILL.md 的文件夹。Nocturne 会在
            ~/.nocturne/skills、~/.agents/skills、~/.claude/skills 和项目里的同名目录中查找，Claude
            Code、Codex 装好的技能可以直接用。
          </p>
          <div>
            <button
              className="btn primary"
              onClick={() => void attempt(() => openDirectory(data.homeDir, true))}
            >
              打开技能文件夹
            </button>
            <button
              className="btn"
              onClick={() => void attempt(() => openUrl("https://agentskills.io"))}
            >
              Agent Skills 规范 ↗
            </button>
          </div>
          <SkillWarnings warnings={parseWarnings} />
          <p className="fine">扫描目录：{data.scannedDirs.join("、")}</p>
        </div>
      ) : (
        <div className="cols3">
          <nav className="plist" aria-label="技能列表">
            {(["user", "project"] as const).map((layer) => (
              <div key={layer}>
                <h5>
                  {layer === "user"
                    ? "用户"
                    : `项目 · ${workspaceRoot ? projectName(workspaceRoot) : "当前工作区"}`}
                </h5>
                {data?.skills
                  .filter((s) => s.layer === layer)
                  .map((s) => (
                    <button
                      type="button"
                      className={`mcp-server-row skill-row ${s.entryPath === selected ? "on" : ""}`}
                      key={s.entryPath}
                      onClick={() => {
                        setSelected(s.entryPath);
                      }}
                      aria-current={s.entryPath === selected ? "true" : undefined}
                    >
                      <span
                        className={`dot ${!s.enabled || s.shadowedBy ? "off" : s.missingDescription || s.ignored.length ? "warn" : "ok"}`}
                      />
                      <span className={`nm ${s.shadowedBy ? "shadowed" : ""}`}>{s.name}</span>
                      <span className="tagc">{s.source === "extra" ? "额外目录" : s.source}</span>
                      <small>{skillStatus(s)}</small>
                    </button>
                  ))}
              </div>
            ))}
            <SkillWarnings warnings={parseWarnings} />
            <span className="fine skill-scanned">扫描目录：{data?.scannedDirs.join("、")}</span>
          </nav>
          <div className="pane">
            {skill && (
              <>
                <div className="t1">
                  <h3>{skill.name}</h3>
                  <span className="tagc">
                    {skill.layer === "user" ? "用户" : "项目"} ·{" "}
                    {skill.source === "extra" ? "额外目录" : skill.source}
                  </span>
                  <div className="acts">
                    <button
                      className={`mcp-switch ${skill.enabled ? "on" : ""}`}
                      role="switch"
                      aria-checked={skill.enabled}
                      aria-label={`启用 ${skill.name}`}
                      disabled={!!skill.shadowedBy || busy}
                      onClick={() => void toggle()}
                    >
                      {skill.enabled ? "启用" : "停用"}
                    </button>
                    <span className="mcp-action-divider" />
                    {skill.shadowedBy && (
                      <button
                        className="btn"
                        onClick={() => {
                          setSelected(skill.shadowedBy);
                        }}
                      >
                        查看生效的那份
                      </button>
                    )}
                    <button
                      className="btn"
                      onClick={() => void attempt(() => openDirectory(skill.realPath))}
                    >
                      在资源管理器中打开 ↗
                    </button>
                  </div>
                </div>
                {skill.shadowedBy && (
                  <div className="skill-banner info">
                    被
                    {data?.skills.find((s) => s.entryPath === skill.shadowedBy)?.layer === "user"
                      ? "用户"
                      : "项目"}
                    技能 {skill.name} 覆盖
                    <span>
                      同名时用户层优先，生效的是 <code>{skill.shadowedBy}</code>
                      ，这一份不会被加载。想两份都用，把其中一份改名。
                    </span>
                  </div>
                )}
                {skill.missingDescription && (
                  <div className="skill-banner warn">
                    缺少说明，模型看不到这个技能
                    <span>
                      SKILL.md 的前言里没有 <code>description</code>。现在只能用{" "}
                      <code>/{skill.name}</code>{" "}
                      手动调用；补上一句「做什么、什么时候用」，下个会话起就会进入模型目录。
                    </span>
                  </div>
                )}
                {skill.commandConflict && (
                  <div className="skill-banner warn">
                    与内置命令重名，斜杠不能调用
                    <span>
                      <code>/{skill.name}</code>{" "}
                      已经是内置命令，内置命令优先。模型仍然可以加载这个技能；想手动调用，把技能改名。
                    </span>
                  </div>
                )}
                {!!skill.ignored.length && (
                  <>
                    <div className="skill-banner warn">
                      有 {skill.ignored.length} 处写法在 Nocturne 里不生效
                      <span>
                        技能照常可用。Nocturne
                        不让技能文件自己放行工具或执行命令，这些操作都要经过权限设置。
                      </span>
                    </div>
                    <table className="skill-ignored">
                      <thead>
                        <tr>
                          <th>写法</th>
                          <th>在 Nocturne 里</th>
                        </tr>
                      </thead>
                      <tbody>
                        {skill.ignored.map((item, i) => (
                          <tr key={i}>
                            <td>
                              <code>{item.syntax}</code>
                            </td>
                            <td>{item.reason}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                )}
                <dl className="kv skill-kv">
                  <div className="full">
                    <dt>位置</dt>
                    <dd>
                      <code>{skill.realPath}\SKILL.md</code>
                      {skill.otherEntries.length > 0 && (
                        <div className="fine">
                          经 {skill.entryPath} 进入；另有入口 {skill.otherEntries.join("、")}{" "}
                          指向同一目录，只算一个
                        </div>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>调用</dt>
                    <dd>{invocationText(skill)}</dd>
                  </div>
                  <div>
                    <dt>斜杠</dt>
                    <dd>
                      <code>
                        {skill.invocation === "both" || skill.invocation === "user"
                          ? `/${skill.name} ${typeof skill.fields["argument-hint"] === "string" ? skill.fields["argument-hint"] : ""}`
                          : "—"}
                      </code>
                    </dd>
                  </div>
                  <div>
                    <dt>模型目录</dt>
                    <dd>{catalogText(skill)}</dd>
                  </div>
                  <div>
                    <dt>大小</dt>
                    <dd>
                      {(skill.size / 1024).toFixed(1)} KB
                      {skill.files.some((f) => f.directory)
                        ? ` · ${skill.files.filter((f) => f.directory).length} 个子目录`
                        : ""}
                    </dd>
                  </div>
                </dl>
                {skill.description && (
                  <>
                    <div className="skill-heading">
                      <h4>说明</h4>
                      <small>
                        {skill.description.length} 字符
                        {skill.catalogStatus === "full" &&
                        skill.displayedDescriptionLength < skill.description.length
                          ? ` · 模型目录里显示前 ${skill.displayedDescriptionLength} 字符`
                          : ""}
                      </small>
                    </div>
                    <div className="skill-description">
                      {skill.catalogStatus === "full" &&
                      skill.displayedDescriptionLength < skill.description.length ? (
                        <>
                          {skill.description.slice(0, skill.displayedDescriptionLength)}
                          <span className="skill-cut">模型目录到此为止</span>
                          <span className="skill-truncated">
                            {skill.description.slice(skill.displayedDescriptionLength)}
                          </span>
                        </>
                      ) : (
                        skill.description
                      )}
                    </div>
                  </>
                )}
                <div className="skill-heading">
                  <h4>前言字段</h4>
                </div>
                <div className="chips">
                  {Object.keys(skill.fields).map((key) => (
                    <span key={key} title={JSON.stringify(skill.fields[key])}>
                      {key}
                    </span>
                  ))}
                  {Object.keys(skill.unknownFields).map((key) => (
                    <span
                      key={key}
                      className="skill-unknown"
                      title={JSON.stringify(skill.unknownFields[key])}
                    >
                      {key} · 仅展示
                    </span>
                  ))}
                  {skill.ignored
                    .filter((i) => !i.syntax.startsWith("!") && !i.syntax.startsWith("```!"))
                    .map((i) => (
                      <span key={i.syntax} className="skill-ignored-chip" title={i.syntax}>
                        {i.syntax.split(":")[0]}
                      </span>
                    ))}
                </div>
                <div className="skill-heading">
                  <h4>正文预览</h4>
                  <small>
                    前 {Math.min(40, skill.bodyLines)} 行 · 共 {skill.bodyLines} 行
                  </small>
                </div>
                <pre className="tail">{skill.bodyPreview}</pre>
                <div className="skill-heading">
                  <h4>支持文件</h4>
                  <small>模型读取这些文件不需要确认</small>
                </div>
                <div className="chips">
                  {skill.files
                    .filter((f) => f.name !== "SKILL.md")
                    .map((f) => (
                      <span key={f.name}>
                        {f.name}
                        {f.directory ? "/" : ""}
                      </span>
                    ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {toast && (
        <div className="skill-toast" role="status">
          ✓ {toast}
        </div>
      )}
      {importOpen && client !== undefined && pickFolder !== undefined && (
        <SkillImportDialog
          client={client}
          workspaceRoot={workspaceRoot}
          pickFolder={pickFolder}
          onClose={() => {
            setImportOpen(false);
          }}
          onDone={(message) => {
            setImportOpen(false);
            setToast(message);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

function SkillWarnings({ warnings }: { warnings: SkillsDescription["warnings"] }) {
  return warnings.length ? (
    <details className="skill-warnings">
      <summary>{warnings.length} 个技能的前言解析失败 · 查看 ›</summary>
      {warnings.map((w, i) => (
        <div key={i}>
          <code>
            {w.path}:{w.line}
          </code>
          <span>{w.message}</span>
        </div>
      ))}
    </details>
  ) : null;
}

/* ---------------- 导入技能（U-08） ---------------- */

type ImportPhase =
  | { kind: "pick" }
  | { kind: "previewing" }
  | { kind: "review" }
  | { kind: "committing" }
  | { kind: "done" };

/**
 * 导入技能对话框（U-08，ADR-0048 修订）：来源只支持本地文件夹（系统
 * 对话框选择，已有 dialog 插件，不新增）。选中的文件夹本身含 SKILL.md
 * 时作为单个技能，否则扫描下一层子目录。预检返回候选与冲突，执行时
 * 带逐项决定；写入经 Core（skills.importSkills），客户端不直接写目录。
 */
function SkillImportDialog({
  client,
  workspaceRoot,
  pickFolder,
  onClose,
  onDone,
}: {
  client: RpcClient;
  workspaceRoot: string | undefined;
  pickFolder: () => Promise<string | null>;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [phase, setPhase] = useState<ImportPhase>({ kind: "pick" });
  const [target, setTarget] = useState<"user" | "project">("user");
  const [preview, setPreview] = useState<SkillImportPreview | null>(null);
  const [actions, setActions] = useState<Record<string, "rename" | "overwrite" | "skip">>({});
  const [names, setNames] = useState<Record<string, string>>({});
  const [results, setResults] = useState<SkillImportCommit["results"]>([]);
  const [affectedSessions, setAffectedSessions] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [disabling, setDisabling] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const runPreview = async (sourceDir: string, picked: "user" | "project") => {
    setPhase({ kind: "previewing" });
    setError(null);
    try {
      const out = await client.runtime.importSkills({
        mode: "preview",
        sourceDir,
        target: picked,
        ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
      });
      if (!mounted.current) return;
      if (out.mode !== "preview") return;
      setPreview(out);
      const initialActions: Record<string, "rename" | "overwrite" | "skip"> = {};
      const initialNames: Record<string, string> = {};
      for (const candidate of out.candidates) {
        if (!candidate.valid) continue;
        if (candidate.targetConflict) {
          initialActions[candidate.sourcePath] = "rename";
          initialNames[candidate.sourcePath] = candidate.suggestedName ?? `${candidate.name}-2`;
        } else {
          initialActions[candidate.sourcePath] = "overwrite";
        }
      }
      setActions(initialActions);
      setNames(initialNames);
      setPhase({ kind: "review" });
    } catch (e) {
      if (!mounted.current) return;
      setError(e instanceof Error ? e.message : String(e));
      setPhase({ kind: "pick" });
    }
  };

  const pick = async () => {
    const dir = await pickFolder().catch((e: unknown) => {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    });
    if (dir === null) return;
    await runPreview(dir, target);
  };

  const commit = async () => {
    if (preview === null) return;
    const decisions = preview.candidates
      .filter((c) => c.valid)
      .map((c) => {
        const action = actions[c.sourcePath] ?? "skip";
        return {
          sourcePath: c.sourcePath,
          ...(action === "rename" ? { name: (names[c.sourcePath] ?? "").trim() || c.name } : {}),
          action,
        };
      });
    if (decisions.length === 0) {
      setError("没有可导入的候选");
      return;
    }
    setPhase({ kind: "committing" });
    setError(null);
    try {
      const out = await client.runtime.importSkills({
        mode: "commit",
        target: preview.targetLayer,
        ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
        decisions,
      });
      if (!mounted.current) return;
      if (out.mode !== "commit") return;
      setResults(out.results);
      setAffectedSessions(out.affectedSessions);
      setPhase({ kind: "done" });
    } catch (e) {
      if (!mounted.current) return;
      setError(e instanceof Error ? e.message : String(e));
      setPhase({ kind: "review" });
    }
  };

  const disable = async (name: string) => {
    setDisabling(name);
    try {
      const result = await client.runtime.setSkillEnabled({ name, enabled: false });
      if (!mounted.current) return;
      onDone(`已导入并停用 ${name} · ${result.affectedSessions} 个已打开的会话将在本轮结束后更新`);
    } catch (e) {
      if (!mounted.current) return;
      setError(e instanceof Error ? e.message : String(e));
      setDisabling(null);
    }
  };

  const validCount = preview?.candidates.filter((c) => c.valid).length ?? 0;
  return (
    <Scrim onClose={onClose}>
      <div className="dlg" role="dialog" aria-label="导入技能">
        <div className="dh3">
          <b>导入技能</b>
          <span>只支持本地文件夹；只复制文件，不执行其中任何脚本。</span>
        </div>
        <div className="db">
          <div className="field">
            <div className="lab">
              <label>导入到</label>
            </div>
            <span className="seg" role="group" aria-label="导入目标">
              <button
                className={target === "user" ? "on" : ""}
                onClick={() => {
                  setTarget("user");
                }}
              >
                用户技能
              </button>
              <button
                className={target === "project" ? "on" : ""}
                disabled={workspaceRoot === undefined}
                title={workspaceRoot ?? "先在左栏选中一个工作区"}
                onClick={() => {
                  setTarget("project");
                }}
              >
                当前工作区
              </button>
            </span>
          </div>
          {phase.kind === "pick" && (
            <div className="fl">
              <span>选中的文件夹本身含 SKILL.md 时作为单个技能；否则扫描其下一层子目录。</span>
              <button className="btn primary" onClick={() => void pick()}>
                选择文件夹…
              </button>
            </div>
          )}
          {phase.kind === "previewing" && <div className="fl">正在扫描…</div>}
          {(phase.kind === "review" || phase.kind === "committing") && preview !== null && (
            <>
              <div className="fine">
                目标 {preview.targetDir} · {validCount} 个可导入
              </div>
              {preview.candidates.map((candidate) => (
                <div className="fetch" key={candidate.sourcePath}>
                  <div className="fl">
                    <b>{candidate.name}</b>
                    <span className="fine">{(candidate.sizeBytes / 1024).toFixed(1)} KB</span>
                    {!candidate.valid && <span className="bad">{candidate.reason}</span>}
                  </div>
                  {candidate.valid && (
                    <>
                      {candidate.missingDescription && (
                        <div className="fl">
                          <span className="bad">缺少说明，模型看不到这个技能（仍可导入）</span>
                        </div>
                      )}
                      {candidate.skippedLinks.length > 0 && (
                        <div className="fl">
                          <span className="fine">
                            跳过 {candidate.skippedLinks.length} 个符号链接：
                            {candidate.skippedLinks.slice(0, 3).join("、")}
                            {candidate.skippedLinks.length > 3 ? "…" : ""}
                          </span>
                        </div>
                      )}
                      {candidate.shadowNote !== undefined && !candidate.targetConflict && (
                        <div className="fl">
                          <span className="fine">{candidate.shadowNote}</span>
                        </div>
                      )}
                      {candidate.targetConflict && (
                        <div className="fl">
                          <span className="bad">目标已存在同名技能</span>
                          <span
                            className="seg"
                            role="group"
                            aria-label={`${candidate.name} 重名处理`}
                          >
                            <button
                              className={actions[candidate.sourcePath] === "rename" ? "on" : ""}
                              onClick={() => {
                                setActions((cur) => ({ ...cur, [candidate.sourcePath]: "rename" }));
                              }}
                            >
                              改名
                            </button>
                            <button
                              className={actions[candidate.sourcePath] === "overwrite" ? "on" : ""}
                              onClick={() => {
                                setActions((cur) => ({
                                  ...cur,
                                  [candidate.sourcePath]: "overwrite",
                                }));
                              }}
                            >
                              覆盖
                            </button>
                            <button
                              className={actions[candidate.sourcePath] === "skip" ? "on" : ""}
                              onClick={() => {
                                setActions((cur) => ({ ...cur, [candidate.sourcePath]: "skip" }));
                              }}
                            >
                              跳过
                            </button>
                          </span>
                        </div>
                      )}
                      {candidate.targetConflict && actions[candidate.sourcePath] === "rename" && (
                        <div className="field">
                          <div className="lab">
                            <label>新名字</label>
                            <small>自动加后缀，同时改写 SKILL.md 的 name</small>
                          </div>
                          <input
                            className="input"
                            aria-label={`${candidate.name} 的新名字`}
                            value={names[candidate.sourcePath] ?? ""}
                            onChange={(e) => {
                              setNames((cur) => ({
                                ...cur,
                                [candidate.sourcePath]: e.target.value,
                              }));
                            }}
                          />
                        </div>
                      )}
                      {!candidate.targetConflict && (
                        <div className="fl">
                          <label>
                            <input
                              type="checkbox"
                              checked={(actions[candidate.sourcePath] ?? "overwrite") !== "skip"}
                              onChange={(e) => {
                                setActions((cur) => ({
                                  ...cur,
                                  [candidate.sourcePath]: e.target.checked ? "overwrite" : "skip",
                                }));
                              }}
                            />{" "}
                            导入
                          </label>
                        </div>
                      )}
                    </>
                  )}
                </div>
              ))}
            </>
          )}
          {phase.kind === "done" && (
            <>
              <div className="fine">
                {results.filter((r) => r.status === "imported").length} 个成功 · 跳过{" "}
                {results.filter((r) => r.status === "skipped").length} 个
                {affectedSessions > 0
                  ? ` · ${affectedSessions} 个已打开的会话将在本轮结束后看到新技能`
                  : ""}
              </div>
              {results.map((result) => (
                <div className="fetch" key={result.sourcePath}>
                  <div className="fl">
                    <b>{result.finalName ?? result.name}</b>
                    {result.status === "imported" ? (
                      <span className="ok">✓ 已导入</span>
                    ) : (
                      <span className="fine">
                        已跳过{result.reason ? `：${result.reason}` : ""}
                      </span>
                    )}
                    {result.missingDescription && result.status === "imported" && (
                      <span className="bad">缺少说明，模型看不到</span>
                    )}
                    {result.status === "imported" && (
                      <button
                        className="btn"
                        disabled={disabling !== null}
                        onClick={() => void disable(result.finalName ?? result.name)}
                      >
                        {disabling === (result.finalName ?? result.name) ? "停用中…" : "停用"}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </>
          )}
          {error !== null && <div className="errt">{error}</div>}
        </div>
        <div className="df">
          <span className="sp" />
          {phase.kind === "done" ? (
            <button className="btn primary" onClick={onClose}>
              关闭
            </button>
          ) : (
            <>
              <button className="btn" onClick={onClose}>
                取消
              </button>
              {(phase.kind === "review" || phase.kind === "committing") && (
                <button
                  className="btn primary"
                  disabled={phase.kind === "committing" || validCount === 0}
                  onClick={() => void commit()}
                >
                  {phase.kind === "committing" ? "导入中…" : `导入 ${validCount} 个`}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </Scrim>
  );
}
