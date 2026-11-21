import { isNode, LineCounter, parseDocument } from "yaml";
import { fsErrorCode, type Platform } from "../platform/index.js";
import {
  BUILTIN_SLASH_COMMANDS,
  type SkillsConfig,
  type SkillOverview,
  type SkillWarning,
} from "../protocol/index.js";

export interface DiscoveredSkill extends SkillOverview {
  body: string;
}

const supported = new Set([
  "name",
  "description",
  "when_to_use",
  "disable-model-invocation",
  "user-invocable",
  "argument-hint",
  "arguments",
]);
const ignoredReasons: Record<string, string> = {
  "allowed-tools": "不预先放行；运行脚本时照常按权限设置确认",
  "disallowed-tools": "不改变会话权限；照常按权限设置处理",
  context: "不另起子代理，在当前会话里执行",
  agent: "不切换代理，在当前会话里执行",
  model: "不切换模型，沿用会话设置",
  effort: "不改变思考档位，沿用会话设置",
  background: "不转为后台任务，在当前会话里执行",
  hooks: "不注册钩子，沿用会话设置",
  paths: "不限制技能匹配路径",
  shell: "不改变 shell，沿用会话设置",
};
const builtinCommands = new Set<string>(BUILTIN_SLASH_COMMANDS);
const parseError = (line: number, message: string) => Object.assign(new Error(message), { line });

export function parseSkill(
  text: string,
  directory: string,
  options?: { allowMissingFrontmatter?: boolean },
): { fields: Record<string, unknown>; body: string } {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    if (options?.allowMissingFrontmatter) {
      return { fields: { name: directory }, body: normalized };
    }
    throw parseError(1, "缺少 YAML 前言");
  }
  const end = normalized.indexOf("\n---", 4);
  if (end < 0 || !/^\n---(?:\n|$)/.test(normalized.slice(end)))
    throw parseError(1, "YAML 前言未闭合");
  const lineCounter = new LineCounter();
  const doc = parseDocument(normalized.slice(4, end), { lineCounter, uniqueKeys: true });
  const error = doc.errors[0];
  if (error) {
    throw parseError(lineCounter.linePos(error.pos[0]).line + 1, error.message);
  }
  const fields: unknown = doc.toJS({ maxAliasCount: 100 }) ?? {};
  if (!fields || typeof fields !== "object" || Array.isArray(fields))
    throw parseError(2, "前言必须为字段映射");
  const values = fields as Record<string, unknown>;
  const fieldLine = (key: string) => {
    const node = doc.get(key, true);
    return lineCounter.linePos(isNode(node) ? (node.range?.[0] ?? 0) : 0).line + 1;
  };
  for (const key of ["name", "description", "when_to_use", "argument-hint"]) {
    if (values[key] !== undefined && typeof values[key] !== "string")
      throw parseError(fieldLine(key), `${key} 必须是字符串`);
  }
  for (const key of ["disable-model-invocation", "user-invocable"]) {
    if (values[key] !== undefined && typeof values[key] !== "boolean")
      throw parseError(fieldLine(key), `${key} 必须是布尔值`);
  }
  values.name ??= directory;
  return { fields: values, body: normalized.slice(end + 4).replace(/^\n/, "") };
}

