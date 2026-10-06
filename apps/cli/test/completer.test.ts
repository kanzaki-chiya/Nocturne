import { describe, expect, it } from "vitest";

import { readlineCompleter } from "@nocturne/tui/slash-catalog";
import { skillCompletionLines } from "../src/completer.js";

describe("CLI completer", () => {
  const ctx = { effortLevels: ["minimal", "low"], providerIds: ["commandcode"] };

  it("技能候选显示分组、参数和说明，插入文本仍只有命令名", () => {
    const context = {
      ...ctx,
      skills: [
        {
          name: "alpha",
          invocation: "user" as const,
          description: "skill description",
          fields: { "argument-hint": "<file>" },
        },
      ],
    };
    const lines = skillCompletionLines("/", context);
    expect(lines[0]).toBe("命令");
    expect(lines).toContain("技能");
    expect(lines.at(-1)).toContain("/alpha <file>  skill description");
    expect(readlineCompleter("/alp", context)[0]).toEqual(["/alpha "]);
    expect(skillCompletionLines("/alp", context)).toEqual([]);
  });

  it("与 TUI 同一张命令表：前缀、思考档位、服务商、预设", () => {
    expect(readlineCompleter("/mo", ctx)[0]).toContain("/model");
    expect(readlineCompleter("/effort ", ctx)[0]).toEqual([
      "/effort off",
      "/effort minimal",
      "/effort low",
    ]);
    expect(readlineCompleter("/provider ", ctx)[0]).toEqual(
      expect.arrayContaining(["/provider add", "/provider model", "/provider commandcode"]),
    );
    expect(readlineCompleter("/preset d", ctx)[0]).toContain("/preset default");
  });

  it("/shell 参数补全：auto 在前，列出全部 shell 种类", () => {
    expect(readlineCompleter("/shell ", ctx)[0]).toEqual([
      "/shell auto",
      "/shell pwsh",
      "/shell powershell",
      "/shell bash",
      "/shell cmd",
      "/shell sh",
    ]);
    expect(readlineCompleter("/shell b", ctx)[0]).toEqual(["/shell bash"]);
    expect(readlineCompleter("/sh", ctx)[0]).toContain("/shell");
  });

  it("不向逐行 CLI 补全 TUI 专用的 /theme", () => {
    expect(readlineCompleter("/th", ctx)[0]).not.toContain("/theme");
  });
});
