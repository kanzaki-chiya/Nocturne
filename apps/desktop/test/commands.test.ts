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
      hint: "在底部状态栏切换模型",
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
      hint: expect.stringContaining("会话内"),
    });
    expect(parseSlash("/model provider/one")).toMatchObject({
      kind: "redirect",
      name: "/model",
    });
    for (const name of ["/provider", "/new", "/effort", "/preset", "/shell", "/exit"]) {
      expect(parseSlash(name)?.kind).toBe("redirect");
    }
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
    expect(groups[0]?.items.map((item) => item.label)).toEqual(["/compact", "/mcp"]);
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
