import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createPlatform } from "../src/platform/index.js";
import { loadConfig } from "../src/config/index.js";
import {
  discoverSkills,
  renderSkill,
  skillCatalog,
  createSkillDiscoveryCache,
} from "../src/skills/index.js";
import { referenceCatalog } from "./fixtures/skill-catalog-reference.js";
import { parseSkillSlash, replaySessionView } from "../src/protocol/index.js";
import { createRulePolicy } from "../src/permission/index.js";
import { createRuntime } from "../src/index.js";
import { FakeProvider } from "../src/provider/index.js";
import { createSkillTool } from "../src/tools/index.js";
import { buildContext } from "../src/context/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "nct-skills-"));
  roots.push(root);
  const home = path.join(root, "home");
  const workspace = path.join(root, "project");
  mkdirSync(home);
  mkdirSync(workspace);
  const platform = {
    ...createPlatform(),
    homeDir: () => root,
    nocturneHome: () => home,
    env: () => undefined,
  };
  const skill = (base: string, name: string, front = "description: test", body = "body") => {
    const dir = path.join(base, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "SKILL.md"), `---\n${front}\n---\n${body}`);
    return dir;
  };
  const scan = () =>
    discoverSkills(platform, { nocturneHome: home, workspaceRoot: workspace, cwd: workspace });
  return { root, home, workspace, platform, skill, scan };
}

it("用户优先、名字忽略大小写、只扫一层，并保存未知和忽略字段", async () => {
  const f = fixture();
  f.skill(
    path.join(f.home, "skills"),
    "Humanizer-zh",
    "description: >\n  long description\n  across lines\nversion: 1\nallowed-tools: Bash(*)",
    "!`echo unsafe`\n```!\necho unsafe\n```",
  );
  f.skill(path.join(f.workspace, ".claude/skills"), "humanizer-zh");
  f.skill(path.join(f.home, "skills/deep"), "nested");
  const result = await f.scan();
  expect(result.skills).toHaveLength(2);
  expect(result.skills[0]).toMatchObject({
    name: "Humanizer-zh",
    unknownFields: { version: 1 },
    bodyLines: 4,
  });
  expect(item(result.skills, 0).description).toContain("long description across lines");
  expect(item(result.skills, 0).ignored).toHaveLength(3);
  expect(item(result.skills, 1).shadowedBy).toBe(item(result.skills, 0).entryPath);
  expect(result.warnings).toEqual([expect.objectContaining({ kind: "name", line: 2 })]);
});

it("300 个混合技能新旧目录逐字一致（窗口、禁用、覆盖、长描述与各调用状态）", async () => {
  const f = fixture();
  f.skill(path.join(f.home, "skills"), "seed");
  const seed = item((await f.scan()).skills, 0);
  const skills = Array.from({ length: 300 }, (_, i) => ({
    ...seed,
    name: `s-${i}`,
    layer: i % 3 === 0 ? ("project" as const) : ("user" as const),
    description:
      i % 2
        ? `English description ${i} ${"text ".repeat(i % 70)}`
        : `中文 カタカナ 한글 全角！？🙂 ${i} ${"中英 mixed ".repeat(i % 80)}`,
    shadowedBy: i % 11 === 0 ? "other" : undefined,
    missingDescription: i % 13 === 0,
    commandConflict: i % 17 === 0,
    fields: { "disable-model-invocation": i % 19 === 0, "user-invocable": i % 23 !== 0 },
  }));
  for (const window of [undefined, 1, 100, 2000, 20000, 128000, 1000000]) {
    for (const disabled of [
      [],
      ["s-1", "S-7", "s-12"],
      skills.filter((_, i) => i % 4 === 0).map((s) => s.name),
    ]) {
      const actual = skillCatalog(skills, disabled, window, "session-model");
      const expected = referenceCatalog(skills, disabled, window, "session-model");
      expect(actual.text).toBe(expected.text);
      expect(actual.budget).toEqual(expected.budget);
      expect(actual.truncated).toBe(expected.truncated);
      expect(actual.skills.map((s) => [s.catalogStatus, s.displayedDescriptionLength])).toEqual(
        expected.skills.map((s) => [s.catalogStatus, s.displayedDescriptionLength]),
      );
    }
  }
});

it("发现缓存命中不读 SKILL.md；正文修改、目录新增删除和缺失文件新增均失效", async () => {
  const f = fixture();
  const base = path.join(f.home, "skills");
  const a = f.skill(base, "a");
  const read = vi.spyOn(f.platform.fs, "readTextFile");
  const cache = createSkillDiscoveryCache(f.platform);
  const input = { nocturneHome: f.home, workspaceRoot: f.workspace, cwd: f.workspace };
  const first = await cache.discover(input);
  expect(first.skills.map((s) => s.name)).toEqual(["a"]);
  read.mockClear();
  first.skills[0]?.otherEntries.push("should-not-leak");
  const second = await cache.discover(input);
  expect(read).not.toHaveBeenCalled();
  expect(second.skills[0]?.otherEntries).toEqual([]);
  writeFileSync(
    path.join(a, "SKILL.md"),
    "---\ndescription: changed longer description\n---\nnew body",
  );
  expect((await cache.discover(input)).skills[0]?.description).toBe("changed longer description");
  expect(read).toHaveBeenCalledOnce();
  read.mockClear();
  f.skill(base, "b");
  expect((await cache.discover(input)).skills.map((s) => s.name)).toEqual(["a", "b"]);
  expect(read).toHaveBeenCalledTimes(2);
  read.mockClear();
  rmSync(path.join(base, "b"), { recursive: true });
  expect((await cache.discover(input)).skills.map((s) => s.name)).toEqual(["a"]);
  expect(read).toHaveBeenCalledOnce();
  read.mockClear();
  mkdirSync(path.join(base, "empty"));
  await cache.discover(input);
  read.mockClear();
  f.skill(base, "empty");
  expect((await cache.discover(input)).skills.map((s) => s.name)).toEqual(["a", "empty"]);
  expect(read).toHaveBeenCalledTimes(2);
  read.mockRestore();
});

