import { describe, expect, it } from "vitest";

import { HOST_INJECTED_ENV, injectHostEnv } from "../src/host-env.js";

describe("injectHostEnv", () => {
  it("未设置时写入并登记", () => {
    const env: NodeJS.ProcessEnv = {};
    injectHostEnv("NODE_ENV", "production", env);
    expect(env.NODE_ENV).toBe("production");
    expect(env[HOST_INJECTED_ENV]).toBe("NODE_ENV");
  });

  it("用户已设置：原样保留，不登记（子进程照常继承用户的值）", () => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: "development" };
    injectHostEnv("NODE_ENV", "production", env);
    expect(env.NODE_ENV).toBe("development");
    expect(env[HOST_INJECTED_ENV]).toBeUndefined();
  });

  it("用户设成空字符串也算已设置", () => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: "" };
    injectHostEnv("NODE_ENV", "production", env);
    expect(env.NODE_ENV).toBe("");
    expect(env[HOST_INJECTED_ENV]).toBeUndefined();
  });

  it("多个变量累加登记、不重复", () => {
    const env: NodeJS.ProcessEnv = {};
    injectHostEnv("NODE_ENV", "production", env);
    injectHostEnv("OTHER", "x", env);
    injectHostEnv("OTHER", "y", env);
    expect(env[HOST_INJECTED_ENV]).toBe("NODE_ENV,OTHER");
    expect(env.OTHER).toBe("x");
  });
});
