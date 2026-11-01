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
  lines.push(
    exceeded
      ? `间距警告 ${warnings} 处，超过上限 ${exceeded.maxWarnings}`
      : `间距警告 ${warnings} 处`,
  );
  return `${lines.join("\n")}\n`;
}