it("目录 junction/符号链接按真实路径去重，保留最高优先级入口", async (ctx) => {
  const f = fixture();
  const actual = f.skill(path.join(f.home, "skills"), "shared");
  const links = path.join(f.root, ".claude/skills");
  mkdirSync(links, { recursive: true });
  try {
    symlinkSync(
      actual,
      path.join(links, "alias"),
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    ctx.skip(`无法创建目录链接：${String(error)}`);
    return;
  }
  const result = await f.scan();
  expect(result.skills).toHaveLength(1);
  expect(item(result.skills, 0).source).toBe(".nocturne");
  expect(item(result.skills, 0).otherEntries).toEqual([path.join(links, "alias")]);
});

it("解析失败隔离且带准确行号，缺说明仍可用户调用", async () => {
  const f = fixture();
  f.skill(path.join(f.home, "skills"), "bad", "name: bad\ndescription: [broken");
  f.skill(path.join(f.home, "skills"), "manual", "category: text");
  const scan = await f.scan();
  expect(scan.skills).toHaveLength(1);
  expect(scan.warnings[0]).toMatchObject({
    kind: "parse",
    path: path.join(f.home, "skills/bad/SKILL.md"),
  });
  expect(item(scan.warnings, 0).line).toBeGreaterThanOrEqual(3);
  const catalog = skillCatalog(scan.skills, [], 128000);
  expect(catalog.text).toBe("");
  expect(catalog.skills[0]).toMatchObject({ invocation: "user", missingDescription: true });
});

it("用户配置控制来源和 ~ extraDirs；项目配置 skills 无效；设置队列不丢并发开关", async () => {
  const f = fixture();
  writeFileSync(
    path.join(f.home, "config.json"),
    JSON.stringify({
      modelsDev: false,
      skills: { sources: { agents: false, claude: false }, extraDirs: ["~/extras"] },
    }),
  );
  mkdirSync(path.join(f.workspace, ".nocturne"));
  writeFileSync(
    path.join(f.workspace, ".nocturne/config.json"),
    JSON.stringify({ skills: { sources: { agents: true }, extraDirs: ["invalid"] } }),
  );
  f.skill(path.join(f.root, ".claude/skills"), "excluded");
  f.skill(path.join(f.root, "extras"), "extra");
  const config = await loadConfig(f.platform, { nocturneHome: f.home });
  const discovery = await discoverSkills(f.platform, {
    nocturneHome: f.home,
    workspaceRoot: f.workspace,
    cwd: f.workspace,
    config: config.skillConfig(),
  });
  expect(discovery.skills.map((s) => s.name)).toEqual(["extra"]);
  await Promise.all([
    config.setSkillEnabled("extra", false),
    config.setSkillEnabled("other", false),
  ]);
  expect(config.disabledSkills()).toEqual(["extra", "other"]);
  await config.setSkillEnabled("EXTRA", true);
  expect(config.disabledSkills()).toEqual(["other"]);
  expect(JSON.parse(readFileSync(path.join(f.home, "settings.json"), "utf8"))).toMatchObject({
    skills: { disabled: ["other"] },
  });
});

it("所有参数和路径替换一次完成，未知变量原样保留，无参数占位时追加参数", () => {
  const s = { realPath: "C:/skills/a", fields: { arguments: ["target", "scope"] } };
  expect(
    renderSkill(
      "$ARGUMENTS|$ARGUMENTS[1]|$0|$target|$scope|$HOME|${NOCTURNE_SKILL_DIR}|${CLAUDE_SKILL_DIR}|${CLAUDE_PROJECT_DIR}|${CLAUDE_SESSION_ID}",
      s,
      { name: "a", arguments: '"hello world" later' },
      "Z:/work",
      "session",
    ),
  ).toBe(
    '"hello world" later|later|hello world|hello world|later|$HOME|C:/skills/a|C:/skills/a|Z:/work|session',
  );
  expect(renderSkill("body", s, { name: "a", arguments: "value" }, "work", "session")).toBe(
    "body\nARGUMENTS: value",
  );
});

it("目录预算含标题与省略提示，项目优先、250 字截断，退化为名字和省略计数", async () => {
  const f = fixture();
  for (let i = 0; i < 110; i++)
    f.skill(path.join(f.home, "skills"), `s-${i}`, `description: ${"中".repeat(1019)}`);
  f.skill(path.join(f.workspace, ".agents/skills"), "project", "description: 项目优先");
  const scan = await f.scan();
  const catalog = skillCatalog(scan.skills, ["s-0"], 20000);
  expect(catalog.budget.usedTokens).toBeLessThanOrEqual(400);
  expect(catalog.text).toContain("project [项目]: 项目优先");
  expect(catalog.budget.nameCount).toBeGreaterThan(0);
  expect(catalog.text).toMatch(/另有 \d+ 个技能未列出/);
  const large = skillCatalog(scan.skills, [], 1000000);
  expect(large.budget.limitTokens).toBe(8000);
  expect(
    large.skills.find((s) => s.catalogStatus === "full" && s.layer === "user")
      ?.displayedDescriptionLength,
  ).toBe(250);
});

it("技能根目录仅放行 read，外部读取、edit 和 shell 不改变", () => {
  const policy = createRulePolicy({
    workspaceRoot: "C:/work",
    caseSensitive: false,
    preset: "default",
    presetContext: { skillRoots: ["C:/skills/a"] },
  });
  expect(
    policy.evaluate([
      { kind: "read", target: "C:/skills/a/ref.md", resolved: "C:/skills/a/ref.md" },
    ]).decision.action,
  ).toBe("allow");
  for (const [kind, target] of [
    ["read", "C:/skills/ab/ref.md"],
    ["edit", "C:/skills/a/ref.md"],
    ["shell", "node C:/skills/a/script.js"],
  ] as const)
    expect(
      policy.evaluate([{ kind, target, ...(kind !== "shell" ? { resolved: target } : {}) }])
        .decision.action,
    ).toBe("ask");
});

it("工具提供正文和最多50项文件，重复加载省略，摘要后重载，未知名给三个建议", async () => {
  const f = fixture();
  const dir = f.skill(path.join(f.home, "skills"), "alpha");
  f.skill(path.join(f.home, "skills"), "beta");
  f.skill(path.join(f.home, "skills"), "gamma");
  for (let i = 0; i < 70; i++) writeFileSync(path.join(dir, `file-${i}`), "x");
  const discovery = await f.scan();
  let epoch = 0;
  const tool = createSkillTool(
    skillCatalog(discovery.skills, []).skills.map((s, i) => ({
      ...s,
      body: item(discovery.skills, i).body,
    })),
    () => epoch,
  );
  const ctx = { sessionId: "session", workspaceRoot: f.workspace } as Parameters<
    typeof tool.execute
  >[1];
  expect(tool.traits).toMatchObject({ pinResult: true, mutates: false });
  expect((await tool.execute({ name: "ALPHA" }, ctx)).modelContent).toContain("body");
  expect((await tool.execute({ name: "alpha" }, ctx)).modelContent).toContain("已加载，见前文");
  epoch++;
  expect((await tool.execute({ name: "alpha" }, ctx)).modelContent).toContain("body");
  expect((await tool.execute({ name: "alph" }, ctx)).modelContent).toContain("alpha、beta、gamma");
  expect(item(discovery.skills, 0).files).toHaveLength(50);
});

it("用户正文快照恢复不重读；磁盘改动下一会话生效；停用即时更新空闲会话", async () => {
  const f = fixture();
  f.skill(
    path.join(f.home, "skills"),
    "manual",
    "disable-model-invocation: true",
    "original $ARGUMENTS",
  );
  writeFileSync(
    path.join(f.home, "config.json"),
    JSON.stringify({ modelsDev: false, skills: { sources: { agents: false, claude: false } } }),
  );
  const config = await loadConfig(f.platform, { nocturneHome: f.home });
  const provider = new FakeProvider({
    scripts: [
      [
        { type: "text_delta", text: "ok" },
        { type: "finish", reason: "stop" },
      ],
    ],
  });
  const runtime = await createRuntime({ cwd: f.workspace, config, providers: [provider] });
  const session = await runtime.createSession({ model: "fake/fake-1" });
  expect(session.describeContext().request.tools.some((t) => t.name === "skill")).toBe(false);
  await session.submit({ text: "/manual value", skill: { name: "manual", arguments: "value" } });
  writeFileSync(
    path.join(f.home, "skills/manual/SKILL.md"),
    "---\ndescription: changed\n---\nchanged",
  );
  const id = session.id;
  await session.close();
  const resumed = await runtime.resumeSession(id);
  const user = replaySessionView(resumed.durableEvents()).entries.find((e) => e.kind === "user");
  expect(user).toMatchObject({ skill: { name: "manual", body: "original value" } });
  expect(user?.kind === "user" && user.content.at(-1)).toMatchObject({
    text: '<skill name="manual">\noriginal value\n</skill>',
  });
  expect(item(resumed.describeSkills().skills, 0).description).toBe("changed");
  expect(await runtime.setSkillEnabled({ name: "manual", enabled: false })).toEqual({
    affectedSessions: 1,
  });
  expect(item(resumed.describeSkills().skills, 0).enabled).toBe(false);
  await resumed.close();
});

it("Turn 与压缩保持目录快照，启停在结束边界应用；磁盘修改等配置重载", async () => {
  const f = fixture();
  f.skill(path.join(f.home, "skills"), "alpha", "description: initial");
  writeFileSync(
    path.join(f.home, "config.json"),
    JSON.stringify({ modelsDev: false, skills: { sources: { agents: false, claude: false } } }),
  );
  const config = await loadConfig(f.platform, { nocturneHome: f.home });
  let release!: () => void;
  let started!: () => void;
  let entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  let held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const provider = new FakeProvider({
    handler: async () => {
      started();
      await held;
      return [
        { type: "text_delta", text: "summary" },
        { type: "finish", reason: "stop" },
      ];
    },
  });
  const runtime = await createRuntime({ cwd: f.workspace, config, providers: [provider] });
  const session = await runtime.createSession({ model: "fake/fake-1" });
  const turn = session.submit({ text: "test" });
  await entered;
  await runtime.setSkillEnabled({ name: "alpha", enabled: false });
  expect(item(session.describeSkills().skills, 0).enabled).toBe(true);
  expect(JSON.stringify(provider.requests[0])).toContain("initial");
  release();
  await turn;
  expect(item(session.describeSkills().skills, 0).enabled).toBe(false);
  await runtime.setSkillEnabled({ name: "alpha", enabled: true });
  writeFileSync(
    path.join(f.home, "skills/alpha/SKILL.md"),
    "---\ndescription: changed\n---\nnew body",
  );
  expect(item((await runtime.describeSkills()).skills, 0).description).toBe("changed");
  expect(item(session.describeSkills().skills, 0).description).toBe("initial");
  await runtime.updateProviders(await loadConfig(f.platform, { nocturneHome: f.home }));
  expect(item(session.describeSkills().skills, 0).description).toBe("changed");
  entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const compact = session.compact();
  await entered;
  await runtime.setSkillEnabled({ name: "alpha", enabled: false });
  expect(item(session.describeSkills().skills, 0).enabled).toBe(true);
  release();
  await compact;
  expect(item(session.describeSkills().skills, 0).enabled).toBe(false);
  await session.close();
});

it("模型实际调用 skill 的 pinResult 写入日志并在恢复后保持", async () => {
  const f = fixture();
  f.skill(path.join(f.home, "skills"), "alpha");
  writeFileSync(
    path.join(f.home, "config.json"),
    JSON.stringify({ modelsDev: false, skills: { sources: { agents: false, claude: false } } }),
  );
  const config = await loadConfig(f.platform, { nocturneHome: f.home });
  const provider = new FakeProvider({
    handler: (_request, index) =>
      index < 2
        ? [
            {
              type: "tool_call",
              toolCallId: `load-${index}`,
              name: "skill",
              input: { name: "alpha" },
            },
            { type: "finish", reason: "tool_calls" },
          ]
        : [
            { type: "text_delta", text: "ok" },
            { type: "finish", reason: "stop" },
          ],
  });
  const runtime = await createRuntime({ cwd: f.workspace, config, providers: [provider] });
  const session = await runtime.createSession({ model: "fake/fake-1" });
  await session.submit({ text: "load twice" });
  const events = session.durableEvents();
  expect(
    events.filter((e) => e.type === "tool.started").every((e) => e.payload.pinResult === true),
  ).toBe(true);
  const completed = events.filter((e) => e.type === "tool.completed");
  expect(completed).toHaveLength(2);
  expect(completed[0]?.payload.modelContent).toContain("body");
  expect(completed[1]?.payload.modelContent).toContain("已加载，见前文");
  const id = session.id;
  await session.close();
  const resumed = await runtime.resumeSession(id);
  const tools = resumed.state().history.filter((e) => e.kind === "tool");
  expect(tools).toHaveLength(2);
  expect(tools.every((e) => e.pinResult)).toBe(true);
  await resumed.close();
});

it("explore 子会话默认可用 skill，使用父会话的正文快照", async () => {
  const f = fixture();
  const dir = f.skill(path.join(f.home, "skills"), "alpha", "description: snapshot", "parent body");
  writeFileSync(
    path.join(f.home, "config.json"),
    JSON.stringify({ modelsDev: false, skills: { sources: { agents: false, claude: false } } }),
  );
  const config = await loadConfig(f.platform, { nocturneHome: f.home });
  const provider = new FakeProvider({
    handler: (request) => {
      if (request.tools.some((t) => t.name === "finish")) {
        expect(request.tools.some((t) => t.name === "skill")).toBe(true);
        const loaded = request.messages.find((m) => m.role === "tool");
        if (loaded) {
          expect(JSON.stringify(loaded)).toContain("parent body");
          return [
            {
              type: "tool_call",
              toolCallId: "finish-child",
              name: "finish",
              input: { result: "done" },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return [
          { type: "tool_call", toolCallId: "load-child", name: "skill", input: { name: "alpha" } },
          { type: "finish", reason: "tool_calls" },
        ];
      }
      if (request.messages.some((m) => m.role === "tool"))
        return [
          { type: "text_delta", text: "ok" },
          { type: "finish", reason: "stop" },
        ];
      writeFileSync(path.join(dir, "SKILL.md"), "---\ndescription: changed\n---\nchanged body");
      return [
        {
          type: "tool_call",
          toolCallId: "task-parent",
          name: "task",
          input: { task: "load alpha", preset: "explore" },
        },
        { type: "finish", reason: "tool_calls" },
      ];
    },
  });
  const runtime = await createRuntime({ cwd: f.workspace, config, providers: [provider] });
  const session = await runtime.createSession({ model: "fake/fake-1" });
  await session.submit({ text: "delegate" });
  expect(
    session.durableEvents().find((e) => e.type === "tool.completed" && e.payload.name === "task")
      ?.payload,
  ).toMatchObject({ status: "ok" });
  expect(provider.requests.filter((r) => r.tools.some((t) => t.name === "finish"))).toHaveLength(2);
  await session.close();
});

it("L1 pinResult 保留正文，普通工具结果仍修剪，目录放在指令与环境之间", () => {
  const model = item(new FakeProvider({}).models(), 0);
  const built = buildContext({
    model,
    tools: [],
    instructions: { user: { source: "test", content: "instructions" }, project: [] },
    environment: { cwd: "work", workspaceRoot: "work", sessionDate: "2026-10-06", os: "Windows" },
    skills: { text: "catalog", truncated: true },
    history: [
      {
        kind: "tool",
        seq: 1,
        turnId: "t",
        callId: "a",
        name: "custom",
        status: "ok",
        modelContent: "pinned",
        pinResult: true,
      },
      {
        kind: "tool",
        seq: 2,
        turnId: "t",
        callId: "b",
        name: "other",
        status: "ok",
        modelContent: "ordinary",
      },
      {
        kind: "compaction",
        seq: 3,
        compactKind: "prune",
        throughSeq: 2,
        turnId: undefined,
        summary: undefined,
      },
    ],
  });
  const content = JSON.stringify(built.request.messages);
  expect(content).toContain("pinned");
  expect(content).not.toContain("ordinary");
  expect(built.report.sections.map((s) => s.name)).toEqual([
    "system",
    "tools",
    "instructions",
    "skills",
    "environment",
    "history",
  ]);
  expect(built.report.sections.find((s) => s.name === "skills")?.truncated).toBe(true);
});

it("守护：默认测试运行时不读真实主目录", async () => {
  // setup-offline.ts 把 HOME/USERPROFILE 重定向到独立的临时目录。
  // 先断言重定向仍在（回归时第一时间失败），再端到端验证技能发现
  // 跟的是重定向后的 home：标记技能写进当前 homedir 能被不传
  // platform 的 createRuntime 发现；另一个假主目录里的同名位置看不到。
  const realHome = process.env.NOCTURNE_TEST_REAL_HOME;
  expect(realHome).toBeTruthy();
  expect(homedir()).not.toBe(realHome);
  const marker = `nct-guard-${process.pid}`;
  const dir = path.join(homedir(), ".agents", "skills", marker);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), "---\ndescription: guard\n---\nbody");
  const decoyHome = mkdtempSync(path.join(tmpdir(), "nct-decoy-home-"));
  mkdirSync(path.join(decoyHome, ".agents", "skills", "decoy"), { recursive: true });
  writeFileSync(
    path.join(decoyHome, ".agents", "skills", "decoy", "SKILL.md"),
    "---\ndescription: decoy\n---\nbody",
  );
  const ws = mkdtempSync(path.join(tmpdir(), "nct-guard-ws-"));
  roots.push(ws, decoyHome);
  try {
    const runtime = await createRuntime({
      cwd: ws,
      sessionsDir: path.join(ws, "sessions"),
      providers: [new FakeProvider({})],
    });
    const session = await runtime.createSession({ model: "fake/fake-1" });
    try {
      const names = session.describeSkills().skills.map((s) => s.name);
      expect(names).toContain(marker);
      expect(names).not.toContain("decoy");
    } finally {
      await session.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("agents 内置命令优先且忽略大小写；停用技能不可被斜杠调用", async () => {
  const f = fixture();
  f.skill(path.join(f.home, "skills"), "agents");
  f.skill(path.join(f.home, "skills"), "manual");
  const discovery = await f.scan();
  const catalog = skillCatalog(discovery.skills, []);
  expect(catalog.skills.find((skill) => skill.name === "agents")?.commandConflict).toBe(true);
  expect(parseSkillSlash("/AGENTS task", catalog.skills)).toBeUndefined();
  expect(parseSkillSlash("/MANUAL 原文", catalog.skills)).toEqual({
    name: "manual",
    arguments: "原文",
  });
  expect(
    parseSkillSlash("/manual task", skillCatalog(discovery.skills, ["manual"]).skills),
  ).toBeUndefined();
});

function item<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) throw new Error("缺少测试条目");
  return value;
}

it("正文超过单次输出预算：开头提示总长和 SKILL.md 的读法；预算内不加提示", async () => {
  const f = fixture();
  f.skill(path.join(f.home, "skills"), "big", "description: big", "行".repeat(40_000));
  f.skill(path.join(f.home, "skills"), "small", "description: small", "短正文");
  const discovery = await f.scan();
  const tool = createSkillTool(
    skillCatalog(discovery.skills, []).skills.map((s, i) => ({
      ...s,
      body: item(discovery.skills, i).body,
    })),
  );
  const ctx = { sessionId: "session", workspaceRoot: f.workspace } as Parameters<
    typeof tool.execute
  >[1];
  const big = (await tool.execute({ name: "big" }, ctx)).modelContent;
  const noticeAt = big.indexOf("提示：正文共 40000 字符");
  expect(noticeAt).toBeGreaterThan(0);
  // 提示在开头，位于正文之前，不会被执行器截掉的中间一段吞掉
  expect(noticeAt).toBeLessThan(500);
  expect(big).toContain(path.join("skills", "big", "SKILL.md"));
  expect(big).toContain("offset/limit");
  expect((await tool.execute({ name: "small" }, ctx)).modelContent).not.toContain("提示：正文共");
});

it("项目层技能根是普通文件时不报警告，其他技能根照常发现", async () => {
  const f = fixture();
  mkdirSync(path.join(f.workspace, ".agents"), { recursive: true });
  mkdirSync(path.join(f.workspace, ".claude"), { recursive: true });
  writeFileSync(path.join(f.workspace, ".agents/skills"), "../doc/src/devdocs/agents/skills");
  writeFileSync(path.join(f.workspace, ".claude/skills"), "../doc/src/devdocs/agents/skills");
  f.skill(path.join(f.home, "skills"), "ok-user");
  f.skill(path.join(f.workspace, ".nocturne/skills"), "ok-project");

  const result = await f.scan();
  expect(result.warnings).toEqual([]);
  expect(result.skills.map((s) => s.name)).toEqual(["ok-user", "ok-project"]);
});

it("用户层和插件技能根是普通文件时不报警告，其他技能根照常发现且缓存感知替换", async () => {
  const f = fixture();
  writeFileSync(path.join(f.home, "skills"), "../other/skills");
  mkdirSync(path.join(f.root, ".agents"), { recursive: true });
  writeFileSync(path.join(f.root, ".agents/skills"), "../other/skills");
  const pluginFile = path.join(f.root, "plugin-skills-file");
  writeFileSync(pluginFile, "../other/skills");
  const pluginDir = path.join(f.root, "plugin-skills-dir");
  f.skill(path.join(f.root, ".claude/skills"), "from-claude");
  f.skill(pluginDir, "from-plugin");

  const cache = createSkillDiscoveryCache(f.platform);
  const input = {
    nocturneHome: f.home,
    workspaceRoot: f.workspace,
    cwd: f.workspace,
    pluginSkillDirs: [
      { path: pluginFile, plugin: "file-root@local" },
      { path: pluginDir, plugin: "dir-root@local" },
    ],
  };
  const first = await cache.discover(input);
  expect(first.warnings).toEqual([]);
  expect(first.skills.map((s) => s.name)).toEqual(["from-claude", "from-plugin"]);

  // 普通文件被替换为真实目录后，发现缓存应失效并扫出新技能
  rmSync(path.join(f.root, ".agents/skills"));
  f.skill(path.join(f.root, ".agents/skills"), "now-a-dir");
  const second = await cache.discover(input);
  expect(second.warnings).toEqual([]);
  expect(second.skills.map((s) => s.name)).toEqual(["now-a-dir", "from-claude", "from-plugin"]);
});

it("技能根是指向目录的符号链接或目录联接时照常发现技能", async (ctx) => {
  const f = fixture();
  const targetDir = path.join(f.root, "real-skills");
  f.skill(targetDir, "linked-root-skill");
  mkdirSync(path.join(f.workspace, ".agents"), { recursive: true });
  try {
    symlinkSync(
      targetDir,
      path.join(f.workspace, ".agents/skills"),
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    ctx.skip(`无法创建目录链接：${String(error)}`);
    return;
  }

  const result = await f.scan();
  expect(result.warnings).toEqual([]);
  expect(result.skills).toHaveLength(1);
  expect(item(result.skills, 0)).toMatchObject({
    name: "linked-root-skill",
    layer: "project",
    source: ".agents",
  });
});

it("技能根 readdir 因其他错误失败时仍然产生 read 警告", async () => {
  const f = fixture();
  const brokenRoot = path.join(f.workspace, ".agents/skills");
  mkdirSync(brokenRoot, { recursive: true });
  f.skill(path.join(f.home, "skills"), "ok-user");

  const origReaddir = f.platform.fs.readdir.bind(f.platform.fs);
  const spy = vi.spyOn(f.platform.fs, "readdir").mockImplementation(async (p) => {
    if (f.platform.paths.equals(p, brokenRoot)) {
      throw Object.assign(new Error(`EACCES: permission denied, scandir '${p}'`), {
        code: "EACCES",
      });
    }
    return origReaddir(p);
  });
  try {
    const result = await f.scan();
    expect(result.skills.map((s) => s.name)).toEqual(["ok-user"]);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        path: brokenRoot,
        line: 1,
        kind: "read",
        message: expect.stringContaining("EACCES"),
      }),
    ]);
  } finally {
    spy.mockRestore();
  }
});

it("命令文件发现：用户与项目四个命令根、子目录取文件名、关闭 claude 开关、不扫 .agents/commands", async () => {
  const f = fixture();
  const cmd = (filePath: string, content: string) => {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
    return filePath;
  };
  const userNocturne = cmd(path.join(f.home, "commands/u-nocturne.md"), "# 用户命令\n正文");
  const userClaude = cmd(
    path.join(f.root, ".claude/commands/ops/u-claude.md"),
    "---\ndescription: 用户 Claude 命令\n---\n执行 $ARGUMENTS",
  );
  const projectNocturne = cmd(
    path.join(f.workspace, ".nocturne/commands/team/p-nocturne.md"),
    "项目子目录命令\n细节",
  );
  const projectClaude = cmd(
    path.join(f.workspace, ".claude/commands/p-claude.md"),
    "## 项目 Claude 命令\n步骤",
  );
  // 不读 .agents/commands
  cmd(path.join(f.root, ".agents/commands/ignored-user.md"), "# 不应被发现");
  cmd(path.join(f.workspace, ".agents/commands/ignored-project.md"), "# 不应被发现");
  // 非 .md 文件跳过；命令根是普通文件时不报警告
  cmd(path.join(f.home, "commands/note.txt"), "not markdown");

  const all = await f.scan();
  expect(all.warnings).toEqual([]);
  expect(all.skills.map((s) => [s.name, s.layer, s.source, s.layout])).toEqual([
    ["u-nocturne", "user", ".nocturne", "file"],
    ["u-claude", "user", ".claude", "file"],
    ["p-nocturne", "project", ".nocturne", "file"],
    ["p-claude", "project", ".claude", "file"],
  ]);
  expect(item(all.skills, 0).entryPath).toBe(userNocturne);
  expect(item(all.skills, 1).entryPath).toBe(userClaude);
  expect(item(all.skills, 2).entryPath).toBe(projectNocturne);
  expect(item(all.skills, 3).entryPath).toBe(projectClaude);

  const noClaude = await discoverSkills(f.platform, {
    nocturneHome: f.home,
    workspaceRoot: f.workspace,
    cwd: f.workspace,
    config: { sources: { claude: false } },
  });
  expect(noClaude.skills.map((s) => s.name)).toEqual(["u-nocturne", "p-nocturne"]);
});

it("命令文件优先级：同级目录技能优先、离 cwd 近优先于上层、用户层优先于项目层、同根重名按路径取首个", async () => {
  const f = fixture();
  const cmd = (filePath: string, content: string) => {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
    return filePath;
  };
  const sub = path.join(f.workspace, "packages/web");
  mkdirSync(sub, { recursive: true });

  // 1. 同一级目录技能与命令文件同名：目录技能优先
  const sameLevelDir = f.skill(path.join(f.workspace, ".nocturne/skills"), "same-level");
  const sameLevelCmd = cmd(path.join(f.workspace, ".nocturne/commands/same-level.md"), "命令版");

  // 2. 离 cwd 近的命令文件优先于上层目录技能
  const nearCmd = cmd(path.join(sub, ".nocturne/commands/near-win.md"), "近处命令");
  f.skill(path.join(f.workspace, ".nocturne/skills"), "near-win");

  // 3. 用户层命令文件优先于项目层目录技能和命令文件
  const userCmd = cmd(path.join(f.home, "commands/user-win.md"), "用户命令");
  f.skill(path.join(sub, ".nocturne/skills"), "user-win");
  cmd(path.join(sub, ".nocturne/commands/user-win.md"), "项目命令");

  // 4. 同一个命令文件根里出现同名文件：按路径排序取第一个
  const firstDup = cmd(path.join(f.workspace, ".nocturne/commands/a/dup.md"), "第一个");
  const secondDup = cmd(path.join(f.workspace, ".nocturne/commands/b/dup.md"), "第二个");

  const result = await discoverSkills(f.platform, {
    nocturneHome: f.home,
    workspaceRoot: f.workspace,
    cwd: sub,
  });

  const byName = (name: string) => result.skills.filter((s) => s.name === name);

  const sameLevel = byName("same-level");
  expect(sameLevel).toHaveLength(2);
  expect(sameLevel[0]).toMatchObject({
    layout: "directory",
    entryPath: sameLevelDir,
    shadowedBy: undefined,
  });
  expect(sameLevel[1]).toMatchObject({
    layout: "file",
    entryPath: sameLevelCmd,
    shadowedBy: sameLevelDir,
  });

  const nearWin = byName("near-win");
  expect(nearWin).toHaveLength(2);
  expect(nearWin[0]).toMatchObject({ layout: "file", entryPath: nearCmd, shadowedBy: undefined });
  expect(nearWin[1]).toMatchObject({ layout: "directory", shadowedBy: nearCmd });

  const userWin = byName("user-win");
  expect(userWin).toHaveLength(3);
  expect(userWin[0]).toMatchObject({
    layer: "user",
    layout: "file",
    entryPath: userCmd,
    shadowedBy: undefined,
  });
  expect(userWin[1]?.shadowedBy).toBe(userCmd);
  expect(userWin[2]?.shadowedBy).toBe(userCmd);

  const dup = byName("dup");
  expect(dup).toHaveLength(2);
  expect(dup[0]).toMatchObject({ entryPath: firstDup, shadowedBy: undefined });
  expect(dup[1]).toMatchObject({ entryPath: secondDup, shadowedBy: firstDup });
});

it("命令文件格式：无 frontmatter 说明回退正文首行、空正文缺说明、有 frontmatter 字段与参数替换", async () => {
  const f = fixture();
  const cmd = (filePath: string, content: string) => {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
    return filePath;
  };
  const plainFile = cmd(
    path.join(f.workspace, ".nocturne/commands/deploy.md"),
    "\n  ##  部署到目标环境  \n\n目标：$1\n全部：$ARGUMENTS\n目录：${NOCTURNE_SKILL_DIR}|${CLAUDE_SKILL_DIR}\n!`echo no-run`",
  );
  cmd(path.join(f.workspace, ".nocturne/commands/blank.md"), "   \n#\n  ");
  cmd(
    path.join(f.workspace, ".nocturne/commands/manual-cmd.md"),
    "---\nargument-hint: <env>\ndisable-model-invocation: true\nallowed-tools: Bash(*)\n---\n# 手动发布\n执行 $ARGUMENTS",
  );

  const discovery = await f.scan();
  const catalog = skillCatalog(discovery.skills, []);

  const deploy = catalog.skills.find((s) => s.name === "deploy");
  const deploySource = discovery.skills.find((s) => s.name === "deploy");
  expect(deploy).toMatchObject({
    layout: "file",
    description: "部署到目标环境",
    missingDescription: false,
    invocation: "both",
    catalogStatus: "full",
    files: [],
  });
  expect(deploy?.ignored).toEqual([expect.objectContaining({ syntax: "!`echo no-run`" })]);
  expect(deploySource).toBeDefined();
  if (!deploySource) throw new Error("expected deploySource");
  expect(
    renderSkill(
      deploySource.body,
      deploySource,
      { name: "deploy", arguments: "staging prod" },
      f.workspace,
      "sess-1",
    ),
  ).toContain(
    `目标：prod\n全部：staging prod\n目录：${path.dirname(deploySource.realPath)}|${path.dirname(deploySource.realPath)}`,
  );
  expect(plainFile).toBe(deploy?.entryPath);

  const blank = catalog.skills.find((s) => s.name === "blank");
  expect(blank).toMatchObject({
    missingDescription: true,
    invocation: "user",
    catalogStatus: "omitted",
  });

  const manual = catalog.skills.find((s) => s.name === "manual-cmd");
  expect(manual).toMatchObject({
    description: "手动发布",
    missingDescription: false,
    invocation: "user",
    catalogStatus: "omitted",
    fields: expect.objectContaining({
      "argument-hint": "<env>",
      "disable-model-invocation": true,
    }),
    ignored: [expect.objectContaining({ syntax: "allowed-tools: Bash(*)" })],
  });
});

it("命令文件工具与权限：skill 工具返回正文且文件清单为空，read allow 仅放行单文件", async () => {
  const f = fixture();
  const cmdDir = path.join(f.home, "commands");
  mkdirSync(cmdDir, { recursive: true });
  const targetFile = path.join(cmdDir, "release.md");
  const siblingFile = path.join(cmdDir, "secret.txt");
  writeFileSync(targetFile, "# 发布版本\n检查 $ARGUMENTS 并记录到 ${NOCTURNE_SKILL_DIR}");
  writeFileSync(siblingFile, "not allowed");

  const discovery = await f.scan();
  const catalog = skillCatalog(discovery.skills, []);
  const release = item(catalog.skills, 0);
  const releaseSource = item(discovery.skills, 0);

  const tool = createSkillTool([{ ...release, body: releaseSource.body }]);
  const ctx = { sessionId: "sess-cmd", workspaceRoot: f.workspace } as Parameters<
    typeof tool.execute
  >[1];
  const result = await tool.execute({ name: "release", arguments: "v1.2" }, ctx);
  expect(result.status).toBe("ok");
  expect(result.output).toEqual({
    name: "release",
    directory: path.dirname(releaseSource.realPath),
    files: [],
  });
  expect(result.modelContent).toContain("检查 v1.2");
  expect(result.modelContent).toContain(`文件：\n`);

  // 预设权限：skillFiles 仅放行单个命令文件的 read，不放行同目录其他文件，也不放行 edit/shell
  const policy = createRulePolicy({
    workspaceRoot: f.workspace,
    caseSensitive: f.platform.caseSensitivePaths,
    preset: "default",
    presetContext: { skillFiles: [releaseSource.realPath] },
  });
  expect(
    policy.evaluate([
      { kind: "read", target: releaseSource.realPath, resolved: releaseSource.realPath },
    ]).decision.action,
  ).toBe("allow");
  expect(
    policy.evaluate([{ kind: "read", target: siblingFile, resolved: siblingFile }]).decision.action,
  ).toBe("ask");
  expect(
    policy.evaluate([
      { kind: "edit", target: releaseSource.realPath, resolved: releaseSource.realPath },
    ]).decision.action,
  ).toBe("ask");

  // 运行时集成：会话预设放行命令文件本身的 read，不放行同目录其他文件
  writeFileSync(
    path.join(f.home, "config.json"),
    JSON.stringify({ modelsDev: false, skills: { sources: { agents: false, claude: false } } }),
  );
  const config = await loadConfig(f.platform, { nocturneHome: f.home });
  const askedTargets: string[] = [];
  const provider = new FakeProvider({
    scripts: [
      [
        { type: "tool_call", toolCallId: "read-cmd", name: "read", input: { path: targetFile } },
        {
          type: "tool_call",
          toolCallId: "read-sibling",
          name: "read",
          input: { path: siblingFile },
        },
        { type: "finish", reason: "tool_calls" },
      ],
      [
        { type: "text_delta", text: "done" },
        { type: "finish", reason: "stop" },
      ],
    ],
  });
  const runtime = await createRuntime({
    cwd: f.workspace,
    config,
    providers: [provider],
    interactive: true,
  });
  const session = await runtime.createSession({ model: "fake/fake-1" });
  const unsub = session.subscribe((ev) => {
    if (ev.type === "permission.requested") {
      askedTargets.push(...ev.payload.subjects.map((s) => s.target));
      void session.respondPermission(ev.payload.requestId, { decision: "deny" });
    }
  });
  try {
    await session.submit({ text: "check read rules" });
  } finally {
    unsub();
    await session.close();
  }
  expect(askedTargets.some((t) => f.platform.paths.equals(t, targetFile))).toBe(false);
  expect(askedTargets.some((t) => f.platform.paths.equals(t, siblingFile))).toBe(true);
});

it("命令文件发现缓存：根目录新建以及命令文件增改删均失效，未变化时命中不重读", async () => {
  const f = fixture();
  const cache = createSkillDiscoveryCache(f.platform);
  const input = { nocturneHome: f.home, workspaceRoot: f.workspace, cwd: f.workspace };
  const read = vi.spyOn(f.platform.fs, "readTextFile");

  // 1. 根目录尚不存在 → 创建后能重新发现
  expect((await cache.discover(input)).skills).toEqual([]);
  const cmdDir = path.join(f.workspace, ".nocturne/commands");
  mkdirSync(cmdDir, { recursive: true });
  const aFile = path.join(cmdDir, "alpha.md");
  writeFileSync(aFile, "# 初始说明\n正文");
  const afterCreate = await cache.discover(input);
  expect(afterCreate.skills.map((s) => [s.name, s.description])).toEqual([["alpha", "初始说明"]]);

  // 2. 未变化时缓存命中，不重读文件
  read.mockClear();
  const cached = await cache.discover(input);
  expect(cached.skills.map((s) => s.name)).toEqual(["alpha"]);
  expect(read).not.toHaveBeenCalled();

  // 3. 修改命令文件正文 → 失效并读取新内容
  writeFileSync(aFile, "# 更新后的更长说明\n新正文内容");
  const afterEdit = await cache.discover(input);
  expect(afterEdit.skills[0]?.description).toBe("更新后的更长说明");
  expect(read).toHaveBeenCalledOnce();

  // 4. 子目录新增命令文件 → 失效并发现新文件
  read.mockClear();
  const subDir = path.join(cmdDir, "ops");
  mkdirSync(subDir, { recursive: true });
  const bFile = path.join(subDir, "beta.md");
  writeFileSync(bFile, "# 子目录命令\n内容");
  const afterAdd = await cache.discover(input);
  expect(afterAdd.skills.map((s) => s.name)).toEqual(["alpha", "beta"]);

  // 5. 删除命令文件 → 失效并移除
  read.mockClear();
  rmSync(bFile);
  const afterDelete = await cache.discover(input);
  expect(afterDelete.skills.map((s) => s.name)).toEqual(["alpha"]);
  read.mockRestore();
});
