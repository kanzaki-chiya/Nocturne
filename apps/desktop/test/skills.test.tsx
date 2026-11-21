import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  BUILTIN_SLASH_COMMANDS,
  type ExternalAgentOverview,
  type SkillOverview,
  type SkillsDescription,
} from "@nocturne/core/protocol";
import { SkillsPage } from "../src/SkillsPage";
import { Composer } from "../src/Composer";
import {
  completeSlash,
  parseSlash,
  COMMANDS,
  REDIRECTS,
  externalAgentSlashConflict,
} from "../src/commands";
import { fakeServer, withInit } from "./fake-server";

afterEach(cleanup);
const skill = (overrides: Partial<SkillOverview> = {}): SkillOverview => ({
  name: "alpha",
  layer: "user",
  source: ".agents",
  entryPath: "C:/home/alpha",
  realPath: "C:/actual/alpha",
  otherEntries: [],
  description: "说明".repeat(200),
  displayedDescriptionLength: 250,
  invocation: "both",
  catalogStatus: "full",
  enabled: true,
  commandConflict: false,
  missingDescription: false,
  fields: { name: "alpha", "argument-hint": "<file>" },
  unknownFields: { author: "test" },
  ignored: [],
  bodyLines: 3,
  bodyPreview: "body",
  files: [{ name: "SKILL.md", directory: false }],
  size: 1024,
  ...overrides,
});
const data = (skills: SkillOverview[]): SkillsDescription => ({
  skills,
  warnings: [{ path: "C:/home/bad/SKILL.md", line: 3, message: "bad YAML", kind: "parse" }],
  budget: {
    usedTokens: 678,
    limitTokens: 2560,
    fullCount: 2,
    nameCount: 4,
    disabledCount: 1,
    basis: "session-model",
  },
  homeDir: "C:/home/skills",
  scannedDirs: ["C:/home/skills", "Z:/project/.agents/skills"],
});

it("桌面每个斜杠命令与重定向都在 Core 的 BUILTIN_SLASH_COMMANDS 里", () => {
  // 技能与命令重名时禁止斜杠调用（skills.md 第 6 节）；新增命令或重定向要同步名单
  const builtin = new Set(BUILTIN_SLASH_COMMANDS);
  for (const { name } of COMMANDS) expect(builtin.has(name.slice(1)), name).toBe(true);
  for (const name of Object.keys(REDIRECTS)) {
    expect(builtin.has(name.slice(1)), name).toBe(true);
  }
});

it("补全命令优先，技能过滤、排序、参数提示及用户调用", () => {
  const skills = [
    skill({ name: "zeta" }),
    skill(),
    skill({ name: "off", invocation: "none", enabled: false }),
    skill({ name: "model-only", invocation: "model" }),
    skill({ name: "compact", commandConflict: true, invocation: "model" }),
  ];
  const groups = completeSlash("/", skills);
  expect(groups.map((g) => g.id)).toEqual(["commands", "skills"]);
  expect(groups[1]?.items.map((s) => s.label)).toEqual(["/alpha", "/zeta"]);
  expect(groups[1]?.items[0]?.argumentHint).toBe("<file>");
  expect(groups[1]?.items[0]?.summary.length).toBe(250);
  expect(parseSlash("/alpha file.ts", "session", skills)).toEqual({
    kind: "skill",
    invocation: { name: "alpha", arguments: "file.ts" },
  });
  expect(parseSlash("/compact", "session", skills)?.kind).toBe("command");
});

