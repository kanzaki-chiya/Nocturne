/**
 * 斜杠命令分发（tui.md §3）：命令名与 CLI 一致，交互形态按 TUI 适配
 * （/model、/resume 弹列表选择器；/context、/help 弹可滚动面板）。
 * 不共享 CLI 的渲染代码（cli.md §1）；语义参数（模型归一化等）走 core 公开 API。
 */
import { normalizeModelRef, type RuntimeConfig, type RuntimeSession } from "@nocturne/core";

import { helpLines as catalogHelpLines } from "./slash-catalog.js";

export type OverlayName = "context" | "help" | "resume" | "preset" | "effort" | "shell";

/** /provider 向导启动形态（add / key / thinking） */
export type ProviderWizardStart =
  | { kind: "add"; presetId?: string | undefined }
  | { kind: "key"; providerId: string }
  | { kind: "thinking"; providerId: string };

export type SlashResult =
  | { kind: "overlay"; name: OverlayName }
  /** /model 打开全屏模型选择页（tui.md §7） */
  | { kind: "picker"; focus: "left" | "right" }
  /** /provider（无参/add）打开全屏服务商页（tui.md §8）；presetId 直达内嵌向导 */
  | { kind: "provider-page"; presetId?: string | undefined }
  | { kind: "message"; text: string }
  | { kind: "exit" }
  | { kind: "new" }
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
    case "/new":
    case "/clear":
      return { kind: "new" };
    case "/provider": {
      // 无参：打开全屏服务商页（tui.md §8）；add 同页内嵌向导
      if (arg === "") return { kind: "provider-page" };
      if (provider === undefined) {
        return { kind: "message", text: "! 当前环境不支持 /provider 管理" };
      }
      const [sub, ...subRest] = arg.split(/\s+/);
      const name = subRest.join(" ").trim();
      switch (sub) {
        case "add":
          return {
            kind: "provider-page",
            presetId: name !== "" ? name : undefined,
          };
        case "key":
          if (name === "") return { kind: "message", text: "用法：/provider key <名称>" };
          return { kind: "provider-wizard", start: { kind: "key", providerId: name } };
        case "thinking":
          if (name === "") return { kind: "message", text: "用法：/provider thinking <名称>" };
          return { kind: "provider-wizard", start: { kind: "thinking", providerId: name } };
        case "image": {
          // /provider image <服务商> <模型> on|off（ADR-0023 第 1 节）
          const [pid, mid, flag] = [subRest[0], subRest[1], subRest[2]];
          if (pid === undefined || mid === undefined || (flag !== "on" && flag !== "off")) {
            return { kind: "message", text: "用法：/provider image <服务商> <模型> on|off" };
          }
          try {
            await provider.config.saveSetupImageInput(pid, mid, flag === "on");
            provider.updateProviders(await provider.reloadConfig());
            return {
              kind: "message",
              text: `已声明 ${pid}/${mid} ${flag === "on" ? "支持" : "不支持"}图片输入`,
            };
          } catch (e) {
            return { kind: "message", text: `! ${errText(e)}` };
          }
        }
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
            text: `未知子命令 ${sub}；可用：add | key <名称> | thinking <名称> | image <名称> <模型> on|off | refresh <名称> | remove <名称>`,
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
        return { kind: "overlay", name: "effort" };
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
        return { kind: "overlay", name: "preset" };
      }
      try {
        await session.setPermissionPreset(arg);
        return { kind: "none" };
      } catch (e) {
        return { kind: "message", text: `! ${errText(e)}` };
      }
    }
    case "/shell": {
      // ADR-0022 第 4 节：无参打开选择页（未安装灰显、当前高亮）；
      // 带种类名直接切换——生效从下一次 shell 调用起
      if (arg === "") return { kind: "overlay", name: "shell" };
      const before = session.shellInfo();
      try {
        await session.setShell(arg);
      } catch (e) {
        return { kind: "message", text: `! ${errText(e)}` };
      }
      const after = session.shellInfo();
      if (after.overriddenBy !== undefined) {
        return {
          kind: "message",
          text: `已写入 settings.json（当前由 ${
            after.overriddenBy === "env" ? "NOCTURNE_SHELL" : "config.json"
          } 指定，移除后才会生效）`,
        };
      }
      if (after.effective === undefined) {
        return { kind: "message", text: `! ${after.error ?? "所选 shell 不可用"}` };
      }
      // 确认行由 session.config_changed 事件渲染；未发生实际切换时兜底
      if (
        before.effective?.kind === after.effective.kind &&
        before.effective.path === after.effective.path
      ) {
        return { kind: "message", text: `shell 已是 ${after.effective.kind}` };
      }
      return { kind: "none" };
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
  return catalogHelpLines();
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
  // ADR-0023：图片附件按固定 1600 tok/张计入总量，单列一行
  if (report.images !== undefined) {
    lines.push(
      `  ${"images".padEnd(12)} ${String(report.images.count).padStart(7)} 张  ~${report.images.estimatedTokens} tok`,
    );
  }
  return [
    "上下文组成：",
    ...lines,
    `  ${"─".repeat(40)}`,
    `  合计 ~${report.estimatedTokens} / ${report.budgetTokens} tok${overBudget ? "  [超预算]" : ""}`,
  ];
}
