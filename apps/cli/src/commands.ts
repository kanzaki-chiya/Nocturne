/**
 * 斜杠命令分发（cli.md 第 4 节）。纯逻辑层：依赖注入 session/runtime/io，
 * 离线测试不需要真实终端。REPL 内命令错误只显示，不退出进程。
 */
import type {
  ModelInfo,
  Runtime,
  RuntimeConfig,
  RuntimeSession,
  SessionShellInfo,
} from "@nocturne/core";
import { RuntimeCommandError, type PermissionPresetName } from "@nocturne/core";
import { cliHelpText } from "@nocturne/tui/slash-catalog";

import { normalizeModelRef } from "./config.js";

export interface CommandIo {
  print(text: string): void;
}

/**
 * /provider 需要的桥（cli.md 第 4 节；main.ts/repl.ts 注入）：
 * 列表/修改走 RuntimeConfig，修改后 reloadConfig + updateProviders 生效。
 */
export interface CommandDeps {
  provider?:
    | {
        config: RuntimeConfig;
        reloadConfig: () => Promise<RuntimeConfig>;
        updateProviders: (rc: RuntimeConfig) => void;
        workspaceRoot?: string | undefined;
      }
    | undefined;
  /** /provider add：REPL 暂停外层 readline 后运行向导（含切换询问） */
  runAddWizard?: (() => Promise<void>) | undefined;
  /** /provider key <name>：同上密钥向导 */
  runKeyWizard?: ((providerId: string) => Promise<void>) | undefined;
  /** /provider model <name> <model>：同上模型设置问答（ADR-0024） */
  runModelWizard?: ((providerId: string, modelId: string) => Promise<void>) | undefined;
}

export type CommandOutcome = "handled" | "exit" | "unknown";

const SLASH_HELP = cliHelpText();

// ── /model 表格（cli.md 第 4 节：与 TUI 模型选择页同列信息） ──