it("列表分组、模型目录预算、进详情、截断、写法、覆盖同名、缺说明、冲突与解析失败", async () => {
  const normal = skill({
    source: ".nocturne",
    otherEntries: ["C:/alt/alpha"],
  });
  const ignored = skill({
    name: "release",
    entryPath: "C:/home/release",
    ignored: [
      { syntax: "allowed-tools: Bash(*)", reason: "照常确认" },
      { syntax: "context: fork", reason: "当前会话" },
    ],
  });
  const shadow = skill({
    layer: "project",
    source: ".nocturne",
    entryPath: "Z:/project/alpha",
    realPath: "Z:/project/alpha",
    shadowedBy: normal.entryPath,
    invocation: "none",
    catalogStatus: "omitted",
  });
  const local = skill({
    name: "local-only",
    layer: "project",
    source: ".nocturne",
    entryPath: "Z:/project/local-only",
  });
  const manual = skill({
    name: "manual",
    entryPath: "C:/home/manual",
    missingDescription: true,
    commandConflict: true,
    description: "",
    invocation: "user",
    catalogStatus: "omitted",
  });
  const extra = skill({
    name: "pdf-tools",
    source: "extra",
    entryPath: "D:/shared/pdf-tools",
  });
  const disabled = skill({
    name: "deploy",
    entryPath: "C:/home/deploy",
    enabled: false,
    invocation: "none",
    catalogStatus: "omitted",
  });
  const f = fakeServer(
    withInit({
      "skills.describeSkills": data([normal, ignored, shadow, local, manual, extra, disabled]),
      "skills.setSkillEnabled": { affectedSessions: 2 },
    }),
  );
  await f.initialize();
  const openDirectory = vi.fn(async () => undefined);
  render(
    <SkillsPage
      client={f.client}
      workspaceRoot="Z:/project"
      version={0}
      openDirectory={openDirectory}
      openUrl={vi.fn()}
    />,
  );
  // 列表页：预算在 PageHeader，不显示旧预算条、统计句、扫描目录
  await screen.findByText("678 / 2,560");
  expect(screen.queryByRole("meter")).toBeNull();
  expect(screen.queryByText(/完整说明 \d+ 个/)).toBeNull();
  expect(screen.queryByText(/扫描目录/)).toBeNull();
  expect(screen.getByText("project").parentElement?.textContent).toBe("项目project · 1");

  const userGroup = screen.getByRole("region", { name: /用户 · 5/ });
  expect(within(userGroup).queryByText("模型 + 用户")).toBeNull();
  expect(within(userGroup).getByText("只限用户")).toBeTruthy();
  expect(within(userGroup).getByText("不加载")).toBeTruthy();
  expect(within(userGroup).getByText("缺说明")).toBeTruthy();
  expect(within(userGroup).queryByText(/2 处不生效/)).toBeNull();
  expect(within(userGroup).getAllByText("alpha")).toHaveLength(1);

  // 解析失败汇总
  fireEvent.click(screen.getByText("1 个技能的前言解析失败，查看"));
  expect(screen.getByText("C:/home/bad/SKILL.md:3")).toBeTruthy();

  // 进入 alpha 详情：概况、同名、位置 title、截断、图标按钮打开目录
  fireEvent.click(within(userGroup).getByText("alpha"));
  await screen.findByText("模型目录到此为止");
  expect(screen.getByRole("button", { name: "技能" })).toBeTruthy();
  expect(screen.getByRole("group", { name: "同名" }).textContent).toContain("Z:/project/alpha");
  expect(screen.queryByRole("button", { name: "查看生效的那份" })).toBeNull();
  expect(screen.queryByText(/另有入口 C:\/alt\/alpha/)).toBeNull();
  expect(screen.getByText("C:/actual/alpha\\SKILL.md").getAttribute("title")).toContain(
    "经 C:/home/alpha 进入；另有入口 C:/alt/alpha 指向同一目录，只算一个",
  );
  expect(screen.getByRole("region", { name: "说明 · 400 字" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: /^写法/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "在资源管理器中打开" }));
  expect(openDirectory).toHaveBeenCalledWith("C:/actual/alpha");

  // 面包屑返回列表，再进入 release 查看写法组（无旧警告横幅）
  fireEvent.click(screen.getByRole("button", { name: "技能" }));
  await screen.findByText("678 / 2,560");
  fireEvent.click(screen.getByText("release"));
  expect(screen.queryByText(/处写法在 Nocturne 里不生效/)).toBeNull();
  const ignoredGroup = await screen.findByRole("region", { name: "写法 · 2" });
  expect(within(ignoredGroup).getByText("allowed-tools: Bash(*)")).toBeTruthy();
  expect(within(ignoredGroup).getByText("照常确认")).toBeTruthy();

  // 返回列表，进入 manual 查看斜杠冲突与缺说明（无旧警告横幅）
  fireEvent.click(screen.getByRole("button", { name: "技能" }));
  fireEvent.click(await screen.findByText("manual"));
  expect(screen.queryByText("缺少说明，模型看不到这个技能")).toBeNull();
  expect(screen.queryByText("与内置命令重名，斜杠不能调用")).toBeNull();
  expect(screen.getByRole("group", { name: "斜杠" }).textContent).toContain("/manual");
  expect(screen.getByRole("group", { name: "斜杠" }).textContent).toContain("与内置命令重名");
  expect(within(screen.getByRole("region", { name: "说明" })).getByText("缺说明")).toBeTruthy();

  // 详情页开关调用 setSkillEnabled 且留在详情页
  fireEvent.click(screen.getByRole("switch", { name: "启用 manual" }));
  expect(await screen.findByRole("status")).toHaveProperty("textContent", "✓ 已停用 manual");
  expect(screen.getByRole("button", { name: "技能" })).toBeTruthy();
});

