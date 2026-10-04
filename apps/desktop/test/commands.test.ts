import { describe, expect, it } from "vitest";

import { COMMANDS, completeCommands, parseCommand } from "../src/commands";

describe("desktop command catalog", () => {
  it("覆盖 TUI 全部命令并明确标示桌面能力", () => {
    expect(COMMANDS.map((command) => command.name)).toEqual([
      "/help",
      "/theme",
      "/settings",
      "/model",
      "/effort",
      "/preset",
      "/shell",
      "/context",
      "/mcp",
      "/compact",
      "/resume",
      "/rewind",
      "/fork",
      "/new",
      "/clear",
      "/provider",
      "/exit",
      "/quit",
    ]);
    expect(
      COMMANDS.filter((command) => command.status === "planned").map((command) => command.name),
    ).toEqual(["/settings", "/provider"]);
    expect(COMMANDS.find((command) => command.name === "/rewind")?.statusText).toBe("暂不支持");
    expect(COMMANDS.find((command) => command.name === "/fork")?.status).toBe("unsupported");
    expect(COMMANDS.find((command) => command.name === "/clear")?.status).toBe("supported");
  });
});

describe("parseCommand", () => {
  it("非命令、空白及正文中的斜杠都不拦截", () => {
    for (const text of ["", " \n ", "hello /model", "https://example.com/path"]) {
      expect(parseCommand(text)).toBeNull();
    }
  });

  it("解析已知命令，保留原文及参数内部空白", () => {
    const raw = "  /model\tprovider/model  with  spaces \n";
    expect(parseCommand(raw)).toMatchObject({
      kind: "command",
      name: "/model",
      args: "provider/model  with  spaces",
      raw,
      command: { status: "supported", arguments: "model" },
    });
    expect(parseCommand("/context")).toMatchObject({ kind: "command", args: "" });
    expect(parseCommand("/preset\nread-only")).toMatchObject({
      name: "/preset",
      args: "read-only",
    });
  });

  it("未知命令和不支持命令仍返回可分发结果，而不是当普通消息发送", () => {
    expect(parseCommand("/unknown hello")).toEqual({
      kind: "unknown",
      name: "/unknown",
      args: "hello",
      raw: "/unknown hello",
    });
    expect(parseCommand("/")).toMatchObject({ kind: "unknown", name: "/" });
    expect(parseCommand("/provider add")).toMatchObject({
      kind: "command",
      args: "add",
      command: { status: "planned", statusText: "第 3 步实现" },
    });
    expect(parseCommand("/rewind")).toMatchObject({
      kind: "command",
      command: { status: "unsupported" },
    });
  });

  it("无参命令带参数返回用法错误，不静默忽略输入", () => {
    for (const name of [
      "/help",
      "/context",
      "/compact",
      "/mcp",
      "/new",
      "/clear",
      "/rewind",
      "/fork",
    ]) {
      expect(parseCommand(`${name} unexpected`)).toMatchObject({
        kind: "invalid",
        name,
        args: "unexpected",
        message: `用法：${name}`,
      });
    }
  });
});

describe("completeCommands", () => {
  it("/ 列出全部命令和状态，前缀选择不改变原始空白", () => {
    expect(completeCommands("/")).toHaveLength(COMMANDS.length);
    expect(completeCommands("  /co").map((candidate) => candidate.insert)).toEqual([
      "  /context ",
      "  /compact ",
    ]);
    expect(completeCommands("/provider")[0]).toMatchObject({
      label: "/provider",
      status: "planned",
      statusText: "第 3 步实现",
    });
  });

  it("非命令、未知命令参数和多行草稿不触发整行替换", () => {
    for (const text of ["hi", "/unknown arg", "/help ", "/model one\ntwo"]) {
      expect(completeCommands(text)).toEqual([]);
    }
  });

  it("档位由当前模型提供，off 不重复；预设和 shell 有独立桌面补全", () => {
    expect(
      completeCommands("/effort ", { effortLevels: ["off", "low", "high", "high"] }).map(
        (candidate) => candidate.insert,
      ),
    ).toEqual(["/effort off", "/effort low", "/effort high"]);
    expect(completeCommands("/preset ").map((candidate) => candidate.label)).toEqual([
      "read-only",
      "default",
      "auto-edit",
      "guarded",
      "smart",
      "bypass",
    ]);
    expect(completeCommands("/shell ").map((candidate) => candidate.label)).toEqual([
      "auto",
      "pwsh",
      "powershell",
      "bash",
      "cmd",
      "sh",
    ]);
  });

  it("模型和会话引用直接补全，参数匹配前缀优先再包含", () => {
    expect(
      completeCommands("/model a", { modelRefs: ["z/a", "a/model"] }).map(
        (candidate) => candidate.insert,
      ),
    ).toEqual(["/model a/model", "/model z/a"]);
    expect(
      completeCommands("/resume id", { sessionIds: ["id-two", "other"] }).map(
        (candidate) => candidate.insert,
      ),
    ).toEqual(["/resume id-two"]);
  });

  it("服务商子命令及 id 补全保持第 3 步提示", () => {
    expect(completeCommands("/provider ").map((candidate) => candidate.label)).toEqual([
      "login",
      "logout",
      "add",
      "key",
      "refresh",
      "model",
      "remove",
    ]);
    expect(completeCommands("/provider model a", { providerIds: ["alpha", "beta"] })).toEqual([
      {
        label: "alpha",
        summary: "管理服务商",
        insert: "/provider model alpha",
        status: "planned",
        statusText: "第 3 步实现",
      },
      {
        label: "beta",
        summary: "管理服务商",
        insert: "/provider model beta",
        status: "planned",
        statusText: "第 3 步实现",
      },
    ]);
    expect(completeCommands("/provider invalid ", { providerIds: ["alpha"] })).toEqual([]);
  });
});
