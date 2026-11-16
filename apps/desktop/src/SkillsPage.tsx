import { useCallback, useEffect, useRef, useState } from "react";
import type { RpcClient } from "@nocturne/rpc/client";
import type { SkillOverview, SkillsDescription } from "@nocturne/core/protocol";
import { projectName } from "./session-tree";
import { Scrim } from "./ProvidersPage";
import type { SkillImportCommit, SkillImportPreview } from "./rpc-types";
import {
  Button,
  Checkbox,
  DataTable,
  EmptyState,
  ICON_MD,
  ICON_SM,
  Icon,
  IconButton,
  PageHeader,
  SegmentedControl,
  SettingsGroup,
  SettingsListRow,
  SettingsRow,
  Switch,
} from "./ui";
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
  !skill.enabled
    ? "已停用"
    : skill.missingDescription
      ? "缺说明"
      : skill.ignored.length
        ? `${skill.ignored.length} 处不生效`
        : invocationText(skill);
export const skillListMeta = (skill: SkillOverview): string | undefined =>
  !skill.enabled
    ? "已停用"
    : skill.missingDescription
      ? "缺说明"
      : skill.ignored.length
        ? `${skill.ignored.length} 处不生效`
        : undefined;

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
  const [query, setQuery] = useState("");
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
      const effective = result.skills.filter((s) => !s.shadowedBy);
      setSelected((old) =>
        old !== undefined && effective.some((s) => s.entryPath === old) ? old : undefined,
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
  const effective = data?.skills.filter((s) => !s.shadowedBy) ?? [];
  const skill =
    selected !== undefined ? effective.find((s) => s.entryPath === selected) : undefined;
  const shadowed = data?.skills.filter((s) => s.shadowedBy === skill?.entryPath) ?? [];
  const parseWarnings = data?.warnings.filter((w) => w.kind === "parse") ?? [];
  const attempt = async (action: () => Promise<void>) => {
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const toggleSkill = async (target: SkillOverview) => {
    if (!client || busy) return;
    setBusy(true);
    await attempt(async () => {
      await client.runtime.setSkillEnabled({
        name: target.name,
        enabled: !target.enabled,
      });
      setToast(`已${target.enabled ? "停用" : "启用"} ${target.name}`);
      await refresh();
    });
    setBusy(false);
  };
  const budget = data?.budget;
  const empty = data?.skills.length === 0;
  const normalizedQuery = query.trim().toLowerCase();
  const matchesQuery = (s: SkillOverview) =>
    !normalizedQuery ||
    s.name.toLowerCase().includes(normalizedQuery) ||
    s.description.toLowerCase().includes(normalizedQuery);
  const supportFiles = skill ? skill.files.filter((f) => f.name !== "SKILL.md") : [];
  const argumentHint =
    skill && typeof skill.fields["argument-hint"] === "string"
      ? skill.fields["argument-hint"].trim()
      : "";
  const slashText =
    skill && (skill.invocation === "both" || skill.invocation === "user")
      ? argumentHint
        ? `/${skill.name} ${argumentHint}`
        : `/${skill.name}`
      : null;
  const entryTitle =
    skill && skill.otherEntries.length > 0
      ? `经 ${skill.entryPath} 进入；另有入口 ${skill.otherEntries.join("、")} 指向同一目录，只算一个`
      : undefined;
  return (
    <div className="page3 skills-page">
      <div className="spage">
        <div className="readable">
          {skill ? (
            <>
              <PageHeader
                title={<span className="skill-detail-title">{skill.name}</span>}
                crumb={{
                  parent: "技能",
                  onBack: () => {
                    setSelected(undefined);
                  },
                }}
                actions={
                  <>
                    <Switch
                      checked={skill.enabled}
                      aria-label={`启用 ${skill.name}`}
                      disabled={busy}
                      onChange={() => void toggleSkill(skill)}
                    />
                    <IconButton
                      aria-label="在资源管理器中打开"
                      title="在资源管理器中打开"
                      onClick={() => void attempt(() => openDirectory(skill.realPath))}
                    >
                      <Icon name="folder" size={ICON_MD} />
                    </IconButton>
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
                  <SettingsRow label="位置">
                    <code title={entryTitle}>{skill.realPath}\SKILL.md</code>
                  </SettingsRow>
                  {shadowed.length > 0 && (
                    <SettingsRow label="同名">
                      {shadowed.map((s) => (
                        <div key={s.entryPath}>
                          <code>{s.realPath}\SKILL.md</code>
                        </div>
                      ))}
                    </SettingsRow>
                  )}
                  <SettingsRow label="调用">{invocationText(skill)}</SettingsRow>
                  <SettingsRow label="斜杠">
                    {slashText !== null ? (
                      <>
                        <code>{slashText}</code>
                        {skill.commandConflict && (
                          <span className="skill-warn">与内置命令重名</span>
                        )}
                      </>
                    ) : (
                      <span className="val dim">—</span>
                    )}
                  </SettingsRow>
                  <SettingsRow label="模型目录">{catalogText(skill)}</SettingsRow>
                  <SettingsRow label="大小">
                    {(skill.size / 1024).toFixed(1)} KB
                    {supportFiles.length > 0 && (
                      <>
                        <span className="val dim"> · </span>
                        {supportFiles.length} 个支持文件
                      </>
                    )}
                  </SettingsRow>
                </SettingsGroup>
                <SettingsGroup
                  title="说明"
                  plain
                  count={skill.description ? `${skill.description.length} 字` : undefined}
                >
                  {skill.description ? (
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
                  ) : (
                    <SettingsRow label={<span className="skill-warn">缺说明</span>} />
                  )}
                </SettingsGroup>
                <SettingsGroup title="前言字段" plain>
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
                        {key}（仅展示）
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
                </SettingsGroup>
                {skill.ignored.length > 0 && (
                  <SettingsGroup title="写法" plain count={skill.ignored.length}>
                    {skill.ignored.map((item, i) => (
                      <SettingsRow key={`${item.syntax}-${i}`} label={<code>{item.syntax}</code>}>
                        <span className="skill-warn">{item.reason}</span>
                      </SettingsRow>
                    ))}
                  </SettingsGroup>
                )}
                {supportFiles.length > 0 && (
                  <SettingsGroup title="支持文件" plain count={supportFiles.length}>
                    <DataTable
                      aria-label="支持文件"
                      rows={supportFiles}
                      rowKey={(f) => f.name}
                      columns={[
                        {
                          key: "name",
                          header: "文件",
                          mono: true,
                          render: (f) => `${f.name}${f.directory ? "/" : ""}`,
                        },
                      ]}
                    />
                  </SettingsGroup>
                )}
                <SettingsGroup
                  title="正文预览"
                  plain
                  count={`${Math.min(40, skill.bodyLines)} / ${skill.bodyLines} 行`}
                >
                  <pre className="tail">{skill.bodyPreview}</pre>
                </SettingsGroup>
              </div>
            </>
          ) : (
            <>
              <PageHeader
                title="技能"
                extra={
                  !empty && budget ? (
                    <span
                      className="skill-catalog-budget"
                      title={
                        budget.basis === "fallback"
                          ? "模型上下文窗口未知，使用 8,000 token 上限"
                          : undefined
                      }
                    >
                      模型目录{" "}
                      <span className="mono">
                        {budget.usedTokens.toLocaleString()} / {budget.limitTokens.toLocaleString()}
                      </span>
                    </span>
                  ) : undefined
                }
                actions={
                  <>
                    {!empty && (
                      <input
                        className="input skill-search"
                        placeholder="搜索技能"
                        aria-label="搜索技能"
                        value={query}
                        onChange={(e) => {
                          setQuery(e.target.value);
                        }}
                      />
                    )}
                    <Button
                      size="sm"
                      disabled={client === undefined || pickFolder === undefined}
                      title={pickFolder === undefined ? "当前宿主不支持选择文件夹" : undefined}
                      onClick={() => {
                        setImportOpen(true);
                      }}
                    >
                      导入技能…
                    </Button>
                  </>
                }
              />
              {error && (
                <div className="errt" role="alert">
                  {error}
                </div>
              )}
              {empty ? (
                <div>
                  <EmptyState
                    action={
                      <>
                        <Button
                          variant="primary"
                          onClick={() => void attempt(() => openDirectory(data.homeDir, true))}
                        >
                          打开技能文件夹
                        </Button>
                        <Button
                          onClick={() => void attempt(() => openUrl("https://agentskills.io"))}
                        >
                          Agent Skills 规范 ↗
                        </Button>
                      </>
                    }
                  />
                  <SkillWarnings warnings={parseWarnings} />
                </div>
              ) : (
                <div className="sbody">
                  {(["user", "project"] as const).map((layer) => {
                    const layerSkills = effective.filter((s) => s.layer === layer);
                    if (layerSkills.length === 0) return null;
                    const filtered = layerSkills.filter(matchesQuery);
                    return (
                      <SettingsGroup
                        key={layer}
                        plain
                        count={filtered.length}
                        title={
                          layer === "user" ? (
                            "用户"
                          ) : (
                            <>
                              项目
                              <span className="muted-value">
                                {workspaceRoot ? projectName(workspaceRoot) : "当前工作区"}
                              </span>
                            </>
                          )
                        }
                      >
                        {filtered.length === 0 ? (
                          <SettingsRow label={<span className="val dim">—</span>} />
                        ) : (
                          filtered.map((s) => (
                            <SettingsListRow
                              key={s.entryPath}
                              name={s.name}
                              mono
                              description={
                                s.missingDescription || !s.description ? (
                                  <span className="skill-warn">缺说明</span>
                                ) : (
                                  s.description
                                )
                              }
                              status={s.invocation !== "both" ? invocationText(s) : undefined}
                              toggle={
                                <Switch
                                  checked={s.enabled}
                                  aria-label={`启用 ${s.name}`}
                                  disabled={busy}
                                  onChange={() => void toggleSkill(s)}
                                />
                              }
                              disabled={!s.enabled}
                              onOpen={() => {
                                setSelected(s.entryPath);
                              }}
                            />
                          ))
                        )}
                      </SettingsGroup>
                    );
                  })}
                  <SkillWarnings warnings={parseWarnings} />
                </div>
              )}
            </>
          )}
        </div>
      </div>
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
      <summary>
        <Icon name="right_small" size={ICON_SM} className="fold-arrow" />
        {warnings.length} 个技能的前言解析失败，查看
      </summary>
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
      await client.runtime.setSkillEnabled({ name, enabled: false });
      if (!mounted.current) return;
      onDone(`已导入并停用 ${name}`);
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
        </div>
        <div className="db">
          <div className="field">
            <div className="lab">
              <label>导入到</label>
            </div>
            <SegmentedControl
              aria-label="导入目标"
              value={target}
              options={[
                { value: "user", label: "用户技能" },
                {
                  value: "project",
                  label: "当前工作区",
                  disabled: workspaceRoot === undefined,
                  title: workspaceRoot ?? "先在左栏选中一个工作区",
                },
              ]}
              onChange={setTarget}
            />
          </div>
          {phase.kind === "pick" && (
            <div className="fl">
              <Button variant="primary" onClick={() => void pick()}>
                选择文件夹…
              </Button>
            </div>
          )}
          {phase.kind === "previewing" && <div className="fl">正在扫描…</div>}
          {(phase.kind === "review" || phase.kind === "committing") && preview !== null && (
            <>
              <div className="fine">
                目标 {preview.targetDir}，{validCount} 个可导入
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
                          <SegmentedControl
                            aria-label={`${candidate.name} 重名处理`}
                            size="sm"
                            value={actions[candidate.sourcePath] ?? "rename"}
                            options={[
                              { value: "rename", label: "改名" },
                              { value: "overwrite", label: "覆盖" },
                              { value: "skip", label: "跳过" },
                            ]}
                            onChange={(val) => {
                              setActions((cur) => ({ ...cur, [candidate.sourcePath]: val }));
                            }}
                          />
                        </div>
                      )}
                      {candidate.targetConflict && actions[candidate.sourcePath] === "rename" && (
                        <div className="field">
                          <div className="lab">
                            <label>新名字</label>
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
                          <Checkbox
                            checked={(actions[candidate.sourcePath] ?? "overwrite") !== "skip"}
                            onChange={(checked) => {
                              setActions((cur) => ({
                                ...cur,
                                [candidate.sourcePath]: checked ? "overwrite" : "skip",
                              }));
                            }}
                          >
                            导入
                          </Checkbox>
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
                {results.filter((r) => r.status === "imported").length} 个成功，跳过{" "}
                {results.filter((r) => r.status === "skipped").length} 个
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
                      <Button
                        size="sm"
                        disabled={disabling !== null}
                        onClick={() => void disable(result.finalName ?? result.name)}
                      >
                        {disabling === (result.finalName ?? result.name) ? "停用中…" : "停用"}
                      </Button>
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
            <Button variant="primary" onClick={onClose}>
              关闭
            </Button>
          ) : (
            <>
              <Button onClick={onClose}>取消</Button>
              {(phase.kind === "review" || phase.kind === "committing") && (
                <Button
                  variant="primary"
                  disabled={phase.kind === "committing" || validCount === 0}
                  onClick={() => void commit()}
                >
                  {phase.kind === "committing" ? "导入中…" : `导入 ${validCount} 个`}
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    </Scrim>
  );
}
