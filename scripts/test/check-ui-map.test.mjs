import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { checkUiMap } from "../check-ui-map.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..", "..");

describe("check-ui-map", () => {
  const dirs = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("仓库 docs/development/ui-map.md 中全部路径真实存在", () => {
    const res = checkUiMap({ repoRoot });
    expect(res.ok).toBe(true);
    expect(res.rowCount).toBeGreaterThan(20);
    expect(res.checkedCount).toBeGreaterThan(40);
    expect(res.missing).toEqual([]);
  });

  it("表里出现不存在的路径时返回失败与准确行号", () => {
    const root = mkdtempSync(join(tmpdir(), "nctrn-uimap-"));
    dirs.push(root);
    mkdirSync(join(root, "apps", "desktop", "src"), { recursive: true });
    mkdirSync(join(root, "docs", "development"), { recursive: true });
    writeFileSync(join(root, "apps", "desktop", "src", "Ok.tsx"), "");
    writeFileSync(
      join(root, "docs", "development", "ui-map.md"),
      [
        "# UI Map",
        "",
        "| 界面名 | 进入方式 | 主组件文件 | 测试文件 |",
        "|---|---|---|---|",
        "| 正常 | 点按钮 | `apps/desktop/src/Ok.tsx` | `apps/desktop/test/missing.test.tsx` |",
        "",
      ].join("\n"),
    );

    const res = checkUiMap({ repoRoot: root });
    expect(res.ok).toBe(false);
    expect(res.rowCount).toBe(1);
    expect(res.checkedCount).toBe(2);
    expect(res.missing).toEqual([
      {
        file: "docs/development/ui-map.md",
        line: 5,
        path: "apps/desktop/test/missing.test.tsx",
      },
    ]);
  });
});
