/**
 * 上下文用量面板（桌面状态栏与手机网页共用）：分段明细与来源说明。
 */
import type { ContextSummary } from "@nocturne/rpc/client";

import { abbreviateHome } from "./paths";
import "./status-bar.css";

type Report = ContextSummary["report"];
type Section = Report["sections"][number];

export interface ContextRow {
  key: string;
  label: string;
  tokens: number;
  chars?: number;
  color: string;
  source?: string;
  nested?: boolean;
  group?: boolean;
  truncated?: boolean | undefined;
}

const SECTIONS: Record<Section["name"], { label: string; color: string }> = {
  system: { label: "系统提示", color: "var(--a-faint)" },
  tools: { label: "工具定义", color: "var(--a-accentAlt)" },
  instructions: { label: "项目说明", color: "var(--a-secondary)" },
  skills: { label: "技能目录", color: "var(--a-accentAlt)" },
  environment: { label: "环境", color: "var(--a-muted)" },
  todos: { label: "任务清单", color: "var(--a-muted)" },
  history: { label: "对话历史", color: "var(--a-accent)" },
};
const HISTORY = [
  { key: "user", label: "用户消息", color: "var(--a-success)" },
  { key: "assistant", label: "助手回答", color: "var(--a-warning)" },
  { key: "tool", label: "工具调用与结果", color: "var(--a-accent)" },
  { key: "summary", label: "压缩摘要", color: "var(--a-selStrong)" },
] as const;
export const number = new Intl.NumberFormat("zh-CN");

/** history 总量仅作分组标题；堆叠条使用四项明细，不能重复计入总量。 */
export function contextRows(report: Report): ContextRow[] {
  const rows: ContextRow[] = [];
  for (const section of report.sections) {
    const group = section.name === "history" && section.breakdown !== undefined;
    rows.push({
      key: section.name,
      ...SECTIONS[section.name],
      tokens: section.estimatedTokens,
      chars: section.chars,
      source: section.source,
      group,
      truncated: section.truncated,
    });
    if (section.name === "history" && section.breakdown !== undefined) {
      for (const item of HISTORY) {
        const size = section.breakdown[item.key];
        rows.push({
          ...item,
          key: `history-${item.key}`,
          tokens: size.estimatedTokens,
          chars: size.chars,
          nested: true,
        });
      }
    }
  }
  if (report.images !== undefined) {
    rows.push({
      key: "images",
      label: "图片",
      color: "var(--a-error)",
      tokens: report.images.estimatedTokens,
      source: `${report.images.count} 张`,
    });
  }
  return rows;
}

/** 上下文报告里的英文来源文本 → 中文；路径按主目录缩写。 */
export function contextSourceLabel(source: string, home?: string | null): string {
  if (source === "nocturne base prompt") return "内置提示词";
  if (source === "custom base prompt") return "自定义提示词";
  const tools = /^(\d+) tools$/.exec(source);
  if (tools !== null) return `${tools[1]} 个工具`;
  const items = /^(\d+) items$/.exec(source);
  if (items !== null) return `${items[1]} 项`;
  const entries = /^(\d+) entries$/.exec(source);
  if (entries !== null) return `${entries[1]} 条`;
  return abbreviateHome(source, home);
}

export function percent(used: number, budget: number): number | null {
  return budget > 0 ? Math.round((used / budget) * 100) : null;
}

export function ContextPanel({
  context,
  home,
}: {
  context: ContextSummary;
  home?: string | null | undefined;
}) {
  const { report } = context;
  const rows = contextRows(report);
  const used = percent(report.estimatedTokens, report.budgetTokens);
  return (
    <>
      <div className="context-total">
        <b>上下文</b>
        <span>
          {number.format(report.estimatedTokens)} / {number.format(report.budgetTokens)} tokens
          {used === null ? "（无可用预算）" : `（${used}%）`}
        </span>
      </div>
      <div className="context-stack" aria-label="上下文组成">
        {rows
          .filter((row) => !row.group)
          .map((row) => (
            <i
              key={row.key}
              data-segment={row.key}
              title={`${row.label}：${number.format(row.tokens)} tokens`}
              style={{
                width: `${report.estimatedTokens > 0 ? (row.tokens / report.estimatedTokens) * 100 : 0}%`,
                background: row.color,
              }}
            />
          ))}
      </div>
      <dl className="context-details">
        {rows.map((row) => {
          const source =
            row.source === undefined ? undefined : contextSourceLabel(row.source, home);
          return (
            <div
              key={row.key}
              className={row.nested ? "context-nested" : row.group ? "context-group" : undefined}
            >
              <dt>
                {!row.group && <i style={{ background: row.color }} aria-hidden="true" />}
                {row.label}
                {source !== undefined && source !== "" && <small title={source}>{source}</small>}
                {row.truncated && <small>已截断</small>}
              </dt>
              <dd title={row.chars === undefined ? undefined : `${number.format(row.chars)} chars`}>
                {number.format(row.tokens)}
              </dd>
            </div>
          );
        })}
      </dl>
      {context.overBudget && <p className="status-warning">已超出输入预算</p>}
      {report.modelDefaults?.contextWindow && (
        <p className="status-note">模型未声明上下文长度，预算使用默认值。</p>
      )}
      {report.modelDefaults?.maxOutputTokens && (
        <p className="status-note">模型未声明输出上限，预算使用默认值。</p>
      )}
      <div className="context-footer">
        可以输入 <code>/compact</code> 压缩
      </div>
    </>
  );
}