it("列表开关只调用启用不导航，fallback 预算带 title", async () => {
  const base = data([skill()]);
  const f = fakeServer(
    withInit({
      "skills.describeSkills": {
        ...base,
        budget: { ...base.budget, basis: "fallback", limitTokens: 8000 },
      },
      "skills.setSkillEnabled": { affectedSessions: 1 },
    }),
  );
  await f.initialize();
  render(
    <SkillsPage
      client={f.client}
      workspaceRoot="Z:/project"
      version={0}
      openDirectory={vi.fn()}
      openUrl={vi.fn()}
    />,
  );
  const budgetText = await screen.findByText("678 / 8,000");
  expect(budgetText.parentElement?.getAttribute("title")).toBe(
    "模型上下文窗口未知，使用 8,000 token 上限",
  );
  fireEvent.click(screen.getByRole("switch", { name: "启用 alpha" }));
  expect(await screen.findByRole("status")).toHaveProperty("textContent", "✓ 已停用 alpha");
  expect(screen.queryByRole("button", { name: "技能" })).toBeNull();
  expect(f.calls.find((c) => c.method === "skills.setSkillEnabled")?.params).toMatchObject({
    name: "alpha",
    enabled: false,
  });
});

it("搜索技能按名称和说明不区分大小写过滤，无结果各组只显示一行 —", async () => {
  const userSkill = skill({
    name: "Alpha-Tool",
    description: "Read PDF files",
    entryPath: "C:/home/alpha-tool",
  });
  const projectSkill = skill({
    name: "build-check",
    layer: "project",
    description: "Run Build Verification",
    entryPath: "Z:/project/build-check",
  });
  const f = fakeServer(
    withInit({
      "skills.describeSkills": data([userSkill, projectSkill]),
    }),
  );
  await f.initialize();
  render(
    <SkillsPage
      client={f.client}
      workspaceRoot="Z:/project"
      version={0}
      openDirectory={vi.fn()}
      openUrl={vi.fn()}
    />,
  );
  const search = (await screen.findByPlaceholderText("搜索技能")) as HTMLInputElement;
  // 按名称不区分大小写匹配
  fireEvent.change(search, { target: { value: "alpha" } });
  const userGroup = screen.getByRole("region", { name: "用户 · 1" });
  expect(within(userGroup).getByText("Alpha-Tool")).toBeTruthy();
  const projectGroup = screen.getByRole("region", { name: /项目.*· 0/ });
  expect(within(projectGroup).getByText("—")).toBeTruthy();

  // 按说明不区分大小写匹配
  fireEvent.change(search, { target: { value: "VERIFICATION" } });
  expect(within(screen.getByRole("region", { name: "用户 · 0" })).getByText("—")).toBeTruthy();
  expect(
    within(screen.getByRole("region", { name: /项目.*· 1/ })).getByText("build-check"),
  ).toBeTruthy();

  // 全部无结果时各组只留一行 —
  fireEvent.change(search, { target: { value: "not-found" } });
  expect(screen.getAllByText("—")).toHaveLength(2);
});

it("大小格只在有支持文件时显示支持文件数", async () => {
  const nested = skill({
    name: "nested",
    entryPath: "C:/home/nested",
    files: [
      { name: "SKILL.md", directory: false },
      { name: "scripts", directory: true },
      { name: "ref", directory: true },
    ],
  });
  const f = fakeServer(withInit({ "skills.describeSkills": data([skill(), nested]) }));
  await f.initialize();
  render(
    <SkillsPage
      client={f.client}
      workspaceRoot="Z:/project"
      version={0}
      openDirectory={vi.fn()}
      openUrl={vi.fn()}
    />,
  );
  const size = () => screen.getByRole("group", { name: "大小" }).textContent?.slice("大小".length);
  fireEvent.click(await screen.findByText("alpha"));
  expect(size()).toBe("1.0 KB");
  fireEvent.click(screen.getByRole("button", { name: "技能" }));
  fireEvent.click(await screen.findByText("nested"));
  expect(size()).toBe("1.0 KB · 2 个支持文件");
});

