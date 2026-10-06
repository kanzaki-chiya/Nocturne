import { isNode, LineCounter, parseDocument } from "yaml";
import type { Platform } from "../platform/index.js";
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

function parseSkill(
  text: string,
  directory: string,
): { fields: Record<string, unknown>; body: string } {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) throw parseError(1, "缺少 YAML 前言");
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

export async function discoverSkills(
  platform: Platform,
  input: {
    nocturneHome: string;
    workspaceRoot: string;
    cwd: string;
    config?: SkillsConfig | undefined;
  },
): Promise<{
  skills: DiscoveredSkill[];
  warnings: SkillWarning[];
  scannedDirs: string[];
  homeDir: string;
}> {
  const { fs, paths } = platform;
  const roots: { path: string; layer: "user" | "project"; source: SkillOverview["source"] }[] = [];
  const add = (base: string, layer: "user" | "project", user = false) => {
    roots.push({
      path: paths.join(base, user ? "skills" : ".nocturne/skills"),
      layer,
      source: ".nocturne",
    });
    for (const source of ["agents", "claude"] as const) {
      if (input.config?.sources?.[source] !== false)
        roots.push({
          path: paths.join(user ? platform.homeDir() : base, `.${source}/skills`),
          layer,
          source: `.${source}`,
        });
    }
  };
  add(input.nocturneHome, "user", true);
  for (const dir of input.config?.extraDirs ?? []) {
    const expanded = /^~(?:[\\/]|$)/.test(dir) ? paths.join(platform.homeDir(), dir.slice(2)) : dir;
    roots.push({
      path: paths.resolve(platform.homeDir(), expanded),
      layer: "user",
      source: "extra",
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
  for (const root of roots) {
    if (!(await fs.exists(root.path))) continue;
    let entries;
    try {
      entries = await fs.readdir(root.path);
    } catch (e) {
      warnings.push({ path: root.path, line: 1, kind: "read", message: String(e) });
      continue;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.type !== "directory" && entry.type !== "symlink") continue;
      const file = paths.join(entry.path, "SKILL.md");
      if (!(await fs.exists(file))) continue;
      try {
        const realPath = await fs.realpath(entry.path);
        const previous = realSeen.get(paths.canonicalize(realPath));
        if (previous) {
          previous.otherEntries.push(entry.path);
          continue;
        }
        const { fields, body } = parseSkill(await fs.readTextFile(file), entry.name);
        const name = String(fields.name);
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64)
          warnings.push({
            path: file,
            line: 2,
            kind: "name",
            message: `名字 ${name} 不符合 Agent Skills 规范；仍然可用`,
          });
        const description = [fields.description, fields.when_to_use]
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
        const files = (await fs.readdir(realPath))
          .sort((a, b) => a.name.localeCompare(b.name))
          .slice(0, 50)
          .map((f) => ({ name: f.name, directory: f.type === "directory" }));
        const winner = names.get(name.toLowerCase());
        const skill: DiscoveredSkill = {
          name,
          layer: root.layer,
          source: root.source,
          entryPath: entry.path,
          realPath,
          otherEntries: [],
          description,
          displayedDescriptionLength: 0,
          invocation: "none",
          catalogStatus: "omitted",
          enabled: true,
          shadowedBy: winner?.entryPath,
          commandConflict: builtinCommands.has(name.toLowerCase()),
          missingDescription: typeof fields.description !== "string" || !fields.description.trim(),
          fields: Object.fromEntries(Object.entries(fields).filter(([key]) => supported.has(key))),
          unknownFields: Object.fromEntries(
            Object.entries(fields).filter(([key]) => !supported.has(key) && !ignoredReasons[key]),
          ),
          ignored,
          body,
          bodyLines: body.split("\n").length,
          bodyPreview: body.split("\n").slice(0, 40).join("\n"),
          files,
          size: (await fs.stat(file)).size,
        };
        skills.push(skill);
        realSeen.set(paths.canonicalize(realPath), skill);
        if (!winner) names.set(name.toLowerCase(), skill);
      } catch (e) {
        const error = e as { line?: number; message?: string };
        warnings.push({
          path: file,
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
