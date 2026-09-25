/**
 * 斜杠命令分发（tui.md §3）：命令名与 CLI 一致，交互形态按 TUI 适配
 * （/model、/resume 弹列表选择器；/context、/help 弹可滚动面板）。
 * 不共享 CLI 的渲染代码（cli.md §1）；语义参数（模型归一化等）走 core 公开 API。
 */
import { normalizeModelRef, type RuntimeConfig, type RuntimeSession } from "@nocturne/core";

export type OverlayName = "context" | "help" | "resume";

/** /provider 向导启动形态（add / key / thinking） */
export type ProviderWizardStart =
  | { kind: "add"; presetId?: string | undefined }
  | { kind: "key"; providerId: string }
  | { kind: "thinking"; providerId: string };

export type SlashResult =
  | { kind: "overlay"; name: OverlayName }
  /** /model 与 /provider（无参）打开全屏模型选择页（tui.md §7） */
  | { kind: "picker"; focus: "left" | "right" }
  | { kind: "message"; text: string }
  | { kind: "exit" }
  /** /resume <id>：由 App 调用注入的 switchSession 执行切换 */
  | { kind: "switch"; id: string }
  /** /provider add/key：App 侧打开向导弹层 */
  | { kind: "provider-wizard"; start: ProviderWizardStart }
  /** /provider remove <name>：App 侧确认后删除 */
  | { kind: "provider-remove"; providerId: string }
  /** 已静默处理（确认行由 session.config_changed 事件渲染） */
  | { kind: "none" };

/** /provider 修改类子命令需要的配置桥（由 CLI 注入，与 REPL 同一份语义） */
export interface ProviderBridge {
  config: RuntimeConfig;
  reloadConfig: () => Promise<RuntimeConfig>;
  updateProviders: (rc: RuntimeConfig) => void;
  workspaceRoot?: string | undefined;
}

const HELP_TEXT = `斜杠命令：
  /help          本帮助
  /model         弹出模型列表选择器（↑↓ + Enter，Esc 取消）
  /model <id>    直接切换模型
  /effort        显示当前思考强度；/effort <档位> 切换
  /preset        显示当前权限预设
  /preset <name> 切换权限预设（read-only | default | auto-edit | full-access）
  /context       上下文组成面板（Esc/Enter 关闭，↑↓ 滚动）
  /mcp           显示本会话 MCP 服务器状态（只读）
  /compact       手动压缩上下文（L2 摘要）
  /resume        弹出会话列表选择器；/resume <id> 直接切换
  /provider      打开模型选择页（焦点在服务商栏）
  /provider add  添加服务商向导；key <名称> 更新密钥；thinking <名称> 调整思考档位
  /provider refresh <名称> 刷新上游模型；remove <名称> 删除
  /exit, /quit   退出
快捷键：a/s/p/d/x 权限确认（d 进反馈行，Enter 发送、Esc 返回）；
Ctrl+C 中断（空闲时退出）；Ctrl+D 退出。`;