it("输入技能与参数后 Enter 把 skill 字段交给提交，不执行斜杠命令", () => {
  const onSubmit = vi.fn(async () => true);
  const onSlash = vi.fn(async () => true);
  render(
    <Composer
      running={false}
      onSubmit={onSubmit}
      onInterrupt={vi.fn()}
      onSlash={onSlash}
      fileRefs={null}
      pickImages={vi.fn()}
      skills={[skill()]}
    />,
  );
  const field = screen.getByRole("textbox");
  fireEvent.change(field, { target: { value: "/alpha file.ts" } });
  fireEvent.keyDown(field, { key: "Enter" });
  expect(onSubmit).toHaveBeenCalledWith({
    text: "/alpha file.ts",
    attachments: [],
    skill: { name: "alpha", arguments: "file.ts" },
  });
  expect(onSlash).not.toHaveBeenCalled();
});

it("空态打开 Nocturne 技能目录和规范链接", async () => {
  const openDirectory = vi.fn();
  const openUrl = vi.fn();
  const f = fakeServer(withInit({ "skills.describeSkills": data([]) }));
  await f.initialize();
  render(
    <SkillsPage
      client={f.client}
      workspaceRoot={undefined}
      version={0}
      openDirectory={openDirectory}
      openUrl={openUrl}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "打开技能文件夹" }));
  expect(openDirectory).toHaveBeenCalledWith("C:/home/skills", true);
  expect(screen.queryByText(/扫描目录/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Agent Skills 规范/ }));
  expect(openUrl).toHaveBeenCalledWith("https://agentskills.io");
});

