import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createPlatform } from "../src/platform/index.js";
import { discoverSkills, loadConfig } from "../src/config/index.js";
import { skillCatalog, renderSkill, replaySessionView } from "../src/protocol/index.js";
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
  const provider = new FakeProvider({});
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
        : [{ type: "finish", reason: "stop" }],
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
        return [{ type: "finish", reason: "stop" }];
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

function item<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) throw new Error("缺少测试条目");
  return value;
}
