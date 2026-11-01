import { useCallback, useEffect, useRef, useState } from "react";
import type { RpcClient } from "@nocturne/rpc/client";
import type { SkillOverview, SkillsDescription } from "@nocturne/core/protocol";
import { projectName } from "./session-tree";
import { Scrim } from "./ProvidersPage";
import type { SkillImportCommit, SkillImportPreview } from "./rpc-types";
import {
  Badge,
  Button,
  Checkbox,
  DataTable,
  DetailHeader,
  EmptyState,
  ListGroup,
  ListItem,
  MasterDetail,
  PageHeader,
  SegmentedControl,
  SettingsGroup,
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
  skill.shadowedBy
    ? "被覆盖"
    : !skill.enabled
      ? "已停用"
      : skill.missingDescription
        ? "缺说明"
        : skill.ignored.length
          ? `${skill.ignored.length} 处不生效`
          : invocationText(skill);
export const skillListMeta = (skill: SkillOverview): string | undefined =>
  skill.shadowedBy
    ? "被覆盖"
    : !skill.enabled
      ? "已停用"
      : skill.missingDescription
        ? "缺说明"
        : skill.ignored.length
          ? `${skill.ignored.length} 处不生效`
          : skill.source === "extra"
            ? "额外目录"
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
      await client.runtime.setSkillEnabled({
        name: skill.name,
        enabled: !skill.enabled,
      });
      setToast(`已${skill.enabled ? "停用" : "启用"} ${skill.name}`);
      await refresh();
    });
    setBusy(false);
  };
  const budget = data?.budget;
  const empty = data?.skills.length === 0;
  return (
    <div className="page3 skills-page spage flush">
      <PageHeader
        title="技能"
        actions={
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
                <Button onClick={() => void attempt(() => openUrl("https://agentskills.io"))}>
                  Agent Skills 规范 ↗
                </Button>
              </>
            }
          />
          <SkillWarnings warnings={parseWarnings} />
          <p className="fine">扫描目录：{data.scannedDirs.join("、")}</p>
        </div>
      ) : (
        <MasterDetail
          listLabel="技能列表"
          list={
            <>
              {(["user", "project"] as const).map(
                (layer) =>
                  data?.skills.some((s) => s.layer === layer) && (
                    <ListGroup
                      key={layer}
                      count={data.skills.filter((s) => s.layer === layer).length}
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
                      {data.skills
                        .filter((s) => s.layer === layer)
                        .map((s) => (
                          <ListItem
                            key={s.entryPath}
                            label={s.name}
                            mono
                            selected={s.entryPath === selected}
                            off={!s.enabled || !!s.shadowedBy}
                            dot={
                              !s.enabled || s.shadowedBy
                                ? ""
                                : s.missingDescription || s.ignored.length
                                  ? "warn"
                                  : "ok"
                            }
                            meta={skillListMeta(s)}
                            onClick={() => {
                              setSelected(s.entryPath);
                            }}
                          />
                        ))}
                    </ListGroup>
                  ),
              )}
              <SkillWarnings warnings={parseWarnings} />
            </>
          }
          listFoot={
            <>
              {budget && (
                <div className="skill-budget">
                  <meter
                    min={0}
                    max={Math.max(1, budget.limitTokens)}
                    value={budget.usedTokens}
                    aria-label="模型目录预算"
                  />
                  <span>
                    模型目录{" "}
                    <b>
                      {budget.usedTokens.toLocaleString()} / {budget.limitTokens.toLocaleString()}
                    </b>{" "}
                    tokens
                  </span>
                  <span>
                    完整说明 {budget.fullCount} 个，只显示名字 {budget.nameCount} 个，已停用{" "}
                    {budget.disabledCount} 个
                  </span>
                </div>
              )}
              {budget?.basis === "fallback" && (
                <span className="fine">模型上下文窗口未知，使用 8,000 token 上限</span>
              )}
              <span className="fine skill-scanned">扫描目录：{data?.scannedDirs.join("、")}</span>
            </>
          }
        >
          {skill && (
            <>
              <DetailHeader
                title={skill.name}
                mono
                extra={
                  <Badge>
                    {skill.layer === "user" ? "用户" : "项目"}
                    <span className="muted-value">
                      {skill.source === "extra" ? "额外目录" : skill.source}
                    </span>
                  </Badge>
                }
                actions={
                  <>
                    <Switch
                      checked={skill.enabled}
                      aria-label={`启用 ${skill.name}`}
                      disabled={!!skill.shadowedBy || busy}
                      onChange={() => void toggle()}
                    />
                    {skill.shadowedBy && (
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setSelected(skill.shadowedBy);
                        }}
                      >
                        查看生效的那份
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      onClick={() => void attempt(() => openDirectory(skill.realPath))}
                    >
                      在资源管理器中打开 ↗
                    </Button>
                  </>
                }
              />
              {skill.shadowedBy && (
                <div className="skill-banner info">
                  被
                  {data?.skills.find((s) => s.entryPath === skill.shadowedBy)?.layer === "user"
                    ? "用户"
                    : "项目"}
                  技能 {skill.name} 覆盖
                </div>
              )}
              {skill.missingDescription && (
                <div className="skill-banner warn">缺少说明，模型看不到这个技能</div>
              )}
              {skill.commandConflict && (
                <div className="skill-banner warn">与内置命令重名，斜杠不能调用</div>
              )}
              {!!skill.ignored.length && (
                <>
                  <div className="skill-banner warn">
                    有 {skill.ignored.length} 处写法在 Nocturne 里不生效
                  </div>
                  <DataTable
                    rows={skill.ignored.map((item, i) => ({ ...item, key: String(i) }))}
                    rowKey={(item) => item.key}
                    columns={[
                      {
                        key: "syntax",
                        header: "写法",
                        mono: true,
                        render: (item) => <code>{item.syntax}</code>,
                      },
                      { key: "reason", header: "在 Nocturne 里", render: (item) => item.reason },
                    ]}
                  />
                </>
              )}
              <SettingsGroup title="概况">
                <SettingsRow label="位置">
                  <code>{skill.realPath}\SKILL.md</code>
                  {skill.otherEntries.length > 0 && (
                    <div className="fine">
                      经 {skill.entryPath} 进入；另有入口 {skill.otherEntries.join("、")}{" "}
                      指向同一目录，只算一个
                    </div>
                  )}
                </SettingsRow>
                <SettingsRow label="调用">{invocationText(skill)}</SettingsRow>
                <SettingsRow label="斜杠">
                  <code>
                    {skill.invocation === "both" || skill.invocation === "user"
                      ? `/${skill.name} ${typeof skill.fields["argument-hint"] === "string" ? skill.fields["argument-hint"] : ""}`
                      : "—"}
                  </code>
                </SettingsRow>
                <SettingsRow label="模型目录">{catalogText(skill)}</SettingsRow>
                <SettingsRow label="大小">
                  {(skill.size / 1024).toFixed(1)} KB
                  {skill.files.some((f) => f.directory)
                    ? `，${skill.files.filter((f) => f.directory).length} 个子目录`
                    : ""}
                </SettingsRow>
              </SettingsGroup>
              {skill.description && (
                <>
                  <SettingsGroup
                    title="说明"
                    plain
                    count={`${skill.description.length} 字符${skill.catalogStatus === "full" && skill.displayedDescriptionLength < skill.description.length ? `，模型目录里显示前 ${skill.displayedDescriptionLength} 字符` : ""}`}
                  >
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
                  </SettingsGroup>
                </>
              )}
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
              <SettingsGroup title="正文预览" plain>
                <small>
                  前 {Math.min(40, skill.bodyLines)} / {skill.bodyLines} 行
                </small>
                <pre className="tail">{skill.bodyPreview}</pre>
              </SettingsGroup>
              {skill.files.some((f) => f.name !== "SKILL.md") && (
                <SettingsGroup
                  title="支持文件"
                  plain
                  count={skill.files.filter((f) => f.name !== "SKILL.md").length}
                >
                  <DataTable
                    aria-label="支持文件"
                    rows={skill.files.filter((f) => f.name !== "SKILL.md")}
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
            </>
          )}
        </MasterDetail>
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
      <summary>{warnings.length} 个技能的前言解析失败，查看 ›</summary>
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
