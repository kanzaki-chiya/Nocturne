/**
 * 从 CLI 参数解析 `--max-warnings` 上限，用于反向棘轮检查。
 */
function parseMaxWarningsFromArgv(argv = process.argv) {
  let maxWarnings;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    let raw;
    if (arg.startsWith("--max-warnings=")) {
      raw = arg.slice("--max-warnings=".length);
    } else if (arg === "--max-warnings" && i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
      raw = argv[++i];
    }
    if (raw !== undefined && /^\d+$/.test(raw)) {
      maxWarnings = Number.parseInt(raw, 10);
    }
  }
  return maxWarnings;
}

/**
 * lint:css 的输出：错误逐条列出，存量间距警告只报总数（DESIGN.md 第 10 节），
 * 否则每次 pnpm lint 都要刷几百行。看明细直接跑 stylelint 不带这个 formatter。
 */
export default function formatter(results, returnValue) {
  const lines = [];
  let warnings = 0;
  for (const result of results) {
    const errors = result.warnings.filter((w) => w.severity === "error");
    warnings += result.warnings.length - errors.length;
    if (errors.length === 0) continue;
    lines.push(result.source ?? "<input>");
    for (const e of errors) lines.push(`  ${e.line}:${e.column}  ${e.text}`);
  }
  const exceeded = returnValue?.maxWarningsExceeded;
  const hasReturnMaxWarnings =
    typeof returnValue?.maxWarnings === "number" && Number.isFinite(returnValue.maxWarnings);
  const maxWarnings = hasReturnMaxWarnings ? returnValue.maxWarnings : parseMaxWarningsFromArgv();

  if (exceeded) {
    lines.push(`间距警告 ${warnings} 处，超过上限 ${exceeded.maxWarnings}`);
  } else if (maxWarnings !== undefined && warnings < maxWarnings) {
    lines.push(`间距警告已降到 ${warnings} 处，把 package.json 里的上限改成 ${warnings}`);
    // 仅在由 CLI 参数驱动时置非零退出码，避免单测通过 returnValue.maxWarnings 断言时污染进程状态
    if (!hasReturnMaxWarnings) {
      process.exitCode = 2;
    }
  } else {
    lines.push(`间距警告 ${warnings} 处`);
  }
  return `${lines.join("\n")}\n`;
}
