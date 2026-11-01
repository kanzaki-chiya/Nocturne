import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import stylelint from "stylelint";
import { describe, expect, it } from "vitest";

const rootDir = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const configFile = resolve(rootDir, ".stylelintrc.json");
const codeFilename = resolve(rootDir, "apps/desktop/src/x.css");

async function lintSnippet(code) {
  const result = await stylelint.lint({
    code,
    codeFilename,
    configFile,
  });
  const warnings = result.results[0]?.warnings ?? [];
  return {
    errored: result.errored,
    errors: warnings.filter((w) => w.severity === "error"),
    warnings: warnings.filter((w) => w.severity === "warning"),
  };
}

describe("stylelint config", () => {
  it.each([
    ["a{color:#fff}", "color-no-hex"],
    ["a{color:white}", "color-named"],
    ["a{background:rgb(0 0 0 / 0.5)}", "function-disallowed-list"],
    ["a{font-size:13px}", "declaration-property-value-allowed-list"],
    ["a{border-radius:6px}", "declaration-property-value-allowed-list"],
    ["a{box-shadow:0 1px 2px red}", "declaration-property-value-allowed-list"],
  ])("报错拦截 %s (%s)", async (code, expectedRule) => {
    const res = await lintSnippet(code);
    expect(res.errored).toBe(true);
    expect(res.errors.map((e) => e.rule)).toContain(expectedRule);
  });

  it("间距字面量只有警告", async () => {
    const res = await lintSnippet("a{padding:3px}");
    expect(res.errored).toBe(false);
    expect(res.errors).toEqual([]);
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]?.rule).toBe("declaration-property-value-disallowed-list");
  });

  it.each([
    "a{white-space:nowrap}",
    "a{color:var(--a-text)}",
    "a{font-size:max(var(--fs-1),0.92em)}",
    "a{padding:var(--space-2)}",
  ])("合法写法无报错无警告：%s", async (code) => {
    const res = await lintSnippet(code);
    expect(res.errored).toBe(false);
    expect(res.errors).toEqual([]);
    expect(res.warnings).toEqual([]);
  });

  it("无理由的 stylelint-disable-next-line 被报告", async () => {
    const res = await lintSnippet(
      "a{\n  /* stylelint-disable-next-line color-no-hex */\n  color:#fff;\n}",
    );
    expect(res.errored).toBe(true);
    expect(res.errors.map((e) => e.rule)).toContain("--report-descriptionless-disables");
  });
});