export async function runSlash(
  line: string,
  session: RuntimeSession,
  provider?: ProviderBridge,
): Promise<SlashResult> {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  const arg = rest.join(" ").trim();
  switch (cmd) {
    case "/help":
      return { kind: "overlay", name: "help" };
    case "/exit":
    case "/quit":
      return { kind: "exit" };
    case "/provider": {
      // 无参：打开模型选择页，焦点在左栏服务商列表（tui.md §7）
      if (arg === "") return { kind: "picker", focus: "left" };
      if (provider === undefined) {
        return { kind: "message", text: "! 当前环境不支持 /provider 管理" };
      }
      const [sub, ...subRest] = arg.split(/\s+/);
      const name = subRest.join(" ").trim();
      switch (sub) {
        case "add":
          return {
            kind: "provider-wizard",
            start: { kind: "add", presetId: name !== "" ? name : undefined },
          };
        case "key":
          if (name === "") return { kind: "message", text: "用法：/provider key <名称>" };
          return { kind: "provider-wizard", start: { kind: "key", providerId: name } };
        case "thinking":
          if (name === "") return { kind: "message", text: "用法：/provider thinking <名称>" };
          return { kind: "provider-wizard", start: { kind: "thinking", providerId: name } };
        case "refresh": {
          if (name === "") return { kind: "message", text: "用法：/provider refresh <名称>" };
          try {
            await provider.config.refreshUpstreamLimits(name);
            provider.updateProviders(await provider.reloadConfig());
            return { kind: "message", text: `已刷新 ${name} 的上游模型列表` };
          } catch (e) {
            return { kind: "message", text: `! ${errText(e)}` };
          }
        }
        case "remove":
          if (name === "") return { kind: "message", text: "用法：/provider remove <名称>" };
          return { kind: "provider-remove", providerId: name };
        default:
          return {
            kind: "message",
            text: `未知子命令 ${sub}；可用：add | key <名称> | thinking <名称> | refresh <名称> | remove <名称>`,
          };
      }
    }
    case "/model": {
      if (arg === "") return { kind: "picker", focus: "right" };
      const norm = normalizeModelRef(arg, session.state().config.model.provider);
      if (!norm.ok) return { kind: "message", text: `! ${norm.problem}` };
      try {
        await session.setModel(norm.ref);
        return { kind: "none" };
      } catch (e) {
        return { kind: "message", text: `! ${errText(e)}` };
      }
    }
    case "/effort": {
      const info = session.reasoningEffortInfo();
      if (arg === "") {
        if (info.available.length === 0) {
          return { kind: "message", text: `当前思考强度：${info.current}（该模型未声明可用档位）` };
        }
        return {
          kind: "message",
          text:
            `当前思考强度：${info.current}\n可用档位：off | ${info.available.join(" | ")}` +
            (info.effective !== info.current
              ? `\n本 Turn 生效中：${info.effective}（新档位下一 Turn 生效）`
              : ""),
        };
      }
      try {
        await session.setReasoningEffort(arg);
        return { kind: "none" };
      } catch (e) {
        return { kind: "message", text: `! ${errText(e)}` };
      }
    }
    case "/preset": {
      if (arg === "") {
        return {
          kind: "message",
          text: `当前权限预设：${session.state().config.permissionPreset}\n可用：read-only | default | auto-edit | full-access`,
        };
      }
      try {
        await session.setPermissionPreset(arg);
        return { kind: "none" };
      } catch (e) {
        return { kind: "message", text: `! ${errText(e)}` };
      }
    }
    case "/context":
      return { kind: "overlay", name: "context" };
    case "/mcp": {
      const servers = session.mcpServers();
      if (servers.length === 0) {
        return { kind: "message", text: "本会话没有配置 MCP 服务器" };
      }
      const lines = servers.map((s) => {
        const tools = s.state === "ready" ? `，${s.toolCount} 个工具` : "";
        const err = s.error !== undefined ? `，${s.error}` : "";
        const restarts = s.restarts > 0 ? `，重连 ${s.restarts} 次` : "";
        return `  ${s.name}  ${s.state}${tools}${restarts}${err}`;
      });
      return { kind: "message", text: ["MCP 服务器：", ...lines].join("\n") };
    }
    case "/compact": {
      try {
        await session.compact();
        return { kind: "none" };
      } catch (e) {
        return { kind: "message", text: `! ${errText(e)}` };
      }
    }
    case "/resume":
      // 无参：列表选择器；带 id：直接切换（App 侧执行注入的 switchSession）
      return arg === "" ? { kind: "overlay", name: "resume" } : { kind: "switch", id: arg };
    default:
      return { kind: "message", text: `未知命令 ${cmd}；/help 列出可用命令` };
  }
}

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function helpLines(): string[] {
  return HELP_TEXT.split("\n");
}

/** /resume 切换后打印的提示行：恢复修复摘要 + 聚合警告（与 CLI sessionOpenNotes 同文案） */
export function sessionNotes(session: RuntimeSession): string[] {
  const notes: string[] = [];
  const r = session.recovery;
  if (r !== undefined) {
    const parts: string[] = [];
    if (r.truncatedTail !== undefined) parts.push(`损坏尾部已截断（另存 ${r.truncatedTail}）`);
    if (r.interruptedCalls > 0) parts.push(`${r.interruptedCalls} 个未完成调用标记为 interrupted`);
    if (r.recoveredTurns > 0)
      parts.push(`${r.recoveredTurns} 个未完成 Turn 已按 process_exited 收束`);
    if (parts.length > 0) notes.push(`会话恢复时已修复：${parts.join("；")}`);
  }
  notes.push(...session.warnings);
  return notes;
}

/** /context 面板内容（与 CLI /context 同口径的分区报告） */
export function contextLines(session: RuntimeSession): string[] {
  const { report, overBudget } = session.describeContext();
  const lines = report.sections.map(
    (s) =>
      `  ${s.name.padEnd(12)} ${String(s.chars).padStart(7)} chars  ~${s.estimatedTokens} tok  ${s.source}${s.truncated === true ? "  [已截断]" : ""}`,
  );
  return [
    "上下文组成：",
    ...lines,
    `  ${"─".repeat(40)}`,
    `  合计 ~${report.estimatedTokens} / ${report.budgetTokens} tok${overBudget ? "  [超预算]" : ""}`,
  ];
}