/** 上下文长度缩写：128000 → 128k；1_000_000 → 1m */
function formatContext(n: number | undefined): string {
  if (n === undefined) return "?";
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}m`;
  }
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/** 每百万 token 价格：$输入/输出；单边缺失显示 ? */
function formatPricing(p: ModelInfo["pricing"]): string {
  if (p === undefined) return "";
  const fmt = (v: number | undefined): string =>
    v === undefined ? "?" : v >= 100 ? String(Math.round(v)) : String(Number(v.toFixed(2)));
  return `$${fmt(p.input)}/${fmt(p.output)}`;
}

/** 模型编号表格：id | R | I | 上下文 | 价格 | 标注（当前会话/默认模型） */
function modelTable(
  models: readonly ModelInfo[],
  current: { provider: string; model: string },
  defaultRef: { provider: string; model: string } | undefined,
): string {
  const tags = (m: ModelInfo): string => {
    const t: string[] = [];
    // ADR-0026 §5：不可用模型照常列出并标注
    if (m.unavailable !== undefined) t.push("协议不支持");
    if (m.ref.provider === current.provider && m.ref.model === current.model) t.push("当前会话");
    if (m.ref.provider === defaultRef?.provider && m.ref.model === defaultRef.model)
      t.push("默认模型");
    return t.length > 0 ? `  ← ${t.join("、")}` : "";
  };
  const lines = models.map((m, i) => {
    const id = `${m.ref.provider}/${m.ref.model}`;
    const r = m.capabilities.reasoning !== "none" ? "R" : " ";
    const img = m.capabilities.imageInput ? "I" : " ";
    return `  ${String(i + 1).padStart(3)} ${id.padEnd(42)} ${r} ${img} ${formatContext(m.contextWindow).padStart(6)} ${formatPricing(m.pricing)}${tags(m)}`;
  });
  return lines.join("\n");
}

/** /provider 列表（cli.md 第 4 节：密钥来源/来源层/当前会话标注） */
function describeOrigin(o: string): string {
  switch (o) {
    case "setup":
      return "向导";
    case "user":
      return "config.json";
    case "project":
      return "项目";
    case "env":
      return "环境变量";
    case "cli":
      return "命令行";
    default:
      return o;
  }
}

export async function runSlashCommand(
  line: string,
  session: RuntimeSession,
  runtime: Runtime,
  io: CommandIo,
  deps: CommandDeps = {},
): Promise<CommandOutcome> {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  switch (cmd) {
    case "/help":
      io.print(SLASH_HELP);
      return "handled";
    case "/exit":
    case "/quit":
      return "exit";
    case "/model": {
      const cur = session.state().config.model;
      const all = runtime.listModels();
      if (rest.length === 0) {
        io.print(
          `当前模型：${cur.provider}/${cur.model}\n` +
            `   id                                        R I   上下文    价格($/M)\n` +
            modelTable(all, cur, runtime.defaultModel()),
        );
        return "handled";
      }
      // 参数先按模型 id 精确匹配（含 provider/model 归一化）；未匹配按关键词过滤
      const raw = rest.join(" ");
      const current = cur.provider;
      const norm = normalizeModelRef(raw, current);
      if (!norm.ok) {
        io.print(`! ${norm.problem}`);
        return "handled";
      }
      {
        const hit = all.find((m) => `${m.ref.provider}/${m.ref.model}` === norm.ref);
        if (hit !== undefined) {
          try {
            await session.setModel(norm.ref);
            // session.config_changed 事件会渲染确认行
          } catch (e) {
            io.print(`! ${errorText(e)}`);
          }
          return "handled";
        }
        // 未命中清单：provider/model 写法（含斜杠）按 §4 清单外 id 仍可切换；
        // 单词输入视为关键词，过滤列表不切换
        if (raw.includes("/")) {
          try {
            await session.setModel(norm.ref);
          } catch (e) {
            io.print(`! ${errorText(e)}`);
          }
          return "handled";
        }
      }
      const kw = raw.toLowerCase();
      const filtered = all.filter(
        (m) =>
          `${m.ref.provider}/${m.ref.model}`.toLowerCase().includes(kw) ||
          (m.displayName ?? "").toLowerCase().includes(kw),
      );
      if (filtered.length === 0) {
        io.print(`没有匹配 "${raw}" 的模型`);
        return "handled";
      }
      io.print(
        `   id                                        R I   上下文    价格($/M)\n` +
          modelTable(filtered, cur, runtime.defaultModel()),
      );
      return "handled";
    }
    case "/provider": {
      const bridge = deps.provider;
      if (bridge === undefined) {
        io.print("! /provider 在当前环境不可用（缺少配置桥接）");
        return "handled";
      }
      const { config, reloadConfig, updateProviders, workspaceRoot } = bridge;
      const sub = rest[0] ?? "";
      if (sub === "") {
        const rows = await config.describeProviders(workspaceRoot);
        if (config.providerSetupWarning !== undefined) {
          io.print(`! ${config.providerSetupWarning}`);
        }
        if (rows.length === 0) {
          io.print("（没有配置服务商——运行 nctrn setup 或 /provider add）");
          return "handled";
        }
        const cur = session.state().config.model.provider;
        const lines = rows.map((p) => {
          const key =
            p.keySource === "credential"
              ? "凭据文件"
              : p.keySource === "env"
                ? `环境变量 ${p.keyEnvName ?? ""}`
                : "缺失";
          const host = p.host ?? "(官方端点)";
          const marks = [p.id === cur ? "当前会话" : "", p.overridden ? "被高层覆盖" : ""]
            .filter(Boolean)
            .join("、");
          return (
            `  ${p.id.padEnd(16)} ${p.type.padEnd(18)} ${host.padEnd(28)} ` +
            `${key.padEnd(16)} ${describeOrigin(p.origin)}` +
            (p.modelCount > 0 ? `  ${p.modelCount} 个模型` : "") +
            (marks !== "" ? `  ← ${marks}` : "")
          );
        });
        io.print(["服务商：", ...lines].join("\n"));
        return "handled";
      }
      if (sub === "add") {
        if (deps.runAddWizard === undefined) {
          io.print("! /provider add 需要交互式终端（或运行 nctrn setup）");
          return "handled";
        }
        try {
          await deps.runAddWizard();
        } catch (e) {
          io.print(`! ${errorText(e)}`);
        }
        return "handled";
      }
      // /provider model <服务商> <模型>：行式模型设置问答（ADR-0024 第 4 节）
      if (sub === "model") {
        const [pid, mid] = [rest[1], rest[2]];
        if (pid === undefined || mid === undefined) {
          io.print("用法：/provider model <服务商> <模型>");
          return "handled";
        }
        if (deps.runModelWizard === undefined) {
          io.print("! /provider model 需要交互式终端");
          return "handled";
        }
        try {
          await deps.runModelWizard(pid, mid);
        } catch (e) {
          io.print(`! ${errorText(e)}`);
        }
        return "handled";
      }
      const name = rest[1];
      if (name === undefined || name === "") {
        io.print(`! /provider ${sub} 需要服务商名`);
        return "handled";
      }
      switch (sub) {
        case "key": {
          if (deps.runKeyWizard === undefined) {
            io.print("! /provider key 需要交互式终端");
            return "handled";
          }
          try {
            await deps.runKeyWizard(name);
          } catch (e) {
            io.print(`! ${errorText(e)}`);
          }
          return "handled";
        }
        case "refresh": {
          try {
            const warning = await config.refreshUpstreamLimits(name);
            updateProviders(await reloadConfig());
            io.print(`已刷新 ${name} 的模型列表与限额`);
            if (warning !== undefined) io.print(`! ${warning}`);
          } catch (e) {
            io.print(`! ${errorText(e)}`);
          }
          return "handled";
        }
        case "remove": {
          if (session.state().config.model.provider === name) {
            io.print(`! 当前会话正在使用 ${name}，不能删除；先 /model 切换到其他服务商`);
            return "handled";
          }
          try {
            await config.removeSetupProvider(name);
            updateProviders(await reloadConfig());
            io.print(`已删除服务商 ${name} 及其凭据`);
          } catch (e) {
            io.print(`! ${errorText(e)}`);
          }
          return "handled";
        }
        default:
          io.print(`未知 /provider 子命令 ${sub}；/help 列出用法`);
          return "handled";
      }
    }
    case "/settings": {
      const sources = {
        default: "默认",
        setup: "向导",
        settings: "设置",
        user: "config.json",
        project: "项目配置",
        env: "环境变量",
        cli: "命令行",
      };
      if (rest.length === 0) {
        const items = runtime.describeSettings();
        const describe = (item: (typeof items)[number] | undefined) =>
          item === undefined
            ? "未设置"
            : `${item.effective ?? "未设置"} · ${sources[item.source]}${item.overridden ? ` · 已保存，但被 ${sources[item.source]} 覆盖` : ""}`;
        const find = (key: (typeof items)[number]["key"]) => items.find((item) => item.key === key);
        io.print("会话默认（默认值对新会话生效）");
        io.print(`默认权限预设：${describe(find("permissions.preset"))}`);
        // 默认模型与档位成对只读显示，修改去 /model 页「设为默认」（ADR-0034 修订）
        io.print(`默认模型（/model）：${describe(find("defaultModel"))}`);
        io.print(`  档位：${describe(find("reasoningEffort"))}`);
        io.print("界面：/theme 仅 TUI\n执行");
        io.print(`Shell（/shell）：${describe(find("shell"))}`);
        return "handled";
      }
      const [sub, value = ""] = rest;
      const presets = [
        "read-only",
        "default",
        "auto-edit",
        "guarded",
        "smart",
        "bypass",
        "full-access",
      ];
      try {
        if (rest.length !== 2 || sub !== "preset")
          throw new RuntimeCommandError(
            "invalid_command",
            "用法：/settings preset <值|reset>；默认模型与档位去 /model，Shell 去 /shell，主题 /theme 仅 TUI",
          );
        if (value !== "reset" && !presets.includes(value))
          throw new RuntimeCommandError("invalid_command", `可选：${presets.join(" | ")} | reset`);
        await runtime.updateSettings({
          "permissions.preset":
            value === "reset"
              ? null
              : ((value === "full-access" ? "guarded" : value) as PermissionPresetName),
        });
        io.print("已保存默认设置（对新会话生效）");
      } catch (cause) {
        io.print(
          `! ${cause instanceof RuntimeCommandError ? `${cause.code}: ` : ""}${errorText(cause)}`,
        );
      }
      return "handled";
    }
    case "/effort": {
      const info = session.reasoningEffortInfo();
      if (rest.length === 0) {
        if (info.available.length === 0) {
          io.print(`当前思考强度：${info.current}（该模型未声明可用档位）`);
        } else {
          io.print(
            `当前思考强度：${info.current}\n可用档位：off | ${info.available.join(" | ")}` +
              (info.effective !== info.current
                ? `\n本 Turn 生效中：${info.effective}（新档位下一 Turn 生效）`
                : ""),
          );
        }
        return "handled";
      }
      try {
        await session.setReasoningEffort(rest.join(" "));
        // session.config_changed 事件渲染确认行
      } catch (e) {
        io.print(`! ${errorText(e)}`);
      }
      return "handled";
    }
    case "/shell": {
      // ADR-0022 第 4 节：/shell 打印编号列表；/shell <种类|编号> 切换
      const info = session.shellInfo();
      const detected = session.listShells();
      const sourceLabel = (s: SessionShellInfo["source"]): string =>
        s === "env"
          ? "NOCTURNE_SHELL"
          : s === "config"
            ? "config.json"
            : s === "settings"
              ? "settings.json"
              : "自动选择";
      if (rest.length === 0) {
        const cur = info.effective;
        const lines = [
          cur !== undefined
            ? `当前 shell：${cur.kind}（${cur.name}，${cur.path}）——来源：${sourceLabel(info.source)}`
            : `当前 shell 不可用：${info.error ?? "未探测到可用 shell"}`,
        ];
        if (info.overriddenBy !== undefined) {
          lines.push(
            `注意：settings.json 中的选择当前被 ${sourceLabel(info.overriddenBy)} 覆盖，不会生效`,
          );
        }
        lines.push("   编号  种类          可执行文件");
        const rows: { n: number; kind: string; desc: string }[] = [
          {
            n: 1,
            kind: "auto",
            desc:
              info.selected === "auto" && cur !== undefined ? `自动（当前为 ${cur.kind}）` : "自动",
          },
          ...detected.map((d, i) => ({
            n: i + 2,
            kind: d.kind,
            desc: d.executable ?? "（未安装）",
          })),
        ];
        for (const r of rows) {
          const mark = info.selected === r.kind ? "  ← 当前" : "";
          lines.push(`   ${String(r.n).padStart(4)}  ${r.kind.padEnd(12)} ${r.desc}${mark}`);
        }
        io.print(lines.join("\n"));
        return "handled";
      }
      const arg = rest.join(" ").trim().toLowerCase();
      let target = arg;
      if (/^\d+$/.test(arg)) {
        const n = Number(arg);
        target = n === 1 ? "auto" : (detected[n - 2]?.kind ?? arg);
      }
      try {
        await session.setShell(target);
      } catch (e) {
        io.print(`! ${errorText(e)}`);
        return "handled";
      }
      const after = session.shellInfo();
      if (after.overriddenBy !== undefined) {
        io.print(
          `已写入 settings.json（当前由 ${sourceLabel(after.overriddenBy)} 指定，移除后才会生效）`,
        );
      } else if (after.effective !== undefined) {
        // session.config_changed.shell 的确认行由事件渲染输出；这里只兜底
        io.print(`shell 已切换为 ${after.effective.kind}（${after.effective.path}）`);
      } else {
        io.print(`! ${after.error ?? "所选 shell 不可用"}`);
      }
      return "handled";
    }
    case "/preset": {
      const current = session.state().config.permissionPreset;
      if (rest.length === 0) {
        io.print(
          `当前权限预设：${current}\n可用预设：read-only | default | auto-edit | guarded | smart | bypass`,
        );
        return "handled";
      }
      try {
        await session.setPermissionPreset(rest.join(" "));
        // session.config_changed 事件会渲染确认行
      } catch (e) {
        io.print(`! ${errorText(e)}`);
      }
      return "handled";
    }
    case "/context": {
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
      io.print(
        [
          "上下文组成：",
          ...lines,
          `  ${"─".repeat(40)}`,
          `  合计 ~${report.estimatedTokens} / ${report.budgetTokens} tok${overBudget ? "  [超预算]" : ""}`,
        ].join("\n"),
      );
      return "handled";
    }
    case "/mcp": {
      const servers = session.mcpServers();
      if (servers.length === 0) {
        io.print("本会话没有配置 MCP 服务器");
        return "handled";
      }
      const lines = servers.map((s) => {
        const tools = s.state === "ready" ? `，${s.toolCount} 个工具` : "";
        const err = s.error !== undefined ? `，${s.error}` : "";
        const restarts = s.restarts > 0 ? `，重连 ${s.restarts} 次` : "";
        return `  ${s.name.padEnd(16)} ${s.state}${tools}${restarts}${err}`;
      });
      io.print(["MCP 服务器：", ...lines].join("\n"));
      return "handled";
    }
    case "/compact": {
      try {
        await session.compact();
        // context.compacted(kind="summary") 事件渲染确认行
      } catch (e) {
        io.print(`! ${errorText(e)}`);
      }
      return "handled";
    }
    default:
      io.print(`未知命令 ${cmd}；/help 列出可用命令`);
      return "unknown";
  }
}

function errorText(e: unknown): string {
  if (e instanceof RuntimeCommandError) return `${e.code}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}