function firstNonEmptyBodyLine(body: string): string {
  for (const rawLine of body.split("\n")) {
    const cleaned = rawLine.replace(/^\s*#+\s*/, "").trim();
    if (cleaned) return cleaned;
  }
  return "";
}

export async function discoverSkills(
  platform: Platform,
  input: {
    nocturneHome: string;
    workspaceRoot: string;
    cwd: string;
    config?: SkillsConfig | undefined;
    pluginSkillDirs?:
      | readonly ({ path: string; plugin: string } & Pick<
          SkillOverview,
          "pluginDisplayName" | "pluginIcon"
        >)[]
      | undefined;
  },
): Promise<{
  skills: DiscoveredSkill[];
  warnings: SkillWarning[];
  scannedDirs: string[];
  homeDir: string;
}> {
  const { fs, paths } = platform;
  const roots: ({
    path: string;
    layer: SkillOverview["layer"];
    source: SkillOverview["source"];
    layout: "directory" | "file";
  } & Pick<SkillOverview, "plugin" | "pluginDisplayName" | "pluginIcon">)[] = [];
  const add = (base: string, layer: "user" | "project", user = false) => {
    roots.push({
      path: paths.join(base, user ? "skills" : ".nocturne/skills"),
      layer,
      source: ".nocturne",
      layout: "directory",
    });
    for (const source of ["agents", "claude"] as const) {
      if (input.config?.sources?.[source] !== false)
        roots.push({
          path: paths.join(user ? platform.homeDir() : base, `.${source}/skills`),
          layer,
          source: `.${source}`,
          layout: "directory",
        });
    }
    roots.push({
      path: paths.join(base, user ? "commands" : ".nocturne/commands"),
      layer,
      source: ".nocturne",
      layout: "file",
    });
    if (input.config?.sources?.claude !== false)
      roots.push({
        path: paths.join(user ? platform.homeDir() : base, ".claude/commands"),
        layer,
        source: ".claude",
        layout: "file",
      });
  };
  add(input.nocturneHome, "user", true);
  for (const dir of input.config?.extraDirs ?? []) {
    const expanded = /^~(?:[\\/]|$)/.test(dir) ? paths.join(platform.homeDir(), dir.slice(2)) : dir;
    roots.push({
      path: paths.resolve(platform.homeDir(), expanded),
      layer: "user",
      source: "extra",
      layout: "directory",
    });
  }
  for (const dir of input.pluginSkillDirs ?? []) {
    roots.push({
      ...dir,
      layer: "user",
      source: "plugin",
      layout: "directory",
    });
  }
  let dir = paths.resolve(input.cwd, ".");
  while (paths.isWithin(input.workspaceRoot, dir)) {
    add(dir, "project");
    if (paths.equals(dir, input.workspaceRoot)) break;
    const parent = paths.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const skills: DiscoveredSkill[] = [];
  const warnings: SkillWarning[] = [];
  const realSeen = new Map<string, DiscoveredSkill>();
  const names = new Map<string, DiscoveredSkill>();
  const collectCommandFiles = async (
    rootPath: string,
  ): Promise<{ name: string; entryPath: string; file: string; realTarget: string }[]> => {
    const collected: {
      name: string;
      entryPath: string;
      file: string;
      realTarget: string;
      relPath: string;
    }[] = [];
    const visitedDirs = new Set<string>();
    const visit = async (dirPath: string, relPrefix: string) => {
      let realDir: string;
      try {
        realDir = await fs.realpath(dirPath);
      } catch (e) {
        const code = fsErrorCode(e);
        if (code === "ENOENT" || code === "ENOTDIR") return;
        warnings.push({ path: dirPath, line: 1, kind: "read", message: String(e) });
        return;
      }
      const canonicalDir = paths.canonicalize(realDir);
      if (visitedDirs.has(canonicalDir)) return;
      visitedDirs.add(canonicalDir);
      let entries;
      try {
        entries = await fs.readdir(dirPath);
      } catch (e) {
        warnings.push({ path: dirPath, line: 1, kind: "read", message: String(e) });
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
        if (entry.type === "directory") {
          await visit(entry.path, rel);
        } else if (entry.type === "file") {
          if (entry.name.endsWith(".md") && entry.name.length > 3) {
            collected.push({
              name: entry.name.slice(0, -3),
              entryPath: entry.path,
              file: entry.path,
              realTarget: entry.path,
              relPath: rel,
            });
          }
        } else if (entry.type === "symlink") {
          let targetStat;
          try {
            targetStat = await fs.stat(entry.path);
          } catch (e) {
            const code = fsErrorCode(e);
            if (code === "ENOENT" || code === "ENOTDIR") continue;
            warnings.push({ path: entry.path, line: 1, kind: "read", message: String(e) });
            continue;
          }
          if (targetStat.type === "directory") {
            await visit(entry.path, rel);
          } else if (
            targetStat.type === "file" &&
            entry.name.endsWith(".md") &&
            entry.name.length > 3
          ) {
            collected.push({
              name: entry.name.slice(0, -3),
              entryPath: entry.path,
              file: entry.path,
              realTarget: entry.path,
              relPath: rel,
            });
          }
        }
      }
    };
    await visit(rootPath, "");
    collected.sort((a, b) => a.relPath.localeCompare(b.relPath));
    return collected;
  };
  for (const root of roots) {
    let rootStat;
    try {
      rootStat = await fs.stat(root.path);
    } catch (e) {
      const code = fsErrorCode(e);
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      warnings.push({ path: root.path, line: 1, kind: "read", message: String(e) });
      continue;
    }
    if (rootStat.type !== "directory") continue;
    let skillEntries: { name: string; entryPath: string; file: string; realTarget: string }[] = [];
    if (root.layout === "file") {
      skillEntries = await collectCommandFiles(root.path);
    } else {
      const directSkill = root.source === "plugin" ? paths.join(root.path, "SKILL.md") : undefined;
      if (directSkill !== undefined && (await fs.exists(directSkill))) {
        skillEntries = [
          {
            name: paths.basename(root.path),
            entryPath: root.path,
            file: directSkill,
            realTarget: root.path,
          },
        ];
      } else {
        let entries;
        try {
          entries = await fs.readdir(root.path);
        } catch (e) {
          warnings.push({ path: root.path, line: 1, kind: "read", message: String(e) });
          continue;
        }
        skillEntries = entries
          .sort((a, b) => a.name.localeCompare(b.name))
          .filter((e) => e.type === "directory" || e.type === "symlink")
          .map((e) => ({
            name: e.name,
            entryPath: e.path,
            file: paths.join(e.path, "SKILL.md"),
            realTarget: e.path,
          }));
      }
    }
    for (const entry of skillEntries) {
      if (root.layout === "directory" && !(await fs.exists(entry.file))) continue;
      try {
        const realPath = await fs.realpath(entry.realTarget);
        const previous = realSeen.get(paths.canonicalize(realPath));
        if (previous) {
          previous.otherEntries.push(entry.entryPath);
          continue;
        }
        const raw = await fs.readTextFile(entry.file);
        const hasFrontmatter = raw
          .replace(/^\uFEFF/, "")
          .replace(/\r\n/g, "\n")
          .startsWith("---\n");
        const { fields, body } = parseSkill(raw, entry.name, {
          allowMissingFrontmatter: root.layout === "file",
        });
        const name = String(fields.name);
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64)
          warnings.push({
            path: entry.file,
            line: hasFrontmatter ? 2 : 1,
            kind: "name",
            message: `名字 ${name} 不符合 Agent Skills 规范；仍然可用`,
          });
        const rawDescription =
          typeof fields.description === "string" && fields.description.trim()
            ? fields.description
            : root.layout === "file"
              ? firstNonEmptyBodyLine(body)
              : "";
        const description = [rawDescription, fields.when_to_use]
          .filter((x) => typeof x === "string" && x.trim())
          .join("\n");
        const ignored = Object.entries(fields).flatMap(([key, value]) =>
          ignoredReasons[key]
            ? [
                {
                  syntax: `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
                  reason: ignoredReasons[key],
                },
              ]
            : [],
        );
        for (const match of body.matchAll(/!`[^`\n]+`|^```![^\n]*/gm))
          ignored.push({ syntax: match[0], reason: "不执行，原文交给模型，模型需要时自己运行" });
        const files =
          root.layout === "file"
            ? []
            : (await fs.readdir(realPath))
                .sort((a, b) => a.name.localeCompare(b.name))
                .slice(0, 50)
                .map((f) => ({ name: f.name, directory: f.type === "directory" }));
        const winner = names.get(name.toLowerCase());
        const skill: DiscoveredSkill = {
          name,
          layer: root.layer,
          source: root.source,
          layout: root.layout,
          ...(root.plugin !== undefined ? { plugin: root.plugin } : {}),
          ...(root.pluginDisplayName !== undefined
            ? { pluginDisplayName: root.pluginDisplayName }
            : {}),
          ...(root.pluginIcon !== undefined ? { pluginIcon: root.pluginIcon } : {}),
          entryPath: entry.entryPath,
          realPath,
          otherEntries: [],
          description,
          displayedDescriptionLength: 0,
          invocation: "none",
          catalogStatus: "omitted",
          enabled: true,
          shadowedBy: winner?.entryPath,
          commandConflict: builtinCommands.has(name.toLowerCase()),
          missingDescription: !rawDescription.trim(),
          fields: Object.fromEntries(Object.entries(fields).filter(([key]) => supported.has(key))),
          unknownFields: Object.fromEntries(
            Object.entries(fields).filter(([key]) => !supported.has(key) && !ignoredReasons[key]),
          ),
          ignored,
          body,
          bodyLines: body.split("\n").length,
          bodyPreview: body.split("\n").slice(0, 40).join("\n"),
          files,
          size: (await fs.stat(entry.file)).size,
        };
        skills.push(skill);
        realSeen.set(paths.canonicalize(realPath), skill);
        if (!winner) names.set(name.toLowerCase(), skill);
      } catch (e) {
        const error = e as { line?: number; message?: string };
        warnings.push({
          path: entry.file,
          line: error.line ?? 1,
          kind: "parse",
          message: error.message ?? String(e),
        });
      }
    }
  }
  return {
    skills,
    warnings,
    scannedDirs: roots.map((r) => r.path),
    homeDir: paths.join(input.nocturneHome, "skills"),
  };
}
