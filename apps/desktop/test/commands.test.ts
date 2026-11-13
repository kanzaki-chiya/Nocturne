import { describe, expect, it } from "vitest";

import { COMMANDS, completeSlash, parseSlash } from "../src/commands";

describe("slash 命令目录", () => {
  it("只保留界面上没有对应操作的命令", () => {
    expect(COMMANDS.map((command) => command.name)).toEqual(["/compact", "/mcp"]);
  });
});

describe("parseSlash", () => {
  it("非命令、空白及正文中的斜杠都不拦截", () => {
    for (const text of ["", " \n ", "hello /model", "https://example.com/path"]) {
      expect(parseSlash(text)).toBeNull();
    }
    expect(parseSlash("/compact\n第二行")).toBeNull();
  });

  it("可用命令返回 command", () => {
    expect(parseSlash("/compact")).toEqual({ kind: "command", name: "/compact", raw: "/compact" });
    expect(parseSlash("  /mcp  ")).toMatchObject({ kind: "command", name: "/mcp" });
  });

  it("可用命令带参数按用法提示处理，不静默忽略输入", () => {
    expect(parseSlash("/compact today")).toEqual({
      kind: "unknown",
      name: "/compact",
      hint: "用法：/compact",
    });
  });

  it("已移除命令给出界面操作提示，按输入框所在场景指向控件位置", () => {
    expect(parseSlash("/model")).toEqual({
      kind: "redirect",
      name: "/model",
      hint: "在输入框右下角切换模型",
    });
    expect(parseSlash("/model", "draft")).toEqual({
      kind: "redirect",
      name: "/model",
      hint: "在输入框右下角切换模型",
    });
    expect(parseSlash("/preset", "draft")).toMatchObject({
      kind: "redirect",
      hint: "在输入框下方切换权限预设",
    });
    expect(parseSlash("/shell", "draft")).toMatchObject({
      kind: "redirect",
      hint: "在 设置 › 常规 切换 Shell",
    });
    expect(parseSlash("/fork")).toEqual({
      kind: "redirect",
      name: "/fork",
      hint: "在用户消息上点「分叉」",
    });
    expect(parseSlash("/model provider/one")).toMatchObject({
      kind: "redirect",
      name: "/model",
    });
    for (const name of ["/provider", "/new", "/effort", "/preset", "/shell", "/exit"]) {
      expect(parseSlash(name)?.kind).toBe("redirect");
    }
  });

  it("执行方式（ADR-0076）：带任务返回 work，任务可多行；只有命令名给用法", () => {
    expect(parseSlash("/grill-me 做个登录页\n要暗色")).toEqual({
      kind: "work",
      workMode: "grill-me",
      text: "做个登录页\n要暗色",
    });
    expect(parseSlash("/grill-me")).toEqual({
      kind: "unknown",
      name: "/grill-me",
      hint: "用法：/grill-me 需求",
    });
  });

  it("/goal：无参数与 stop|resume 交给 onSlash，其余文字是目标", () => {
    for (const line of ["/goal", "/goal stop", " /goal resume "])
      expect(parseSlash(line)).toEqual({ kind: "command", name: "/goal", raw: line });
    expect(parseSlash("/goal 修好测试")).toEqual({
      kind: "work",
      workMode: "goal",
      text: "修好测试",
    });
    for (const line of ["/plan approve", " /plan cancel "])
      expect(parseSlash(line)).toEqual({ kind: "command", name: "/plan", raw: line });
    expect(parseSlash("/plan 重构登录")).toEqual({
      kind: "work",
      workMode: "plan",
      text: "重构登录",
    });
    expect(parseSlash("/boost 并行改造")).toEqual({
      kind: "work",
      workMode: "boost",
      text: "并行改造",
    });
  });

  it("/ensemble 与 /swarm 别名：board|end 交给 onSlash，其余文字是任务，无参数给用法", () => {
    expect(parseSlash("/ensemble")).toEqual({
      kind: "unknown",
      name: "/ensemble",
      hint: "用法：/ensemble 任务",
    });
    expect(parseSlash("/swarm")).toEqual({
      kind: "unknown",
      name: "/swarm",
      hint: "用法：/ensemble 任务",
    });
    for (const line of ["/ensemble board", " /ensemble end ", "/swarm board", " /swarm end "])
      expect(parseSlash(line)).toEqual({ kind: "command", name: "/ensemble", raw: line });
    expect(parseSlash("/ensemble board 改一下")).toEqual({
      kind: "work",
      workMode: "swarm",
      text: "board 改一下",
    });
    expect(parseSlash("/swarm board 改一下")).toEqual({
      kind: "work",
      workMode: "swarm",
      text: "board 改一下",
    });
  });

  it("/ensemble 与 /swarm 的子命令在草稿页只给提示（还没有会话可操作）", () => {
    // 无参数仍是用法提示：与在会话内一致
    expect(parseSlash("/ensemble", "draft")).toEqual({
      kind: "unknown",
      name: "/ensemble",
      hint: "用法：/ensemble 任务",
    });
    expect(parseSlash("/swarm", "draft")).toEqual({
      kind: "unknown",
      name: "/swarm",
      hint: "用法：/ensemble 任务",
    });
    for (const line of ["/ensemble board", " /ensemble end ", "/swarm board", " /swarm end "])
      expect(parseSlash(line, "draft")).toEqual({
        kind: "unknown",
        name: line.trim().split(/\s+/u)[0],
        hint: "用法：/ensemble 任务",
      });
    // 带任务仍是可提交的合奏会话
    expect(parseSlash("/ensemble board 改一下", "draft")).toEqual({
      kind: "work",
      workMode: "swarm",
      text: "board 改一下",
    });
  });

  it("未知命令给出查看提示", () => {
    expect(parseSlash("/unknown hello")).toEqual({
      kind: "unknown",
      name: "/unknown",
      hint: "未知命令 /unknown；输入 / 查看可用命令",
    });
  });
});

describe("completeSlash", () => {
  it("/ 分组列出全部命令，空组不出现", () => {
    const groups = completeSlash("/");
    expect(groups).toHaveLength(1);
    expect(groups[0]?.id).toBe("commands");
    expect(groups[0]?.label).toBe("命令");
    expect(groups[0]?.items.map((item) => item.label)).toEqual([
      "/compact",
      "/mcp",
      "/grill-me",
      "/goal",
      "/plan",
      "/boost",
      // 执行方式补全来自 Core 的 WORK_MODE_COMMANDS（ADR-0089 修订：对外显示 /ensemble）
      "/ensemble",
    ]);
    expect(groups[0]?.items.find((item) => item.label === "/ensemble")?.summary).toBe("合奏协作");
    expect(completeSlash("/sw")).toEqual([]);
  });

  it("前缀过滤并保留原始前导空白", () => {
    expect(completeSlash("  /m").map((group) => group.items.map((item) => item.insert))).toEqual([
      ["  /mcp "],
    ]);
    expect(completeSlash("/z")).toEqual([]);
  });

  it("命令词之外（参数、多行、非斜杠）不补全", () => {
    for (const text of ["hi", "/compact arg", "/compact\nx", "/compact "]) {
      expect(completeSlash(text)).toEqual([]);
    }
  });
});