it("外部 agent 分组在技能之后，冲突及停用隐藏，点名保留名称并提交delegate", async () => {
  const agent: ExternalAgentOverview = {
    name: "OMP",
    command: "omp",
    args: ["--mode", "acp"],
    enabled: true,
    origin: "app",
    editable: true,
  };
  const skills = [skill()];
  const agents = [
    agent,
    { ...agent, name: "ALPHA" },
    { ...agent, name: "COMPACT" },
    { ...agent, name: "off", enabled: false },
  ];
  expect(completeSlash("/", skills, agents).map((group) => group.id)).toEqual([
    "commands",
    "skills",
    "external",
  ]);
  expect(
    completeSlash("/", skills, agents)
      .at(-1)
      ?.items.map((item) => item.label),
  ).toEqual(["/OMP"]);
  expect(externalAgentSlashConflict("ALPHA", skills)).toContain("技能");
  expect(externalAgentSlashConflict("COMPACT", skills)).toContain("内置命令");
  expect(parseSlash("/omp 完整任务", "session", skills, agents)).toEqual({
    kind: "agent",
    delegate: { agent: "OMP", task: "完整任务" },
  });
  expect(parseSlash("/OMP", "session", skills, agents)).toMatchObject({
    kind: "unknown",
    hint: "用法：/OMP 任务",
  });
  expect(parseSlash("/omp 第一行\n第二行", "session", skills, agents)).toEqual({
    kind: "agent",
    delegate: { agent: "OMP", task: "第一行\n第二行" },
  });
  expect(parseSlash("/alpha 第一行\n第二行", "session", skills, agents)).toEqual({
    kind: "skill",
    invocation: { name: "alpha", arguments: "第一行\n第二行" },
  });
  expect(parseSlash("/compact", "session", skills, agents)?.kind).toBe("command");
  expect(parseSlash("/alpha task", "session", skills, agents)?.kind).toBe("skill");
  expect(parseSlash("/off task", "session", skills, agents)?.kind).toBe("unknown");
  const onSubmit = vi.fn(async () => true);
  render(
    <Composer
      running={false}
      fileRefs={null}
      onSlash={() => false}
      externalAgents={agents}
      skills={skills}
      onSubmit={onSubmit}
      onInterrupt={() => undefined}
      pickImages={async () => []}
    />,
  );
  const input = screen.getByRole("textbox", { name: "消息输入" });
  fireEvent.change(input, { target: { value: "/omp 完整任务" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onSubmit).toHaveBeenCalledWith({
    text: "/omp 完整任务",
    delegate: { agent: "OMP", task: "完整任务" },
    attachments: [],
  });
});

it("导入技能：选择文件夹→预检→改名/跳过→结果与停用", async () => {
  const preview = {
    mode: "preview",
    targetDir: "C:/home/skills",
    targetLayer: "user",
    candidates: [
      {
        name: "alpha",
        sourcePath: "C:/src/alpha",
        valid: true,
        skippedLinks: [],
        sizeBytes: 512,
        missingDescription: false,
        targetConflict: false,
      },
      {
        name: "dup",
        sourcePath: "C:/src/dup",
        valid: true,
        skippedLinks: ["lib"],
        sizeBytes: 1024,
        missingDescription: true,
        targetConflict: true,
        suggestedName: "dup-2",
      },
      {
        name: "bad",
        sourcePath: "C:/src/bad",
        valid: false,
        reason: "缺少 YAML 前言",
        skippedLinks: [],
        sizeBytes: 64,
        missingDescription: false,
        targetConflict: false,
      },
    ],
  };
  const f = fakeServer(
    withInit({
      "skills.describeSkills": data([]),
      "skills.importSkills": (params: Record<string, unknown>) =>
        params.mode === "preview"
          ? preview
          : {
              mode: "commit",
              targetDir: "C:/home/skills",
              results: [
                {
                  sourcePath: "C:/src/alpha",
                  name: "alpha",
                  status: "imported",
                  targetPath: "C:/home/skills/alpha",
                  missingDescription: false,
                },
                {
                  sourcePath: "C:/src/dup",
                  name: "dup",
                  status: "skipped",
                  reason: "已跳过",
                  targetPath: "",
                  missingDescription: false,
                },
              ],
              affectedSessions: 1,
            },
      "skills.setSkillEnabled": { affectedSessions: 1 },
    }),
  );
  await f.initialize();
  const pickFolder = vi.fn(async () => "C:/src");
  render(
    <SkillsPage
      client={f.client}
      workspaceRoot="Z:/project"
      version={0}
      openDirectory={vi.fn()}
      openUrl={vi.fn()}
      pickFolder={pickFolder}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "导入技能…" }));
  const dialog = await screen.findByRole("dialog", { name: "导入技能" });
  // 项目目标可选（选中了工作区）
  expect(screen.getByRole("button", { name: "当前工作区" }).hasAttribute("disabled")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "选择文件夹…" }));
  expect(pickFolder).toHaveBeenCalledTimes(1);
  // 预检渲染：候选、符号链接跳过、缺说明、冲突改名默认
  await within(dialog).findByText("dup");
  expect(within(dialog).getByText("缺少 YAML 前言")).toBeTruthy();
  expect(within(dialog).getByText(/跳过 1 个符号链接/)).toBeTruthy();
  expect(within(dialog).getByText(/缺少说明，模型看不到/)).toBeTruthy();
  expect((within(dialog).getByLabelText("dup 的新名字") as HTMLInputElement).value).toBe("dup-2");
  // dup 改跳过，只导入 alpha
  fireEvent.click(within(dialog).getByRole("button", { name: "跳过" }));
  const previewCall = f.calls.find((c) => c.method === "skills.importSkills");
  expect(previewCall?.params).toMatchObject({
    mode: "preview",
    sourceDir: "C:/src",
    target: "user",
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "导入 2 个" }));
  await within(dialog).findByText("✓ 已导入");
  const commit = f.calls.filter((c) => c.method === "skills.importSkills").at(-1);
  expect(commit?.params).toMatchObject({
    mode: "commit",
    decisions: [
      { sourcePath: "C:/src/alpha", action: "overwrite" },
      { sourcePath: "C:/src/dup", action: "skip" },
    ],
  });
  // 成功项可停用
  fireEvent.click(within(dialog).getByRole("button", { name: "停用" }));
  expect(await screen.findByRole("status")).toHaveProperty("textContent", "✓ 已导入并停用 alpha");
  expect(screen.queryByText(/进行中的会话本轮结束后生效/)).toBeNull();
  expect(f.calls.find((c) => c.method === "skills.setSkillEnabled")?.params).toMatchObject({
    name: "alpha",
    enabled: false,
  });
});

it("导入技能：无工作区时项目目标置灰", async () => {
  const f = fakeServer(withInit({ "skills.describeSkills": data([]) }));
  await f.initialize();
  render(
    <SkillsPage
      client={f.client}
      workspaceRoot={undefined}
      version={0}
      openDirectory={vi.fn()}
      openUrl={vi.fn()}
      pickFolder={vi.fn(async () => null)}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "导入技能…" }));
  const dialog = await screen.findByRole("dialog", { name: "导入技能" });
  expect(
    (within(dialog).getByRole("button", { name: "当前工作区" }) as HTMLButtonElement).disabled,
  ).toBe(true);
});

