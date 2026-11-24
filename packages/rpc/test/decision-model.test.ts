import { afterEach, describe, expect, it, vi } from "vitest";
import type { DecisionModelConfig } from "@nocturne/core";
import { SENSITIVE_METHODS } from "../src/server/server.js";
import { cleanupTmp, connectWithConfig } from "./harness.js";

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await cleanupTmp();
});

describe("RPC 决策模型透传与密钥遮蔽", () => {
  it("listDecisionModels 与 updateSettings(decisionModel, decisionModelKey) 透传", async () => {
    const dm: DecisionModelConfig = {
      source: "gemini",
      endpoint: "custom",
      baseURL: "http://127.0.0.1:19999/v1beta",
      model: "gemini-decision-1",
      credential: { stored: true },
    };
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({
        models: [{ name: "models/gemini-2.5-flash" }, { name: "models/gemini-decision-1" }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { client, config } = await connectWithConfig();
    try {
      const updated = await client.runtime.updateSettings(
        { decisionModel: dm },
        { decisionModelKey: "fake-rpc-dm-key" },
      );
      const item = updated.find((entry) => entry.key === "decisionModel");
      expect(item?.decisionModel?.effective).toEqual(dm);
      expect(await config.credentials.get("decision-model")).toBe("fake-rpc-dm-key");

      const models = await client.runtime.listDecisionModels(dm);
      expect(models).toEqual({ models: ["gemini-decision-1"] });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:19999/v1beta/models");

      expect(
        SENSITIVE_METHODS["runtime.updateSettings"]?.({
          patch: {},
          decisionModelKey: "secret-dm-key",
          reviewerKey: "secret-rev-key",
        }),
      ).toEqual(["secret-rev-key", "secret-dm-key"]);
    } finally {
      await client.close();
    }
  });
});
