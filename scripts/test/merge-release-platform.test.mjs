import { expect, it } from "vitest";
import { mergeReleasePlatform } from "../merge-release-platform.mjs";

const latest = {
  version: "1.2.3",
  notes: "notes",
  changelog: [{ version: "1.2.3" }],
  pub_date: "date",
  platforms: { "windows-x86_64": { url: "setup.exe", signature: "win" } },
};
const entry = { version: "1.2.3", platform: "darwin-aarch64", url: "app.tar.gz", signature: "mac" };

it("preserves release metadata and other platforms", () => {
  expect(mergeReleasePlatform(latest, entry)).toEqual({
    ...latest,
    platforms: { ...latest.platforms, "darwin-aarch64": { url: "app.tar.gz", signature: "mac" } },
  });
  expect(latest.platforms).not.toHaveProperty("darwin-aarch64");
});

it("rejects a platform entry for another version", () => {
  expect(() => mergeReleasePlatform(latest, { ...entry, version: "1.2.2" })).toThrow("版本");
});
