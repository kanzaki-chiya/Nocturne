import { describe, expect, it } from "vitest";

import { desktopWarningText, openWarningsToShow, phoneWarningText } from "../src/open-warnings";

const UNTRUSTED =
  "检测到项目配置 Z:/p/.nocturne/config.json，但该工作区未信任——其中仅收紧方向的规则生效；执行 nctrn trust 信任该工作区";

describe("openWarningsToShow", () => {
  it("没有警告时什么也不显示", () => {
    expect(openWarningsToShow(undefined, [])).toEqual([]);
    expect(openWarningsToShow([], [])).toEqual([]);
  });

  it("去掉重复项，并略过视图提示里已有同样文字的警告", () => {
    expect(
      openWarningsToShow(["甲", "乙", "甲", "丙"], [{ message: "乙" }, { message: "无关" }]),
    ).toEqual(["甲", "丙"]);
  });
});

it("桌面信任提示指向授权页并注明新会话生效", () => {
  expect(desktopWarningText(UNTRUSTED)).toContain("设置 › 授权");
  expect(desktopWarningText(UNTRUSTED)).toContain("新开或重新打开会话生效");
});

describe("phoneWarningText", () => {
  it("含 nctrn trust 的分句改成在电脑上信任，其余原样", () => {
    expect(phoneWarningText(UNTRUSTED)).toBe(
      "检测到项目配置 Z:/p/.nocturne/config.json，但该工作区未信任——其中仅收紧方向的规则生效；请在电脑上信任该项目",
    );
    expect(phoneWarningText("MCP 装配失败：超时")).toBe("MCP 装配失败：超时");
  });
});
