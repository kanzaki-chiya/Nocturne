import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthResolver } from "../src/provider/auth.js";
import { fetchModels, listProviderPresets } from "../src/provider/presets.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "nocturne-auth-test-"));
  dirs.push(dir);
  const path = join(dir, "auth.json");
  const auth = {
    kind: "external-file" as const,
    path,
    keyPath: ["https://accounts.x.ai/sign-in", "key"],
    renewHint: "grok login",
  };
  return { path, auth, resolver: createAuthResolver({ id: "grok", auth }) };
}
const signal = new AbortController().signal;
describe("provider authentication", () => {
  it("preserves environment precedence and falls back to stored API keys", async () => {
    const credentials = vi.fn().mockResolvedValue("stored-test-key");
    expect(
      await createAuthResolver(
        { id: "api", apiKeyEnv: "KEY", credentials },
        () => "env-test-key",
      ).token(signal),
    ).toBe("env-test-key");
    expect(credentials).not.toHaveBeenCalled();
    expect(
      await createAuthResolver({ id: "api", apiKeyEnv: "KEY", credentials }, () => undefined).token(
        signal,
      ),
    ).toBe("stored-test-key");
  });
  it("reads external credentials lazily, caches by mtime, and never changes the file", async () => {
    const { path, resolver } = await fixture();
    const raw = JSON.stringify({ "https://accounts.x.ai/sign-in": { key: "first-test-key" } });
    await writeFile(path, raw);
    expect(await resolver.token(signal)).toBe("first-test-key");
    expect(await readFile(path, "utf8")).toBe(raw);
    await writeFile(
      path,
      JSON.stringify({ "https://accounts.x.ai/sign-in": { key: "new-test-key" } }),
    );
    await utimes(path, new Date(), new Date(Date.now() + 2000));
    expect(await resolver.token(signal)).toBe("new-test-key");
    await resolver.invalidate();
    await writeFile(path, "malformed-private-test-content");
    await expect(resolver.token(signal)).rejects.toThrow("grok login");
  });
  it("sanitizes missing, malformed, and missing-key credential errors", async () => {
    const { path, resolver } = await fixture();
    for (const body of [
      undefined,
      "private-test-invalid-json",
      JSON.stringify({ secret: "private-test-value" }),
    ]) {
      if (body !== undefined) await writeFile(path, body);
      await resolver.invalidate();
      await expect(resolver.token(signal)).rejects.toMatchObject({
        kind: "auth",
        retryable: false,
        message: "未找到可用的外部登录凭据，请先执行 grok login",
      });
    }
  });
  it("model discovery invalidates once on 401 and uses the renewed token", async () => {
    const resolver = {
      token: vi.fn().mockResolvedValueOnce("old-test-key").mockResolvedValue("new-test-key"),
      invalidate: vi.fn().mockResolvedValue(undefined),
    };
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        requests.push(new Headers(init.headers).get("authorization") ?? "");
        return Promise.resolve(
          requests.length === 1
            ? new Response("", { status: 401 })
            : Response.json({ data: [{ id: "test-model" }] }),
        );
      }),
    );
    expect(
      await fetchModels(
        { type: "openai-compatible", baseURL: "https://test.invalid/v1" },
        resolver,
      ),
    ).toEqual([{ id: "test-model" }]);
    expect(requests).toEqual(["Bearer old-test-key", "Bearer new-test-key"]);
    expect(resolver.invalidate).toHaveBeenCalledTimes(1);
  });
  it("a second 401 is a non-retryable auth error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("private-test-upstream-body", { status: 401 })),
    );
    await expect(
      fetchModels({ type: "openai-compatible", baseURL: "https://test.invalid/v1" }, "test-key"),
    ).rejects.toMatchObject({ kind: "auth", retryable: false });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("Grok preset carries the external login contract", () => {
    expect(listProviderPresets().find((p) => p.id === "grok-cli")).toMatchObject({
      baseURL: "https://cli-chat-proxy.grok.com/v1",
      modelHeader: "x-grok-model-override",
      headers: { "X-XAI-Token-Auth": "xai-grok-cli" },
      auth: { kind: "external-file", renewHint: "grok login" },
    });
  });
});
