import { describe, expect, it } from "vitest";

import { isAllowedExternalUrl, linkKind, replyLinkOpener } from "../src/external-url";

describe("linkKind（设置 › 浏览器 › 打开方式）", () => {
  it("http(s) 且主机是 localhost / 127.0.0.1 / [::1] 是本地网址", () => {
    expect(linkKind("http://localhost:5173/")).toBe("local");
    expect(linkKind("https://localhost/")).toBe("local");
    expect(linkKind("http://LOCALHOST:3000/a?b=1")).toBe("local");
    expect(linkKind("http://127.0.0.1:8080/")).toBe("local");
    expect(linkKind("https://127.0.0.1/")).toBe("local");
    expect(linkKind("http://[::1]:8080/")).toBe("local");
  });

  it("其余 http(s) 是网页链接，包括像本机却不是本机主机名的", () => {
    expect(linkKind("https://example.com/")).toBe("web");
    expect(linkKind("http://example.com/")).toBe("web");
    expect(linkKind("http://192.168.1.10:3000/")).toBe("web");
    expect(linkKind("http://127.0.0.1.nip.io/")).toBe("web");
    expect(linkKind("http://localhost.example.com/")).toBe("web");
    expect(linkKind("http://my-localhost/")).toBe("web");
  });

  it("别的协议与解析失败不归任何一类", () => {
    expect(linkKind("file:///C:/a.html")).toBeNull();
    expect(linkKind("mailto:a@b.c")).toBeNull();
    expect(linkKind("javascript:alert(1)")).toBeNull();
    expect(linkKind("localhost:3000")).toBeNull();
    expect(linkKind("not a url")).toBeNull();
    expect(linkKind("")).toBeNull();
  });
});

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

describe("replyLinkOpener", () => {
  it("缺省都用系统浏览器", () => {
    expect(replyLinkOpener("https://example.com/", {})).toBe("system");
    expect(replyLinkOpener("http://localhost:3000/", {})).toBe("system");
  });

  it("两类各自生效，互不影响", () => {
    const web = { webLinkOpener: "panel" as const };
    expect(replyLinkOpener("https://example.com/", web)).toBe("panel");
    expect(replyLinkOpener("http://127.0.0.1:8080/", web)).toBe("system");
    const local = { localLinkOpener: "panel" as const };
    expect(replyLinkOpener("http://[::1]:8080/", local)).toBe("panel");
    expect(replyLinkOpener("https://example.com/", local)).toBe("system");
  });

  it("不是 http(s) 的一律系统浏览器（由外链白名单决定能不能开）", () => {
    const both = { webLinkOpener: "panel" as const, localLinkOpener: "panel" as const };
    expect(replyLinkOpener("mailto:a@b.c", both)).toBe("system");
  });
});
