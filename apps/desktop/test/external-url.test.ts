import { describe, expect, it } from "vitest";

import { isAllowedExternalUrl } from "../src/external-url";

describe("isAllowedExternalUrl", () => {
  it("https 放行", () => {
    expect(isAllowedExternalUrl("https://nodejs.org/")).toBe(true);
    expect(isAllowedExternalUrl("https://example.com/path?q=1")).toBe(true);
  });

  it("本机 http 放行（回调页）", () => {
    expect(isAllowedExternalUrl("http://127.0.0.1:1455/cb")).toBe(true);
    expect(isAllowedExternalUrl("http://localhost:8080")).toBe(true);
  });

  it("外网 http 拒绝", () => {
    expect(isAllowedExternalUrl("http://example.com")).toBe(false);
    expect(isAllowedExternalUrl("http://192.168.1.1:8080")).toBe(false);
  });

  it("其他协议与非法字符串拒绝", () => {
    expect(isAllowedExternalUrl("file:///C:/a.txt")).toBe(false);
    expect(isAllowedExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedExternalUrl("not a url")).toBe(false);
    expect(isAllowedExternalUrl("")).toBe(false);
  });
});
