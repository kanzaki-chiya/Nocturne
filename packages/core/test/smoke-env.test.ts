import { describe, expect, it } from "vitest";

import { smokeSessionHeader } from "./smoke-env.js";

describe("smokeSessionHeader", () => {
  it("设置了变量就带上 sessionHeader", () => {
    expect(smokeSessionHeader({ NOCTURNE_SMOKE_SESSION_HEADER: "x-opencode-session" })).toEqual({
      sessionHeader: "x-opencode-session",
    });
    expect(smokeSessionHeader({ NOCTURNE_SMOKE_SESSION_HEADER: "  x-a  " })).toEqual({
      sessionHeader: "x-a",
    });
  });

  it("没设置或为空时不加字段，配置与原来一致", () => {
    expect(smokeSessionHeader({})).toEqual({});
    expect(smokeSessionHeader({ NOCTURNE_SMOKE_SESSION_HEADER: "" })).toEqual({});
    expect(smokeSessionHeader({ NOCTURNE_SMOKE_SESSION_HEADER: "   " })).toEqual({});
    expect("sessionHeader" in smokeSessionHeader({})).toBe(false);
  });
});
