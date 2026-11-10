import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PhoneApp, TRUST_TEXT } from "../src/web/App";
import { memoryStorage } from "../src/web/storage";
import { PhonePush } from "../src/web/push";
import { recordDisconnect } from "../src/web/local";

vi.mock("../src/web/connection", () => ({
  PhoneConnection: class {
    state = "offline";
    message = "电脑已离线";
    start = vi.fn();
    stop = vi.fn();
    visibility = vi.fn();
  },
}));
let root: Root | undefined;
beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});
afterEach(async () => {
  await act(() => root?.unmount());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it.each([true, false])("iOS 非 standalone=%s：按钮显示与权限只在点击发起", async (ios) => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ios ? "iPhone Safari" : "Chrome");
  const storage = memoryStorage();
  await storage.putHost({ hostId: "computer", hostPub: "pub", name: "电脑 1", pairedAt: 1 });
  const request = vi.fn(() => Promise.resolve<NotificationPermission>("denied"));
  const push = new PhonePush({
    registration: () =>
      Promise.resolve({
        pushManager: { getSubscription: () => Promise.resolve(null) } as PushManager,
      }),
    permission: () => "default",
    requestPermission: request,
    info: vi.fn(),
    changed: vi.fn(),
  });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<PhoneApp storage={storage} push={push} />);
  });
  expect(request).not.toHaveBeenCalled();
  // 推送开关在设置页
  await act(async () => {
    container.querySelector<HTMLButtonElement>('button[aria-label="设置"]')?.click();
  });
  const toggle = container.querySelector<HTMLButtonElement>(
    '[role="switch"][aria-label="推送通知"]',
  );
  if (ios) {
    expect(toggle).toBeNull();
    expect(container.textContent).toContain("添加到主屏幕后才能接收推送");
  } else {
    expect(toggle).not.toBeNull();
    await act(async () => {
      toggle?.click();
    });
    expect(request).toHaveBeenCalledOnce();
  }
});
it("配对页不显示信任说明，完整说明在设置「关于」", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<PhoneApp storage={memoryStorage()} />);
  });
  expect(container.textContent).not.toContain("详细的信任说明见电脑上的「设置 › 远程」");
  expect(container.textContent).not.toContain(TRUST_TEXT);
  await act(async () => {
    container.querySelector<HTMLButtonElement>('button[aria-label="设置"]')?.click();
  });
  const about = container.querySelector('section[aria-label="关于"]');
  expect(about?.querySelector("details > summary")?.textContent).toBe("安全说明");
  expect(about?.querySelector("details > p")?.textContent).toBe(TRUST_TEXT);
  expect(about?.textContent).not.toContain("手机能做会话里的一切");
});

it("设置页按电脑分组；连接诊断子页列出断线记录并可清除，首页不出现断线列表", async () => {
  recordDisconnect("电脑 1", "网络中断", new Date(2026, 10, 10, 12, 40, 8).getTime());
  const storage = memoryStorage();
  await storage.putHost({ hostId: "computer", hostPub: "pub", name: "电脑 1", pairedAt: 1 });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<PhoneApp storage={storage} />);
  });
  await act(async () => {
    await new Promise((done) => setTimeout(done, 50));
  });
  await act(async () => {
    container.querySelector<HTMLButtonElement>('button[aria-label="设置"]')?.click();
  });
  const group = container.querySelector('section[aria-label="电脑 1"]');
  expect(group?.querySelector("h3")?.textContent).toBe("电脑 1");
  expect(
    [...(group?.querySelectorAll(".phone-item-label") ?? [])].map((item) => item.textContent),
  ).toEqual(["连接诊断", "授权", "用量"]);
  expect(container.querySelector('input[type="checkbox"]')).toBeNull();
  expect(container.textContent).not.toContain("网络中断");
  expect(container.textContent).not.toContain("清除记录");
  expect([...container.querySelectorAll('[role="radio"]')].map((item) => item.textContent)).toEqual(
    ["跟随系统", "月之亮面", "月之暗面"],
  );
  await act(async () => {
    [...(group?.querySelectorAll("button") ?? [])]
      .find((b) => b.textContent?.startsWith("连接诊断"))
      ?.click();
  });
  expect(container.querySelector("h1")?.textContent).toBe("连接诊断");
  const log = container.querySelector('section[aria-label="断线记录"]');
  expect(log?.querySelector("h3")?.textContent).toBe("断线记录");
  const row = log?.querySelector("li");
  expect(row?.querySelector("time")?.textContent).toBe("11/10 12:40:08");
  expect(row?.querySelector("span")?.textContent).toBe("网络中断");
  await act(async () => {
    [...container.querySelectorAll("button")].find((b) => b.textContent === "清除记录")?.click();
  });
  expect(container.querySelector('section[aria-label="断线记录"]')).toBeNull();
  expect(container.textContent).not.toContain("清除记录");
  expect(container.textContent).not.toContain("断线记录");
});
