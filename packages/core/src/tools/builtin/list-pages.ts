/**
 * list_pages 内置工具（ADR-0114 §5）：
 * 列出当前会话所在项目的全部面板页面（按来源合并为最近副本、按最近更新倒序）。
 * 只读、免确认、仅主会话，与 render_html 同样的可用范围。
 */
import type { ToolDefinition } from "../types.js";

export type ListPagesInput = Record<string, never>;

export interface ListPagesItem {
  ref: string;
  title: string;
  version: number;
  updatedAt: string;
  path: string;
}

export interface ListPagesOutput {
  pages: ListPagesItem[];
}

export const listPagesTool: ToolDefinition<ListPagesInput, ListPagesOutput> = {
  name: "list_pages",
  description:
    "List this project's panel pages by most recent update, with ref, title, version, timestamp and absolute HTML path. Use the ref as render_html's page to continue editing.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  traits: {
    mutates: false,
    concurrencySafe: true,
    mainSessionOnly: true,
  },
  permissionSubjects: () => [],
  async execute(_input, ctx) {
    if (!ctx.projectPages) {
      return {
        status: "ok",
        modelContent: "当前项目暂无面板页面。",
        output: { pages: [] },
      };
    }
    const entries = await ctx.projectPages.listPages();
    const pages: ListPagesItem[] = entries.map((item) => ({
      ref: item.ref,
      title: item.title,
      version: item.version,
      updatedAt: item.updatedAt,
      path: item.path,
    }));
    if (pages.length === 0) {
      return {
        status: "ok",
        modelContent: "当前项目暂无面板页面。",
        output: { pages },
      };
    }
    const lines = pages.map(
      (p) => `- ${p.ref} | ${p.title} | v${p.version} | ${p.updatedAt} | ${p.path}`,
    );
    return {
      status: "ok",
      modelContent: `当前项目共有 ${pages.length} 个面板页面（按最近更新倒序）：\n${lines.join("\n")}`,
      output: { pages },
    };
  },
};
