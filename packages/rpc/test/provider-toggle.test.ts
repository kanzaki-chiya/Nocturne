/**
 * provider.* 启停（ADR-0054，rpc.md 3.3）：setProviderEnabled / setModelsEnabled
 * 写 settings.json 专用字段并推 runtime.providersChanged；listModels 默认滤除
 * 停用模型；打开中的会话提交被拒绝且错误带 disabled + 模型引用；describeToggleImpact。
 */
import { afterEach, describe, expect, it } from "vitest";

import { RpcError } from "@nocturne/rpc/client";

import { cleanupTmp, connectWithConfig, MODEL } from "./harness.js";

afterEach(cleanupTmp);

describe("provider.* 启停（ADR-0054）", () => {
  it("setProviderEnabled / setModelsEnabled 写设置、推 providersChanged，listModels 默认滤除", async () => {
    const h = await connectWithConfig();
    let changed = 0;
    h.client.onProvidersChanged(() => {
      changed++;
    });

    await h.client.provider.setProviderEnabled("fake", false);
    expect(changed).toBe(1);
    expect(await h.client.runtime.listModels()).toEqual([]);
    expect(
      (await h.client.runtime.listModels({ includeDisabled: true })).map((m) => [
        m.ref.model,
        m.disabled,
      ]),
    ).toEqual([["fake-model", "provider"]]);

    await h.client.provider.setProviderEnabled("fake", true);
    expect((await h.client.runtime.listModels()).map((m) => m.ref.model)).toEqual(["fake-model"]);

    await h.client.provider.setModelsEnabled("fake", ["fake-model"], false);
    expect(await h.client.runtime.listModels()).toEqual([]);
    await h.client.provider.setModelsEnabled("fake", ["fake-model"], true);
    expect((await h.client.runtime.listModels()).map((m) => m.ref.model)).toEqual(["fake-model"]);
    expect(changed).toBe(4);

    h.client.close();
    await h.served;
  });

  it("打开中的会话在停用后提交被拒绝，错误带 disabled 与模型引用", async () => {
    const h = await connectWithConfig({
      scripts: [
        [
          { type: "text_delta", text: "ok" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    const { session } = await h.client.runtime.createSession({ model: MODEL });
    await h.client.provider.setProviderEnabled("fake", false);
    const error = await session.submit({ text: "hi" }).then(
      () => undefined,
      (e: unknown) => e as RpcError,
    );
    expect(error).toBeInstanceOf(RpcError);
    expect(error?.code).toBe("invalid_model");
    expect(error?.disabled).toBe("provider");
    expect(error?.model).toEqual({ provider: "fake", model: "fake-model" });

    h.client.close();
    await h.served;
  });

  it("describeToggleImpact 反映打开会话、默认模型与角色", async () => {
    const h = await connectWithConfig();
    const { session } = await h.client.runtime.createSession({ model: MODEL });
    await h.client.runtime.setDefaultModel(MODEL, null);
    await h.client.runtime.setModelRole("task", MODEL);

    expect(await h.client.provider.describeToggleImpact("fake")).toEqual({
      affectedSessions: 1,
      defaultModel: true,
      roles: ["task"],
    });
    expect(await h.client.provider.describeToggleImpact("fake", ["other"])).toEqual({
      affectedSessions: 0,
      defaultModel: false,
      roles: [],
    });

    await session.close();
    h.client.close();
    await h.served;
  });
});
