import { useMemo, useState } from "react";

import { formatRelative, projectKey, projectName, type SessionSummary } from "./session-tree";
import { Button, EmptyState, ICON_MD, Icon, PageHeader } from "./ui";
import "./archive.css";

const CHAT_GROUP = "\u0000chat";
const SCHEDULE_GROUP = "\u0000schedule";

interface ArchiveRow {
  id: string;
  title: string;
  archivedAtMs: number;
}

interface ArchiveGroup {
  key: string;
  name: string;
  latest: number;
  rows: ArchiveRow[];
}

function archivedAtMs(session: SessionSummary): number | undefined {
  if (session.archivedAt === undefined) return undefined;
  const parsed = Date.parse(session.archivedAt);
  return Number.isNaN(parsed) ? session.mtimeMs : parsed;
}

/**
 * 归档页按侧栏同样的归属和名称分组（ADR-0080）：普通对话进「对话」、定时任务进
 * 「定时任务」，其余按项目路径归并，被移除（hidden）的项目也照常列出。
 */
function groupArchived(
  sessions: readonly SessionSummary[],
  plainWorkspaces: readonly string[],
): ArchiveGroup[] {
  const plainKeys = new Set(plainWorkspaces.map(projectKey));
  const groups = new Map<string, ArchiveGroup>();
  for (const session of sessions) {
    const at = archivedAtMs(session);
    if (at === undefined) continue;
    const key = projectKey(session.cwd);
    const groupKey =
      session.schedule !== undefined ? SCHEDULE_GROUP : plainKeys.has(key) ? CHAT_GROUP : key;
    const name =
      groupKey === SCHEDULE_GROUP
        ? "定时任务"
        : groupKey === CHAT_GROUP
          ? "对话"
          : projectName(session.cwd);
    let group = groups.get(groupKey);
    if (group === undefined) {
      group = { key: groupKey, name, latest: at, rows: [] };
      groups.set(groupKey, group);
    }
    group.latest = Math.max(group.latest, at);
    group.rows.push({ id: session.id, title: session.firstText ?? "未命名会话", archivedAtMs: at });
  }
  const ordered = [...groups.values()];
  for (const group of ordered) group.rows.sort((a, b) => b.archivedAtMs - a.archivedAtMs);
  ordered.sort((a, b) =>
    a.latest === b.latest ? a.name.localeCompare(b.name) : b.latest - a.latest,
  );
  return ordered;
}

export interface ArchivePageProps {
  /** 含归档摘要的完整会话列表（App 的 listSessions includeArchived） */
  sessions: readonly SessionSummary[];
  /** 普通对话工作区：这些 cwd 下的归档会话归入「对话」 */
  plainWorkspaces: readonly string[];
  /** 当前时间，测试固定用 */
  now?: number;
  onOpen: (id: string) => void;
  onRestore: (id: string) => void;
}

export function ArchivePage({
  sessions,
  plainWorkspaces,
  now = Date.now(),
  onOpen,
  onRestore,
}: ArchivePageProps) {
  const [query, setQuery] = useState("");
  const archived = useMemo(
    () => sessions.filter((session) => session.archivedAt !== undefined),
    [sessions],
  );
  const groups = useMemo(() => {
    const all = groupArchived(sessions, plainWorkspaces);
    const needle = query.trim().toLowerCase();
    if (needle === "") return all;
    return all
      .map((group) => ({
        ...group,
        rows: group.rows.filter((row) => row.title.toLowerCase().includes(needle)),
      }))
      .filter((group) => group.rows.length > 0);
  }, [sessions, plainWorkspaces, query]);

  if (archived.length === 0) {
    return (
      <section className="page3" aria-label="已归档的会话">
        <div className="spage">
          <div className="readable">
            <PageHeader title="已归档的会话" />
            <div className="sbody">
              <EmptyState>没有已归档的会话</EmptyState>
            </div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="page3" aria-label="已归档的会话">
      <div className="spage">
        <div className="readable">
          <PageHeader title="已归档的会话" />
          <div className="sbody">
            <div className="archive-search">
              <Icon name="search" size={ICON_MD} />
              <input
                type="text"
                aria-label="搜索"
                value={query}
                spellCheck={false}
                onChange={(event) => {
                  setQuery(event.target.value);
                }}
              />
            </div>
            {groups.length === 0 ? (
              <EmptyState>没有匹配的会话</EmptyState>
            ) : (
              groups.map((group) => (
                <section className="group" key={group.key}>
                  <div className="ghead">
                    <Icon name="folder" size={ICON_MD} />
                    <h2>{group.name}</h2>
                  </div>
                  <div className="card">
                    {group.rows.map((row) => (
                      <div className="archive-row" key={row.id}>
                        <button
                          type="button"
                          className="archive-open"
                          title={row.title}
                          onClick={() => {
                            onOpen(row.id);
                          }}
                        >
                          {row.title}
                        </button>
                        <span className="archive-when">
                          {formatRelative(row.archivedAtMs, now)}
                        </span>
                        <Button
                          size="sm"
                          onClick={() => {
                            onRestore(row.id);
                          }}
                        >
                          恢复
                        </Button>
                      </div>
                    ))}
                  </div>
                </section>
              ))
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
