import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { checkDocLinks } from "../check-doc-links.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..", "..");

describe("check-doc-links", () => {
  const dirs = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("仓库内已跟踪 Markdown 的相对链接全部指向存在的文件", () => {
    const res = checkDocLinks({ repoRoot });
    expect(res.missing).toEqual([]);
    expect(res.fileCount).toBeGreaterThan(100);
    expect(res.checkedCount).toBeGreaterThan(1000);
  });

  it("报告不存在的目标及行号，跳过外部链接、锚点、站点路径和代码", () => {
    const root = mkdtempSync(join(tmpdir(), "nctrn-doclinks-"));
    dirs.push(root);
    mkdirSync(join(root, "docs", "decisions"), { recursive: true });
    mkdirSync(join(root, "docs", "architecture"), { recursive: true });
    writeFileSync(join(root, "docs", "architecture", "skills.md"), "");
    writeFileSync(
      join(root, "docs", "decisions", "ADR-1.md"),
      [
        "# ADR",
        "[ok](../architecture/skills.md#节) [dir](../architecture/)",
        "[wrong](skills.md) [web](https://example.com/x.md) [anchor](#top) [site](/docs/x.md)",
        "`[code](nope.md)`",
        "```",
        "[fenced](nope.md)",
        "```",
        "[编码](%E7%BC%BA.md)",
        "",
      ].join("\n"),
    );

    const res = checkDocLinks({ repoRoot: root, files: ["docs/decisions/ADR-1.md"] });
    expect(res.ok).toBe(false);
    expect(res.checkedCount).toBe(4);
    expect(res.missing).toEqual([
      { file: "docs/decisions/ADR-1.md", line: 3, link: "skills.md" },
      { file: "docs/decisions/ADR-1.md", line: 8, link: "%E7%BC%BA.md" },
    ]);
  });
});
