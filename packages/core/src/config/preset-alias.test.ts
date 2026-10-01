import { expect, it } from "vitest";
import { parseConfigFile } from "./schema.js";
it("config.json / settings.json 接受旧 full-access 并归一化", () => {
  for (const name of ["config.json", "settings.json"])
    expect(
      parseConfigFile({ permissions: { preset: "full-access" } }, name).permissions?.preset,
    ).toBe("guarded");
});
