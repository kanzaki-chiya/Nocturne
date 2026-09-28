import { describe, expect, it } from "vitest";

import { readlineCompleter } from "@nocturne/tui/slash-catalog";

describe("CLI completer", () => {
  const ctx = { effortLevels: ["minimal", "low"], providerIds: ["commandcode"] };

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
});
