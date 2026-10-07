/**
 * 技能导入（U-08）：预检与执行的 Core 逻辑测试。
 * 场景覆盖 ADR-0048 修订：单个/多个技能目录、格式不合格、三重名处理、
 * 覆盖失败原技能不变、跳过符号链接、大小上限。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createPlatform } from "../src/platform/index.js";
import { parseSkill } from "../src/skills/discovery.js";
import {
  commitSkillImport,
  previewSkillImport,
  rewriteSkillName,
  SKILL_IMPORT_SIZE_LIMIT_BYTES,
} from "../src/skills/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "nct-skill-import-"));
  roots.push(root);
  const home = path.join(root, "home");
  const workspace = path.join(root, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  const platform = createPlatform();
  const skill = (base: string, name: string, front = "description: test", body = "body") => {
    const dir = path.join(base, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "SKILL.md"), `---\n${front}\n---\n${body}`);
    return dir;
  };
  const preview = (sourceDir: string, target: "user" | "project" = "user") =>
    previewSkillImport(platform, {
      sourceDir,
      target,
      nocturneHome: home,
      workspaceRoot: workspace,
      cwd: workspace,
    });
  return { root, home, workspace, platform, skill, preview };
}

describe("previewSkillImport", () => {
  it("单个技能目录：来源本身含 SKILL.md 时作为一个候选", async () => {
    const f = fixture();
    const src = path.join(f.root, "src");
    f.skill(src, "one", "description: only");
    const preview = await f.preview(path.join(src, "one"));
    expect(preview.targetDir).toBe(path.join(f.home, "skills"));
    expect(preview.candidates).toHaveLength(1);
    expect(preview.candidates[0]).toMatchObject({ name: "one", valid: true });
  });

  it("多个技能目录：扫描下一层含 SKILL.md 的子目录", async () => {
    const f = fixture();
    const src = path.join(f.root, "bundle");
    mkdirSync(src, { recursive: true });
    f.skill(src, "a", "description: A");
    f.skill(src, "b", "description: B");
    mkdirSync(path.join(src, "empty"), { recursive: true });
    const preview = await f.preview(src);
    expect(preview.candidates.map((c) => c.name).sort()).toEqual(["a", "b"]);
  });

  it("格式不合格：无前言、名字不规范的候选不可选", async () => {
    const f = fixture();
    const src = path.join(f.root, "bundle");
    mkdirSync(src, { recursive: true });
    const bad = path.join(src, "bad");
    mkdirSync(bad, { recursive: true });
    writeFileSync(path.join(bad, "SKILL.md"), "no frontmatter here");
    f.skill(src, "Bad_Name", "description: x");
    const preview = await f.preview(src);
    const byName = new Map(preview.candidates.map((c) => [c.name, c]));
    expect(byName.get("bad")).toMatchObject({ valid: false });
    expect(byName.get("bad")?.reason).toContain("前言");
    expect(byName.get("Bad_Name")).toMatchObject({ valid: false });
    expect(byName.get("Bad_Name")?.reason).toContain("规范");
  });

  it("跳过符号链接：链接不计入大小、候选中列出", async () => {
    const f = fixture();
    const src = path.join(f.root, "src");
    const dir = f.skill(src, "linked", "description: l");
    const outside = path.join(f.root, "outside.txt");
    writeFileSync(outside, "secret");
    symlinkSync(outside, path.join(dir, "link.txt"));
    const preview = await f.preview(path.join(src, "linked"));
    expect(preview.candidates[0]?.skippedLinks).toEqual(["link.txt"]);
  });

  it("超过大小上限的候选不可选", async () => {
    const f = fixture();
    const src = path.join(f.root, "src");
    const dir = f.skill(src, "big", "description: b");
    writeFileSync(path.join(dir, "blob.bin"), Buffer.alloc(SKILL_IMPORT_SIZE_LIMIT_BYTES + 1));
    const preview = await f.preview(path.join(src, "big"));
    expect(preview.candidates[0]).toMatchObject({ valid: false });
    expect(preview.candidates[0]?.reason).toContain("上限");
  });

  it("目标同名冲突给出改名建议；他层同名给出覆盖提示", async () => {
    const f = fixture();
    f.skill(path.join(f.home, "skills"), "dup", "description: old");
    f.skill(path.join(f.workspace, ".nocturne/skills"), "shadowed", "description: p");
    const src = path.join(f.root, "src");
    mkdirSync(src, { recursive: true });
    f.skill(src, "dup", "description: new");
    f.skill(src, "shadowed", "description: new");
    const preview = await f.preview(src);
    const byName = new Map(preview.candidates.map((c) => [c.name, c]));
    expect(byName.get("dup")?.targetConflict).toBe(true);
    expect(byName.get("dup")?.suggestedName).toBe("dup-2");
    expect(byName.get("shadowed")?.targetConflict).toBe(false);
    expect(byName.get("shadowed")?.shadowNote).toContain("覆盖");
  });
});

describe("commitSkillImport", () => {
  it("改名：目录与 SKILL.md 的 name 同步改写", async () => {
    const f = fixture();
    f.skill(path.join(f.home, "skills"), "dup", "description: old");
    const src = path.join(f.root, "src");
    mkdirSync(src, { recursive: true });
    const dir = f.skill(src, "dup", "description: new");
    const results = await commitSkillImport(f.platform, {
      targetDir: path.join(f.home, "skills"),
      decisions: [{ sourcePath: dir, name: "dup-2", action: "rename" }],
    });
    expect(results[0]).toMatchObject({ status: "imported", finalName: "dup-2" });
    const { fields } = parseSkill(
      readFileSync(path.join(f.home, "skills", "dup-2", "SKILL.md"), "utf8"),
      "dup-2",
    );
    expect(fields.name).toBe("dup-2");
  });

  it("覆盖：成功替换内容；跳过：目标与来源都不动", async () => {
    const f = fixture();
    const src = path.join(f.root, "src");
    mkdirSync(src, { recursive: true });
    const dir = f.skill(src, "k", "description: new", "new body");
    const target = f.skill(path.join(f.home, "skills"), "k", "description: old", "old body");
    const results = await commitSkillImport(f.platform, {
      targetDir: path.join(f.home, "skills"),
      decisions: [
        { sourcePath: dir, action: "overwrite" },
        { sourcePath: dir, action: "skip" },
      ],
    });
    expect(results.map((r) => r.status)).toEqual(["imported", "skipped"]);
    expect(readFileSync(path.join(target, "SKILL.md"), "utf8")).toContain("new body");
  });

  it("非 overwrite 不静默覆盖已存在目标", async () => {
    const f = fixture();
    f.skill(path.join(f.home, "skills"), "k", "description: old");
    const src = path.join(f.root, "src");
    mkdirSync(src, { recursive: true });
    const dir = f.skill(src, "k", "description: new");
    await expect(
      commitSkillImport(f.platform, {
        targetDir: path.join(f.home, "skills"),
        decisions: [{ sourcePath: dir, action: "rename" }],
      }),
    ).rejects.toMatchObject({ name: "SkillImportError" });
  });

  it("commit 中途失败时原有目标内容不变", async () => {
    const f = fixture();
    const src = path.join(f.root, "src");
    mkdirSync(src, { recursive: true });
    const keep = f.skill(path.join(f.home, "skills"), "keep", "description: keep", "keep body");
    const dir = f.skill(src, "newcomer", "description: new");
    await expect(
      commitSkillImport(f.platform, {
        targetDir: path.join(f.home, "skills"),
        decisions: [
          { sourcePath: dir, action: "overwrite" },
          { sourcePath: path.join(src, "ghost"), action: "overwrite" },
        ],
      }),
    ).rejects.toMatchObject({ name: "SkillImportError" });
    // 原有技能不受影响
    expect(readFileSync(path.join(keep, "SKILL.md"), "utf8")).toContain("keep body");
  });
});

describe("rewriteSkillName", () => {
  it("有 name 行替换、无 name 行插入", () => {
    expect(rewriteSkillName("---\nname: old\ndescription: x\n---\nbody", "new")).toContain(
      "name: new",
    );
    const inserted = rewriteSkillName("---\ndescription: x\n---\nbody", "new");
    expect(inserted).toContain("name: new");
    expect(inserted.indexOf("name: new")).toBeLessThan(inserted.indexOf("description"));
  });
});
