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

it("分组、状态、预算、截断、忽略横幅、覆盖只读、缺说明和解析失败路径", async () => {
  const normal = skill();
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
    shadowedBy: normal.entryPath,
    invocation: "none",
    catalogStatus: "omitted",
  });
  const manual = skill({
    name: "manual",
    entryPath: "C:/home/manual",
    missingDescription: true,
    description: "",
    invocation: "user",
    catalogStatus: "omitted",
  });
  const f = fakeServer(
    withInit({
      "skills.describeSkills": data([normal, ignored, shadow, manual]),
      "skills.setSkillEnabled": { affectedSessions: 2 },
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
  await screen.findByText("模型目录到此为止");
  expect(screen.getByRole("meter").getAttribute("value")).toBe("678");
  expect(screen.getByText(/完整说明 2 个 · 只显示名字 4 个 · 已停用 1 个/)).toBeTruthy();
  expect(screen.getByText("项目 · project")).toBeTruthy();
  const list = screen.getByRole("navigation", { name: "技能列表" });
  fireEvent.click(within(list).getByRole("button", { name: /release/ }));
  expect(screen.getByText("有 2 处写法在 Nocturne 里不生效").className).toContain("warn");
  expect(screen.getByRole("columnheader", { name: "在 Nocturne 里" })).toBeTruthy();
  fireEvent.click(within(list).getByRole("button", { name: /alpha.*被覆盖/ }));
  expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText("被用户技能 alpha 覆盖").className).toContain("info");
  expect(list.querySelector(".shadowed")?.textContent).toBe("alpha");
  fireEvent.click(within(list).getByRole("button", { name: /manual/ }));
  expect(screen.getByText("缺少说明，模型看不到这个技能").className).toContain("warn");
  fireEvent.click(screen.getByText("1 个技能的前言解析失败 · 查看 ›"));
  expect(screen.getByText("C:/home/bad/SKILL.md:3")).toBeTruthy();
  fireEvent.click(within(list).getByRole("button", { name: /alpha.*模型/ }));
  fireEvent.click(screen.getByRole("switch"));
  expect(await screen.findByRole("status")).toHaveProperty(
    "textContent",
    "✓ 已停用 alpha · 2 个已打开的会话将在本轮结束后更新技能目录",
  );
});

it("大小格只在有子目录时显示子目录数", async () => {
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
  const size = () => screen.getByText("大小").nextElementSibling?.textContent;
  expect((await screen.findByText("大小")).nextElementSibling?.textContent).toBe("1.0 KB");
  const list = screen.getByRole("navigation", { name: "技能列表" });
  fireEvent.click(within(list).getByRole("button", { name: /nested/ }));
  expect(size()).toBe("1.0 KB · 2 个子目录");
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
  expect(await screen.findByRole("status")).toHaveProperty(
    "textContent",
    "✓ 已导入并停用 alpha · 1 个已打开的会话将在本轮结束后更新",
  );
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
