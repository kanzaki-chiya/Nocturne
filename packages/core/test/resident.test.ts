import { describe, expect, it } from "vitest";

import { residentCallId, residentKindOf } from "../src/resident/index.js";

describe("resident callId helpers", () => {
  it("round-trips ensemble and suite callIds", () => {
    const ensembleId = residentCallId("ensemble", "architect");
    expect(ensembleId).toBe("ensemble:architect");
    expect(residentKindOf(ensembleId)).toBe("ensemble");

    const suiteId = residentCallId("suite", "t3");
    expect(suiteId).toBe("suite:t3");
    expect(residentKindOf(suiteId)).toBe("suite");
  });

  it("returns undefined for unknown prefixes or missing callIds", () => {
    expect(residentKindOf(undefined)).toBeUndefined();
    expect(residentKindOf("")).toBeUndefined();
    expect(residentKindOf("call-1")).toBeUndefined();
    expect(residentKindOf("task:sub-1")).toBeUndefined();
    expect(residentKindOf("ensemble")).toBeUndefined();
    expect(residentKindOf("suite")).toBeUndefined();
    expect(residentKindOf("other:architect")).toBeUndefined();
  });
});