it("命令文件技能：同组展示、详情显示 .md 入口路径、打开父目录、隐藏支持文件一节", async () => {
  const commandSkill = skill({
    name: "deploy",
    layer: "project",
    source: ".nocturne",
    layout: "file",
    entryPath: "Z:/project/.nocturne/commands/deploy.md",
    realPath: "Z:/project/.nocturne/commands/deploy.md",
    description: "部署当前分支到测试环境",
    displayedDescriptionLength: 11,
    fields: { name: "deploy", "argument-hint": "<env>" },
    unknownFields: {},
    bodyPreview: "# 部署当前分支到测试环境\n执行发布脚本 $ARGUMENTS",
    files: [],
    size: 256,
  });
  const dirSkill = skill({
    name: "review",
    layer: "project",
    source: ".nocturne",
    layout: "directory",
    entryPath: "Z:/project/.nocturne/skills/review",
    realPath: "Z:/project/.nocturne/skills/review",
    description: "代码审查",
    displayedDescriptionLength: 4,
    files: [
      { name: "SKILL.md", directory: false },
      { name: "checklist.md", directory: false },
    ],
  });
  const f = fakeServer(withInit({ "skills.describeSkills": data([commandSkill, dirSkill]) }));
  await f.initialize();
  const openDirectory = vi.fn(async () => undefined);
  render(
    <SkillsPage
      client={f.client}
      workspaceRoot="Z:/project"
      version={0}
      openDirectory={openDirectory}
      openUrl={vi.fn()}
    />,
  );

  // 命令文件技能与目录技能在同一项目分组中，不新增分组或徽标
  const projectGroup = await screen.findByRole("region", { name: /项目.*2/ });
  expect(within(projectGroup).getByText("deploy")).toBeTruthy();
  expect(within(projectGroup).getByText("review")).toBeTruthy();

  // 进入命令文件技能详情：位置显示 .md 入口路径，不显示支持文件一节，打开目录传父目录
  fireEvent.click(within(projectGroup).getByText("deploy"));
  expect(await screen.findByText("Z:/project/.nocturne/commands/deploy.md")).toBeTruthy();
  expect(screen.queryByText(/SKILL\.md/)).toBeNull();
  expect(screen.queryByRole("region", { name: /^支持文件/ })).toBeNull();
  expect(screen.queryByText(/个支持文件/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "在资源管理器中打开" }));
  expect(openDirectory).toHaveBeenCalledWith("Z:/project/.nocturne/commands");
});

it("命令文件技能：桌面斜杠补全能补出并提交 submit.skill", async () => {
  const commandSkill = skill({
    name: "deploy",
    layer: "project",
    source: ".nocturne",
    layout: "file",
    entryPath: "Z:/project/.nocturne/commands/deploy.md",
    realPath: "Z:/project/.nocturne/commands/deploy.md",
    description: "部署到测试环境",
    displayedDescriptionLength: 7,
    fields: { name: "deploy", "argument-hint": "<env>" },
    files: [],
  });
  const groups = completeSlash("/dep", [commandSkill]);
  expect(groups.map((g) => g.id)).toEqual(["skills"]);
  expect(groups[0]?.items[0]).toMatchObject({
    label: "/deploy",
    argumentHint: "<env>",
    summary: "部署到测试环境",
  });

  const origScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    value: vi.fn(),
    configurable: true,
  });
  try {
    const onSubmit = vi.fn(async () => true);
    render(
      <Composer
        running={false}
        fileRefs={null}
        onSlash={() => false}
        skills={[commandSkill]}
        onSubmit={onSubmit}
        onInterrupt={() => undefined}
        pickImages={vi.fn(async () => [])}
      />,
    );
    const input = screen.getByRole<HTMLTextAreaElement>("textbox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "/dep" } });
    input.setSelectionRange(4, 4);
    const menu = await screen.findByRole("listbox", { name: "斜杠命令补全" });
    const option = within(menu).getByRole("option", { name: /\/deploy/ });
    fireEvent.mouseDown(option);
    fireEvent.click(option);
    fireEvent.change(input, { target: { value: "staging" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith({
      text: "/deploy staging",
      attachments: [],
      skill: { name: "deploy", arguments: "staging" },
    });
  } finally {
    if (origScrollIntoView) {
      Object.defineProperty(Element.prototype, "scrollIntoView", origScrollIntoView);
    } else {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  }
});
